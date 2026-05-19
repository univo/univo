import WS from "ws"; // Probs make a peer dep?
import { WebSocket } from "partysocket";
import type { ErrorEvent } from "partysocket/ws";

import { http } from "./client";
import { assert, createLogger, hexToNumber, isHexEqual, mutex, retry } from "./utils";

/**
 * Socket -----------------------------------------------------------------------------------------------------------------------------------
 */

type SocketOptions = {
	/**
	 * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
	 * this indicates that the connection is ready to send and receive data. Note that this function
	 * can be called multiple times over the lifetime of a socket as dropped connections are initialised
	 */
	onOpen?: () => Promise<void> | void;
	/**
	 * An event listener to be called when the WebSocket connection's readyState changes to CLOSED.
	 */
	onClose?: () => Promise<void> | void;
	/**
	 * An event listener to be called when an error occurs
	 */
	onError?: (event: ErrorEvent) => Promise<void> | void;
	/**
	 * An event listener to be called when a message is received from the server
	 */
	onMessage?: (event: MessageEvent) => Promise<void> | void;
};

function createSocket(url: `wss://${string}`, opts: SocketOptions) {
	const ws = new WebSocket(url, [], { WebSocket: WS });

	// No support for `binaryType` of "blob" in Bun yet so we set it to "arraybuffer" https://github.com/partykit/partykit/issues/774
	ws.binaryType = "arraybuffer";

	if (opts.onOpen) ws.onopen = opts.onOpen;
	if (opts.onError) ws.onerror = opts.onError;
	if (opts.onClose) ws.onclose = opts.onClose;
	if (opts.onMessage) ws.onmessage = opts.onMessage;

	return ws;
}

/**
 * Transport -----------------------------------------------------------------------------------------------------------------------------------
 */

type TransportOptions = {
	/** Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs. */
	quiet?: boolean;
};

type Transport = {
	/**
	 * Performs as JSON RPC request and returns the result
	 */
	request(opts: { method: string; params: any[] }): Promise<any>;
	/**
	 * Subscribes to specific event types and returns a function to unsubscribe.
	 */
	subscribe(param: "newHeads", handler: (message: any) => void): Promise<{ unsubscribe(): Promise<void> }>;
};

