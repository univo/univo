import { hexToNumber } from "viem";
import type { EIP1193EventMap, EIP1193RequestFn } from "viem";

import { IndexerRpc, Rpc } from "./rpc";
import type { Transport } from "./transport";
import { createLogger, iife, isHexEqual, mutex, retry } from "./utils";

/**
 * Blockchain -----------------------------------------------------------------------------------------------------------------------------------
 */

type Head = {
	hash: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
};

type BlockchainOptions = {
	quiet?: boolean;
	onBlockAdded?: (head: Head) => Promise<void> | void;
	onBlockReorganised?: (head: Head) => Promise<void> | void;
	getBlockByHash(hash: `0x${string}`): Promise<Head | null>;
};

type Blockchain = {
	/**
	 * An ordered list of heads representing our local chain
	 */
	chain: Head[];

	/**
	 * Accepts a block from our local chain and removes all blocks less than the provided block
	 */
	prune(tail: Head): Promise<void>;

	/**
	 * Accepts a new remote block and reconciles it with our local chain
	 */
	reconcile(newBlock: Head): Promise<void>;
};

function defineBlockchain(opts: BlockchainOptions): Blockchain {
	const log = createLogger({ quiet: opts.quiet });

	const chain: Head[] = [];

	function getHeadBlock() {
		const block = chain[chain.length - 1];

		if (block === undefined) {
			throw new Error("Expected non-empty chain when retrieving latest block");
		}

		return block;
	}

	function getTailBlock() {
		const block = chain[0];

		if (block === undefined) {
			throw new Error("Expected non-empty chain when retrieving oldest block");
		}

		return block;
	}

	function setHeadBlock(newBlock: Head) {
		chain.push(newBlock);

		if (opts.onBlockAdded) {
			opts.onBlockAdded(newBlock);
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

	async function prune(tail: Head) {
		if (hexToNumber(tail.number) >= hexToNumber(getHeadBlock().number)) {
			throw new Error("Cannot remove head block");
		}

		while (hexToNumber(tail.number) > hexToNumber(getTailBlock().number)) {
			chain.shift();
		}
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
		if (hexToNumber(newBlock.number) < hexToNumber(getTailBlock().number)) {
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
		if (getHeadBlock().hash === newBlock.parent_hash) {
			return setHeadBlock(newBlock);
		}

		// 5.
		// A re-org has taken place AND the new block _is_ the forked block itself
		if (chain.some((block) => block.hash === newBlock.parent_hash)) {
			// We recursively remove our head block until we reach the common ancestor between the remote and local chains
			while (getHeadBlock().hash !== newBlock.parent_hash) {
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
		if (newBlock.parent_hash === "0x0000000000000000000000000000000000000000000000000000000000000000") {
			while (chain.length > 0) {
				removeHeadBlock();
			}

			return setHeadBlock(newBlock);
		}

		// Load the parent remote block and reconcile
		const parentBlock = await retry(() => opts.getBlockByHash(newBlock.parent_hash), 2);

		if (parentBlock === null) {
			throw new Error(`Failed to fetch parent block ${hexToNumber(newBlock.number)} ${newBlock.parent_hash.slice(0, 16)}`);
		}

		if (!isHexEqual(parentBlock.hash, newBlock.parent_hash)) {
			throw new Error("Expected block hashes to match");
		}

		await reconcile(parentBlock); // Reconcile up to the parent block
		return await reconcile(newBlock); // Finally we add this block
	}

	// TODO: `prune` and `reconcile` should submit to a queue to process serially

	return {
		chain,
		prune: mutex(prune),
		reconcile: mutex(reconcile),
	};
}

/**
 * Realtime -----------------------------------------------------------------------------------------------------------------------------------
 */

const POLLING_INTERVAL_MS = 12 * 1000;

type RealtimeOptions = {
	/**
	 * Silences all logs including errors.
	 *
	 * Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to suppress all logs.
	 * Available log options are `DEBUG`, `INFO`, `WARN`, and `ERROR`.
	 */
	quiet?: boolean;

	/**
	 * Connection to a blockchain node.
	 *
	 * Must use the `wss` or `browser` transport protocol from `univo/transport`.
	 */
	node: Transport<Rpc, "wss" | "browser">;

	/**
	 * Connection to a univo indexer.
	 *
	 * Must use the `http` or `local` transport protocol from `univo/transport`. If you want to deploy your
	 * indexer and realtime client in a single monolithic deployment, you should use the `local` transport.
	 */
	indexer: Transport<IndexerRpc, "http" | "local">;
};

type EIP6963AnnounceProviderEvent = CustomEvent & {
	type: "eip6963:announceProvider";
	detail: EIP6963ProviderDetail;
};

type EIP6963ProviderDetail = {
	provider: EIP1193Provider;
	info: EIP6963ProviderInfo;
};

type EIP6963ProviderInfo = {
	uuid: string;
	name: string;
	icon: string;
	rdns: string;
};

type EIP1193Provider = {
	request: EIP1193RequestFn;
	on: <event extends keyof EIP1193EventMap>(event: event, listener: EIP1193EventMap[event]) => void;
	removeListener: <event extends keyof EIP1193EventMap>(event: event, listener: EIP1193EventMap[event]) => void;
};

function realtime(realtime: RealtimeOptions) {
	const log = createLogger({ quiet: realtime.quiet, prefix: "[realtime]" });

	const instance = ({ chain, node }: { chain: `0x${string}`; node: Transport<Rpc> }) => {
		const finalizers: Array<() => Promise<void> | void> = [];

		const interrupt = () => {
			for (const fn of finalizers) {
				try {
					const res = fn();

					if (res instanceof Promise) {
						res.catch((error) => {
							throw error;
						});
					}
				} catch (error) {
					if (error instanceof Error) {
						log.warn(error.message);
					}
				}
			}
		};

		const promise = iife(async () => {
			// First step is to initialise the realtime client so that it immediately begins indexing the tip
			// of the chain. This is fundamentally important part of recovering from downtime because it means
			// that the number of blocks we have to process while unavailable is bounded. This puts an upper
			// limit on our time-to-recovery and makes operational management simple.

			const [chainLatestBlock, chainFinalizedBlock] = await Promise.all([
				node.request({ method: "eth_getBlockByNumber", params: ["latest", false] }), //
				node.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }),
			]);

			if (chainLatestBlock === null) {
				throw new Error("Latest block not found");
			}

			if (chainFinalizedBlock === null) {
				throw new Error("Finalized block not found");
			}

			const unfinalized = defineBlockchain({
				quiet: realtime.quiet,

				getBlockByHash: async (hash: `0x${string}`) => {
					const block = await node.request({ method: "eth_getBlockByHash", params: [hash, false] });

					if (block === null) {
						return null;
					}

					return { number: block.number, hash: block.hash, parent_hash: block.parentHash };
				},

				onBlockAdded: async (head) => {
					try {
						log.debug("Received unfinalized head");

						// We intentionally do not perform retries here. It makes more sense to improve the resiliency of
						// tip indexing by deploying more realtime clients. Three clients means it at least three requests
						// attempt to process the latest block. Concurrency control mechanisms on the indexer ensure that
						// only one of these requests actually write data to storage

						await realtime.indexer.request({
							method: "public_writeUnfinalizedHead",
							params: [{ chain, ...head }],
						});

						log.debug("Delivered unfinalized head");
					} catch (error) {
						if (error instanceof Error) {
							log.warn(`Failed to write unfinalized head: ${error.message}`);
						}
					}
				},

				onBlockReorganised: async (head) => {
					try {
						log.debug("Received reorganised head");

						// Because reorganised blocks are rare, it's safe to be pretty liberal with retries here. It won't cause any
						// thundering herd or degradation and maximises the chance our indexer can safely process the reorged head

						await retry(
							() => realtime.indexer.request({ method: "public_deleteReorganisedHead", params: [{ chain, ...head }] }), //
							2,
						);

						log.debug("Delivered reorganised head");
					} catch (error) {
						if (error instanceof Error) {
							log.warn(`Failed to write reorganised head: ${error.message}`);
						}
					}
				},
			});

			await unfinalized.reconcile({
				hash: chainLatestBlock.hash,
				number: chainLatestBlock.number,
				parent_hash: chainLatestBlock.parentHash,
			});

			log.debug("Subscribing unfinalized chain to new heads...");

			const unsubscribe = await node.subscribe("newHeads", async (head) => {
				await unfinalized.reconcile({ hash: head.hash, number: head.number, parent_hash: head.parentHash }).catch((error) => {
					if (error instanceof Error) {
						log.error(`Failed to reconcile unfinalized head: ${error.message}`);
					}
				});
			});

			finalizers.push(() => unsubscribe());

			log.debug("Subscribed unfinalized chain to new heads");

			// We wrap finalization in a mutex. On the indexer finalization is a single-writer process that
			// operates under 60s leases. This means that any new requests while finalization is in-flight
			// will fail anyway so this mutex is just an optimisation and doesn't break correctness.

			async function finalize() {
				try {
					log.debug("Finalizing indexer...");

					await realtime.indexer.request({ params: [chain], method: "public_finalize" });

					log.debug("Indexer finalized");
				} catch (error) {
					if (error instanceof Error) {
						log.warn(`Failed to finalize: ${error.message}`);
					}
				}
			}

			const mutex_finalize = mutex(finalize);

			// Begin polling for finalized height

			let chainFinalizedHeight = hexToNumber(chainFinalizedBlock.number);

			async function poll() {
				try {
					log.debug("Polling for finalized height...");

					const finalizedBlock = await node.request({
						method: "eth_getBlockByNumber",
						params: ["finalized", false],
					});

					if (finalizedBlock === null) {
						throw new Error("Finalized block not found");
					}

					const nextFinalizedHeight = hexToNumber(finalizedBlock.number);

					if (nextFinalizedHeight <= chainFinalizedHeight) {
						return log.debug("Chain finalized height has not progressed");
					}

					await realtime.indexer.request({ params: [chain], method: "public_writeFinalizedHeight" });

					// Determine new finalized heads

					const newFinalizedHeads = unfinalized.chain
						.filter((head) => {
							if (hexToNumber(head.number) > chainFinalizedHeight && hexToNumber(head.number) <= nextFinalizedHeight) {
								return true;
							}

							return false;
						})
						.map((head) => {
							return { chain, ...head };
						});

					if (newFinalizedHeads.length === 0) {
						chainFinalizedHeight = nextFinalizedHeight;

						return log.debug("No new finalized heads to process");
					}

					// Process new heads

					log.debug(`Processing ${newFinalizedHeads.length} finalized head(s) in parallel`);

					const promises = newFinalizedHeads.map(async (head) => {
						try {
							log.debug("Received finalized head");

							// Similar to tip indexing, we don't perform any retries here because of thundering herd issues.
							// Instead retries should be handled by deploying multiple realtime clients. Any failures will
							// automatically be resolved by the finalization process

							await realtime.indexer.request({ params: [head], method: "public_writeFinalizedHead" });

							log.debug("Delivered finalized head");
						} catch (error) {
							if (error instanceof Error) {
								log.warn(`Failed to write finalized head: ${error.message}`);
							}
						}
					});

					await Promise.allSettled(promises);

					// Acknowledge heads were processed, irrespective of failures

					log.debug(`Processed ${newFinalizedHeads.length} finalized head(s) in parallel`);

					chainFinalizedHeight = nextFinalizedHeight;

					await unfinalized.prune({
						hash: finalizedBlock.hash,
						number: finalizedBlock.number,
						parent_hash: finalizedBlock.parentHash,
					});

					await mutex_finalize();
				} catch (error) {
					if (error instanceof Error) {
						log.error(`Failed to reconcile finalized head: ${error.message}`);
					}
				}
			}

			const id = setInterval(poll, POLLING_INTERVAL_MS);
			finalizers.push(() => clearInterval(id));

			log.debug("Started polling finalized height");
		});

		promise.catch((error) => {
			if (error instanceof Error) {
				log.error(error.message);
			}

			interrupt();
		});

		return interrupt;
	};

	const browser = (browser: { signal: AbortSignal; chain: `0x${string}`; provider: EIP1193Provider }) => {
		const finalizers: Array<() => Promise<void> | void> = [];

		const interrupt = () => {
			for (const fn of finalizers) {
				try {
					const res = fn();

					if (res instanceof Promise) {
						res.catch((error) => {
							throw error;
						});
					}
				} catch (error) {
					if (error instanceof Error) {
						log.warn(error.message);
					}
				}
			}
		};

		const promise = iife(async () => {
			// If a provider is announced for a chain that we don't want to index we early return
			const metadata = await realtime.indexer.request({ method: "public_getMetadata", params: [] });

			if (!metadata.chains.includes(browser.chain)) {
				return;
			}

			// We want to decouple subscriptions to the node from subscriptions to this abstraction, allowing
			// us to deduplicate multiple subscribers into a single node subscription. Therefore we first create
			// a map that allows us to go from a subscription id to a given param, and then from a given param to
			// a set of listeners.

			const subscriptions = {
				node: new Map<string, string>(),
				abstraction: new Map<string, Set<(data: any) => void>>(),
			};

			const transport: Transport<Rpc> = {
				protocol: "browser",

				request: async (request) => {
					browser.signal.throwIfAborted();

					const res = await browser.provider.request({ method: request.method, params: request.params });

					browser.signal.throwIfAborted();

					return res;
				},

				subscribe: async (param, listener) => {
					const listeners = subscriptions.abstraction.get(param);

					if (listeners === undefined) {
						const listeners = new Set<(data: any) => void>();

						listeners.add(listener);

						subscriptions.abstraction.set(param, listeners);

						const id = await transport.request({ method: "eth_subscribe", params: [param] }).catch((cause) => {
							throw new Error(`Failed to initialise subscription for param ${param}`, { cause });
						});

						subscriptions.node.set(id, param);
					} else {
						listeners.add(listener);
					}

					return async function unsubscribe() {
						const listeners = subscriptions.abstraction.get(param);

						if (listeners === undefined) {
							return;
						}

						listeners.delete(listener);

						if (listeners.size === 0) {
							for (const [id, _param] of subscriptions.node) {
								if (param === _param) {
									await transport.request({ method: "eth_unsubscribe", params: [id] }).catch(() => {
										log.warn("Failed to unsubscribe unused subscription");
									});
								}
							}
						}
					};
				},
			};

			const onMessage = async (message: { type: string; data: any }) => {
				if (message.type === "eth_subscription") {
					const param = subscriptions.node.get(message.data.subscription);

					if (param === undefined) {
						// Injected providers are shared; unknown subscriptions may belong to another application.
						// Rather than automatically unsubscribing we simply ignore

						return;
					}

					const listeners = subscriptions.abstraction.get(param);

					if (listeners === undefined) {
						return await transport.request({ method: "eth_unsubscribe", params: [message.data.subscription] }).catch(() => {
							log.warn("Failed to unsubscribe stale subscription");
						});
					}

					for (const listener of listeners) {
						try {
							listener(message.data.result);
						} catch (error) {
							if (error instanceof Error) {
								log.error(error.message);
							}
						}
					}
				}
			};

			browser.provider.on("message", onMessage);
			finalizers.push(() => browser.provider.removeListener("message", onMessage));

			const interrupt = instance({ chain: browser.chain, node: transport });
			finalizers.push(() => interrupt());
		});

		promise.catch((error) => {
			if (error instanceof Error) {
				log.error(error.message);
			}

			interrupt();
		});

		return interrupt;
	};

	iife(async () => {
		try {
			log.debug("Initialising realtime client");

			if (realtime.node.protocol === "wss") {
				log.debug("Found user provided node");

				const [chain, metadata] = await Promise.all([
					realtime.node.request({ method: "eth_chainId", params: [] }),
					realtime.indexer.request({ method: "public_getMetadata", params: [] }),
				]);

				log.debug(`Determined chain identifier for connected node: ${hexToNumber(chain)}`);

				if (!metadata.chains.some((_chain) => _chain === chain)) {
					throw new Error("Provided `node` is connected to a chain not indexed by the provided `indexer`");
				}

				instance({ chain, node: realtime.node });

				return;
			}

			if (realtime.node.protocol === "browser") {
				log.debug("Looking for browser injected node providers");

				// Early return if this is accidentally called on the server

				if (typeof window === "undefined") {
					return log.debug("Browser indexing invoked on the server, aborting...");
				}

				// Store every provider that is announced
				const providers = new Map<string, EIP6963ProviderDetail>();

				// Store any active executions of handler for a given provider:chain pair
				const sessions = new Map<`${string}:${string}`, () => void>();

				window.addEventListener("eip6963:announceProvider", async (event) => {
					const typed = event as EIP6963AnnounceProviderEvent;

					const provider = typed.detail;

					// Determine if this provider has already been announced
					if (providers.get(provider.info.uuid) !== undefined) {
						return log.debug(`Found duplicate provider (${provider.info.uuid})`);
					}

					log.debug(`Found provider (${provider.info.uuid})`);
					providers.set(provider.info.uuid, provider);

					let controller = new AbortController();

					const initialise = (initialise: { signal: AbortSignal; chain: `0x${string}` }) => {
						// Whenever we initialise a provider for a given chain, we must first interrupt any existing
						// sessions for this provider. The previous signal is aborted on chain changes so that existing
						// sessions begin erroring immediately for the wrong chain

						for (const [key, interrupt] of sessions) {
							if (key.startsWith(provider.info.uuid)) {
								try {
									interrupt();
									sessions.delete(key);
								} catch (error) {
									if (error instanceof Error) {
										log.error(error.message);
									}

									sessions.delete(key);
								}
							}
						}

						// Before initialising, we then determine if the chain already has a session with a different
						// provider and abort if so

						for (const key of sessions.keys()) {
							if (key.endsWith(`:${initialise.chain}`)) {
								return log.debug(`Already indexing key ${key}, aborting initialisation...`);
							}
						}

						// Now we are free to start a new session

						const key = `${provider.info.uuid}:${initialise.chain}` as const;
						log.debug(`Initialising indexing for key ${key}`);

						const interrupt = browser({ signal: initialise.signal, chain: initialise.chain, provider: provider.provider });
						sessions.set(key, interrupt);
					};

					// We add an event listener to detect any changes to the providers chain
					provider.provider.on("chainChanged", async (chain: `0x${string}`) => {
						log.debug(`Provider (${provider.info.uuid}) changed to chain (${hexToNumber(chain)})`);

						// Invalidate only this provider's previous session immediately
						controller.abort();
						controller = new AbortController();

						// Start indexing chain for provider
						initialise({ chain, signal: controller.signal });
					});

					const initialSignal = controller.signal;

					// And then we request the chain we are currently connected to and begin indexing
					const initialChain: `0x${string}` = await provider.provider.request({ method: "eth_chainId" });

					// If a chain change occurred while the request was in flight be abort early
					if (initialSignal.aborted) {
						return;
					}

					// Start indexing chain for provider
					initialise({ chain: initialChain, signal: initialSignal });
				});

				window.dispatchEvent(new Event("eip6963:requestProvider"));
			}
		} catch (error) {
			if (error instanceof Error) {
				log.error(error.message);
			}
		}
	});
}

export { realtime };
