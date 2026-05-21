import { IndexerRpc, NodeRpc } from "./rpc";
import type { Transport } from "./transport";
import { assert, createLogger, hexToNumber, iife, isHexEqual, mutex, retry } from "./utils";

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
		const parentBlock = await retry(() => opts.getBlockByHash(newBlock.parentHash), 5);

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
	/** Connection to a blockchain node */
	node: Transport<NodeRpc>;
	/** Connection to a univo indexer */
	indexer: Transport<IndexerRpc>;
};

function realtime(opts: RealtimeOptions) {
	const log = createLogger({ quiet: opts.quiet ?? false });

	const promise = iife(async () => {
		let pending: Head[] = [];

		const chain = await opts.node.request({ method: "eth_chainId", params: [] });

		const [latestBlock, finalizedStartBlock] = await Promise.all([
			opts.node.request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
			opts.indexer.request({ method: "public_getUnfinalizedHeight", params: [chain] }),
		]);

		async function getBlockByHash(hash: `0x${string}`) {
			const block = await opts.node.request({
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
					// will spam requests. We need a strategy for queueing requests for new heads. It's okay to drop
					// unfinalised heads if the queue gets too big

					const heads = pending.concat(head);

					await opts.indexer.request({ method: "public_writeUnfinalizedHeads", params: [heads] });

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
					await retry(() => opts.indexer.request({ method: "public_deleteReorganisedHead", params: [head] }), 2);
				} catch {
					log.warn("Failed to write reorganised head");
				}
			},
		});

		// TODO
		// This starts from the indexer state. As the chain finalizes we iterate over all the finalized
		// blocks less than or equal to the finalized chain and deliver them to the finalized endpoint.
		// If successful we can drop all blocks sent from the unfinalized chain

		const indexer = defineBlockchain({
			getBlockByHash,
			quiet: opts.quiet ?? false,
		});

		await opts.node.subscribe("newHeads", async (head) => {
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
				const block = await opts.node.request({
					method: "eth_getBlockByNumber",
					params: ["finalized", false], // We don't need transaction receipts
				});

				// We already have the chain state local to construct the finalized chain so all
				// we have to do is iterate over the latest chain reconciling blocks less than
				// the latest finalized block

				for (const head of latest.chain) {
					if (hexToNumber(head.number) <= hexToNumber(block.number)) {
						await indexer.reconcile(head);
					}
				}
			} catch {
				log.error("Failed to reconcile finalized head");
			}
		}

		setInterval(polling, POLLING_INTERVAL_MS);
	});

	promise.catch(() => {
		log.error(`Failed to initialise realtime client for indexer ${opts.indexer}`);
	});
}

export { realtime };