function defineTransport(url: string, opts: TransportOptions = {}): Transport {
	if (!url.startsWith("wss://")) {
		throw new Error("Websocket connections must start with `wss://`");
	}

	const logger = createLogger({ quiet: opts.quiet ?? false });

	let id = 0;

	// Every request gets an identifier based on `id` above. This map represents that request in-flight
	// and it's corresponding callback handler to invoke when a response is received on the connection.
	const requests = new Map<number, (data: any) => void>();

	// This is a key value store for a given subscription id to a given param
	const subscriptions = new Map<string, { param: string; latest: number }>();

	// For each param we keep a set of handlers to notify when we receive a response
	const params = new Map<string, Set<(data: any) => void>>();

	const socket = createSocket(url as "wss://", {
		async onError(cause) {
			logger.error(new Error("Socket error", { cause }));
		},

		async onOpen() {
			if (subscriptions.size === 0) return;

			// If the socket connection is reinitalised this function will be called multiple times. When that
			// happens we need to re-initialise all underlying subscriptions on the new connection.

			const params: string[] = [];

			for (const [id, subscription] of subscriptions) {
				params.push(subscription.param);

				// This isn't strictly needed for correctness. The fact that the websocket connection was dropped
				// likely means the node automatically dropped our subscriptions. So we can fire-and-forget this.

				request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
					logger.warn("Failed to cancel old susbcription");
				});

				subscriptions.delete(id);
			}

			for (const param of params) {
				request({ method: "eth_subscribe", params: [param] }).then((id) => {
					subscriptions.set(id, { param, latest: Date.now() });
				});
			}
		},

		async onMessage(event) {
			const data = JSON.parse(event.data);

			if (data.method === "eth_subscription") {
				const subscription = subscriptions.get(data.params.subscription);

				if (subscription === undefined) {
					return await request({ method: "eth_unsubscribe", params: [data.params.subscription] }).catch(() => {
						logger.warn("Failed to unsubscribe stale subscription");
					});
				}

				const handlers = params.get(subscription.param);

				if (handlers === undefined) {
					return await request({ method: "eth_unsubscribe", params: [data.params.subscription] }).catch(() => {
						logger.warn("Failed to unsubscribe stale subscription");
					});
				}

				for (const handler of handlers) {
					try {
						handler(data.params.result);
					} catch (cause) {
						logger.error(new Error("Handler error", { cause }));
					}
				}

				subscription.latest = Date.now();

				return;
			}

			const handler = requests.get(data.id);

			if (handler === undefined) {
				return logger.warn(`Received unknown response for request id ${data.id}...`);
			}

			return handler(data.result);
		},
	});

	async function request(opts: { method: string; params: any[] }) {
		return await new Promise<any>((resolve) => {
			const body = Object.assign({ id: id++ }, opts);

			requests.set(body.id, (data) => {
				// TODO: Could set a timeout to clean up the request to mitigate memory leaks
				requests.delete(body.id);
				resolve(data);
			});

			socket.send(JSON.stringify(body));
		});
	}

	async function subscribe(param: string, handler: (messsage: any) => void) {
		const handlers = params.get(param);

		if (handlers === undefined) {
			const handlers = new Set<(data: any) => void>().add(handler);

			params.set(param, handlers);

			const id = await request({ method: "eth_subscribe", params: [param] }).catch((cause) => {
				throw new Error(`Failed to initialise subscription for param ${param}`, { cause });
			});

			subscriptions.set(id, { param, latest: Date.now() });
		} else {
			handlers.add(handler);
		}

		return {
			async unsubscribe() {
				const handlers = params.get(param);

				if (handlers === undefined) {
					return logger.warn("Param already unsubscribed...");
				}

				handlers.delete(handler);

				if (handlers.size === 0) {
					await request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
						logger.warn("Failed to unsubscribe unused subscription");
					});
				}
			},
		};
	}

	function healthcheck() {
		const params: string[] = [];

		for (const [id, subscription] of subscriptions) {
			if (Date.now() - subscription.latest > 60 * 1000) {
				params.push(subscription.param);

				request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
					logger.warn("Failed to cancel old susbcription");
				});

				subscriptions.delete(id);

				logger.warn(`Subscription ${id} failed health check, reinitialising..`);
			}
		}

		for (const param of params) {
			request({ method: "eth_subscribe", params: [param] }).then((id) => {
				subscriptions.set(id, { param, latest: Date.now() });
			});
		}
	}

	setInterval(healthcheck, 60 * 1000);

	return { request, subscribe };
}

/**
 * Blockchain -----------------------------------------------------------------------------------------------------------------------------------
 */

const MAX_LENGTH = 1000;

type Head = {
	chain: `0x${string}`;
	hash: `0x${string}`;
	number: `0x${string}`;
	parentHash: `0x${string}`;
};

type BlockchainOptions = {
	quiet: boolean;
	onBlockAdded(head: Head): void | Promise<void>;
	onBlockRemoved(head: Head): void | Promise<void>;
	getBlockByHash(hash: `0x${string}`): Promise<Head | null>;
};

type Blockchain = {
	chain: Head[];
	reconcile(newBlock: Head): Promise<void>;
};

