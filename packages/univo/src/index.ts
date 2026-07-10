import { StorageError } from "@storagesdk/core";
import type { Storage } from "@storagesdk/core";

import { local } from "./transport";
import { createServer } from "./server";
import type { IndexerRpc } from "./rpc";
import { version } from "../package.json";
import { catchException, createException } from "./exceptions";
import { compress, createLogger, decompress, hexToNumber, isHexEqual, normalizeHex, retry } from "./utils";

/**
 * Block -----------------------------------------------------------------------------------------------------------------------------------
 */

// This is the minimum set of block fields univo needs to function. These are mostly required to allow to perform
// filter matching on a given block. We need to have _some_ agreed contract to able to understand the chain,
// the block, and log address and events. We also expect some methods so that we can verify these known methods
// originate from the intended block hash.

type Block = {
	eth_chainId: `0x${string}`;

	eth_getBlockByNumber: {
		hash: `0x${string}`;
		number: `0x${string}`;
		parentHash: `0x${string}`;
	};

	eth_getBlockReceipts: Array<{
		blockHash: `0x${string}`;

		logs: Array<{
			address: `0x${string}`;
			topics: `0x${string}`[];
		}>;
	}>;
};

/**
 * Filters -----------------------------------------------------------------------------------------------------------------------------------
 */

type Filter = {
	/** Index blocks with this chain id */
	chain: number;
	/** Index blocks from this start block (inclusive) */
	fromBlock: number;
	/** Index blocks until this stop block (inclusive)  */
	toBlock?: number;
	/** Index blocks where this event topic was emitted */
	event?: `0x${string}`;
	/** Index blocks that involve this address */
	address?: `0x${string}`;
};

function matchFilter(block: Block, filter: Filter) {
	if (!chainValid(block, filter)) return false;
	if (!toBlockValid(block, filter)) return false;
	if (!fromBlockValid(block, filter)) return false;
	if (!includesLogEvent(block, filter)) return false;
	if (!includesLogAddress(block, filter)) return false;
	return true;
}

type MatchFilter = (block: Block, filter: Filter) => boolean;

const chainValid: MatchFilter = (block, filter) => {
	if (hexToNumber(block.eth_chainId) === filter.chain) return true;
	return false;
};

const fromBlockValid: MatchFilter = (block, filter) => {
	if (hexToNumber(block.eth_getBlockByNumber.number) >= filter.fromBlock) return true;
	return false;
};

const toBlockValid: MatchFilter = (block, filter) => {
	if (filter.toBlock === undefined) return true;
	if (hexToNumber(block.eth_getBlockByNumber.number) <= filter.toBlock) return true;
	return false;
};

const includesLogAddress: MatchFilter = (block, filter) => {
	if (filter.address === undefined) return true;

	for (const receipt of block.eth_getBlockReceipts) {
		for (const log of receipt.logs) {
			if (isHexEqual(log.address, filter.address)) return true;
		}
	}

	return false;
};

const includesLogEvent: MatchFilter = (block, filter) => {
	if (filter.event === undefined) return true;

	for (const receipt of block.eth_getBlockReceipts) {
		for (const log of receipt.logs) {
			if (log.topics[0] === filter.event) return true;
		}
	}

	return false;
};

/**
 * Events -----------------------------------------------------------------------------------------------------------------------------------
 */

type Event<TBlock, TEvent> = {
	/**
	 * A human-readable identifier for the event.
	 */
	id: string;

	/**
	 * Filters let you define what specific blocks you want this event to index.
	 *
	 * Blockchains are massive datasets and most of the time we are only ever interested in small portions of it.
	 * Sometimes that can be specific events like ERC20 transfers and other times it could be all events emitted
	 * by a specific contract. Filters provide a simple way for an event to define exactly which blocks we want
	 * to index.
	 *
	 * Filters reduce costs and improve backfill performance by ensuring we only index the blocks we need and
	 * ignore the blocks that don't have the data we are interested in.
	 *
	 * By default your event will not index any blocks, you must opt-in to indexing by providing atleast one filter.
	 *
	 * Each property in the filter operates like an AND statement. For example, if you specifiy an `address` and
	 * an `event` it implies that you only want to index blocks where the specific `address` emitted the specific
	 * `event` topic provided.
	 *
	 * However, when multiple filters are defined for a given event those filters operate like an OR statement. For
	 * example, if we define a second filter looking for a different `address` and `event` our event will now index
	 * any block that matches either the first filter or the second filter.
	 *
	 * Note that filters are a rudimentary method to dramatically reduce the number of blocks your application needs
	 * to index. Any advanced filtering should be performed in the event `handler` itself.
	 */
	filters: Filter[];

	/**
	 * Synchronously transforms a raw block into a list of events.
	 *
	 * When a block matches any of filters defined by your event it will be passed to this function to be synchronously
	 * transformed into a list of structured events.
	 *
	 * The shape of the input `block` is determined by the return value of `getBlock` function provided to your `indexer`.
	 *
	 * The returned output value should be an array containg any valid JavaScript values. Each event that you return from
	 * your handler should not depend on any information outside of the input block data. It should directly map a given
	 * input (the raw block) to a given output (structured events). This ensures that handler remains idempotent and that
	 * repeated calls with the same input block produce the same output events.
	 */
	handler: (block: TBlock) => TEvent[];

	/**
	 * Storage adapter to persist events in your off-chain storage.
	 */
	storage: {
		/**
		 * Upserts a batch of events into your storage system.
		 *
		 * After a block is transformed into a list of structured events by your `handler` function, that batch
		 * is passed to this `upsert` function so they can be upserted into your storage system.
		 *
		 * This function must be idempotent. Functionally, this means that if the same batch of events is upserted
		 * multiple times it only produces a single set of events in your storage system.
		 */
		upsert: (events: TEvent[]) => Promise<void>;
		/**
		 * Deletes a batch of events from your storage system.
		 *
		 * When your indexer encounters a chain reorganisation, this `delete` function will be invoked with the
		 * same batch of events created by that reorganised block. This ensures that any events that were previously
		 * upserted into your storage system that are no longer part of the canonical chain are safely removed.
		 */
		delete: (events: TEvent[]) => Promise<void>;
	};
};

