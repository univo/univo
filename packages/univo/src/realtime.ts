import { IndexerRpc, NodeRpc } from "./rpc";
import type { Transport } from "./transport";
import { createLogger, hexToNumber, iife, isHexEqual, mutex, numberToHex, retry } from "./utils";

/**
 * Blockchain -----------------------------------------------------------------------------------------------------------------------------------
 */

type Head = {
	hash: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
};

type BlockchainOptions = {
	quiet: boolean;
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
		const parentBlock = await retry(() => opts.getBlockByHash(newBlock.parent_hash), 5);

		if (parentBlock === null) {
			throw new Error(`Failed to fetch parent block ${hexToNumber(newBlock.number)} ${newBlock.parent_hash.slice(0, 16)}`);
		}

		if (!isHexEqual(parentBlock.hash, newBlock.parent_hash)) {
			throw new Error("Expected block hashes to match");
		}

		await reconcile(parentBlock); // Reconcile up to the parent block
		return await reconcile(newBlock); // Finally we add this block
	}

	// TODO: reconcile should queue instead of dropping invocations with a mutex

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
	 * Must use the `wss` transport protocol from `univo/transport`.
	 */
	node: Transport<NodeRpc, "wss">;

	/**
	 * Connection to a univo indexer.
	 *
	 * Must use the `http` or `local` transport protocol from `univo/transport`. If you want to deploy your
	 * indexer and realtime client in a single monolithic deployment, you should use the `local` transport.
	 */
	indexer: Transport<IndexerRpc, "http" | "local">;
};

function realtime(opts: RealtimeOptions) {
	const log = createLogger({ quiet: opts.quiet ?? false, prefix: "[realtime]" });

	async function getBlockByHash(hash: `0x${string}`) {
		const block = await opts.node.request({ method: "eth_getBlockByHash", params: [hash, false] });

		return { number: block.number, hash: block.hash, parent_hash: block.parentHash };
	}

	const promise = iife(async () => {
		log.debug("Initialising realtime client for indexer");

		const chain = await opts.node.request({ method: "eth_chainId", params: [] });

		log.debug(`Determined chain identifier for connected node: ${hexToNumber(chain)}`);

		// First step is to initialise the realtime client so that it immediately begins indexing the tip
		// of the chain. This is fundamentally important part of recovering from downtime because it means
		// that the number of blocks we have to process while unavailable is bounded. This puts an upper
		// limit on our time-to-recovery and makes operational management simple.

		const chainLatestBlock = await opts.node.request({
			params: ["latest", false],
			method: "eth_getBlockByNumber",
		});

		const unfinalized = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
			onBlockAdded: async (head) => {
				try {
					log.debug("Received unfinalized head");

					// We intentionally do not perform retries here. It makes more sense to improve the resiliency of
					// tip indexing by deploying more realtime clients. Three clients means it at least three requests
					// attempt to process the latest block. Concurrency control mechanisms on the indexer ensure that
					// only one of these requests actually write data to storage

					await opts.indexer.request({
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
						() => opts.indexer.request({ method: "public_deleteReorganisedHead", params: [{ chain, ...head }] }), //
						4,
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

		await opts.node.subscribe("newHeads", async (head) => {
			await unfinalized.reconcile({ hash: head.hash, number: head.number, parent_hash: head.parentHash }).catch((error) => {
				if (error instanceof Error) {
					log.error(`Failed to reconcile unfinalized head: ${error.message}`);
				}
			});
		});

		log.debug("Subscribed unfinalized chain to new heads");

		// Now that we are successfully processing the tip of the chain. We now need to index finalized blocks. This is done
		// in two steps: firstly whenever we receive a new batch of finalized blocks we process them in parallel, second we
		// attempt to finalize the work done by sending all heads between the indexer and chain finalized heights.

		const initialIndexerFinalizedHeight = await opts.indexer.request({
			params: [chain],
			method: "public_getFinalizedHeight",
		});

		const [chainFinalizedBlock, indexerFinalizedBlock] = await Promise.all([
			opts.node.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }),
			opts.node.request({ method: "eth_getBlockByNumber", params: [numberToHex(initialIndexerFinalizedHeight), false] }),
		]);

		const indexer = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
		});

		log.debug(`Indexer finalized (${initialIndexerFinalizedHeight}) and with tip (${hexToNumber(chainLatestBlock.number)})`);

		await indexer.reconcile({
			hash: indexerFinalizedBlock.hash,
			number: indexerFinalizedBlock.number,
			parent_hash: indexerFinalizedBlock.parentHash,
		});

		// This can be an expensive operation, especially if we are just recovering from downtime, because we must first
		// connect the last indexer finalized block with the last chain finalized block. This forces the realtime client
		// to reconstruct the entire indexer unfinalized chain locally before any requests are made to the indexer.

		await indexer.reconcile({
			hash: chainLatestBlock.hash,
			number: chainLatestBlock.number,
			parent_hash: chainLatestBlock.parentHash,
		});

		log.debug("Reconciled local indexer chain");

		await opts.node.subscribe("newHeads", async (head) => {
			await indexer.reconcile({ hash: head.hash, number: head.number, parent_hash: head.parentHash }).catch((error) => {
				if (error instanceof Error) {
					log.debug(`Failed to reconcile latest indexer head: ${error.message}`);
				}
			});
		});

		log.debug("Subscribed indexer chain to new heads");

		// writeFinalizedHead is responsible for processing new finalized heads in parallel

		let chainFinalizedHeight = hexToNumber(chainFinalizedBlock.number);

		async function writeFinalizedHead(nextFinalizedBlock: Head) {
			const nextFinalizedHeight = hexToNumber(nextFinalizedBlock.number);

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

					await opts.indexer.request({
						params: [head],
						method: "public_writeFinalizedHead",
					});

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

			await unfinalized.prune(nextFinalizedBlock);
		}

		async function poll() {
			try {
				log.debug("Polling for finalized height...");

				const finalizedBlock = await opts.node.request({
					method: "eth_getBlockByNumber",
					params: ["finalized", false],
				});

				await writeFinalizedHead({
					hash: finalizedBlock.hash,
					number: finalizedBlock.number,
					parent_hash: finalizedBlock.parentHash,
				});
			} catch (error) {
				if (error instanceof Error) {
					log.error(`Failed to reconcile finalized head: ${error.message}`);
				}
			}
		}

		setInterval(poll, POLLING_INTERVAL_MS);

		log.debug("Started polling finalized height");
	});

	promise.catch((error) => {
		if (error instanceof Error) {
			log.error(`Failed to initialise realtime client: ${error.message}`);
		}
	});
}

export { realtime };
