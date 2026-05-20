import WS from "ws"; // Probs make a peer dep?
import { WebSocket } from "partysocket";
import type { ErrorEvent } from "partysocket/ws";

import { http } from "./client";
import { assert, createLogger, hexToNumber, iife, isHexEqual, mutex, retry } from "./utils";

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
	onBlockAdded?: (head: Head) => Promise<void> | void;
	onBlockReorganised?: (head: Head) => Promise<void> | void;
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

		if (opts.onBlockAdded) {
			opts.onBlockAdded(newBlock);
		}

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

		if (opts.onBlockReorganised) {
			opts.onBlockReorganised(head);
		}
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
 * Realtime -----------------------------------------------------------------------------------------------------------------------------------
 */

const POLLING_INTERVAL_MS = 12 * 1000;

type RealtimeOptions = {
	/** Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs. */
	quiet?: boolean;
	/** Endpoint to publish realtime blocks to */
	endpoint: string;
	/** Custom transport */
	transport: Transport;
};

function realtime(opts: RealtimeOptions) {
	const client = http(opts.endpoint);
	const log = createLogger({ quiet: opts.quiet ?? false });

	const promise = iife(async () => {
		let id = 0;
		let pending: Head[] = [];

		const [chain, latestBlock] = await Promise.all([
			retry(opts.transport.request, [{ method: "eth_chainId", params: [] }], 2),
			retry(opts.transport.request, [{ method: "eth_getBlockByNumber", params: ["latest", false] }], 2),
		]);

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

		const latest = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
			onBlockAdded: async (head) => {
				try {
					// TODO
					// The primary improvement to this retry method is that if the queue gets too large we might DDOS
					// the endpoint by forcing it to load too many blocks at once. Moreover, this function doesn't run
					// under any type of mutex so if the request takes longer than when we receive the next block we
					// will spam requests. We need a strategy for queueing requests for new heads.

					const heads = pending.concat(head);

					const response = await client.request({
						id: id++,
						jsonrpc: "2.0",
						params: [heads],
						method: "public_writeUnfinalizedHeads",
					});

					if (response.error) {
						throw new Error(response.error.message);
					}

					pending = pending.filter((head) => {
						return !heads.some((_head) => {
							return isHexEqual(head.chain, _head.chain) && isHexEqual(head.hash, _head.hash);
						});
					});
				} catch {
					log.warn("Failed to write heads");

					pending.push(head);
				}
			},
			onBlockReorganised: async (head) => {
				try {
					const response = await client.request({
						id: id++,
						jsonrpc: "2.0",
						params: [head],
						method: "public_deleteReorganisedHead",
					});

					if (response.error) {
						throw new Error(response.error.message);
					}
				} catch {
					log.warn("Failed to write reorganised head");
				}
			},
		});

		// TODO
		// This starts from the indexer state. As the chain finalizes we iterate over all the unfinalized
		// blocks less than or equal to the finalized chain and deliver them to the finalized endpoint.
		// If successful we can drop all blocks sent from the unfinalized chain

		const unfinalized = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
		});

		const finalized = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
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
	});

	promise.catch(() => {
		log.error(`Failed to initialise realtime client for endpoint ${opts.endpoint}`);
	});
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { realtime, defineTransport };