/**
 * Indexer -----------------------------------------------------------------------------------------------------------------------------------
 */

type Head = {
	hash: `0x${string}`;
	chain: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
};

type Metadata = {
	version: string;
	language: string;
};

type Result = {
	status: string;
	event_id: string;
	hash: `0x${string}`;
	chain: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
	created_at: number;
};

type IndexerOptions<TBlock> = {
	/**
	 * Silences all logs including errors.
	 *
	 * Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs.
	 * Available log options are `DEBUG`, `INFO`, `WARN`, and `ERROR`.
	 */
	quiet?: boolean;

	/**
	 * Request signing key
	 *
	 * Facilitates secure communication with a trusted source like the univo dashboard.
	 */
	signingKey: string;

	/**
	 * Storage interface for durably persisting indexer metadata.
	 *
	 * This uses the unified key-value storage API from unstorage. Install the `unstorage` dependency
	 * and provide the return value of your `createStorage()` call. Check out the documentation for
	 * a full list of [supported storage drivers](https://unstorage.unjs.io/drivers).
	 *
	 * Functionally, storing metadata is fundamental to ensure the correct operation of your indexer. It
	 * ensures that you indexer recovers from downtime and ensures that all blocks are processed correctly during
	 * chain reorganisations.
	 */
	metadataStorage: Storage;

	/**
	 * Loads raw block data in realtime from a trusted set of RPC sources.
	 *
	 * Note that historical backfills do not use this function to load block data.
	 *
	 * The response from this function determines the input data to your `handler` functions in each event.
	 * Generally, the shape is a list of RPC methods with their corresponding value from an RPC node. This
	 * generic format allows you support the full range of RPC data available to you from your node. This
	 * flexibility is important in cases where some methods are supported on specific chains only.
	 *
	 * Note that there is a minimum set of RPC methods expected on the response notably `eth_chainId`,
	 * `eth_getBlockByNumber` and `eth_getBlockReceipts`. These are expected so that we can safely match
	 * each block processed against your event filters.
	 *
	 * Note that we provide only the block number to look up block data. During a chain reorganisation, this
	 * makes it possible for different RPC calls to return data for different block hashes. We manually verify
	 * that all methods return the expected block hash. However, for any custom methods you add you must manually
	 * verify the block hash is consistent with the other known methods.
	 */
	getBlock: (block: { chain: `0x${string}`; number: string }) => Promise<TBlock | null>;
};

type Indexer<TBlock> = {
	fetch: (req: Request) => Promise<Response>;
	event: <TEvent>(event: Event<TBlock, TEvent>) => Event<TBlock, TEvent>;
};

