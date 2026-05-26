import type { Storage } from "unstorage";

import type { IndexerRpc } from "./rpc";
import { version } from "../package.json";
import { catchException, createException, getException } from "./exceptions";
import { createLogger, decoder, decompress, hexToNumber, isHexEqual, nonNullable, retry } from "./utils";

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
		delete?: (events: TEvent[]) => Promise<void>;
	};
};

/**
 * Indexer -----------------------------------------------------------------------------------------------------------------------------------
 */

type Head = {
	hash: `0x${string}`;
	chain: `0x${string}`;
	number: `0x${string}`;
	parentHash: `0x${string}`;
};

type Metadata = {
	version: string;
	language: string;
};

type Result = {
	status: string;
	event_id: string;
	chain: `0x${string}`;
	block_hash: `0x${string}`;
	block_number: `0x${string}`;
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
	const log = createLogger({ quiet: opts.quiet ?? false });

	// We batch events based on the provided storage function. This is an optimisation that allows distinct
	// events that share the same storage adapter to be combined into the same batch for upsert.

	const all_events: Event<any, any>[] = [];
	const events_grouped_by_storage_map = new Map<Event<any, any>["storage"], Event<any, any>[]>();

	// Metadata storage interface. Functionally this is responsible for storing all state related to ensuring
	// the correct processing of the indexer.

	const metadata = {
		blocks: {
			async get(head: { chain: `0x${string}`; number?: `0x${string}`; hash?: `0x${string}` }) {
				let prefix = `/blocks/v1/${head.chain.toLowerCase()}`;

				if (typeof head.number === "string") {
					prefix += `/${head.number.toLowerCase()}`;
				}

				if (typeof head.hash === "string") {
					if (head.number === undefined) {
						throw new Error("Requested block by hash without specifying a block number");
					}

					prefix += `/${head.hash.toLowerCase()}`;

					// When we have the full key we don't perform a prefix search and instead load the key directly
					const block = await opts.metadataStorage.getItem<TBlock>(prefix);

					if (block === null) {
						return [];
					}

					return [block];
				}

				// Otherwise we perform a prefixed search for the values
				const keys = await opts.metadataStorage.getKeys(prefix);
				const results = await opts.metadataStorage.getItems<TBlock>(keys);

				return results.map((result) => result.value);
			},
			async upsert(blocks: TBlock[]) {
				if (blocks.length === 0) {
					return;
				}

				await opts.metadataStorage.setItems(
					blocks.map((block) => {
						const chain = block.eth_chainId.toLowerCase();
						const hash = block.eth_getBlockByNumber.hash.toLowerCase();
						const number = block.eth_getBlockByNumber.number.toLowerCase();
						const key = `/blocks/v1/${chain}/${number}/${hash}`;
						return { key, value: block };
					}),
				);
			},
			async delete(blocks: TBlock[]) {
				if (blocks.length === 0) {
					return;
				}

				await Promise.all(
					blocks.map(async (block) => {
						const chain = block.eth_chainId.toLowerCase();
						const hash = block.eth_getBlockByNumber.hash.toLowerCase();
						const number = block.eth_getBlockByNumber.number.toLowerCase();
						await opts.metadataStorage.del(`/blocks/v1/${chain}/${number}/${hash}`);
					}),
				);
			},
		},
	};

	// Fetches a block using the provided `getBlock` function. Handles retries. The block hash is optional
	// because we sometimes want the canonical block using only the block number. If a hash is provided we
	// will assert that the block returned via the block number lookup is the expected block

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

	const public_getFinalizedHeight = async (chain: `0x${string}`) => {
		const [stored] = await metadata.blocks.get({ chain });

		if (stored !== undefined) {
			return hexToNumber(stored.eth_getBlockByNumber.number) - 1;
		}

		const finalized = await getBlock({ chain, number: "finalized" });

		if (finalized === null) {
			throw new Error("Failed to determine unfinalized height");
		}

		return hexToNumber(finalized.eth_getBlockByNumber.number);
	};

	const public_writeUnfinalizedHeads = async (heads: Head[]) => {
		// Verify that all heads received are from the same chain

		let chain = undefined;

		for (const head of heads) {
			if (chain === undefined) {
				chain = head.chain;
			}

			if (!isHexEqual(chain, head.chain)) {
				throw new Error("All heads received should originate from the same chain");
			}
		}

		if (chain === undefined) {
			return; // No heads were received
		}

		log.debug(`Received ${heads.length} unfinalized heads...`);

		const blocks_start = Date.now();

		const blocks_nullable = await Promise.all(
			heads.map(async (head) => {
				return await getBlock({ chain, number: head.number, hash: head.hash });
			}),
		);

		// A null response is actually a common case during chain reorganisations. Because we load by block number it
		// is common for the client and server to be connected to different nodes. There is no guarantee that both
		// those nodes see the same reorganisation so when we load the block on the server we get null

		const blocks = blocks_nullable.filter(nonNullable);

		if (blocks.length === 0) {
			return log.debug("All blocks failed to load, aborting early...");
		}

		log.debug(`Loaded ${blocks.length} block(s) in ${Date.now() - blocks_start}ms`);

		// Before any blocks are processed they must be committed to the metadata storage. This ensures we have a record
		// of the events that were upserted to storage. This is necessary to ensure that we can correctly discard any events
		// from blocks that are later reorganised and no longer included in the canonical chain

		await metadata.blocks.upsert(blocks);

		log.debug(`Recorded ${blocks.length} block(s) to metadata storage`);

		const events_start = Date.now();

		const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

			for (const block of blocks) {
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

		log.debug(`Wrote ${heads.length} heads in ${Date.now() - events_start}ms`);
	};

	const public_deleteReorganisedHead = async (head: Head) => {
		log.debug(`Received reorganised head ${hexToNumber(head.number)}`);

		// Loading blocks happens via the block number. If this block was truly reorganised and is no longer part of
		// the canonical chain than this request should yield a block with a different block hash. This is our proof
		// that this block is no longer included in the chain and that it's safe to delete data associated with it

		const [canonical_block, [stored_block]] = await Promise.all([
			getBlock({ chain: head.chain, number: head.number }),
			metadata.blocks.get({ chain: head.chain, number: head.number, hash: head.hash }),
		]);

		if (stored_block === undefined) {
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

		const promises = all_events.map(async (event) => {
			// TODO: If they update the indexer to remove the delete method it's possible that reorged events remain in storage

			if (event.storage.delete === undefined) {
				return;
			}

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

		await Promise.all(promises);
	};

	const public_writeFinalizedHeads = async (heads: Head[]) => {
		// Verify that all heads received are from the same chain

		let chain = undefined;

		for (const head of heads) {
			if (chain === undefined) {
				chain = head.chain;
			}

			if (!isHexEqual(chain, head.chain)) {
				throw new Error("All heads received should originate from the same chain");
			}
		}

		if (chain === undefined) {
			throw new Error("Received invalid chain");
		}

		log.debug(`Received ${heads.length} finalized heads...`);

		// We load the finalized block from the chain and the first unfinalized block from storage.

		// Clients can send as many heads as they want. This finalization design is really optimized for a single
		// writer. Multiple clients would contend on finalizing the next block the chain.

		const [unfinalizedBlocks, finalizedBlock] = await Promise.all([
			metadata.blocks.get({ chain }), //
			getBlock({ chain, number: "finalized" }),
		]);

		const [nextUnfinalizedBlock] = unfinalizedBlocks;

		// If we are yet to process this chain then we have no canonical chain to verify and process and can return

		if (nextUnfinalizedBlock === undefined) {
			return log.debug(`No unfinalised blocks processed for chain ${hexToNumber(chain)}, ignoring...`);
		}

		if (finalizedBlock === null) {
			log.error("Failed to load finalized block from the provided `getBlock` function");
			throw new Error("Failed to load finalized block from the provided `getBlock` function");
		}

		// We want to retain only the heads greater than or equal to the first unfinalized head and less than
		// or equal to the finalized head. We can safely process these blocks.

		const nextUnfinalizedHeight = hexToNumber(nextUnfinalizedBlock.eth_getBlockByNumber.number);
		const canonicalFinalizedHeight = hexToNumber(finalizedBlock.eth_getBlockByNumber.number);

		assert(canonicalFinalizedHeight >= nextUnfinalizedHeight, "We should always trail the canonical chain");

		const finalizedHeads = heads.filter((head) => {
			return hexToNumber(head.number) >= nextUnfinalizedHeight && hexToNumber(head.number) <= canonicalFinalizedHeight;
		});

		// Our correctness check means enforcing that we received at least the first unfinalized block and that all
		// heads processed are less than or equal to the latest finalized block. It is also important to verify that
		// the heads themselves form a contiguous chain because we never want to skip a block number.

		const [firstFinalizedHead, ...remainingFinalizedHeads] = finalizedHeads;

		if (firstFinalizedHead === undefined) {
			throw new Error("Expected invalid heads");
		}

		if (hexToNumber(firstFinalizedHead.number) !== nextUnfinalizedHeight) {
			throw new Error("Received invalid heads");
		}

		let previousHead = firstFinalizedHead;

		for (const head of remainingFinalizedHeads) {
			if (hexToNumber(head.number) !== hexToNumber(previousHead.number) + 1) {
				throw new Error("Received invalid heads");
			}

			if (!isHexEqual(head.parentHash, previousHead.hash)) {
				throw new Error("Received invalid heads");
			}

			previousHead = head;
		}

		// After verifying the canonical finalized chain, we essentially have to determine the difference between the
		// remote and what we've processed locally. In general this function doesn't need to be fast. Clients always
		// send the tip, so if we ever recover from downtime we will start processing new blocks immediately. As these
		// are sucessfuly processed it doesn't increase the amount of blocks that this function needs to validate for
		// correctness, it actually has no impact. So that means when we play "catch-up" it's over a finite set of
		// blocks so there are no speed issues. This means simply iterating one by one and processing correctly is a
		// fine strategy

		for (const finalizedHead of finalizedHeads) {
			let processedBlocks = undefined;

			// An optimisation is that we will have already loaded the first few blocks when loading the first unfinalized
			// block. This is because our storage layer has no concept of pagination. So we look for blocks in that
			// response before attempting to load them again from storage

			processedBlocks = unfinalizedBlocks.filter((block) => {
				return isHexEqual(finalizedHead.number, block.eth_getBlockByNumber.number);
			});

			// If we have run out of the initially loaded pending blocks we resort to loading by the head specifically

			if (processedBlocks.length === 0) {
				processedBlocks = await metadata.blocks.get({ chain: finalizedHead.chain, number: finalizedHead.number });
			}

			// When a block finalizes we fully re process it. This means that we delete any reorganised blocks and we
			// upsert the final canonical block again. In general this is pretty slow and expensive. In practice this is
			// okay because this function doesn't need to be fast, and the goal of the system is that we use the two methods
			// in public_writeUnfinalizedHeads and public_deleteReorganisedHead to ensure that the latest chain matches exactly
			// what the finalized chain processes. So it's likely that this correctness function has no material impact on
			// the data stored and is just verifies correctness when the chain finalizes

			await reprocessFinalizedHead(finalizedHead, processedBlocks);

			// Once this canonical block is successfully processed all stored blocks can be safely discarded

			await metadata.blocks.delete(processedBlocks);
		}
	};

	async function reprocessFinalizedHead(canonical: Head, processed: TBlock[]) {
		if (processed.length === 0) {
			return await writeFinalizedHead(canonical, null);
		}

		const reorganised = processed.filter((block) => {
			return !isHexEqual(canonical.hash, block.eth_getBlockByNumber.hash);
		});

		if (reorganised.length > 0) {
			await deleteReorganisedBlocks(reorganised);
		}

		const block = processed.find((block) => {
			return isHexEqual(canonical.hash, block.eth_getBlockByNumber.hash);
		});

		if (block === undefined) {
			return await writeFinalizedHead(canonical, null);
		}

		return await writeFinalizedHead(canonical, block);
	}

	async function writeFinalizedHead(head: Head, block_nullable: TBlock | null) {
		let block = block_nullable;

		if (block === null) {
			block = await getBlock({ chain: head.chain, number: head.number, hash: head.hash });
		}

		if (block === null) {
			throw new Error("Received non-canonical head from malicious client");
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

	async function deleteReorganisedBlocks(blocks: TBlock[]) {
		if (blocks.length === 0) {
			return;
		}

		// We know the block is not included in the canonical chain and we know that our storage system upserted
		// events with this block data. We use the block data to generate the same set of events that we upserted
		// and provide them to each events delete function

		const promises = all_events.map(async (event) => {
			// If they update the indexer to remove the delete method it's possible that reorged events remain in storage

			if (event.storage.delete === undefined) {
				return;
			}

			// We intentionally ignore filters and basically perform an optimistic delete on events that might
			// have never been upserted. I make this choice because there is a time delay between upsert and delete,
			// it's possible for a new deployment to update the filters in this gap that would prevent the delete
			// from removing the upserted events if the filters were changed in just the right way

			const batch: any[] = [];

			try {
				for (const block of blocks) {
					const events = event.handler(block);

					for (const event of events) {
						batch.push(event);
					}
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
							block_hash: block.eth_getBlockByNumber.hash,
							block_number: block.eth_getBlockByNumber.number,
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
							block_hash: block.eth_getBlockByNumber.hash,
							block_number: block.eth_getBlockByNumber.number,
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

	const private_writeEventsAndGetKeys: IndexerRpc["request"]["private_writeEventsAndGetKeys"] = async (params) => {
		if (all_events.length === 0) return { results: [], keys: [] };
		if (params.events.length === 0) return { results: [], keys: [] };

		const relevant_events = all_events.filter((event) => params.events.includes(event.id));
		if (relevant_events.length === 0) return { results: [], keys: [] };

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

		const proxy = new Proxy(params.block, createProxyHandler("")) as Block;

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
						block_hash: proxy.eth_getBlockByNumber.hash,
						block_number: proxy.eth_getBlockByNumber.number,
						created_at: Date.now(),
					};

					return;
				}

				if (events.length === 0) {
					results[event.id + proxy.eth_getBlockByNumber.number] = {
						status: "ok",
						event_id: event.id,
						chain: proxy.eth_chainId,
						block_hash: proxy.eth_getBlockByNumber.hash,
						block_number: proxy.eth_getBlockByNumber.number,
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
						block_hash: proxy.eth_getBlockByNumber.hash,
						block_number: proxy.eth_getBlockByNumber.number,
						created_at: Date.now(),
					};

					return;
				}

				results[event.id + proxy.eth_getBlockByNumber.number] = {
					status: "ok",
					event_id: event.id,
					chain: proxy.eth_chainId,
					block_hash: proxy.eth_getBlockByNumber.hash,
					block_number: proxy.eth_getBlockByNumber.number,
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

	const rpc: IndexerRpc["request"] = {
		public_getFinalizedHeight,
		public_writeFinalizedHeads,
		public_writeUnfinalizedHeads,
		public_deleteReorganisedHead,

		private_getEvents,
		private_getMetadata,
		private_writeEvents,
		private_writeEventsAndGetKeys,
	};

	// Indexer implementation

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

	const handler: Indexer<TBlock>["fetch"] = async (req) => {
		// Parse request body
		let body_buffer: ArrayBuffer;

		try {
			body_buffer = await req.arrayBuffer();
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid request body" } }, //
				{ status: 400 },
			);
		}

		// Determine authentication status
		const authorization = req.headers.get("Authorization");
		const authenticated = authorization === `Bearer ${opts.signingKey}`;

		// Decode request body
		let body_string: string;

		if (req.headers.get("Content-Encoding") === "gzip") {
			// Compressed requests should be authenticated before decompression. This prevents unauthenticated clients
			// from sending ZIP bombs that force the server to spend CPU and memory before rejecting the request.

			if (!authorization) {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: 0, message: "No bearer token provided" } }, //
					{ status: 400 },
				);
			}

			if (!authenticated) {
				return Response.json(
					{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Invalid bearer token" } }, //
					{ status: 400 },
				);
			}

			body_string = await decompress(body_buffer);
		} else {
			body_string = decoder.decode(body_buffer);
		}

		// Parse request as JSON
		let json: any;

		try {
			json = JSON.parse(body_string);
		} catch {
			return Response.json(
				{ jsonrpc: "2.0", id: null, error: { code: 0, message: "Malformed JSON request body" } }, //
				{ status: 400 },
			);
		}

		// Authorize request for any private methods
		if (json.method.startsWith("private_")) {
			if (!authorization) {
				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "No bearer token provided" } }, //
					{ status: 400 },
				);
			}

			if (authorization !== `Bearer ${opts.signingKey}`) {
				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "Invalid bearer token" } }, //
					{ status: 400 },
				);
			}
		}

		// Perform RPC
		try {
			if (rpc[json.method as keyof IndexerRpc["request"]] === undefined) throw new Error(UnknownMethodError);

			// @ts-expect-error types too complicated
			const result = await rpc[json.method](...json.params);

			return Response.json({ jsonrpc: "2.0", id: json.id, result });
		} catch (error) {
			const message = getException(error);

			if (message) {
				return Response.json(
					{ jsonrpc: "2.0", id: json.id, error: { code: 0, message } }, //
					{ status: 400 },
				);
			}

			// Unknown exception
			if (error instanceof Error) {
				log.error(error.message);
			}

			return Response.json(
				{ jsonrpc: "2.0", id: json.id, error: { code: 0, message: "Internal server error" } }, //
				{ status: 500 },
			);
		}
	};

	return { fetch: handler, event };
}

const UnknownMethodError = createException("The requested method does not exist");
const IncompleteBlockError = createException("Received block with missing required property");

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { indexer, matchFilter };
export type { Indexer, Event, Filter, Block, Head, Metadata, Result };
