import type { Storage } from "unstorage";

import * as utils from "./utils";
import type { Flatten } from "./utils";
import { version } from "../package.json";
import { catchException, createException, getException } from "./exceptions";

// Block ------------------------------------------------------------------------------------------------------------------------------------
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

// Filters ------------------------------------------------------------------------------------------------------------------------------------

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
	if (utils.hexToNumber(block.eth_chainId) === filter.chain) return true;
	return false;
};

const fromBlockValid: MatchFilter = (block, filter) => {
	if (utils.hexToNumber(block.eth_getBlockByNumber.number) >= filter.fromBlock) return true;
	return false;
};

const toBlockValid: MatchFilter = (block, filter) => {
	if (filter.toBlock === undefined) return true;
	if (utils.hexToNumber(block.eth_getBlockByNumber.number) <= filter.toBlock) return true;
	return false;
};

const includesLogAddress: MatchFilter = (block, filter) => {
	if (filter.address === undefined) return true;

	for (const receipt of block.eth_getBlockReceipts) {
		for (const log of receipt.logs) {
			if (utils.isHexEqual(log.address, filter.address)) return true;
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

// Events --------------------------------------------------------------------------------------------------------------------------------------

type Event<TBlock, TEvent> = {
	/**
	 * A human-readable identifier for the event.
	 */
	id: string;

	/**
	 * Filters let you define what the specific blocks you want this event to index.
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

// Indexer ------------------------------------------------------------------------------------------------------------------------------------

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
	 * ensures that you indexer recovers from downtime, ensures that all blocks are processed correctly during
	 * chain reorganisations, and records any errors when unable to upsert or delete events in realtime.
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

type Rpc = {
	/**
	 * Accepts a reorganised block and deletes all events generated by it from storage
	 */
	public_deleteBlock(endpoint: string, block: string): Promise<void>;

	/**
	 * Accepts the latest block head and writes all events to storage
	 * @returns A list of signed, compressed, and encrypted blocks that were loaded
	 */
	public_writeAndReturnBlocks(endpoint: string, heads: Head[]): Promise<{ blocks: (string | null)[] }>;

	/**
	 * @returns Specified metadata about the indexer
	 */
	private_getMetadata(): Promise<Metadata>;

	/**
	 * @returns All events defined on this indexer
	 */
	private_getEvents(): Promise<{ id: string; filters: Flatten<Filter>[] }[]>;

	/**
	 * Accepts a list of events and a batch of minified block data and writes to storage
	 * @returns A list of failures that occured for each event and block pair
	 */
	private_writeEvents(params: { events: string[]; blocks: Block[] }): Promise<{ failures: Result[] }>;

	/**
	 * Accepts a raw block directly from the chain and writes events to storage
	 * @returns A list of the block keys that were accessed as events are written to storage
	 */
	private_writeEventsAndGetKeys(params: { events: string[]; block: Block }): Promise<{ results: Result[]; keys: string[] }>;
};

function indexer<TBlock extends Block>(opts: IndexerOptions<TBlock>) {
	const log = utils.createLogger({ quiet: opts.quiet ?? false });

	// We batch events based on the provided storage function. This is an optimisation that allows distinct
	// events that share the same storage adapter to be combined into the same batch for upsert.

	const all_events: Event<any, any>[] = [];
	const events_grouped_by_storage_map = new Map<Event<any, any>["storage"], Event<any, any>[]>();

	const results = {
		async submit(endpoint: string, results: Result[]) {
			const body = JSON.stringify({ endpoint, results });
			const signature = await utils.getSignature({ body, key: opts.signingKey });

			const res = await fetch("https://api.univo.app/v1/results", {
				body,
				method: "POST",
				headers: {
					"X-Univo-Signature": signature,
					"Content-Type": "application/json",
				},
			});

			if (res.status !== 200) {
				throw new Error("Received non-200 response from univo API");
			}

			log.debug(`Recorded ${results.length} result(s)`);
		},
	};

	// Metadata storage interface. Functionally this is responsible for storing all state related to ensuring
	// the correct processing of the indexer.

	type ProcessedBlock = {
		status: "staged" | "committed";
		data: TBlock;
		created_at: number;
	};

	const metadata = {
		results: {
			async get() {
				//
			},
			async upsert() {
				//
			},
		},
		blocks: {
			async list(head: { chain: `0x${string}` }) {
				const keys = await opts.metadataStorage.getKeys(`blocks/v1/${head.chain}`);
				const results = await opts.metadataStorage.getItems<ProcessedBlock>(keys);
				return results.map((result) => result.value);
			},
			async get(head: { chain: `0x${string}`; number: `0x${string}` }) {
				const keys = await opts.metadataStorage.getKeys(`block/v1/${head.chain}/${head.number}`);
				const results = await opts.metadataStorage.getItems<ProcessedBlock>(keys);
				return results.map((result) => result.value);
			},
			async upsert(blocks: ProcessedBlock[]) {
				//
			},
			async delete(blocks: ProcessedBlock[]) {
				//
			},
		},
	};

	// Fetches a block using the provided `getBlock` function. Handles retries. The block hash is optional
	// because we sometimes want the canonical block using only the block number. If a hash is provided we
	// will assert that the block returned via the block number lookup is the expected block

	async function getBlock(head: { chain: `0x${string}`; number: string; hash?: `0x${string}` }) {
		return await utils.retry(retry_getBlock, [head], 2).catch(() => {
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
			if (!utils.isHexEqual(head.hash, block.eth_getBlockByNumber.hash)) {
				throw new Error("Method `eth_getBlockByNumber` returned unexpected block hash");
			}

			for (const receipt of block.eth_getBlockReceipts) {
				if (!utils.isHexEqual(head.hash, receipt.blockHash)) {
					throw new Error("Method `eth_getBlockReceipts` returned receipt with unexpected block hash");
				}
			}
		}

		return block;
	}

	async function signCompressAndEncryptBlock(block: TBlock) {
		const json = JSON.stringify(block);
		const compressed = await utils.compress(json);
		const encrypted = await utils.encrypt({ body: compressed, key: opts.signingKey });
		const signature = await utils.getSignature({ body: encrypted, key: opts.signingKey });
		return `${signature}.${encrypted}`;
	}

	async function verifyDecryptAndDecompressBlock(block: string) {
		try {
			const [signature, iv, body] = block.split(".");

			if (signature === undefined || iv === undefined || body === undefined) {
				throw new Error();
			}

			const valid = await utils.verifySignature({ body: `${iv}.${body}`, key: opts.signingKey, signature });

			if (!valid) {
				throw new Error();
			}

			const compressed = await utils.decrypt({ body, iv, key: opts.signingKey });
			const json = await utils.decompress(compressed);
			return JSON.parse(json) as Block;
		} catch {
			throw new Error(InvalidBlockError);
		}
	}

	// We accept an array so we can perform group commit on fast chains, i.e. the client buffers new blocks received
	// via subscription while a request to the server is in-flight

	const public_writeBlocks = async (heads: Head[]) => {
		if (heads.length === 0) {
			return;
		}

		// Verify that all heads received are from the same chain

		let chain = undefined;

		for (const head of heads) {
			if (chain === undefined) {
				chain = head.chain;
			}

			if (!utils.isHexEqual(chain, head.chain)) {
				throw new Error("All heads received should originate from the same chain");
			}
		}

		// We only stop processing the tip if the metadata layer goes down, if the event storage layer goes down we will just
		// record errors for the specific storages that failed
		//
		// Naively and quickly processes the tip of the chain. Correctness is enforced in the subsequent handler when the chain finalizes
		// Successfully processing the tip means that we either successfuly process the block, or durably record any errors
		//
		// If successful we can delete any errors associated with this block
	};

	const public_deleteBlock = async (head: Head) => {
		// Peforms a deletion of those events.
		// If it fails it tries to record an error and throws.
		// If successful it deletes any reorg errors
	};

	const public_deleteBlocks = async (heads: Head[]) => {
		if (heads.length === 0) {
			return;
		}

		// Verify that all heads received are from the same chain

		let chain = undefined;

		for (const head of heads) {
			if (chain === undefined) {
				chain = head.chain;
			}

			if (!utils.isHexEqual(chain, head.chain)) {
				throw new Error("All heads received should originate from the same chain");
			}
		}

		// We load the finalized block from the chain and the first unfinalized block from storage. To verify that
		// we have received the correct finalized chain we walk backwards from the finalized block and verify the
		// chains integrity all the way to the first unfinalized block.

		// So clients must send all [unfinalized, finalized] heads (inclusive). For this to work we need only one
		// honest client to send the full valid chain which is a reasonable assumption. Heads are pretty small and
		// with compression it's safe to say we can send 10s of thousands of heads. This means we can easily repair
		// from months of downtime

		const [pending, finalized] = await Promise.all([
			metadata.blocks.list({ chain: "0x1" }),
			getBlock({ chain: "0x1", number: "finalized" }),
		]);

		// If we are yet to process this chain then we have no canonical chain to verify and process and can return

		if (pending.length === 0) {
			return;
		}

		// TODO: Filter out heads larger than the finalized head

		// if (filtered.length === 0) {
		// 	return;
		// }

		// TODO: Verifying the canonical chain backwards

		// After verifying the canonical finalized chain, we essentially have to determine the difference between the
		// remote and what we've processed locally. In general this function doesn't need to be fast. Clients always
		// send the tip, so if we ever recover from downtime we will start processing new blocks immediately. As these
		// are sucessfuly processed it doesn't increase the amount of blocks that this function needs to validate for
		// correctness, it actually has no impact. So that means when we play "catch-up" it's over a finite set of
		// blocks so there are no speed issues. This means simply iterating one by one and processing correctly is a
		// fine strategy

		for (const canonical of heads) {
			// Our goal here is determine if this block number was processed correctly.

			let processed = undefined;

			// An optimisation is that we will have already loaded the first few blocks when loading the first unfinalized
			// block. This is because our storage layer has no concept of pagination. So we look for blocks in that
			// response before attempting to load them again from storage

			processed = pending.filter((block) => {
				return utils.isHexEqual(canonical.number, block.data.eth_getBlockByNumber.number);
			});

			// If we have run out of the initially loaded pending blocks we resort to loading by the head specifically

			if (processed.length === 0) {
				processed = await metadata.blocks.get({ chain: canonical.chain, number: canonical.number });
			}

			await verifyBlockProcessedCorrectly(canonical, processed);

			// Once this canonical block is successfully processed all stored blocks can be safely discarded

			await metadata.blocks.delete(processed);
		}
	};

	async function verifyBlockProcessedCorrectly(canonical: Head, processed: ProcessedBlock[]) {
		// Verify that all blocks received are from the same block number

		let number = undefined;

		for (const block of processed) {
			if (number === undefined) {
				number = block.data.eth_getBlockByNumber.number;
			}

			if (!utils.isHexEqual(number, block.data.eth_getBlockByNumber.number)) {
				throw new Error("Expected all processed blocks to have the same number");
			}
		}

		// If no block was processed we manually process it

		if (processed.length === 0) {
			return await public_writeBlocks([canonical]);
		}

		// Correct processing means the canonical block was processed last and any reorganisaed blocks
		// have their events successfully discarded.

		await Promise.all(
			processed.map(async (block) => {
				if (utils.isHexEqual(canonical.hash, block.data.eth_getBlockByNumber.hash)) {
					// The canonical block must be both committed and have a greater timestamp than all other
					// processed blocks (staged and comitted). In all other cases the canonical block must be
					// processed again

					if (block.status === "staged") {
						return await public_writeBlocks([canonical]);
					}

					return;
				}

				// Otherwise we have a reorganised block that successfully delete all events for

				return await public_deleteBlock({
					chain: block.data.eth_chainId,
					hash: block.data.eth_getBlockByNumber.hash,
					number: block.data.eth_getBlockByNumber.number,
					parentHash: block.data.eth_getBlockByNumber.parentHash,
				});
			}),
		);
	}

	const public_writeAndReturnBlocks: Rpc["public_writeAndReturnBlocks"] = async (endpoint, heads) => {
		log.debug(`Received ${heads.length} heads...`);

		const blocks_start = Date.now();
		const results_map: Record<string, Result> = {};

		const blocks_nullable = await Promise.all(
			heads.map(async (head) => {
				const block_nullable = await getBlock(head);

				// A null response is actually a common case during chain reorganisations. Because we load by block number it
				// is common the the client and server to be connected to different nodes. There is no guarantee that both
				// those nodes see the same reorganisation so when we load the block on the server we get null. Because it's
				// not possible for us to determine when this is the case versus the `getBlock` function just error we always
				// report a block error result

				if (block_nullable !== null) {
					return block_nullable;
				}

				for (const event of all_events) {
					const event_id = event.id;
					const chain = head.chain;
					const block_hash = head.hash;
					const block_number = head.number;

					results_map[chain + block_number + block_hash + event_id] ??= {
						status: "block_error",
						event_id,
						chain,
						block_hash,
						block_number,
						created_at: Date.now(),
					};
				}

				return null;
			}),
		);

		const blocks = blocks_nullable.filter(utils.nonNullable);

		log.debug(`Loaded ${blocks.length} block(s) in ${Date.now() - blocks_start}ms`);

		if (blocks.length > 0) {
			const events_start = Date.now();

			const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
				const batch = [];

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
							if (error instanceof Error) {
								log.error(error.message);
							}

							const event_id = event.id;
							const chain = block.eth_chainId;
							const block_hash = block.eth_getBlockByNumber.hash;
							const block_number = block.eth_getBlockByNumber.number;

							results_map[chain + block_number + block_hash + event_id] ??= {
								status: "handler_error",
								event_id,
								chain,
								block_hash,
								block_number,
								created_at: Date.now(),
							};
						}
					}
				}

				if (batch.length > 0) {
					const start = Date.now();

					await utils.retry(storage.upsert, [batch], 2).catch((error) => {
						if (error instanceof Error) {
							log.error(error.message);
						}

						for (const block of blocks) {
							for (const event of grouped_events) {
								// Ignore blocks that don't match any of the defined event filters
								if (!event.filters.some((filter) => matchFilter(block, filter))) {
									continue;
								}

								const event_id = event.id;
								const chain = block.eth_chainId;
								const block_hash = block.eth_getBlockByNumber.hash;
								const block_number = block.eth_getBlockByNumber.number;

								results_map[chain + block_number + block_hash + event_id] ??= {
									status: "upsert_error",
									event_id,
									chain,
									block_hash,
									block_number,
									created_at: Date.now(),
								};
							}
						}
					});

					for (const event of grouped_events) {
						log.debug(`Recorded ${batch.length} ${event.id} in ${Date.now() - start}ms`);
					}
				}

				for (const block of blocks) {
					for (const event of grouped_events) {
						// Ignore blocks that don't match any of the defined event filters
						if (!event.filters.some((filter) => matchFilter(block, filter))) continue;

						const event_id = event.id;
						const chain = block.eth_chainId;
						const block_hash = block.eth_getBlockByNumber.hash;
						const block_number = block.eth_getBlockByNumber.number;

						results_map[chain + block_number + block_hash + event_id] ??= {
							status: "ok",
							event_id,
							chain,
							block_hash,
							block_number,
							created_at: Date.now(),
						};
					}
				}
			});

			await Promise.all(promises);

			log.debug(`Wrote ${heads.length} heads in ${Date.now() - events_start}ms`);
		}

		const results_array = Object.values(results_map);

		// It's possible that we have no results to record if we successfully loaded all heads
		// and determined that none of those blocks matched the defined event filters.

		if (results_array.length > 0) {
			await utils.retry(results.submit, [endpoint, results_array], 2).catch(() => {
				log.error("Failed to submit realtime results");
			});
		}

		// Returning block data is a fundamental step in handling chain reorganisations. We can't know the exact
		// chain until finalization, and by the time finalization occurs the initial block data used we indexed
		// won't be available. Returning it here allows clients to store it, and allows us to process it later
		// once we are confident a block was reorganised. Compressing, encrypting, and signing the payload is
		// what allows this server to trust the data wasn't tampered with and is exactly the initial data we used

		const blocks_returned = await Promise.all(
			blocks_nullable.map(async (block) => {
				return block === null ? null : signCompressAndEncryptBlock(block);
			}),
		);

		return { blocks: blocks_returned };
	};

	const public_deleteBlock: Rpc["public_deleteBlock"] = async (endpoint, block) => {
		const decrypted = await verifyDecryptAndDecompressBlock(block);

		log.debug(`Received reorganised block ${utils.hexToNumber(decrypted.eth_getBlockByNumber.number)}`);

		// Loading blocks happens via the block number. If this block was truly reorganised and is no longer part of
		// the canonical chain than this request should yield a block with a different block hash. This is our proof
		// that this block is no longer included in the chain and that it's safe to delete data associated with it

		const canonical = await getBlock({ chain: decrypted.eth_chainId, number: decrypted.eth_getBlockByNumber.number });

		if (canonical === null) {
			return log.debug("Attempted to delete unknown block, ignoring...");
		}

		if (utils.isHexEqual(canonical.eth_getBlockByNumber.hash, decrypted.eth_getBlockByNumber.hash)) {
			return log.debug("Attempted to delete canonical block, ignoring...");
		}

		// We know the block is not included in the canonical chain and we know that our storage system upserted
		// events with this block data. We use the block data to generate the same set of events that we upserted
		// and provide them to each events delete function

		const results_map: Record<string, Result> = {};

		const promises = all_events.map(async (event) => {
			try {
				if (event.storage.delete === undefined) {
					return;
				}

				if (!event.filters.some((filter) => matchFilter(decrypted, filter))) {
					return;
				}

				const events = event.handler(decrypted);

				if (events.length === 0) {
					return;
				}

				await utils.retry(event.storage.delete, [events], 2);
			} catch (error) {
				if (error instanceof Error) {
					log.error(error.message);
				}

				const event_id = event.id;
				const chain = decrypted.eth_chainId;
				const block_hash = decrypted.eth_getBlockByNumber.hash;
				const block_number = decrypted.eth_getBlockByNumber.number;

				results_map[chain + block_number + block_hash + event_id] ??= {
					status: "delete_error",
					chain,
					event_id,
					block_hash,
					block_number,
					created_at: Date.now(),
				};
			}
		});

		await Promise.all(promises);

		// We optimistically send delete results for all events where an error wasn't already recorded.
		// This is overkill for correctness in the sense we don't need to do this for events that don't
		// expose a delete interface, or events where the block doesn't match one of the provided filters.
		// However it makes it much simpler to detect errors, i.e. failing to delete events created from a
		// reorganised block, simply from the absence of a successful delete result for a each event

		for (const event of all_events) {
			const event_id = event.id;
			const chain = decrypted.eth_chainId;
			const block_hash = decrypted.eth_getBlockByNumber.hash;
			const block_number = decrypted.eth_getBlockByNumber.number;

			results_map[chain + block_number + block_hash + event_id] ??= {
				status: "delete",
				chain,
				event_id,
				block_hash,
				block_number,
				created_at: Date.now(),
			};
		}

		const results_array = Object.values(results_map);

		await utils.retry(results.submit, [endpoint, results_array], 2).catch(() => {
			log.error("Failed to submit delete results");
		});
	};

	const private_getMetadata: Rpc["private_getMetadata"] = async () => {
		return {
			version,
			language: "javascript",
		};
	};

	const private_getEvents: Rpc["private_getEvents"] = async () => {
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

	const private_writeEvents: Rpc["private_writeEvents"] = async (params) => {
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
			const batch = [];

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
				await utils.retry(storage.upsert, [batch], 2);
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

	const private_writeEventsAndGetKeys: Rpc["private_writeEventsAndGetKeys"] = async (params) => {
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

	const rpc: Rpc = {
		public_deleteBlock,
		public_writeAndReturnBlocks,

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

			body_string = await utils.decompress(body_buffer);
		} else {
			body_string = utils.decoder.decode(body_buffer);
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
			if (rpc[json.method as keyof Rpc] === undefined) throw new Error(UnknownMethodError);

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

const InvalidBlockError = createException("Received invalid block");
const UnknownMethodError = createException("The requested method does not exist");
const IncompleteBlockError = createException("Received block with missing required property");

// Exports ------------------------------------------------------------------------------------------------------------------------------------

export { indexer, matchFilter };
export type { Rpc, Indexer, Event };
