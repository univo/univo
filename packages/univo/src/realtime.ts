import WS from "ws"; // Probs make a peer dep?
import { WebSocket } from "partysocket";
import type { ErrorEvent } from "partysocket/ws";

import { http } from "./client";
import { assert, createLogger, hexToNumber, mutex, raise, retry } from "./utils";

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

function defineTransport(url: string): Transport {
	assert(url.startsWith("wss://"), "Websocket connections must start with `wss://`");

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
			console.error(new Error("Socket error", { cause }));
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
					console.warn("Failed to cancel old susbcription");
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
						console.warn("Failed to unsubscribe stale subscription");
					});
				}

				const handlers = params.get(subscription.param);

				if (handlers === undefined) {
					return await request({ method: "eth_unsubscribe", params: [data.params.subscription] }).catch(() => {
						console.warn("Failed to unsubscribe stale subscription");
					});
				}

				for (const handler of handlers) {
					try {
						handler(data.params.result);
					} catch (cause) {
						console.error(new Error("Handler error", { cause }));
					}
				}

				subscription.latest = Date.now();

				return;
			}

			const handler = requests.get(data.id);

			if (handler === undefined) {
				return console.warn(`Received unknown response for request id ${data.id}...`);
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
					return console.warn("Param already unsubscribed...");
				}

				handlers.delete(handler);

				if (handlers.size === 0) {
					await request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
						console.warn("Failed to unsubscribe unused subscription");
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
					console.warn("Failed to cancel old susbcription");
				});

				subscriptions.delete(id);

				console.warn(`Subscription ${id} failed health check, reinitialising..`);
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

type Head = {
	chain: `0x${string}`;
	hash: `0x${string}`;
	number: `0x${string}`;
	parentHash: `0x${string}`;
};

type BlockchainOptions = {
	quiet: boolean;
	onBlockAdded(head: Head): void | Promise<void>;
	getBlockByHash(hash: `0x${string}`): Promise<Head | null | undefined>;
};

type Blockchain = {
	reconcile(newBlock: Head): Promise<void>;
};

// Could be globally cached per chain id
function defineBlockchain(opts: BlockchainOptions): Blockchain {
	const log = createLogger({ quiet: opts.quiet });

	// TODO: convert to a KV api so that we can use unstorage and easily store the chain _anywhere_
	// key would be block number, value is `Block`
	const chain: Head[] = [];

	function setHeadBlock(newBlock: Head) {
		chain.push(newBlock);
		opts.onBlockAdded(newBlock);
		if (chain.length > 100) chain.shift();
	}

	function removeHeadBlock() {
		chain.pop();
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
			while (getHeadBlock().hash !== newBlock.parentHash) removeHeadBlock();
			return setHeadBlock(newBlock);
		}

		// 7.
		// - We have received a block newer than our local chain and we need to catch up to remote
		// - Chain has re-orged but the new block received _is not_ the forked block itself and is further up the forked chain.
		// In either case the fix is the same: we traverse the remote chain backwards until we reach a common ancestor with
		// our local chain (or learn that the re-org is longer than our local chain)

		// This is our recursive base case
		if (newBlock.parentHash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
			while (chain.length > 0) removeHeadBlock();
			return setHeadBlock(newBlock);
		}

		// Load the parent remote block and reconcile
		const parentBlock = await retry(opts.getBlockByHash, [newBlock.parentHash], 5);
		if (!parentBlock) throw new Error(`Failed to fetch parent block ${hexToNumber(newBlock.number)} ${newBlock.parentHash.slice(0, 16)}`);
		assert(parentBlock.hash === newBlock.parentHash, "Expected block hashes to match");
		await reconcile(parentBlock);
		return await reconcile(newBlock);
	}

	return {
		reconcile: mutex(reconcile),
	};
}

/**
 * Stream -----------------------------------------------------------------------------------------------------------------------------------
 */

// We don't attempt to provide for block information. That is outside the boundary of this software.
// If we did it brings up too many questions about what that data should be? Should it be our own custom
// version of a block? Should it be specific raw RPC responses? If so what responses?
// We provide only the hash because it is a canonical id for the block and is what should be used for lookup
// Info like block numbers, parent hashes, should technically be an implementation detail of the software. As a user we should
// have the intuition that the block stream sequentially iterates over all newly added blocks, and re-iterating
// over any new blocks added as a result of a chain re-organisation. One of the problems especially with passing
// a block number for lookup with eth_getBlockByNumber, is that there is a slight chance that a node could return
// a block with that block number and a different block hash.
type Handler = (head: Head) => Promise<void> | void;

