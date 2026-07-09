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
	const log = createLogger({ quiet: opts.quiet ?? false, prefix: "[realtime]" });

	const getBlockByHash = async (hash: `0x${string}`) => {
		const block = await opts.node.request({ method: "eth_getBlockByHash", params: [hash, false] });

		return { number: block.number, hash: block.hash, parent_hash: block.parentHash };
	};

	const promise = iife(async () => {
		log.debug("Initialising realtime client for indexer");

		const chain = await opts.node.request({ method: "eth_chainId", params: [] });

		log.debug(`Determined chain identifier for connected node: ${hexToNumber(chain)}`);

		const [latestBlock, initialIndexerHeight] = await Promise.all([
			opts.node.request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
			opts.indexer.request({ method: "public_getFinalizedHeight", params: [chain] }),
		]);

		const latest = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
			onBlockAdded: async (head) => {
				try {
					log.debug("Received unfinalized head");

					await retry(() => opts.indexer.request({ method: "public_writeUnfinalizedHead", params: [{ chain, ...head }] }), 2);

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

					await retry(() => opts.indexer.request({ method: "public_deleteReorganisedHead", params: [{ chain, ...head }] }), 2);

					log.debug("Delivered reorganised head");
				} catch (error) {
					if (error instanceof Error) {
						log.warn(`Failed to write reorganised head: ${error.message}`);
					}
				}
			},
		});

		await latest.reconcile({
			hash: latestBlock.hash,
			number: latestBlock.number,
			parent_hash: latestBlock.parentHash,
		});

		// Now we attach the subscribers for new blocks because we want the indexer to receive the tip of the chain immediately

		await opts.node.subscribe("newHeads", async (head) => {
			await latest.reconcile({ hash: head.hash, number: head.number, parent_hash: head.parentHash }).catch((error) => {
				if (error instanceof Error) {
					log.error(`Failed to reconcile latest head: ${error.message}`);
				}
			});
		});

		log.debug("Subscribed latest chain to new heads");

		// For correctness, we must also then send all finalised blocks from the last known finalised block from the indexer.
		// First we attach the indexer finalized block and then we attach the latest block to reconstruct the entire chain

		const indexer = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
		});

		log.debug(`Indexer last finalized at ${initialIndexerHeight}, reconciling local chain...`);

		const indexerBlock = await opts.node.request({
			method: "eth_getBlockByNumber",
			params: [numberToHex(initialIndexerHeight), false],
		});

		await indexer.reconcile({
			hash: indexerBlock.hash,
			number: indexerBlock.number,
			parent_hash: indexerBlock.parentHash,
		});

		await indexer.reconcile({
			hash: latestBlock.hash,
			number: latestBlock.number,
			parent_hash: latestBlock.parentHash,
		});

		log.debug("Reconciled local indexer chain");

		// After we have fully constructed the indexer chain we set up a handler to process when new blocks finalize. Right
		// now there exists no subscription for this so we have to poll. When new blocks finalize we send as many heads as
		// possible connecting the latest finalized block indexed versus new blocks finalized on chain

		await opts.node.subscribe("newHeads", async (head) => {
			await indexer.reconcile({ hash: head.hash, number: head.number, parent_hash: head.parentHash }).catch((error) => {
				if (error instanceof Error) {
					log.debug(`Failed to reconcile latest indexer head: ${error.message}`);
				}
			});
		});

		log.debug("Subscribed indexer chain to new heads");

		let indexerHeight = initialIndexerHeight;

		const poll = async () => {
			try {
				log.debug("Polling for finalized height...");

				// This uses a natural retry method. If the request fails we never update the finalized height. If successful
				// we will update it and safely remove all finalized blocks processed from the next request

				const finalizedBlock = await opts.node.request({
					method: "eth_getBlockByNumber",
					params: ["finalized", false],
				});

				const finalizedHeight = hexToNumber(finalizedBlock.number);

				log.debug(`Finalized chain height ${finalizedHeight} and indexer height ${indexerHeight}`);

				const newHeads = indexer.chain
					.filter((head) => {
						if (hexToNumber(head.number) > finalizedHeight) {
							return false;
						}

						if (hexToNumber(head.number) > indexerHeight) {
							return true;
						}

						return false;
					})
					.map((head) => {
						return { chain, ...head };
					});

				if (newHeads.length === 0) {
					return log.debug("No new finalized heads to deliver, ignoring...");
				}

				log.debug(`Delivering ${newHeads.length} finalized head(s)...`);

				await opts.indexer.request({
					params: [newHeads],
					method: "public_writeFinalizedHeads",
					signal: AbortSignal.timeout(Number.POSITIVE_INFINITY),
				});

				log.debug(`Delivered ${newHeads.length} finalized head(s)`);

				indexerHeight = hexToNumber(finalizedBlock.number);

				log.debug(`Updated indexer height to ${indexerHeight}`);

				// After successfully processing all blocks less than the indexer height we can safely prune our local chains
				// and remove all locally stored blocks less than the indexer finalized height

				await indexer.prune({
					number: finalizedBlock.number,
					hash: finalizedBlock.hash,
					parent_hash: finalizedBlock.parentHash,
				});

				await latest.prune({
					number: finalizedBlock.number,
					hash: finalizedBlock.hash,
					parent_hash: finalizedBlock.parentHash,
				});
			} catch (error) {
				if (error instanceof Error) {
					log.error(`Failed to reconcile finalized head: ${error.message}`);
				}
			} finally {
				setTimeout(poll, POLLING_INTERVAL_MS);
			}
		};

		await poll();

		log.debug("Started polling finalized height");
	});

	promise.catch((error) => {
		if (error instanceof Error) {
			log.error(`Failed to initialise realtime client: ${error.message}`);
		}
	});
}

export { realtime };
