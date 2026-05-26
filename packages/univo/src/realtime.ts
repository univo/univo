import { IndexerRpc, NodeRpc } from "./rpc";
import type { Transport } from "./transport";
import { createLogger, hexToNumber, iife, isHexEqual, mutex, numberToHex, retry } from "./utils";

/**
 * Blockchain -----------------------------------------------------------------------------------------------------------------------------------
 */

const MAX_LENGTH = 10_000;

type Head = {
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
			// TODO
			// Remove blocks should be exposed to the consumer. If we have to recover from downtime that is larger than the maximum
			// length allowed we will be unable to recover.

			chain.shift();
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

		if (block === undefined) {
			throw new Error("Expected non-empty chain when retrieving latest block");
		}

		return block;
	}

	function getOldestBlock() {
		const block = chain[0];

		if (block === undefined) {
			throw new Error("Expected non-empty chain when retrieving oldest block");
		}

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
		const parentBlock = await retry(() => opts.getBlockByHash(newBlock.parentHash), 5);

		if (parentBlock === null) {
			throw new Error(`Failed to fetch parent block ${hexToNumber(newBlock.number)} ${newBlock.parentHash.slice(0, 16)}`);
		}

		if (!isHexEqual(parentBlock.hash, newBlock.parentHash)) {
			throw new Error("Expected block hashes to match");
		}

		await reconcile(parentBlock); // Reconcile up to the parent block
		return await reconcile(newBlock); // Finally we add this block
	}

	// TODO: Convert the mutex to use a queue

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
	/**
	 * Silences all logs including errors.
	 *
	 * Logs are emitted based on the environment LOG_LEVEL. Set `quiet: true` to surpress all logs.
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
	 * Must use the `http` transport protocol from `univo/transport`
	 */
	indexer: Transport<IndexerRpc, "http">;
};

function realtime(opts: RealtimeOptions) {
	const log = createLogger({ quiet: opts.quiet ?? false });

	const getBlockByHash = async (hash: `0x${string}`) => {
		return await opts.node.request({ method: "eth_getBlockByHash", params: [hash, false] });
	};

	const getLatestBlock = async () => {
		return await opts.node.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
	};

	const getChainFinalizedBlock = async () => {
		return await opts.node.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
	};

	const getIndexerFinalizedBlock = async (chain: `0x${string}`) => {
		const height = await opts.indexer.request({ method: "public_getFinalizedHeight", params: [chain] });
		return await opts.node.request({ method: "eth_getBlockByNumber", params: [numberToHex(height), false] });
	};

	const promise = iife(async () => {
		log.debug("Initialising realtime client for indexer");

		const chain = await opts.node.request({ method: "eth_chainId", params: [] });

		log.debug(`Determined chain identifier for connected node: ${hexToNumber(chain)}`);

		const [latestBlock, chainFinalizedBlock, indexerFinalizedBlock] = await Promise.all([
			getLatestBlock(),
			getChainFinalizedBlock(), //
			getIndexerFinalizedBlock(chain),
		]);

		let pending: Head[] = [];

		const latest = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
			onBlockAdded: async (head) => {
				try {
					// TODO
					// The primary improvement to this retry method is that if the queue gets too large we might DDOS
					// the endpoint by forcing it to load too many blocks at once. Moreover, this function doesn't run
					// under any type of mutex so if the request takes longer than when we receive the next block we
					// will spam requests. We need a strategy for queueing requests for new heads. It's okay to drop
					// unfinalised heads if the queue gets too big. They will be retried on finalization

					pending.push(head);

					const heads = pending.map((head) => ({ chain, ...head }));

					await opts.indexer.request({ method: "public_writeUnfinalizedHeads", params: [heads] });

					log.debug(`Delivered ${heads.length} unfinalized heads`);

					pending = pending.filter((head) => {
						return !heads.some((_head) => {
							return isHexEqual(head.hash, _head.hash);
						});
					});
				} catch {
					log.warn("Failed to write heads");
				}
			},
			onBlockReorganised: async (head) => {
				try {
					// We use a simple retry here because reorganised blocks aren't common so this isn't likely to cause
					// some type of thundering herd on the indexer server.

					await retry(() => opts.indexer.request({ method: "public_deleteReorganisedHead", params: [{ chain, ...head }] }), 2);
				} catch {
					log.warn("Failed to write reorganised head");
				}
			},
		});

		await latest.reconcile(latestBlock);

		log.debug("Reconciled latest block...");

		// Now that are chains are ready for processing we attach the subscribers for new blocks. As soon as the client
		// initialises we want the indexer to start receiving the tip of the chain.

		await opts.node.subscribe("newHeads", async (head: Head) => {
			try {
				await latest.reconcile(head);
			} catch {
				log.error("Failed to reconcile latest head");
			}
		});

		log.debug("Subscribed to latest blocks");

		// For correctness, we must also then send all finalised blocks from the last known finalised block from the indexer.
		// First we attach the indexer finalized block and then we attach the latest canonical finalized block. This will
		// reconstruct the entire canonical finalized chain locally

		let lastFinalizedHeight = hexToNumber(indexerFinalizedBlock.number);

		log.debug(`Indexer last finalized at ${lastFinalizedHeight}, chain at ${hexToNumber(chainFinalizedBlock.number)}`);

		const finalized = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
		});

		await finalized.reconcile(indexerFinalizedBlock);
		await finalized.reconcile(chainFinalizedBlock);

		log.debug("Reconciled finalized chain...");

		// After we have fully constructed the finalized chain we set up a handler to process when new blocks finalize. Right
		// now there exists no subscription for this so we have to poll. When new blocks finalize we send as many heads as
		// possible connecting the latest finalized block indexed versus new blocks finalized on chain

		const poll = async () => {
			try {
				// This uses a natural retry method. If the request fails we never update the finalized height. If successful
				// we will update it and safely remove all finalized blocks processed from the next request

				const finalizedBlock = await opts.node.request({
					method: "eth_getBlockByNumber",
					params: ["finalized", false], //
				});

				const finalizedHeight = hexToNumber(finalizedBlock.number);

				if (finalizedHeight === lastFinalizedHeight) {
					return log.debug("Chain finalized height equal to indexer finalised height, ignoring...");
				}

				log.debug(`Received new chain height ${finalizedHeight} with last indexer height ${lastFinalizedHeight}`);

				const heads = finalized.chain
					.filter((head) => {
						if (hexToNumber(head.number) > finalizedHeight) return false;
						if (hexToNumber(head.number) < lastFinalizedHeight) return false;
						return true;
					})
					.map((head) => {
						return { chain, ...head };
					});

				if (heads.length === 0) {
					return log.debug("No new finalized heads to deliver, ignoring...");
				}

				await opts.indexer.request({ method: "public_writeFinalizedHeads", params: [heads] });

				log.debug(`Delivered ${heads.length} finalized head(s)`);

				lastFinalizedHeight = hexToNumber(finalizedBlock.number);
			} catch {
				log.error("Failed to reconcile finalized head");
			}
		};

		// Execute once and then run on an interval

		await poll();

		setInterval(poll, POLLING_INTERVAL_MS);

		log.debug("Start polling finalized height");
	});

	promise.catch(() => {
		log.error("Failed to initialise realtime client");
	});
}

export { realtime };