function defineBlockchain(opts: BlockchainOptions): Blockchain {
	const log = createLogger({ quiet: opts.quiet });

	const chain: Head[] = [];

	function setHeadBlock(newBlock: Head) {
		chain.push(newBlock);
		opts.onBlockAdded(newBlock);

		if (chain.length > MAX_LENGTH) {
			// TODO: Removing blocks should be exposed to the consumer
			chain.shift(); // Bounds memory usage
		}
	}

	function removeHeadBlock() {
		const head = chain.pop();

		if (head === undefined) {
			return;
		}

		opts.onBlockRemoved(head);
	}

	function getHeadBlock() {
		const block = chain[chain.length - 1];
		assert(block !== undefined, "Expected non-empty chain when retrieving latest block");
		return block;
	}

	function getOldestBlock() {
		const block = chain[0];
		assert(block !== undefined, "Expected non-empty chain when retrieving oldest block");
		return block;
	}

	async function reconcile(newBlock: Head) {
		// 1.
		// This is the least common case and should only happen when the block stream is initialised and the local chain is empty.
		// It has to come first because all subsequent cases rely on the chain not being empty
		if (chain.length === 0) {
			return setHeadBlock(newBlock);
		}

		// 2.
		// Block number older than our local chain
		if (hexToNumber(newBlock.number) < hexToNumber(getOldestBlock().number)) {
			log.info(`Received block ${hexToNumber(newBlock.number)} older than our local chain`);

			// 1.
			// A malicious node may have delivered a valid/invalid block much older than our local chain in attempt to stall indexing.
			// The simplest way to verify this is by the requesting any block from our local chain and verifying it's validity within
			// the current chain: if a re-org has actually occurred then in theory all blocks after this `newBlock` should be different.
			// So if the block hasn't changed than we can safely ignore this block. The only chance this could break is if the block
			// received comes from a node that is still accepting the old chain.
			//
			// 2.
			// Re-org has taken place that is longer than our local chain length. This is most likely to occur at startup. It can very
			// rarely happen if there exists a major bug in execution clients

			throw new Error("Not implemented");
		}

		// INVARIANT: From here on we know that the block is at least as recent as our local chain.

		// 3.
		// Occasionally we receive the same block again, and can safely ignore it
		if (chain.some((block) => block.hash === newBlock.hash)) {
			return;
		}

		// 4.
		// Common case is that the new block is the next block in the chain
		if (getHeadBlock().hash === newBlock.parentHash) {
			return setHeadBlock(newBlock);
		}

		// 5.
		// A re-org has taken place AND the new block _is_ the forked block itself
		if (chain.some((block) => block.hash === newBlock.parentHash)) {
			// We recursively remove our head block until we reach the common ancestor between the remote and local chains
			while (getHeadBlock().hash !== newBlock.parentHash) {
				removeHeadBlock();
			}

			return setHeadBlock(newBlock);
		}

		// 6.
		// - We have received a block newer than our local chain and we need to catch up to remote
		// - Chain has re-orged but the new block received _is not_ the forked block itself and is further up the forked chain.
		// In either case the fix is the same: we traverse the remote chain backwards until we reach a common ancestor with
		// our local chain (or learn that the re-org is longer than our local chain)

		// This is our recursive base case
		if (newBlock.parentHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
			while (chain.length > 0) {
				removeHeadBlock();
			}

			return setHeadBlock(newBlock);
		}

		// Load the parent remote block and reconcile
		const parentBlock = await retry(opts.getBlockByHash, [newBlock.parentHash], 5);

		if (parentBlock === null) {
			throw new Error(`Failed to fetch parent block ${hexToNumber(newBlock.number)} ${newBlock.parentHash.slice(0, 16)}`);
		}

		assert(isHexEqual(parentBlock.hash, newBlock.parentHash), "Expected block hashes to match");

		await reconcile(parentBlock); // Reconcile up to the parent block
		return await reconcile(newBlock); // Finally we add this block
	}

	// TODO: We should move the mutex here to much higher up in the abstraction

	return {
		chain,
		reconcile: mutex(reconcile),
	};
}

/**
 * Stream -----------------------------------------------------------------------------------------------------------------------------------
 */

const POLLING_INTERVAL_MS = 60 * 1000;

type Handler = (head: Head) => Promise<void> | void;

type Stream = {
	on(event: "block-added" | "block-removed" | "block-finalized", handler: Handler): () => void;
};

type CreateRealtimeStreamOpts = {
	quiet: boolean;
	transport: Transport;
};