function indexer<TBlock extends Block>(opts: IndexerOptions<TBlock>) {
	const log = createLogger({ quiet: opts.quiet ?? false, prefix: "[indexer]" });

	// We batch events based on the provided storage function. This is an optimisation that allows distinct
	// events that share the same storage adapter to be combined into the same batch for upsert.

	const all_events: Event<any, any>[] = [];
	const events_grouped_by_storage_map = new Map<Event<any, any>["storage"], Event<any, any>[]>();

	// Metadata storage interface. Functionally this is responsible for storing all state related to ensuring
	// the correct processing of the indexer.

	const metadata = {
		// The blocks store essentially operates as our write-ahead-log (WAL) for unfinalized blocks. Before we
		// commit any events to storage we first record the block input in our metadata layer. This allows our
		// finalization handler to always have access to the input data in the case we need to remove events
		// because of chain reorganisations

		blocks: {
			async list(chain: `0x${string}`, number?: `0x${string}`) {
				let prefix = `blocks/v1/${normalizeHex(chain)}`;

				if (typeof number === "string") {
					prefix += `/${normalizeHex(number, 16)}`;
				}

				const keys = await opts.metadataStorage.list({ prefix, limit: 1 });

				const mapped = keys.items.map((key) => {
					const [_, __, ___, number, hash] = key.path.split("/") as [string, string, `0x${string}`, `0x${string}`, `0x${string}`];

					return { chain, number, hash };
				});

				return mapped;
			},

			async get(chain: `0x${string}`, number: `0x${string}`, hash: `0x${string}`) {
				const prefix = `blocks/v1/${normalizeHex(chain)}/${normalizeHex(number, 16)}/${normalizeHex(hash)}`;

				const blob = await opts.metadataStorage.download(prefix, { as: "blob" }).catch((error) => {
					if (error instanceof StorageError) {
						if (error.code === "NotFound") {
							return null;
						}
					}

					throw error;
				});

				if (blob === null) {
					return null;
				}

				const block = await decompress(blob);
				const parsed = JSON.parse(block);

				return parsed as TBlock;
			},

			async upsert(blocks: TBlock[]) {
				if (blocks.length === 0) {
					return;
				}

				await Promise.all(
					blocks.map(async (block) => {
						const chain = normalizeHex(block.eth_chainId);
						const hash = normalizeHex(block.eth_getBlockByNumber.hash);
						const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
						const prefix = `blocks/v1/${chain}/${number}/${hash}`;
						const compressed = await compress(JSON.stringify(block));
						await opts.metadataStorage.upload(prefix, compressed);
					}),
				);
			},

			async delete(blocks: TBlock[]) {
				if (blocks.length === 0) {
					return;
				}

				await Promise.all(
					blocks.map(async (block) => {
						const chain = normalizeHex(block.eth_chainId);
						const hash = normalizeHex(block.eth_getBlockByNumber.hash);
						const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
						const prefix = `blocks/v1/${chain}/${number}/${hash}`;
						await opts.metadataStorage.delete(prefix);
					}),
				);
			},
		},

		// When unfinalized events are upserted we commit a given block number and block hash to indicate
		// that those events were successfully recorded. This enables an optimisation in our finalized
		// handler that allows it to skip processing blocks that were successfully processed

		commits: {
			async list(chain: `0x${string}`, number?: `0x${string}`) {
				let prefix = `commits/v1/${normalizeHex(chain)}`;

				if (typeof number === "string") {
					prefix += `/${normalizeHex(number, 16)}`;
				}

				const keys = await opts.metadataStorage.list({ prefix });

				const mapped = keys.items.map((key) => {
					const [_, __, ___, number, hash] = key.path.split("/") as [string, string, `0x${string}`, `0x${string}`, `0x${string}`];

					return { chain, number, hash };
				});

				return mapped;
			},

			async upsert(chain: `0x${string}`, number: `0x${string}`, hash: `0x${string}`) {
				const prefix = `commits/v1/${normalizeHex(chain)}/${normalizeHex(number, 16)}/${normalizeHex(hash)}`;

				const body = JSON.stringify({ hello: "world" }); // Doesn't matter what this is

				await opts.metadataStorage.upload(prefix, body);
			},
		},

		// Our indexer always lags behind the canonical chain. The heights table is used as a durable record
		// to track its own finalized height. As the chain finalizes, we process newly finalized blocks and
		// then update the heights here to reflect to that outside world what height the indexer has currently
		// finalized up to. This information is stored in a separate table so that we can `list` keys and
		// immediately know which blocks were finalized correctly without ever having to load the entire block
		// values themselves reducing memory usage and increasing finalizing throughput

		heights: {
			async list(chain: `0x${string}`) {
				const prefix = `heights/v1/${normalizeHex(chain)}`;

				const keys = await opts.metadataStorage.list({ prefix });

				const mapped = keys.items.map((key) => {
					const [_, __, ___, number] = key.path.split("/") as [string, string, `0x${string}`, `0x${string}`];

					return { chain, number };
				});

				return mapped;
			},

			async upsert(chain: `0x${string}`, number: `0x${string}`) {
				const prefix = `heights/v1/${normalizeHex(chain)}/${normalizeHex(number, 16)}`;

				const body = JSON.stringify({ hello: "world" }); // Doesn't matter what this is

				await opts.metadataStorage.upload(prefix, body);
			},
		},
	};

	// Fetches a block using the provided `getBlock` function. Handles retries. The block hash is optional
	// because we sometimes want the canonical block using only the block number. If a hash is provided we
	// will ensure that the block returned via the block number lookup is the expected block

	async function getBlock(head: { chain: `0x${string}`; number: string; hash?: `0x${string}` }) {
		return await retry(() => retry_getBlock(head), 2).catch(() => {
			log.error("Failed to load block from the provided `getBlock` function after 3 attempts");
			return null;
		});
	}

	async function retry_getBlock(head: { chain: `0x${string}`; number: string; hash?: `0x${string}` }) {
		const block = await opts.getBlock({ chain: head.chain, number: head.number });

		if (block === null) {
			throw new Error("Provided `getBlock` function returned null");
		}

		if (typeof head.hash === "string") {
			if (!isHexEqual(head.hash, block.eth_getBlockByNumber.hash)) {
				throw new Error("Method `eth_getBlockByNumber` returned unexpected block hash");
			}

			for (const receipt of block.eth_getBlockReceipts) {
				if (!isHexEqual(head.hash, receipt.blockHash)) {
					throw new Error("Method `eth_getBlockReceipts` returned receipt with unexpected block hash");
				}
			}
		}

		return block;
	}

	const GetBlockError = createException("Failed to load block from the provided `getBlock` function");

	const public_getFinalizedHeight: IndexerRpc["request"]["public_getFinalizedHeight"] = async (chain) => {
		const heights = await metadata.heights.list(chain);

		if (heights.length === 0) {
			const block = await getBlock({ chain, number: "finalized" });

			if (block === null) {
				log.debug("Failed to fetch finalized block and unable to determine finalized height, aborting...");

				throw new Error(GetBlockError);
			}

			await metadata.heights.upsert(chain, block.eth_getBlockByNumber.number);

			return hexToNumber(block.eth_getBlockByNumber.number);
		}

		// There will exist at least one height in the array so this cannot result in -Infinity

		const height = Math.max(...heights.map((height) => hexToNumber(height.number)));

		return height;
	};

	const public_writeUnfinalizedHead: IndexerRpc["request"]["public_writeUnfinalizedHead"] = async (head) => {
		log.debug("Received unfinalized head...");

		const blocks_start = Date.now();

		const [finalizedBlock, block] = await Promise.all([
			getBlock({ chain: head.chain, number: "finalized" }),
			getBlock({ chain: head.chain, number: head.number, hash: head.hash }),
		]);

		if (block === null) {
			// A null response is actually a common case during chain reorganisations. Because we load by block number it
			// is common for the client and server to be connected to different nodes. There is no guarantee that both
			// those nodes see the same reorganisation so when we load the block on the server we get null

			return;
		}

		if (finalizedBlock === null) {
			log.debug("Failed to determine finalized height when processing unfinalized heads");

			throw new Error(GetBlockError);
		}

		const finalizedHeight = hexToNumber(finalizedBlock.eth_getBlockByNumber.number);

		if (hexToNumber(head.number) <= finalizedHeight) {
			// TODO:
			// This attack vector is no longer possible in the new finalization mechanism?
			// Or we could load the finalised height from the metadata table?

			// We must ensure each block is actually unfinalised to prevent an attack vector where a client could submit
			// the genesis block as unfinalized. Forcing our finalized handler to process the entire chain and effectively
			// stall indexing. We filter them out here and continue operating on unfinalised heads

			return;
		}

		log.debug(`Loaded block in ${Date.now() - blocks_start}ms`);

		// Before any blocks are processed they must be committed to the metadata storage. This ensures we have a record
		// of the events that were upserted to storage. This is necessary to ensure that we can correctly discard any events
		// from blocks that are later reorganised and no longer included in the canonical chain

		const metadata_start = Date.now();

		await metadata.blocks.upsert([block]);

		log.debug(`Persisted block to metadata in ${Date.now() - metadata_start}ms`);

		const events_start = Date.now();

		const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

			for (const event of grouped_events) {
				try {
					if (!event.filters.some((filter) => matchFilter(block, filter))) {
						log.debug(`Block matches no filters for event ${event.id}`);
						continue;
					}

					const events = event.handler(block);

					for (const event of events) {
						batch.push(event);
					}
				} catch (error) {
					log.error(`Failed to run your 'handler' for event ${event.id}`);

					throw error;
				}
			}

			if (batch.length > 0) {
				const start = Date.now();

				await retry(() => storage.upsert(batch), 2).catch((error) => {
					for (const event of grouped_events) {
						log.error(`Failed to run your 'upsert' handler for event ${event.id}`);
					}

					throw error;
				});

				for (const event of grouped_events) {
					log.debug(`Recorded ${batch.length} ${event.id} in ${Date.now() - start}ms`);
				}
			}
		});

		await Promise.all(promises);

		log.debug(`Wrote events in ${Date.now() - events_start}ms`);

		// After upserting events we commit the unfinalized block to the metadata commits table. This is an
		// optimisation that allows the finalized handler to later determine if a block was processed correctly
		// and can therefore be skipped, improving throughput when finalizing.

		// Normally, this commit flag isn't enough on its own to prove an unfinalized block was correctly
		// processed. For example, when there are two concurrent requests for an unfinalized block number it is
		// always possible for one request to stall - while the other processes successfully - and then write
		// events to storage and fail to commit. Leaving our storage layer with mismatching events and commits!
		// Normally we would need some type of fencing to ensure the second concurrent request fails to write.

		// However, this is only true if those requests are committing distinct data, but in this case two
		// concurrent requests are most commonly committing the same data (the canonical block). So the only
		// time we can't prove correctness is when a block was reorganised because we can't determine the timing
		// of when the canonical and reorganised blocks were processed.

		// This means in the rare case of a chain reorganisation we have to process everything again in the
		// finalized handler to ensure correctness (slow) but in the common case we don't need to perform
		// any extra work (fast)

		await metadata.commits.upsert(head.chain, head.number, head.hash);
	};

	const public_deleteReorganisedHead: IndexerRpc["request"]["public_deleteReorganisedHead"] = async (head) => {
		log.debug(`Received reorganised head ${hexToNumber(head.number)}`);

		// We load blocks via their block number. If this block was truly reorganised and is no longer part of the
		// canonical chain than this request should yield a block with a different block hash. This is our proof
		// that this block is no longer included in the chain and that it's safe to delete data associated with it

		const [canonical_block, stored_block] = await Promise.all([
			getBlock({ chain: head.chain, number: head.number }),
			metadata.blocks.get(head.chain, head.number, head.hash),
		]);

		if (stored_block === null) {
			return log.debug("Reorganised block never/already processed");
		}

		if (canonical_block === null) {
			throw new Error("Attempted to delete unknown block");
		}

		if (isHexEqual(head.hash, canonical_block.eth_getBlockByNumber.hash)) {
			throw new Error("Attempted to delete canonical block");
		}

		// We know the block is not included in the canonical chain and we know that our storage system may have upserted
		// events with this block data. We use the block data to generate the same set of events that could have been
		// upserted and provide them to each events delete function

		const deletes = all_events.map(async (event) => {
			// TODO
			// We intentionally ignore filters and basically perform an optimistic delete on events that might
			// have never been upserted. I make this choice because there is a time delay between upsert and delete,
			// it's possible for a new deployment to update the filters in this gap that would prevent the delete
			// from removing the upserted events if the filters were changed in just the right way

			const batch: any[] = [];

			try {
				const events = event.handler(stored_block);

				for (const event of events) {
					batch.push(event);
				}
			} catch (error) {
				log.error(`Failed to run your 'handler' for event ${event.id}`);

				throw error;
			}

			if (batch.length === 0) {
				return;
			}

			await retry(() => event.storage.delete!(batch), 2).catch((error) => {
				log.error(`Failed to run your 'delete' handler for event ${event.id}`);

				throw error;
			});
		});

		await Promise.all(deletes);

		// When the events from a reorganised block have a distinct set of primary keys from the canonical block,
		// it makes cleanup simple because we are operating on a distinct set of events. For example, if we used
		// the block hash in PK identifier then there is no overlap. However, it is possible for an event to return
		// a set of events that share the same PK identifier. For example, if we used only the block number. In
		// the latter case it creates a timing issue, i.e. for our record to be correct we must ensure that we
		// perform a delete of the reorganised events _before_ we perform an upsert of the canonical events.
		// To solve this, we also write the canonical events _after_ deleting the reorganised events.

		const upserts = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

			for (const event of grouped_events) {
				try {
					if (!event.filters.some((filter) => matchFilter(canonical_block, filter))) {
						continue;
					}

					const events = event.handler(canonical_block);

					for (const event of events) {
						batch.push(event);
					}
				} catch (error) {
					log.error(`Failed to run your 'handler' for event ${event.id}`);

					throw error;
				}
			}

			if (batch.length > 0) {
				await retry(() => storage.upsert(batch), 2).catch((error) => {
					for (const event of grouped_events) {
						log.error(`Failed to run your 'upsert' handler for event ${event.id}`);
					}

					throw error;
				});
			}
		});

		await Promise.all(upserts);

		// After the above deletion occurs it is impossible for a malicious client to call `public_writeUnfinalizedHead`
		// with the reorganised block because it won't be retrievable from the chain. This guard guarantees that our
		// record of events will leave the canonical set and not the reorganised set.

		// We don't delete the reorganised block from metadata storage for exceptional cases where a massive chain
		// bug occurs and it takes a long time to finalize. Like in a worst case scenario where the chain could be
		// constantly switching between two chains from major clients. We wait till everything is sorted and the
		// chain finalizes to cleanup and process everything
	};

	// The goal of this function is to accept a contigious chain of heads that connect our indexer finalized height
	// to the chain finalized height. We process each head sequentially, updating our indexer height as we iterate.
	// Returning an OK response indicates to the client that the indexer height is equal to chain height.

	const public_writeFinalizedHeads: IndexerRpc["request"]["public_writeFinalizedHeads"] = async (heads) => {
		if (heads.length === 0) {
			throw new Error("No heads received, aborting...");
		}

		log.debug(`Received ${heads.length} finalized heads...`);

		// Verify that all heads received are from the same chain

		let chain = undefined;

		for (const head of heads) {
			if (chain === undefined) {
				chain = head.chain;
			}

			if (!isHexEqual(chain, head.chain)) {
				throw new Error("Received heads from separate chains");
			}
		}

		if (chain === undefined) {
			throw new Error("Internal error. Expected chain to be defined after checking heads length");
		}

		// Verify that the heads received are contigouous and sequential i.e. all hash and parent hash
		// relationships match with an incrementing block number with each head

		const [firstHead, ...remainingHeads] = heads;

		if (firstHead === undefined) {
			throw new Error("Internal error. Expected firstHead to be defined after checking heads length");
		}

		let previousHead = firstHead;

		for (const head of remainingHeads) {
			if (hexToNumber(head.number) !== hexToNumber(previousHead.number) + 1) {
				throw new Error("Found invalid block number in received heads, aborting...");
			}

			if (!isHexEqual(head.parent_hash, previousHead.hash)) {
				throw new Error("Found invalid block hash in received heads, aborting...");
			}

			previousHead = head;
		}

		// Now we know the heads are valid by themselves, we need to assert their validity in the context of the
		// metadata and external chain state. We load the current indexer height and the finalized block.

		const [heights, finalizedBlock] = await Promise.all([
			metadata.heights.list(chain), //
			getBlock({ chain, number: "finalized" }),
		]);

		if (finalizedBlock === null) {
			log.debug("Failed to load chain finalized block. Request should be retried");

			throw new Error(GetBlockError);
		}

		// This is a rare case that only happens the first time an indexer is started and we haven't stored
		// a height for this given chain yet. As an optimisation we upsert the chain finalised height and
		// manually push it to the finalized heights

		if (heights.length === 0) {
			await metadata.heights.upsert(chain, finalizedBlock.eth_getBlockByNumber.number);

			heights.push({ chain, number: finalizedBlock.eth_getBlockByNumber.number });
		}

		// We need to verify that the first head received is one greater than the indexer. However, we allow
		// clients to send older heads than this. This is because it's a reasonable expectation for a client to
		// have a stale understanding of the indexer height so we just filter those out instead of throwing

		// There will exist at least one height in the array so this cannot result in -Infinity

		const indexerHeight = Math.max(...heights.map((height) => hexToNumber(height.number)));

		const newHeads = heads.filter((head) => {
			return hexToNumber(head.number) > indexerHeight;
		});

		const [firstNewHead] = newHeads;

		if (firstNewHead === undefined || hexToNumber(firstNewHead.number) !== indexerHeight + 1) {
			throw new Error("Client advanced too far. Heads received are greater than the first new head");
		}

		// Verify that the latest head received is equal to the chain finalized block. If not we throw an error
		// because clients should never try finalise heads greater than the chain finalized height. A common
		// error here is when the node connected to the client finalises but the node connected to the indexer
		// still hasn't seen that finalised height. This means the client has optimistically sent heads that
		// we haven't seen finalised. The client should automatically retry the request after a period of time
		// when both nodes will agree on the finalized height and we can continue

		const lastNewHead = newHeads[newHeads.length - 1];

		const finalizedHeight = hexToNumber(finalizedBlock.eth_getBlockByNumber.number);

		if (lastNewHead === undefined || hexToNumber(lastNewHead.number) !== finalizedHeight) {
			throw new Error("Client has stalled. Chain has finalised greater than the heads received");
		}

		// Now that we have fully verified that the received heads connect the indexer height to the chain
		// finalized height, we need to perform all the work required to get our indexer height equal to
		// the chain height before returning OK to the client

		log.debug(`Indexer height ${indexerHeight}, finalized height ${finalizedHeight}`);

		if (indexerHeight === finalizedHeight) {
			log.debug("No heads to finalize, returning...");

			// TODO: Clean up

			return;
		}

		for (const head of newHeads) {
			await processHead(head);

			// Update indexer height without blocking

			metadata.heights.upsert(head.chain, head.number).catch((error) => {
				if (error instanceof Error) {
					log.warn(`Failed to upsert new indexer height: ${error.message}`);
				}
			});
		}

		// TODO: Clean up
	};

	async function processHead(head: Head) {
		const [processed, commits] = await Promise.all([
			metadata.blocks.list(head.chain, head.number), //
			metadata.commits.list(head.chain, head.number),
		]);

		const reorganised = processed.filter((block) => {
			return !isHexEqual(head.hash, block.hash);
		});

		// We check for our common case fast-path

		if (reorganised.length === 0 && processed.length === 1) {
			const [block] = processed;

			if (block === undefined) {
				throw new Error("Internal error. Expected block to be defined");
			}

			if (!isHexEqual(head.hash, block.hash)) {
				throw new Error("Internal error. Expected canonical block to be processed");
			}

			if (commits.some((commit) => isHexEqual(head.hash, commit.hash))) {
				return; // This our common case fast-path
			}
		}

		// Check if no blocks we processed at all

		if (processed.length === 0) {
			await writeFinalizedHead(head);

			return;
		}

		// Finally, if reorganised and canonical blocks were processed we process everything again

		await Promise.all(
			reorganised.map(async (block) => {
				await deleteReorganisedHead(block);
			}),
		);

		await writeFinalizedHead(head);
	}

	async function writeFinalizedHead(head: Head) {
		const block = await getBlock({ chain: head.chain, number: head.number, hash: head.hash });

		if (block === null) {
			throw new Error("Received unknown head that wasn't canonical");
		}

		const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

			for (const event of grouped_events) {
				try {
					if (!event.filters.some((filter) => matchFilter(block, filter))) {
						log.debug(`Block matches no filters for event ${event.id}`);
						continue;
					}

					const events = event.handler(block);

					for (const event of events) {
						batch.push(event);
					}
				} catch (error) {
					log.error(`Failed to run your 'handler' for event ${event.id}`);

					throw error;
				}
			}

			if (batch.length > 0) {
				const start = Date.now();

				await retry(() => storage.upsert(batch), 2).catch((error) => {
					for (const event of grouped_events) {
						log.error(`Failed to run your 'upsert' handler for event ${event.id}`);
					}

					throw error;
				});

				for (const event of grouped_events) {
					log.debug(`Recorded ${batch.length} ${event.id} in ${Date.now() - start}ms`);
				}
			}
		});

		await Promise.all(promises);
	}

	async function deleteReorganisedHead(head: Omit<Head, "parent_hash">) {
		// We know the block is not included in the canonical chain and we know that our storage system upserted
		// events with this block data. We use the block data to generate the same set of events that we upserted
		// and provide them to each events delete function

		const block = await getBlock(head);

		const promises = all_events.map(async (event) => {
			// We intentionally ignore filters and basically perform an optimistic delete on events that might
			// have never been upserted. I make this choice because there is a time delay between upsert and delete,
			// it's possible for a new deployment to update the filters in this gap that would prevent the delete
			// from removing the upserted events if the filters were changed in just the right way

			const batch: any[] = [];

			try {
				const events = event.handler(block);

				for (const event of events) {
					batch.push(event);
				}
			} catch (error) {
				log.error(`Failed to run your 'handler' for event ${event.id}`);

				throw error;
			}

			if (batch.length === 0) {
				return;
			}

			await retry(() => event.storage.delete!(batch), 2).catch((error) => {
				log.error(`Failed to run your 'delete' handler for event ${event.id}`);

				throw error;
			});
		});

		await Promise.all(promises);
	}

	const private_getMetadata: IndexerRpc["request"]["private_getMetadata"] = async () => {
		return {
			version,
			language: "javascript",
		};
	};

	const private_getEvents: IndexerRpc["request"]["private_getEvents"] = async () => {
		return all_events.map((event) => {
			const filters = event.filters.map((filter) => {
				return {
					chain: filter.chain,
					event: filter.event,
					address: filter.address,
					to_block: filter.toBlock,
					from_block: filter.fromBlock,
				};
			});

			return { id: event.id, filters };
		});
	};

	// When calling `private_writeEvents` we want to ensure that a value exists for all keys that were accessed.
	// It's entirely possible that in the middle of an indexing process the indexing handler begins to access keys
	// that weren't accessed in any previous blocks. We guard against this with a proxy that tracks whenever
	// the value of an accessed key is undefined. This could also support accessing deeply nested objects?

	const ignored = [
		"toJSON",
		"toString",
		"valueOf",
		"inspect",
		"constructor",
		"hasOwnProperty",
		"isPrototypeOf",
		"propertyIsEnumerable",
		"__proto__",
		"__defineGetter__",
		"__defineSetter__",
		"__lookupGetter__",
		"__lookupSetter__",
	];

	const getWriteEventsProxy = <T>(value: T, callback: () => void) => {
		const createProxyHandler = (path: string) => {
			return {
				get(target: any, key: any, receiver: any) {
					const value = Reflect.get(target, key, receiver);

					if (Array.isArray(target)) {
						if (typeof value === "object" && value !== null) {
							return new Proxy(value, createProxyHandler(path));
						}

						return value;
					}

					if (value === undefined) {
						if (ignored.some((ignored) => key.endsWith(ignored))) {
							return value;
						}

						return callback();
					}

					if (typeof value === "object" && value !== null) {
						const delimiter = Array.isArray(value) ? "/" : ".";
						return new Proxy(value, createProxyHandler(path + key + delimiter));
					}

					return value;
				},
			};
		};

		return new Proxy(value, createProxyHandler("")) as T;
	};

	const IncompleteBlockError = createException("Received block with missing required property");

	const private_writeEvents: IndexerRpc["request"]["private_writeEvents"] = async (params) => {
		// TODO: Return an error
		if (all_events.length === 0) return { failures: [] };

		// TODO: Return errors
		const relevant_events = all_events.filter((event) => params.events.includes(event.id));
		if (relevant_events.length === 0) return { failures: [] };

		// TODO: This is likely an error and we could inform the client somehow.
		if (params.events.length === 0) return { failures: [] };

		const failures: Record<string, Result> = {};

		// Proxy the object so we can safely determine whenever the user accesses a key that wasn't provided
		let accessed_undefined_key = false;

		const proxied_blocks = getWriteEventsProxy(params.blocks, () => {
			// Setting this flag is designed as a back up to detect undefined key access.
			// In userspace it is possible to wrap a handler or upsert function in a try/catch
			// block that would prevent the below error from propagating
			accessed_undefined_key = true;

			// We throw to prevent any further execution in the handler/upsert fn
			throw new Error(IncompleteBlockError);
		});

		const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
			// For all events that share the same storage adapter we push to the batch
			const batch: any[] = [];

			for (const event of grouped_events) {
				// Ensure event is requested for write
				if (!params.events.includes(event.id)) continue;

				for (const block of proxied_blocks) {
					try {
						// Ignore blocks that don't match any of the defined event filters
						if (!event.filters.some((filter) => matchFilter(block, filter))) continue;
						const events = event.handler(block);
						if (accessed_undefined_key) throw new Error(IncompleteBlockError);
						for (const event of events) batch.push(event);
					} catch (error) {
						const status = catchException(error, IncompleteBlockError) ? "incomplete_error" : "handler_error";

						// Log handler errors for user
						if (status === "handler_error") {
							if (error instanceof Error) {
								log.error(error.message);
							}
						}

						failures[event.id + block.eth_getBlockByNumber.number] ??= {
							status,
							event_id: event.id,
							chain: block.eth_chainId,
							hash: block.eth_getBlockByNumber.hash,
							number: block.eth_getBlockByNumber.number,
							parent_hash: block.eth_getBlockByNumber.parentHash,
							created_at: Date.now(),
						};
					}
				}
			}

			if (batch.length === 0) return;

			const start = Date.now();

			try {
				await retry(() => storage.upsert(batch), 2);
				if (accessed_undefined_key) throw new Error(IncompleteBlockError);
			} catch (error) {
				const status = catchException(error, IncompleteBlockError) ? "incomplete_error" : "upsert_error";

				// Log upsert errors for user
				if (status === "upsert_error") {
					if (error instanceof Error) {
						log.error(error.message);
					}
				}

				for (const event of relevant_events) {
					for (const block of proxied_blocks) {
						// Ignore blocks that don't match any of the defined event filters
						if (!event.filters.some((filter) => matchFilter(block, filter))) continue;

						failures[event.id + block.eth_getBlockByNumber.number] ??= {
							status,
							event_id: event.id,
							chain: block.eth_chainId,
							hash: block.eth_getBlockByNumber.hash,
							number: block.eth_getBlockByNumber.number,
							parent_hash: block.eth_getBlockByNumber.parentHash,
							created_at: Date.now(),
						};
					}
				}
			}

			const stop = Date.now() - start;

			for (const event of relevant_events) {
				log.debug(`Recorded ${batch.length} ${event.id} in ${stop}ms`);
			}
		});

		await Promise.all(promises);

		const failures_array = Object.values(failures);

		return { failures: failures_array };
	};

	// Important to note this method doesn't return an exhaustive list of every key read. It is always possible for the user
	// to write code that reads new keys for a specific block number. The only way to get an exhaustive list is to iterate
	// over all blocks that match the defined filters.

	const private_writeEventsAndGetKeys: IndexerRpc["request"]["private_writeEventsAndGetKeys"] = async (params) => {
		if (all_events.length === 0) {
			return { results: [], keys: [] };
		}

		if (params.events.length === 0) {
			return { results: [], keys: [] };
		}

		// Filter for relevant events
		const relevant_events = all_events.filter((event) => params.events.includes(event.id));

		if (relevant_events.length === 0) {
			return { results: [], keys: [] };
		}

		// Load the requested block
		const block = await getBlock(params.head);

		if (block === null) {
			return {
				keys: [],

				results: relevant_events.map<Result>((event) => {
					return {
						event_id: event.id,
						status: "block_error",
						chain: params.head.chain,
						hash: params.head.hash,
						number: params.head.number,
						parent_hash: params.head.parent_hash,
						created_at: Date.now(),
					};
				}),
			};
		}

		const keys = new Set<string>();
		const results: Record<string, Result> = {};

		function createProxyHandler(path: string) {
			return {
				get(target: any, key: any, receiver: any) {
					const value = Reflect.get(target, key, receiver);

					if (Array.isArray(target)) {
						if (typeof value === "object" && value !== null) {
							return new Proxy(value, createProxyHandler(path));
						}

						return value;
					}

					keys.add(path + key);

					if (typeof value === "object" && value !== null) {
						const delimiter = Array.isArray(value) ? "/" : ".";
						return new Proxy(value, createProxyHandler(path + key + delimiter));
					}

					return value;
				},
			};
		}

		const proxy = new Proxy(block, createProxyHandler("")) as Block;

		await Promise.all(
			relevant_events.map(async (event) => {
				// First step is determine if the block delivered matches any filter
				if (!event.filters.some((filter) => matchFilter(proxy, filter))) {
					// We intentionally do not record a success result if the block doesn't match event filters.
					// Otherwise the external service would record this block as successfully processed when the
					// correct solution is for this block to never have been sent in the first place

					return;
				}

				// Record the transformed events
				let events: any[] = [];

				try {
					events = event.handler(proxy);
				} catch (error) {
					// Log handler errors for user
					if (error instanceof Error) {
						log.error(error.message);
					}

					results[event.id + proxy.eth_getBlockByNumber.number] = {
						status: "handler_error",
						event_id: event.id,
						chain: proxy.eth_chainId,
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
						created_at: Date.now(),
					};

					return;
				}

				if (events.length === 0) {
					results[event.id + proxy.eth_getBlockByNumber.number] = {
						status: "ok",
						event_id: event.id,
						chain: proxy.eth_chainId,
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
						created_at: Date.now(),
					};

					return;
				}

				try {
					const start = Date.now();
					await event.storage.upsert(events);
					log.debug(`Recorded ${events.length} ${event.id} in ${Date.now() - start}ms`);
				} catch (error) {
					// Log upsert errors for user
					if (error instanceof Error) {
						log.error(error.message);
					}

					results[event.id + proxy.eth_getBlockByNumber.number] = {
						status: "upsert_error",
						event_id: event.id,
						chain: proxy.eth_chainId,
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
						created_at: Date.now(),
					};

					return;
				}

				results[event.id + proxy.eth_getBlockByNumber.number] = {
					status: "ok",
					event_id: event.id,
					chain: proxy.eth_chainId,
					hash: proxy.eth_getBlockByNumber.hash,
					number: proxy.eth_getBlockByNumber.number,
					parent_hash: proxy.eth_getBlockByNumber.parentHash,
					created_at: Date.now(),
				};
			}),
		);

		const results_array = Object.values(results);

		// The list of keys cannot be considered the complete set of keys. E.g. it's possible the block provided matches
		// only some of the events. This is possible because events can have mutually exclusive filters. Moreover, if an
		// event errors during the handler for example, we won't be able to detect any new keys accessed after that error.

		const keys_array = Array.from(keys);

		// We don't return the full set of keys because we can prune redundant keys
		const filtered_keys = keys_array.filter((key, i) => {
			// Some keys are accessed as a result of introspection like JSON.stringify or console.log
			if (ignored.some((ignored) => key.endsWith(ignored))) return false;

			// Some are unnecessary because there exists another key with a deeper segment. For example when we record the keys
			// `eth_getBlockHash` and `eth_getBlockByNumber.number`, the first key is made redundant by the second key
			if (keys_array.some((_key) => _key.startsWith(`${key}/`) || _key.startsWith(`${key}.`))) return false;

			// Otherwise we keep it
			return true;
		});

		return { results: results_array, keys: filtered_keys };
	};

	const event: Indexer<TBlock>["event"] = (event) => {
		if (!/^[A-Za-z0-9_-]+$/.test(event.id)) {
			throw new Error(`Invalid event id \`${event.id}\`. Only characters A-Z, a-z, 0-9, underscores, and hyphens are permitted.`);
		}

		all_events.push(event);

		const group = events_grouped_by_storage_map.get(event.storage) ?? [];
		group.push(event);
		events_grouped_by_storage_map.set(event.storage, group);

		return event;
	};

	const rpc: IndexerRpc = {
		request: {
			public_getFinalizedHeight,
			public_writeFinalizedHeads,
			public_writeUnfinalizedHead,
			public_deleteReorganisedHead,

			private_getEvents,
			private_getMetadata,
			private_writeEvents,
			private_writeEventsAndGetKeys,
		},

		subscribe: {},
	};

	const server = createServer({
		transport: local(rpc),
		quiet: opts.quiet ?? false,
		signingKey: opts.signingKey,
	});

	const indexer = {
		...rpc,
		event,
		fetch: server.http,
	};

	return indexer;
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { indexer };
export type { Indexer, Event, Filter, Block, Head, Metadata, Result };