type Stream = {
	on(event: "block", handler: Handler): { unsubscribe: () => void };
};

type CreateRealtimeStreamOpts = {
	quiet: boolean;
	transport: Transport;
};

// createBlockStream? createRealtimeStream? createRealtimeClient?
// I like realtime stream because it's clear that it's only realtime data and not historical data
// If it was createBlockStream and it's ambiguous whether or not the stream includes blocks from genesis or not
function createRealtimeStream(opts: CreateRealtimeStreamOpts): Stream {
	const log = createLogger({ quiet: opts.quiet });

	const handlers = new Set<Handler>();

	function onBlockAdded(head: Head) {
		for (const handler of handlers) {
			try {
				const result = handler(head);

				if (result instanceof Promise) {
					result.catch(() => {
						log.error("Failed to process handler");
					});
				}
			} catch (error) {
				if (error instanceof Error) {
					log.error(error.message);
				}
			}
		}
	}

	async function createRealtimeStreamForChain(chain: `0x${string}`) {
		async function getBlockByHash(hash: `0x${string}`) {
			const block = await opts.transport.request({
				method: "eth_getBlockByHash",
				params: [hash, false],
			});

			return { chain, number: block.number, hash: block.hash, parentHash: block.parentHash };
		}

		const latest = defineBlockchain({ onBlockAdded, getBlockByHash, quiet: opts.quiet });

		async function onNewHead(head: Head) {
			try {
				await latest.reconcile(head);
			} catch (cause) {
				log.error("Failed to reconcile latest head");
			}
		}

		opts.transport
			.subscribe("newHeads", (head) => onNewHead({ chain, number: head.number, hash: head.hash, parentHash: head.parentHash }))
			.then(() => log.debug(`Initialised subscription for chain ${hexToNumber(chain)}`))
			.catch((cause) => raise(`Failed to initialise subscription for chain ${hexToNumber(chain)}`, { cause }));
	}

	// TODO: Handle switching chains

	retry(opts.transport.request, [{ method: "eth_chainId", params: [] }], 5)
		.then((chain) => createRealtimeStreamForChain(chain))
		.catch(() => log.error("Failed to load current chain"));

	return {
		on(_: "block", handler: Handler) {
			handlers.add(handler);
			return { unsubscribe: () => handlers.delete(handler) };
		},
	};
}

/**
 * Realtime -----------------------------------------------------------------------------------------------------------------------------------
 */

type RealtimeOptions = {
	/** Custom transport */
	transport: Transport;
	/** Endpoints to publish realtime blocks to */
	endpoints: string[]; // TODO: Assert https://
	/** Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs. */
	quiet?: boolean;
};

// TODO
// Accept http() transports instead of endpoints. This would allow us to use an authenticated client.
// If we were running realtime in a trusted server environment, we wouldn't need to re-load blocks
//
// This would reduce cost and improve latency. We may have to split up historical and realtime indexing methods because
// of the current implementation of successes/errors
//
// It's also possible that this would happen in the same server environment in a monolithic architecture,
// and would warrant the need for the local() transport to return
//
// The primary reason I don't think we should do this is I can just foresee users consuming this API incorrectly and
// will provide a signingKey in a client environment. If the API is designed with a pit-of-success mentality, this
// feature goes against that

// TODO
// Have multiple transports and initialise multiple streams. Assuming the in memory
// chain is de-deplicated I feel like this would improve resiliency and help process reorgs

function realtime(opts: RealtimeOptions) {
	const defaultOptions = { quiet: false };
	const options = Object.assign(defaultOptions, opts);
	const log = createLogger(options);

	if (options.endpoints.length === 0) throw new Error("Must provide at least one url to `endpoints`");

	function createClient(endpoint: string) {
		const client = http(endpoint);

		let id = 0;
		let pending: Head[] = [];

		return {
			async publish(head: Head) {
				try {
					const heads = pending.concat(head);

					const response = await client.request({ jsonrpc: "2.0", id: id++, method: "public_writeBlocks", params: [endpoint, heads] });
					if (response.error) throw new Error(response.error.message);

					pending = [];
				} catch (cause) {
					log.warn(`Failed to publish realtime block ${head.chain}:${head.number}`);

					// Push failed heads to the pending queue
					pending.push(head);
				}
			},
		};
	}

	const clients = options.endpoints.map((endpoint) => createClient(endpoint));

	createRealtimeStream(options).on("block", async (head) => {
		await Promise.all(
			clients.map(async (client) => {
				await client.publish(head);
			}),
		);
	});
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { realtime, defineTransport, createRealtimeStream };