function createRealtimeStream(opts: CreateRealtimeStreamOpts): Stream {
	const log = createLogger({ quiet: opts.quiet });

	const handlers = {
		"block-added": new Set<Handler>(),
		"block-removed": new Set<Handler>(),
		"block-finalized": new Set<Handler>(),
	};

	function emit(tag: keyof typeof handlers) {
		return (head: Head) => {
			for (const handler of handlers[tag]) {
				try {
					const result = handler(head);

					if (result instanceof Promise) {
						result.catch(() => {
							log.error(`Failed to process ${tag} handler`);
						});
					}
				} catch (error) {
					if (error instanceof Error) {
						log.error(error.message);
					}
				}
			}
		};
	}

	// TODO
	// Probably also add a chain-initialised event?
	// Handle switching chains. Probably done by emitting a stream-closed event?
	// Also need to think about if it's more appropriate to handle the chain id one layer up?
	// Cause if the chain switches we should basically reinitialise everything?

	const request = retry(opts.transport.request, [{ method: "eth_chainId", params: [] }], 5);

	request
		.then(async (chain) => {
			async function getBlockByHash(hash: `0x${string}`) {
				const block = await opts.transport.request({
					method: "eth_getBlockByHash",
					params: [hash, false], // We don't need transaction receipts
				});

				return {
					chain,
					hash: block.hash,
					number: block.number,
					parentHash: block.parentHash,
				};
			}

			// First we create the subscription for block added/removed events

			const latest = defineBlockchain({
				getBlockByHash,
				quiet: opts.quiet,
				onBlockAdded: emit("block-added"),
				onBlockRemoved: emit("block-removed"),
			});

			await opts.transport.subscribe("newHeads", async (head) => {
				try {
					await latest.reconcile({
						chain,
						hash: head.hash,
						number: head.number,
						parentHash: head.parentHash,
					});
				} catch {
					log.error("Failed to reconcile latest head");
				}
			});

			// And then we create our polling implementation for determining when blocks finalize. Unfortunately,
			// no subscription exists so that this can be pushed to us

			const finalized = defineBlockchain({
				getBlockByHash,
				quiet: opts.quiet,
				onBlockRemoved: () => {},
				onBlockAdded: emit("block-finalized"),
			});

			async function polling() {
				try {
					const block = await opts.transport.request({
						method: "eth_getBlockByNumber",
						params: ["finalized", false], // We don't need transaction receipts
					});

					// We already have the chain state local to construct the finalized chain so all
					// we have to do is iterate over the latest chain reconciling blocks less than
					// the latest finalized block

					for (const head of latest.chain) {
						if (hexToNumber(head.number) <= hexToNumber(block.number)) {
							await finalized.reconcile(head);
						}
					}
				} catch {
					log.error("Failed to reconcile finalized head");
				}
			}

			setInterval(polling, POLLING_INTERVAL_MS);
		})
		.catch(() => log.error("Failed to initialise realtime stream. Unable to determine chain id"));

	return {
		on(event: "block-added" | "block-removed" | "block-finalized", handler: Handler) {
			handlers[event].add(handler);
			return () => handlers[event].delete(handler);
		},
	};
}

/**
 * Realtime -----------------------------------------------------------------------------------------------------------------------------------
 */

type RealtimeOptions = {
	/** Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs. */
	quiet?: boolean;
	/** Custom transport */
	transport: Transport;
	/** Endpoints to publish realtime blocks to. We support multiple endpoints to make endpoint migrations easier */
	endpoints: string[];
};

