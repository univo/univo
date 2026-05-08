import type { Flatten } from "./utils";
import { version } from "../package.json";
import { catchException, createException, getException } from "./exceptions";
import { retry, nonNullable, getSignature, createLogger, hexToNumber, isHexEqual, decompress, decoder } from "./utils";

// Block ------------------------------------------------------------------------------------------------------------------------------------
// This is the minimum set of block fields univo needs to function. These are mostly required to allow to perform
// filter matching on a given block. We need to have _some_ agreed contract to able to understand the chain,
// the block, and log address and events.

type Block = {
	eth_chainId: `0x${string}`;

	eth_getBlockByHash: {
		hash: `0x${string}`;
		number: `0x${string}`;
	};

	eth_getBlockReceipts: Array<{
		logs: Array<{
			address: `0x${string}`;
			topics: `0x${string}`[];
		}>;
	}>;
};

// Filters ------------------------------------------------------------------------------------------------------------------------------------

type Filter = {
	/** The chain id */
	chain: number;
	/** Block to querying/listening from */
	fromBlock: number;
	/** Block to query/listen until  */
	toBlock?: number;
	/** The event */
	event?: `0x${string}`;
	/** The contract address from which logs should originate */
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
	if (hexToNumber(block.eth_getBlockByHash.number) >= filter.fromBlock) return true;
	return false;
};