function realtime(opts: RealtimeOptions) {
	const log = createLogger({ quiet: opts.quiet ?? false });

	if (opts.endpoints.length === 0) {
		throw new Error("Must provide at least one url to `endpoints`");
	}

	if (opts.endpoints.some((endpoint) => !endpoint.startsWith("https://"))) {
		log.error("All endpoints must start with https://");
	}

	if (opts.endpoints.some((endpoint) => endpoint.includes("localhost"))) {
		log.error("Endpoints cannot be on localhost");
	}

	function createClient(endpoint: string) {
		const client = http(endpoint);

		let id = 0;

		const queues = {
			pending: [] as Head[],
			reorged: [] as Head[],
		};

		const cache = new WeakMap<Head, string | null>();

		/**
		 * Writes a head to the server. Implements a retry strategy that doesn't spam the endpoint but retrying
		 * blocks on the same schedule of requests
		 */
		async function writeBlock(head: Head) {
			try {
				// TODO
				// The primary improvement to this retry method is that if the queue get's too large we might DDOS
				// the endpoint by forcing it to load too many blocks at once. Moreover, this function doesn't run
				// under any type of mutex so if the request takes longer than when we receive the next block we
				// will spam requests. We need a strategy for queueing requests for new heads.

				const heads = queues.pending.concat(head);

				const response = await client.request({
					id: id++,
					jsonrpc: "2.0",
					params: [endpoint, heads],
					method: "public_writeAndReturnBlocks",
				});

				if (response.error) {
					throw new Error(response.error.message);
				}

				if (response.result === undefined) {
					throw new Error("Expected response.result to be defined");
				}

				if (response.result.blocks.length !== heads.length) {
					throw new Error("Received a different number of blocks in response");
				}

				for (let i = 0; i < heads.length; i++) {
					const head = heads[i];
					const block = response.result.blocks[i];

					if (head === undefined) {
						throw new Error("Expected head to be defined");
					}

					if (block === undefined) {
						throw new Error("Expected block to be defined");
					}

					cache.set(head, block);
				}

				if (heads.length > 1) {
					log.info(`Successfully delivered batch of ${heads.length} blocks`);
				}

				queues.pending = queues.pending.filter((head) => {
					const wasSent = heads.some((_head) => {
						return isHexEqual(head.chain, _head.chain) && isHexEqual(head.hash, _head.hash);
					});

					return !wasSent; // Keep only blocks that weren't sent from the pending queue
				});
			} catch {
				log.warn(`Failed to insert events for block ${hexToNumber(head.chain)}:${hexToNumber(head.number)}.`);
				queues.pending.push(head); // Push failed heads to the pending queue
				log.info(`Pending blocks queue size at ${queues.pending.length}`);
			}
		}

		async function queueBlock(head: Head) {
			// It's okay to be be pretty optimistic about what blocks have been reorged. If there is a major consensus
			// or execution client bug that creates a long fork or means we constantly switch between forks it doesn't matter.
			// Once the chain finalizes we will eventually send all these queued blocks, if a particular block is included
			// in the canonical chain it will just be ignored by the delete process

			queues.reorged.push(head);
		}

		async function retry_deleteBlock(endpoint: string, block: string) {
			const response = await client.request({
				id: id++,
				jsonrpc: "2.0",
				params: [endpoint, block],
				method: "public_deleteBlock",
			});

			if (response.error) {
				throw new Error(response.error.message);
			}
		}

		async function deleteBlock(head: Head) {
			try {
				const index = queues.reorged.findIndex((_head) => {
					return isHexEqual(head.chain, _head.chain) && isHexEqual(head.number, _head.number);
				});

				const reorged = queues.reorged[index];

				// Note that it doesn't matter if the chain is constantly switching between forks. The correctness check
				// on the server ensures that deletion only ever occurs for blocks that are not part of the finalized chain

				if (reorged === undefined) {
					cache.delete(head);
					return;
				}

				const block = cache.get(reorged);

				// Could be an edge case where the block is undefined at chain initialisation?

				if (block === undefined) {
					throw new Error("Expected block to be defined");
				}

				// This indicates the server never actually loaded and processed this block. This happens because of the
				// delay between this client receiving the block and the server attempting to load it again. If the block
				// was reorged the server might not have been able to load and process it because the node it's connected
				// to never saw or has already rejected the reorganised block. Because the reorganised block was deleted
				// it means there are no events that we need to delete

				if (block === null) {
					cache.delete(head);
					return;
				}

				// If the block was successfully returned by the server we need to delete all events created by it

				await retry(retry_deleteBlock, [endpoint, block], 5);

				queues.reorged = queues.reorged.filter((_head) => {
					const isBlock = isHexEqual(head.chain, _head.chain) && isHexEqual(head.number, _head.number);
					return !isBlock;
				});

				cache.delete(head);
			} catch {
				log.error(
					`Failed to delete reorged block ${hexToNumber(head.chain)}:${hexToNumber(head.number)}.
					This failure means that events recorded for this re-organised block have not been disposed of.`,
				);
			}
		}

		return { writeBlock, queueBlock, deleteBlock };
	}

	const clients = opts.endpoints.map((endpoint) => createClient(endpoint));

	const stream = createRealtimeStream({ quiet: opts.quiet ?? false, transport: opts.transport });

	stream.on("block-added", async (head) => {
		await Promise.allSettled(
			clients.map(async (client) => {
				await client.writeBlock(head);
			}),
		);
	});

	stream.on("block-removed", async (head) => {
		await Promise.allSettled(
			clients.map(async (client) => {
				await client.queueBlock(head);
			}),
		);
	});

	stream.on("block-finalized", async (head) => {
		await Promise.allSettled(
			clients.map(async (client) => {
				await client.deleteBlock(head);
			}),
		);
	});
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { realtime, defineTransport };