const toBlockValid: MatchFilter = (block, filter) => {
	if (filter.toBlock === undefined) return true;
	if (hexToNumber(block.eth_getBlockByHash.number) <= filter.toBlock) return true;
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

// Events --------------------------------------------------------------------------------------------------------------------------------------

type Event<TBlock, TEvent> = {
	/** Human-readable identifier for the event */
	id: string;
	/** The set of filters that determines if the handler should execute for a given block */
	filters: Filter[];
	/** The handler that transforms a block into a list of events */
	handler: (block: TBlock) => TEvent[];
	/** Persist storage */
	storage: {
		upsert: (events: TEvent[]) => Promise<void>;
		delete?: (events: TEvent[]) => Promise<void>;
	};
};

// Indexer ------------------------------------------------------------------------------------------------------------------------------------

type Head = {
	hash: `0x${string}`;
	number: `0x${string}`;
	chain: `0x${string}`;
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
	 * Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs.
	 * Available log options are `DEBUG`, `INFO`, `WARN`, and `ERROR`.
	 */
	quiet?: boolean;
	/**
	 * Request signing key
	 */
	signingKey: string;
	/**
	 * This function is to load each block when indexing blocks in realtime. This ensures that all block
	 * data processed originates from a trusted RPC source and can be safely relied on.
	 */
	getBlock: (block: { chain: `0x${string}`; hash: `0x${string}` }) => Promise<TBlock>;
};

type Indexer<TBlock> = {
	fetch: (req: Request) => Promise<Response>;
	event: <TEvent>(event: Event<TBlock, TEvent>) => Event<TBlock, TEvent>;
};

type Rpc = {
	public_deleteBlock(endpoint: string, block: string): Promise<void>;

	public_writeAndReturnBlocks(endpoint: string, heads: Head[]): Promise<{ blocks: (string | null)[] }>;

	private_getMetadata(): Promise<Metadata>;

	private_getEvents(): Promise<{ id: string; filters: Flatten<Filter>[] }[]>;

	// This is our primary function for performing historical backfills. It takes in a list of of blocks and events
	// to index. It returns a list of failure results corresponding to which events and for which blocks any errors occurred whilst indexing.
	private_writeEvents(params: { events: string[]; blocks: Block[] }): Promise<{ failures: Result[] }>;

	// Takes a full raw block directly from the chain and returns a list of keys that were accessed when indexing that block.
	private_writeEventsAndGetKeys(params: { events: string[]; block: Block }): Promise<{ results: Result[]; keys: string[] }>;
};

function indexer<TBlock extends Block>(opts: IndexerOptions<TBlock>) {
	const log = createLogger({ quiet: opts.quiet || false });

	// We batch events based on the provided storage function. This is an optimisation that allows distinct
	// events that share the same storage adapter to be combined into the same batch for upsert.

	const all_events: Event<any, any>[] = [];
	const events_grouped_by_storage_map = new Map<Event<any, any>["storage"], Event<any, any>[]>();

	// Rpc implementation

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

	const createResultsForEndpoint = async (endpoint: string, results: Result[]) => {
		const body = JSON.stringify({ endpoint, results });
		const signature = await getSignature({ body, key: opts.signingKey });

		const res = await fetch("https://api.univo.app/v1/results", {
			body,
			method: "POST",
			headers: {
				"X-Univo-Signature": signature,
				"Content-Type": "application/json",
			},
		});

		if (res.status !== 200) throw new Error("Received non-200 response from univo API");
	};

	const public_writeAndReturnBlocks: Rpc["public_writeAndReturnBlocks"] = async (endpoint, heads) => {
		log.debug(`Received ${heads.length} heads...`);

		const blocks_start = Date.now();
		const results_map: Record<string, Result> = {};

		// Load block
		const blocks_nullable = await Promise.all(
			heads.map(async (head) => {
				try {
					return await retry(opts.getBlock, [head], 2).catch(() => {
						throw new Error("Failed to load block from the provided `getBlock` function after 3 attempts");
					});
				} catch (error) {
					if (error instanceof Error) {
						log.error(error.message);
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
				}
			}),
		);

		const blocks = blocks_nullable.filter(nonNullable);

		log.debug(`Loaded ${blocks.length} block(s) in ${Date.now() - blocks_start}ms`);

		if (blocks.length > 0) {
			const events_start = Date.now();

			const promises = events_grouped_by_storage_map.entries().map(async ([storage, grouped_events]) => {
				const batch = [];

				for (const block of blocks) {
					for (const event of grouped_events) {
						try {
							// Ignore blocks that don't match any of the defined event filters
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
							const block_hash = block.eth_getBlockByHash.hash;
							const block_number = block.eth_getBlockByHash.number;

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

					await retry(storage.upsert, [batch], 2).catch((error) => {
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
								const block_hash = block.eth_getBlockByHash.hash;
								const block_number = block.eth_getBlockByHash.number;

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
						const block_hash = block.eth_getBlockByHash.hash;
						const block_number = block.eth_getBlockByHash.number;

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

		if (results_array.length === 0) {
			return log.debug(`No results to record for ${heads.length} heads`);
		}

		// Otherwise we submit results to the univo endpoint

		try {
			await retry(createResultsForEndpoint, [endpoint, results_array], 2);
			log.debug(`Recorded ${results_array.length} results`);
		} catch (error) {
			log.error("Failed to submit realtime results to univo after 3 attempts");
		}

		const blocks_returned = blocks_nullable.map((block) => block);
	};

	const public_deleteBlock: Rpc["public_deleteBlock"] = async (endpoint, block) => {
		//
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

						failures[event.id + block.eth_getBlockByHash.number] ??= {
							status,
							event_id: event.id,
							chain: block.eth_chainId,
							block_hash: block.eth_getBlockByHash.hash,
							block_number: block.eth_getBlockByHash.number,
							created_at: Date.now(),
						};
					}
				}
			}

			if (batch.length === 0) return;

			const start = Date.now();

			try {
				await retry(storage.upsert, [batch], 2);
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

						failures[event.id + block.eth_getBlockByHash.number] ??= {
							status,
							event_id: event.id,
							chain: block.eth_chainId,
							block_hash: block.eth_getBlockByHash.hash,
							block_number: block.eth_getBlockByHash.number,
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

					results[event.id + proxy.eth_getBlockByHash.number] = {
						status: "handler_error",
						event_id: event.id,
						chain: proxy.eth_chainId,
						block_hash: proxy.eth_getBlockByHash.hash,
						block_number: proxy.eth_getBlockByHash.number,
						created_at: Date.now(),
					};

					return;
				}

				if (events.length === 0) {
					results[event.id + proxy.eth_getBlockByHash.number] = {
						status: "ok",
						event_id: event.id,
						chain: proxy.eth_chainId,
						block_hash: proxy.eth_getBlockByHash.hash,
						block_number: proxy.eth_getBlockByHash.number,
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

					results[event.id + proxy.eth_getBlockByHash.number] = {
						status: "upsert_error",
						event_id: event.id,
						chain: proxy.eth_chainId,
						block_hash: proxy.eth_getBlockByHash.hash,
						block_number: proxy.eth_getBlockByHash.number,
						created_at: Date.now(),
					};

					return;
				}

				results[event.id + proxy.eth_getBlockByHash.number] = {
					status: "ok",
					event_id: event.id,
					chain: proxy.eth_chainId,
					block_hash: proxy.eth_getBlockByHash.hash,
					block_number: proxy.eth_getBlockByHash.number,
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
			// `eth_getBlockHash` and `eth_getBlockByHash.number`, the first key is made redundant by the second key
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

const UnknownMethodError = createException("The requested method does not exist");
const IncompleteBlockError = createException("Received block with missing required property");

// Exports ------------------------------------------------------------------------------------------------------------------------------------

export { indexer, matchFilter };
export type { Rpc, Indexer, Event };
