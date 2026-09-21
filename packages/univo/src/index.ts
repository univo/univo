import * as viem from "viem";

import { local } from "./transport";
import { createServer } from "./server";
import type { IndexerRpc } from "./rpc";
import { version } from "../package.json";
import type { Storage } from "./metadata";
import { AdapterError } from "./metadata/adapters";
import { catchException, createException } from "./exceptions";
import { compress, createLogger, decoder, decompress, normalizeHex, retry, isHexEqual } from "./utils";

/**
 * Block -----------------------------------------------------------------------------------------------------------------------------------
 */

// This is the minimum set of block fields univo needs to function. These are mostly required to allow to perform
// filter matching on a given block. We need to have _some_ agreed contract to able to understand the chain,
// the block, and log address and events. We also expect some methods so that we can verify these known methods
// originate from the intended block hash.

type Block = {
	eth_chainId: `0x${string}`;
	eth_getBlockByNumber: viem.RpcBlock<"latest", true>;
	eth_getBlockReceipts: viem.RpcTransactionReceipt[];
};

/**
 * Filters -----------------------------------------------------------------------------------------------------------------------------------
 */

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
	if (viem.hexToNumber(block.eth_chainId) === filter.chain) return true;
	return false;
};

const fromBlockValid: MatchFilter = (block, filter) => {
	if (viem.hexToNumber(block.eth_getBlockByNumber.number) >= filter.fromBlock) return true;
	return false;
};

const toBlockValid: MatchFilter = (block, filter) => {
	if (filter.toBlock === undefined) return true;
	if (viem.hexToNumber(block.eth_getBlockByNumber.number) <= filter.toBlock) return true;
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

/**
 * Events -----------------------------------------------------------------------------------------------------------------------------------
 */

type Event<TBlock, TEvent> = {
	/**
	 * A human-readable identifier for the event.
	 */
	id: string;

	/**
	 * Filters let you define what specific blocks you want this event to index.
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
		delete: (events: TEvent[]) => Promise<void>;
	};
};

/**
 * Actions -----------------------------------------------------------------------------------------------------------------------------------
 */

type Action<TBlock, TEvent> = {
	/**
	 * A human-readable identifier for the action.
	 */
	id: string;

	/**
	 * The on-chain event that should invoke this action.
	 */
	event: Event<TBlock, TEvent>;

	/**
	 * The action you want to execute when the event _finalizes_ on-chain.
	 *
	 * Actions are processed during realtime indexing only and are never invoked during historical
	 * backfills. Common actions include payment notifications for confirming payments or customer
	 * deposits, transaction monitoring for KYC/AML compliance tracking, DeFi protocol monitoring,
	 * or wallet activity notifications or alerts.
	 *
	 * Actions may be invoked multiple times. It is important that your application code is
	 * resilient to this by making use of an idempotency key (usually the id of the event passed
	 * to your handler).
	 *
	 * Actions can be extremely powerful when combined with a durable execution framework like
	 * Temporal, Inngest, Trigger.dev, Cloudflare Workflows, or Restate.dev to perform more
	 * advanced workflows that allow you to chain together multiple steps and handle retries.
	 *
	 * Actions operate with at-least-once delivery. This means that your actions may be invoked
	 * multiple times. It is important that your handler is resilient to this by making use of an
	 * idempotency key (usually the identifier in the event passed to your handler). We guarantee
	 * that the indexer will not finalize a given block until it achieves a non-erroring execution
	 * from your action.
	 */
	handler: (event: TEvent) => Promise<void> | void;
};

/**
 * Indexer -----------------------------------------------------------------------------------------------------------------------------------
 */

type Head = {
	hash: `0x${string}`;
	chain: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
};

type PartialHead = {
	chain: `0x${string}`;
	number: string;
	hash?: `0x${string}`;
	parent_hash?: `0x${string}`;
};

type Metadata = {
	version: string;
	language: string;
};

type Result = {
	status: string;
	event_id: string;
	hash: `0x${string}`;
	chain: `0x${string}`;
	number: `0x${string}`;
	parent_hash: `0x${string}`;
	created_at: number;
};

type Manifest = {
	finalized_block_height: number;
	finalized_block_hash: `0x${string}`;
	next_finalized_height: number;
	updated_at: number;
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
	 * Functionally, storing metadata is fundamental to ensure the correct operation of your indexer. It
	 * ensures that you indexer recovers from downtime and ensures that all blocks are processed correctly during
	 * chain reorganisations.
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
	/**
	 * A web standard HTTP request handler. This is the entrypoint to your indexer and allows it to be deployed
	 * to your framework of choice so that it can receive requests and process responses.
	 */
	fetch: (req: Request) => Promise<Response>;

	/**
	 * Define on-chain events you want to record in your off-chain storage system.
	 */
	event: <TEvent>(event: Event<TBlock, TEvent>) => Event<TBlock, TEvent>;

	/**
	 * Perform fire-and-forget effects in response to on-chain events.
	 */
	action: <TEvent>(action: Action<TBlock, TEvent>) => Action<TBlock, TEvent>;
};

function defineIndexer<TBlock extends Block>(opts: IndexerOptions<TBlock>) {
	const log = createLogger({ quiet: opts.quiet ?? false, prefix: "[indexer]" });

	// We batch events based on the provided storage function. This is an optimisation that allows distinct
	// events that share the same storage adapter to be combined into the same batch for upsert.

	const allEvents: Event<any, any>[] = [];
	const eventsGroupedByStorageMap = new Map<Event<any, any>["storage"], Event<any, any>[]>();

	// Actions

	const allActions: Action<any, any>[] = [];

	/**
	 * Fetches a block using the provided `getBlock` function. Handles retries. We accept a partial head,
	 * sometimes want the canonical block using only the block number. If a hash and/or parent hash is
	 * provided we will ensure that they match the block returned
	 */
	async function getBlockFromChain(head: PartialHead) {
		const block = await opts.getBlock({ chain: head.chain, number: head.number });

		if (block === null) {
			throw new Error("Provided `getBlock` function returned null");
		}

		// Verify the returned block matches the expected hash and/or parent hash requested

		if (typeof head.hash === "string") {
			if (!isHexEqual(head.hash, block.eth_getBlockByNumber.hash)) {
				throw new Error("Block returned unexpected block hash");
			}
		}

		if (typeof head.parent_hash === "string") {
			if (!isHexEqual(head.parent_hash, block.eth_getBlockByNumber.parentHash)) {
				throw new Error("Block returned unexpected parent hash");
			}
		}

		// Verify integrity of the RPC response

		verifyBlockHashes(block);
		verifyLogIndicies(block);
		verifyReceiptsRoot(block);
		verifyTransactionsRoot(block);
		verifyTransactionIndicies(block);
		verifyTransactionGasUsage(block);

		return block;
	}

	/**
	 * Accepts an RPC block and verifies that all block hashes on the response are consistent.
	 */
	function verifyBlockHashes(block: Block) {
		const blockHash = block.eth_getBlockByNumber.hash;
		const transactions = block.eth_getBlockByNumber.transactions;

		for (const transaction of transactions) {
			if (!isHexEqual(blockHash, transaction.blockHash)) {
				throw new Error("Block returned transaction with unexpected block hash");
			}
		}

		for (const receipt of block.eth_getBlockReceipts) {
			if (!isHexEqual(block.eth_getBlockByNumber.hash, receipt.blockHash)) {
				throw new Error("Block returned receipt with unexpected block hash");
			}

			const transactionIndex = viem.hexToNumber(receipt.transactionIndex);
			const transaction = transactions[transactionIndex];

			if (transaction === undefined || !isHexEqual(transaction.hash, receipt.transactionHash)) {
				throw new Error("Block returned receipt with unexpected transaction hash");
			}

			for (const entry of receipt.logs) {
				if (!isHexEqual(blockHash, entry.blockHash)) {
					throw new Error("Block returned log with unexpected block hash");
				}

				if (!isHexEqual(receipt.transactionHash, entry.transactionHash)) {
					throw new Error("Block returned log with unexpected transaction hash");
				}
			}
		}
	}

	/**
	 * Accepts an RPC block and verifies all log indicies are contiguous
	 */
	function verifyLogIndicies(block: TBlock) {
		let expectedLogIndex = 0n;

		for (const receipt of block.eth_getBlockReceipts) {
			for (const entry of receipt.logs) {
				if (viem.hexToBigInt(entry.logIndex) !== expectedLogIndex) {
					throw new Error("Block returned non-contiguous log indices");
				}

				expectedLogIndex++;
			}
		}
	}

	/**
	 * Reconstructs the receipts trie and verifies it matches the block's receipts root.
	 */
	function verifyReceiptsRoot(block: TBlock) {
		const receiptsRoot = calculateTrieRoot(block.eth_getBlockReceipts.map(serializeReceipt));

		if (!isHexEqual(block.eth_getBlockByNumber.receiptsRoot, receiptsRoot)) {
			throw new Error("Block returned receipts that do not match the block receipts root");
		}
	}

	function calculateTrieRoot(values: Uint8Array[]): viem.Hex {
		if (values.length === 0) {
			return viem.keccak256(viem.toRlp(new Uint8Array(), "bytes"));
		}

		const entries = values.map((value, index) => ({
			key: bytesToNibbles(viem.toRlp(quantityToBytes(BigInt(index)), "bytes")),
			value,
		}));

		return viem.keccak256(viem.toRlp(encodeTrieNode(entries), "bytes"));
	}

	type RlpValue = Uint8Array | RlpValue[];

	function trieNodeReference(node: RlpValue[]): RlpValue {
		const encoded = viem.toRlp(node, "bytes");
		return encoded.length < 32 ? node : viem.hexToBytes(viem.keccak256(encoded));
	}

	function encodeTrieNode(entries: { key: number[]; value: Uint8Array }[], depth = 0): RlpValue[] {
		if (entries.length === 1) {
			const entry = entries[0]!;
			return [encodePath(entry.key.slice(depth), true), entry.value];
		}

		let shared = 0;

		while (entries.every((entry) => entry.key[depth + shared] === entries[0]!.key[depth + shared])) {
			shared++;
		}

		if (shared > 0) {
			const child = encodeTrieNode(entries, depth + shared);
			return [encodePath(entries[0]!.key.slice(depth, depth + shared), false), trieNodeReference(child)];
		}

		const children: RlpValue[] = Array.from({ length: 17 }, () => new Uint8Array());

		for (let nibble = 0; nibble < 16; nibble++) {
			const matching = entries.filter((entry) => entry.key[depth] === nibble);

			if (matching.length > 0) {
				children[nibble] = trieNodeReference(encodeTrieNode(matching, depth + 1));
			}
		}

		const value = entries.find((entry) => entry.key.length === depth)?.value;

		if (value !== undefined) {
			children[16] = value;
		}

		return children;
	}

	function encodePath(path: number[], leaf: boolean) {
		const odd = path.length % 2 === 1;
		const nibbles = odd ? [leaf ? 3 : 1, ...path] : [leaf ? 2 : 0, 0, ...path];
		const bytes = new Uint8Array(nibbles.length / 2);

		for (let index = 0; index < nibbles.length; index += 2) {
			bytes[index / 2] = (nibbles[index]! << 4) | nibbles[index + 1]!;
		}

		return bytes;
	}

	function quantityToBytes(value: viem.Hex | bigint) {
		const number = typeof value === "bigint" ? value : viem.hexToBigInt(value);
		return number === 0n ? new Uint8Array() : viem.numberToBytes(number);
	}

	function bytesToNibbles(value: Uint8Array) {
		return Array.from(value).flatMap((byte) => [byte >> 4, byte & 0x0f]);
	}

	function serializeReceipt(receipt: viem.RpcTransactionReceipt) {
		const outcome = receipt.status === undefined ? viem.hexToBytes(receipt.root!) : quantityToBytes(receipt.status);

		const fields = [
			outcome,
			quantityToBytes(receipt.cumulativeGasUsed),
			viem.hexToBytes(receipt.logsBloom),
			receipt.logs.map((log) => [viem.hexToBytes(log.address), log.topics.map(viem.hexToBytes), viem.hexToBytes(log.data)]),
		];

		const encoded = viem.toRlp(fields, "bytes");

		if (!viem.isHex(receipt.type)) {
			throw new Error(`Unsupported receipt type ${receipt.type}`);
		}

		const type = viem.hexToBigInt(receipt.type);

		return type === 0n ? encoded : viem.concatBytes([Uint8Array.of(Number(type)), encoded]);
	}

	/**
	 * Reconstructs the transactions trie and verifies it matches the block's transactions root.
	 */
	function verifyTransactionsRoot(block: TBlock) {
		const transactions = block.eth_getBlockByNumber.transactions.map((transaction) => {
			const { input, ...formatted } = viem.formatTransaction(transaction);

			// Some RPC providers attach the network chain ID to pre-EIP-155 transactions. Their v value
			// remains authoritative; retaining chainId would incorrectly replay-protect the serialization.

			if (formatted.type === "legacy" && (formatted.v === 27n || formatted.v === 28n)) {
				formatted.chainId = undefined;
			}

			const signature =
				formatted.type === "legacy"
					? { r: formatted.r, s: formatted.s, v: formatted.v }
					: { r: formatted.r, s: formatted.s, yParity: formatted.yParity };

			const serialized = viem.serializeTransaction(
				{ ...formatted, data: input } as viem.TransactionSerializable, //
				signature as viem.Signature,
			);

			if (!isHexEqual(transaction.hash, viem.keccak256(serialized))) {
				throw new Error(`Transaction ${transaction.hash} failed serialization check`);
			}

			return viem.hexToBytes(serialized);
		});

		const transactionsRoot = calculateTrieRoot(transactions);

		if (!isHexEqual(block.eth_getBlockByNumber.transactionsRoot, transactionsRoot)) {
			throw new Error("Block returned transactions that do not match the block transactions root");
		}
	}

	/**
	 * Accepts an RPC block and verifies all transaction indicies are contiguous
	 */
	function verifyTransactionIndicies(block: TBlock) {
		const receipts = block.eth_getBlockReceipts;
		const transactions = block.eth_getBlockByNumber.transactions;

		if (transactions.length !== receipts.length) {
			throw new Error("Block returned different transaction counts");
		}

		for (let index = 0; index < transactions.length; index++) {
			const expectedIndex = BigInt(index);

			if (viem.hexToBigInt(transactions[index]!.transactionIndex) !== expectedIndex) {
				throw new Error("Block returned non-contiguous transaction indices");
			}

			if (viem.hexToBigInt(receipts[index]!.transactionIndex) !== expectedIndex) {
				throw new Error("Block returned non-contiguous transaction indices");
			}

			for (const entry of receipts[index]!.logs) {
				if (viem.hexToBigInt(entry.transactionIndex) !== expectedIndex) {
					throw new Error("Block returned log with unexpected transaction index");
				}
			}
		}
	}

	/**
	 * Accepts an RPC block and verifies the cumulative used adds up transaction by transaction,
	 * and never exceeds the gas limit
	 */
	function verifyTransactionGasUsage(block: TBlock) {
		const gasLimit = viem.hexToBigInt(block.eth_getBlockByNumber.gasLimit);
		const blockGasUsed = viem.hexToBigInt(block.eth_getBlockByNumber.gasUsed);

		if (blockGasUsed > gasLimit) {
			throw new Error("Block returned gas used greater than the block gas limit");
		}

		let cumulativeGasUsed = 0n;

		for (const receipt of block.eth_getBlockReceipts) {
			cumulativeGasUsed += viem.hexToBigInt(receipt.gasUsed);

			if (viem.hexToBigInt(receipt.cumulativeGasUsed) !== cumulativeGasUsed) {
				throw new Error("Block returned inconsistent cumulative gas used");
			}

			if (cumulativeGasUsed > gasLimit) {
				throw new Error("Block returned cumulative gas used greater than the block gas limit");
			}
		}

		if (cumulativeGasUsed !== blockGasUsed) {
			throw new Error("Block returned inconsistent gas used");
		}
	}

	async function getOrInitManifest(chain: `0x${string}`) {
		const path = `manifest/v1/${normalizeHex(chain)}`;

		const manifestRes = await opts.metadataStorage.adapter.get(path);

		let manifest: Manifest;

		if (manifestRes === null) {
			const block = await getBlockFromChain({ chain, number: "finalized" });

			const chainFinalizedHeight = viem.hexToNumber(block.eth_getBlockByNumber.number);

			const newManifest: Manifest = {
				finalized_block_height: chainFinalizedHeight,
				finalized_block_hash: block.eth_getBlockByNumber.hash,
				next_finalized_height: chainFinalizedHeight,
				updated_at: Date.now(),
			};

			await opts.metadataStorage.adapter.put(path, JSON.stringify(newManifest), { ifNoneMatch: "*" });

			manifest = newManifest;
		} else {
			manifest = JSON.parse(decoder.decode(manifestRes.body));
		}

		return manifest;
	}

	const public_getFinalizedHeight: IndexerRpc["request"]["public_getFinalizedHeight"] = async (chain) => {
		const manifest = await getOrInitManifest(chain);

		return manifest.finalized_block_height;
	};

	async function writeUnfinalizedBlock(block: TBlock) {
		// Process the unfinalized block

		const events_start = Date.now();

		const events = eventsGroupedByStorageMap.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

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
					log.error(`Failed to run your 'handler' for event ${event.id}`);

					throw error;
				}
			}

			if (batch.length > 0) {
				const start = Date.now();

				await retry(() => storage.upsert(batch), 2).catch((error) => {
					for (const event of grouped_events) {
						log.error(`Failed to run your 'upsert' handler for event ${event.id}`);
					}

					throw error;
				});

				for (const event of grouped_events) {
					log.debug(`Recorded ${batch.length} ${event.id} in ${Date.now() - start}ms`);
				}
			}
		});

		await Promise.all(events);

		log.debug(`Wrote events in ${Date.now() - events_start}ms`);

		// After upserting events we commit the unfinalized block to the metadata commits table. This is an
		// optimisation that allows the finalized handler to later determine if a block was processed correctly
		// and can therefore be skipped, improving throughput when finalizing.

		// Normally, this commit flag isn't enough on its own to prove an unfinalized block was correctly
		// processed. For example, when there are two concurrent requests for an unfinalized block number it is
		// always possible for one request to stall - while the other processes successfully - and then write
		// events to storage and fail to commit. Leaving our storage layer with mismatching events and commits!
		// Normally we would need some type of fencing to ensure the second concurrent request fails to write.

		// However, this is only true if those requests are committing distinct data, but in this case two
		// concurrent requests are most commonly committing the same data (the canonical block). So the only
		// time we can't prove correctness is when a block was reorganised because we can't determine the timing
		// of when the canonical and reorganised blocks were processed.

		// This means in the rare case of a chain reorganisation we have to process everything again in the
		// finalized handler to ensure correctness (slow) but in the common case we don't need to perform
		// any extra work (fast)

		const chain = normalizeHex(block.eth_chainId);
		const hash = normalizeHex(block.eth_getBlockByNumber.hash);
		const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
		const parentHash = normalizeHex(block.eth_getBlockByNumber.parentHash);

		const commitsKey = `commits/v1/${chain}/${number}/${hash}/${parentHash}`;
		const commitsValue = JSON.stringify({ hello: "world" });

		await opts.metadataStorage.adapter.put(commitsKey, commitsValue);
	}

	const public_writeUnfinalizedHead: IndexerRpc["request"]["public_writeUnfinalizedHead"] = async (head) => {
		log.debug("Received unfinalized head...");

		const blocksStart = Date.now();

		const [block, manifest] = await Promise.all([
			getBlockFromChain(head), //
			getOrInitManifest(head.chain),
		]);

		log.debug(`Loaded block in ${Date.now() - blocksStart}ms`);

		const indexerFinalizedHeight = manifest.finalized_block_height;

		// We must ensure each block is actually unfinalized to prevent an attack vector where a client could submit
		// the genesis block as unfinalized. Forcing our finalized handler to process the entire chain and effectively
		// stall indexing. We filter them out here and continue operating on unfinalized heads

		if (viem.hexToNumber(head.number) <= indexerFinalizedHeight) {
			return log.debug("Receiving finalized head, ignoring...");
		}

		// Before any blocks are processed they must be committed to the metadata storage write ahead log. This ensures we
		// have a record of the events that were upserted to storage so that they can be safely deleted later if the block
		// is ever reorganised out of the canonical chain.

		const metadata_start = Date.now();

		const chain = normalizeHex(block.eth_chainId);
		const hash = normalizeHex(block.eth_getBlockByNumber.hash);
		const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
		const parentHash = normalizeHex(block.eth_getBlockByNumber.parentHash);

		const blocksKey = `blocks/v1/${chain}/${number}/${hash}/${parentHash}`;
		const blocksValue = await compress(JSON.stringify(block));

		// This upsert is performed as a conditional PUT that will error if a block already exists in the WAL for
		// this height. This serves two purposes: it prevents overwriting data from other requests, and also acts as a
		// concurrency control mechanism. When an indexer has multiple realtime clients for the same chain, only the first
		// request received will succeed and all other requests will error (which we safely return OK to the client)

		const conditional = { ifNoneMatch: "*" } as const;

		const result = await opts.metadataStorage.adapter.put(blocksKey, blocksValue, conditional).catch((error) => {
			if (error instanceof AdapterError) {
				if (error.tag === "PreconditionFailed") {
					return null;
				}
			}

			throw error;
		});

		if (result === null) {
			return log.debug("Block already persisted to wal, ignoring...");
		}

		log.debug(`Persisted block to wal in ${Date.now() - metadata_start}ms`);

		await writeUnfinalizedBlock(block);
	};

	async function deleteReorganisedBlocksAndWriteCanonicalBlock(reorganised: TBlock[], canonical: TBlock) {
		const deletes = allEvents.map(async (event) => {
			// TODO
			// We intentionally ignore filters and basically perform an optimistic delete on events that might
			// have never been upserted. I make this choice because there is a time delay between upsert and delete,
			// it's possible for a new deployment to update the filters in this gap that would prevent the delete
			// from removing the upserted events if the filters were changed in just the right way

			const batch: any[] = [];

			try {
				for (const block of reorganised) {
					const events = event.handler(block);

					for (const event of events) {
						batch.push(event);
					}
				}
			} catch (error) {
				log.error(`Failed to run your 'handler' for event ${event.id}`);

				throw error;
			}

			if (batch.length === 0) {
				return;
			}

			await retry(() => event.storage.delete!(batch), 2).catch((error) => {
				log.error(`Failed to run your 'delete' handler for event ${event.id}`);

				throw error;
			});
		});

		await Promise.all(deletes);

		// When the events from a reorganised block have a distinct set of primary keys from the canonical block,
		// it makes cleanup simple because we are operating on a distinct set of events. For example, if we used
		// the block hash in PK identifier then there is no overlap. However, it is possible for an event to return
		// a set of events that share the same PK identifier. For example, if we used only the block number. In
		// the latter case it creates a timing issue, i.e. for our record to be correct we must ensure that we
		// perform a delete of the reorganised events _before_ we perform an upsert of the canonical events.
		// To solve this, we also write the canonical events _after_ deleting the reorganised events.

		const upserts = eventsGroupedByStorageMap.entries().map(async ([storage, grouped_events]) => {
			const batch: any[] = [];

			for (const event of grouped_events) {
				try {
					if (!event.filters.some((filter) => matchFilter(canonical, filter))) {
						continue;
					}

					const events = event.handler(canonical);

					for (const event of events) {
						batch.push(event);
					}
				} catch (error) {
					log.error(`Failed to run your 'handler' for event ${event.id}`);

					throw error;
				}
			}

			if (batch.length > 0) {
				await retry(() => storage.upsert(batch), 2).catch((error) => {
					for (const event of grouped_events) {
						log.error(`Failed to run your 'upsert' handler for event ${event.id}`);
					}

					throw error;
				});
			}
		});

		await Promise.all(upserts);
	}

	const public_deleteReorganisedHead: IndexerRpc["request"]["public_deleteReorganisedHead"] = async (head) => {
		log.debug(`Received reorganised head ${viem.hexToNumber(head.number)}`);

		// We load the reorganised block directly from metadata and bypass the `getBlockFromChainOrMetadata` helper
		// because if the block doesn't exist in metadata it means it was never processed and can safely return

		const chain = normalizeHex(head.chain);
		const number = normalizeHex(head.number, 16);
		const hash = normalizeHex(head.hash);
		const parentHash = normalizeHex(head.parent_hash);
		const blocksKey = `blocks/v1/${chain}/${number}/${hash}/${parentHash}`;

		// We load blocks via their block number. If this block was truly reorganised and is no longer part of the
		// canonical chain than this request should yield a block with a different block hash. This is our proof
		// that this block is no longer included in the chain and that it's safe to delete data associated with it

		const [blocksRes, canonicalBlock] = await Promise.all([
			opts.metadataStorage.adapter.get(blocksKey), //
			getBlockFromChain({ chain: head.chain, number: head.number }),
		]);

		if (blocksRes === null) {
			return log.debug("Reorganised block never/already processed");
		}

		const decompressedBlock = await decompress(blocksRes.body);
		const storedBlock = JSON.parse(decompressedBlock);

		if (isHexEqual(head.hash, canonicalBlock.eth_getBlockByNumber.hash)) {
			throw new Error("Attempted to delete canonical block");
		}

		// We know the block is not included in the canonical chain and we know that our storage system may have upserted
		// events with this block data. We use the block data to generate the same set of events that could have been
		// upserted and provide them to each events delete function

		await deleteReorganisedBlocksAndWriteCanonicalBlock([storedBlock], canonicalBlock);

		// After the above deletion occurs it is impossible for a malicious client to call `public_writeUnfinalizedHead`
		// with the reorganised block because it won't be retrievable from the chain. This guard guarantees that our
		// record of events will leave the canonical set and not the reorganised set.
	};

	async function writeFinalizedBlock(block: TBlock, actions: Action<any, any>[]) {
		// If the indexer hasn't defined any actions then there isn't actually any work to complete
		// on finalization, so this is an optimistic abort case to reduce costs.

		if (actions.length === 0) {
			return;
		}

		const chain = normalizeHex(block.eth_chainId);
		const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
		const hash = normalizeHex(block.eth_getBlockByNumber.hash);
		const parentHash = normalizeHex(block.eth_getBlockByNumber.parentHash);
		const prefix = `commits/v1/${chain}/${number}/${hash}/${parentHash}`;

		const promises = actions.map(async (action) => {
			// Even if the there were no events for this block that would invoke the action it's important that we still
			// mark the action as successful with a commit so that we don't cause the block to be processed again

			const events = action.event.filters.some((filter) => matchFilter(block, filter)) ? action.event.handler(block) : [];

			const promises = events.map(async (event) => {
				await retry(() => action.handler(event), 2).catch((error) => {
					log.error(`Failed to execute action ${action.id}`);

					throw error;
				});
			});

			const results = await Promise.allSettled(promises);

			// If we successfully invoked the action for all events we durably record a commit for this action id.
			// This acknowledges the work was completed without issue and can be safely skipped at finalization.
			// The commit will also run if there are no actual events to invoke the action for this block.

			const failure = results.find((result) => result.status === "rejected");

			if (failure !== undefined) {
				throw failure.reason;
			}

			// In general, the goal of this commit is to maximally acknowledge work processed at finalization. This
			// ensures that our finalization handler always remains fast by only having to re-do the minimum amount
			// of work. However, there are some cost trade-offs to consider here. We commit by block here, either we
			// invoke the action successfully for all events in this block, or we fail. We could commit by each actual
			// event but that could dramatically increase the cost of the metadata layer from increased writes

			const commitsKey = `${prefix}/action/${action.id}`;
			const commitsValue = JSON.stringify({ hello: "world" });

			await opts.metadataStorage.adapter.put(commitsKey, commitsValue);
		});

		await Promise.all(promises);
	}

	const public_writeFinalizedHead: IndexerRpc["request"]["public_writeFinalizedHead"] = async (head) => {
		log.debug("Received finalized head...");

		// If the indexer hasn't defined any actions then there isn't actually any work to complete
		// on finalization, so this is an optimistic abort case to reduce costs.

		if (allActions.length === 0) {
			return;
		}

		// Otherwise, we may have actions to run

		const blocksStart = Date.now();

		const [block, manifest, chainFinalizedBlock] = await Promise.all([
			getBlockFromChain(head),
			getOrInitManifest(head.chain),
			getBlockFromChain({ chain: head.chain, number: "finalized" }),
		]);

		log.debug(`Loaded block in ${Date.now() - blocksStart}ms`);

		const receivedHeight = viem.hexToNumber(head.number);
		const indexerFinalizedHeight = manifest.finalized_block_height;
		const chainFinalizedHeight = viem.hexToNumber(chainFinalizedBlock.eth_getBlockByNumber.number);

		if (receivedHeight <= indexerFinalizedHeight) {
			return log.debug(`Received finalized head (${receivedHeight}) below indexer height (${indexerFinalizedHeight})`);
		}

		if (receivedHeight > chainFinalizedHeight) {
			return log.error(`Received finalized head (${receivedHeight}) that has not finalized (${chainFinalizedHeight})`);
		}

		const chain = normalizeHex(block.eth_chainId);
		const number = normalizeHex(block.eth_getBlockByNumber.number, 16);
		const hash = normalizeHex(block.eth_getBlockByNumber.hash);
		const parentHash = normalizeHex(block.eth_getBlockByNumber.parentHash);
		const finalizedKey = `finalized/v1/${chain}/${number}/${hash}/${parentHash}`;
		const finalizedValue = JSON.stringify({ hello: "world" });

		// Finalized blocks can always be loaded from the chain, so this WAL only needs an empty marker.
		// The conditional put ensures that only one request can invoke actions for this block.

		const conditional = { ifNoneMatch: "*" } as const;

		const result = await opts.metadataStorage.adapter.put(finalizedKey, finalizedValue, conditional).catch((error) => {
			if (error instanceof AdapterError && error.tag === "PreconditionFailed") {
				return null;
			}

			throw error;
		});

		if (result === null) {
			return log.debug("Finalized block already persisted to wal, ignoring...");
		}

		// Given the head is not finalized by the indexer but finalized onchain, perform the associated actions for all events

		await writeFinalizedBlock(block, allActions);
	};

	// TODO
	// These should be exposed as configuration options. At the moment the key limit preventing us from finalizing
	// larger batches of blocks is for the case where we are recovering from downtime. The goal is for us to guarantee
	// that we can process a single batch within the lease, otherwise we will likely never be able to commit. If a user
	// is recovering from downtime they should set this to a smaller batch size to ensure that we process within a
	// single lease, but in steady operation this should really be 1000 or whatever the max LIST size returned by the
	// metadata storage adapter is. It should actually be slightly less than 1000 to accomodate for multiple blocks
	// at the same height

	const FINALIZATION_BATCH_SIZE = 32;
	const LEASE_DURATION_MS = 60 * 1000;

	// Note that there is only ever a finite amount of metadata garbage collection to perform so there exists no
	// attack vector where we wouldn't be able to clear enough garbage to ever escape the while loops

	async function getBlocksProcessedAndGarbageCollect(chain: `0x${string}`, finalizedHeight: number) {
		while (true) {
			// LIST blocks. Trailing slash is necessary to ensure chain ids 0x1 and 0x10 don't clash.

			// There is technically a correctness issue here where if we process more than 1000 blocks
			// for the same height we wouldn't return them all here and therefore wouldn't remove the
			// associated reorganised events. In practice I don't think there will be 1000 different
			// onchain forks so i'm not going to handle this case.

			const blocksKey = `blocks/v1/${normalizeHex(chain)}/`;

			const blocks = await opts.metadataStorage.adapter.list({ prefix: blocksKey, limit: 1000 });

			if (blocks.keys.length === 0) {
				return [];
			}

			// Perform garbage collection

			const garbageCollectionKeys = blocks.keys.filter((key) => {
				const [_, __, ___, number] = key.split("/") as [string, string, `0x${string}`, `0x${string}`];

				return viem.hexToNumber(number) <= finalizedHeight;
			});

			if (garbageCollectionKeys.length === 0) {
				return blocks.keys.map((key) => {
					const [_, __, ___, number, hash, parent_hash] = key.split("/") as [
						string,
						string,
						`0x${string}`,
						`0x${string}`,
						`0x${string}`,
						`0x${string}`,
					];

					return { chain, number, hash, parent_hash };
				});
			}

			const garbageCollectionPromises = garbageCollectionKeys.map(async (key) => {
				await opts.metadataStorage.adapter.delete(key);
			});

			await Promise.all(garbageCollectionPromises);
		}
	}

	async function getCommitsAndGarbageCollect(chain: `0x${string}`, finalizedHeight: number) {
		while (true) {
			// LIST commits. Trailing slash is necessary to ensure chain ids 0x1 and 0x10 don't clash.

			// TODO
			// It's possible that the number of commits for a given height exceed the 1000 limit if the
			// indexer has defined thousands of actions. In this case we wouldn't be able to verify that
			// all actions succeeded and we wouldn't be able to use our fast-path commit optimisation.

			const commitsKey = `commits/v1/${normalizeHex(chain)}/`;

			const commits = await opts.metadataStorage.adapter.list({ prefix: commitsKey, limit: 1000 });

			if (commits.keys.length === 0) {
				return [];
			}

			// Perform garbage collection

			const garbageCollectionKeys = commits.keys.filter((key) => {
				const [_, __, ___, number] = key.split("/") as [string, string, `0x${string}`, `0x${string}`];

				return viem.hexToNumber(number) <= finalizedHeight;
			});

			if (garbageCollectionKeys.length === 0) {
				return commits.keys.map((key) => {
					const [_, __, ___, number, hash, parent_hash, type, id] = key.split("/") as [
						string,
						string,
						`0x${string}`,
						`0x${string}`,
						`0x${string}`,
						`0x${string}`,
						"action" | undefined,
						string | undefined,
					];

					return { chain, number, hash, parent_hash, type, id };
				});
			}

			const garbageCollectionPromises = garbageCollectionKeys.map(async (key) => {
				await opts.metadataStorage.adapter.delete(key);
			});

			await Promise.all(garbageCollectionPromises);
		}
	}

	async function getBlockFromMetadataOrChain(head: Head) {
		const chain = normalizeHex(head.chain);
		const number = normalizeHex(head.number, 16);
		const hash = normalizeHex(head.hash);
		const parentHash = normalizeHex(head.parent_hash);
		const prefix = `blocks/v1/${chain}/${number}/${hash}/${parentHash}`;

		const object = await opts.metadataStorage.adapter.get(prefix);

		if (object !== null) {
			const block = await decompress(object.body);
			const parsed = JSON.parse(block);

			return parsed as TBlock;
		}

		return await getBlockFromChain(head);
	}

	const public_finalize: IndexerRpc["request"]["public_finalize"] = async (chain) => {
		const manifestKey = `manifest/v1/${normalizeHex(chain)}`;

		const [chainFinalizedBlock, manifestGetRes] = await Promise.all([
			getBlockFromChain({ chain, number: "finalized" }),
			opts.metadataStorage.adapter.get(manifestKey), //
		]);

		const chainFinalizedHeight = viem.hexToNumber(chainFinalizedBlock.eth_getBlockByNumber.number);

		if (manifestGetRes === null) {
			log.debug("No manifest file found");

			const manifest: Manifest = {
				finalized_block_height: chainFinalizedHeight,
				finalized_block_hash: chainFinalizedBlock.eth_getBlockByNumber.hash,
				next_finalized_height: chainFinalizedHeight,
				updated_at: Date.now(),
			};

			await opts.metadataStorage.adapter.put(manifestKey, JSON.stringify(manifest), { ifNoneMatch: "*" });

			return log.debug("Nothing to finalize, returning...");
		}

		const manifest = JSON.parse(decoder.decode(manifestGetRes.body)) as Manifest;

		// Check for a valid lease

		if (manifest.finalized_block_height !== manifest.next_finalized_height) {
			if (Date.now() - manifest.updated_at < LEASE_DURATION_MS) {
				return log.debug("Found valid lease, returning...");
			}

			log.debug("Found expired lease");
		}

		let indexerFinalizedBlockHeight = manifest.finalized_block_height;
		let indexerFinalizedBlockHash = manifest.finalized_block_hash;

		// Check if there is finalization work to be done

		if (indexerFinalizedBlockHeight >= chainFinalizedHeight) {
			return log.debug("Indexer already finalized, returning...");
		}

		// Attempt to acquire lease

		log.debug("Acquiring lease...");

		const updatedManifest: Manifest = {
			finalized_block_height: indexerFinalizedBlockHeight,
			finalized_block_hash: indexerFinalizedBlockHash,
			next_finalized_height: Math.min(chainFinalizedHeight, indexerFinalizedBlockHeight + FINALIZATION_BATCH_SIZE),
			updated_at: Date.now(),
		};

		// The following conditional ensures that our read-modify-update doesn't race against another
		// writer attempting to claim the lease. If we hit the precondition error we fail safely.

		const conditional = { ifMatch: manifestGetRes.etag };
		const manifestValue = JSON.stringify(updatedManifest);

		const manifestPutRes = await opts.metadataStorage.adapter.put(manifestKey, manifestValue, conditional).catch((error) => {
			if (error instanceof AdapterError && error.tag === "PreconditionFailed") {
				return null;
			}

			throw error;
		});

		if (manifestPutRes === null) {
			return log.debug("Failed to acquire lease, returning...");
		}

		let latestManifestEtag = manifestPutRes.etag;

		while (indexerFinalizedBlockHeight < chainFinalizedHeight) {
			// These can update on each batch iteration, usually just on the last iteration when the distance
			// between the indexer and chain finalized height is less than the default batch size

			const nextFinalizedHeight = Math.min(chainFinalizedHeight, indexerFinalizedBlockHeight + FINALIZATION_BATCH_SIZE);
			const finalizationBatchSize = nextFinalizedHeight - indexerFinalizedBlockHeight;

			// For each finalized block, our goal is to prove two things:
			// - The unfinalized block was correctly processed (all events and actions returned OK)
			// - The unfinalized block finalized onchain and was not reorganised
			// If we can prove those then we actually have no more work to perform for that block

			// First, we prove canonicality. To assert that a given block header actually finalised
			// on chain we must consult the finalized chain by loading that block by number and
			// comparing the returned block and parent hashes. To do this block by block is both
			// slow and expensive in terms of RPC costs. Like most optimisations, the key method to
			// improve speed and cost is batching. Instead, we load a block some length in the future
			// denoted by FINALIZATION_BATCH_SIZE from the last indexer finalized height and verify
			// it's canonical, then we perform a LIST over the blocks WAL. If we can connect this
			// future finalized block with our last indexer finalized height we can prove that all
			// blocks between these two "anchor" points are also canonical.

			// TODO
			// Unless recovering from down time, it's likely that nextFinalizedBlock is just the
			// chainFinalizedBlock loaded earlier. An RPC cost optimisation would be to detect
			// this in the common case and prevent duplicate loading

			const [nextFinalizedBlock, blocksProcessed] = await Promise.all([
				getBlockFromChain({ chain, number: viem.numberToHex(nextFinalizedHeight) }),
				getBlocksProcessedAndGarbageCollect(chain, indexerFinalizedBlockHeight),
			]);

			const nextFinalizedHead: Head = {
				chain,
				hash: nextFinalizedBlock.eth_getBlockByNumber.hash,
				number: nextFinalizedBlock.eth_getBlockByNumber.number,
				parent_hash: nextFinalizedBlock.eth_getBlockByNumber.parentHash,
			};

			// In our loop to prove canonicality we start the index at 1 so that we skip over nextFinalizedBlock.
			// The only issue with this is that if that block was never processed, we also skip re-processing it.
			// We handle this case manually before entering the loop

			const nextFinalizedBlockProcessed = blocksProcessed.some((block) => {
				return (
					isHexEqual(block.hash, nextFinalizedHead.hash) &&
					isHexEqual(block.parent_hash, nextFinalizedHead.parent_hash) &&
					viem.hexToNumber(block.number) === viem.hexToNumber(nextFinalizedHead.number)
				);
			});

			if (nextFinalizedBlockProcessed === false) {
				await Promise.all([
					writeUnfinalizedBlock(nextFinalizedBlock), //
					writeFinalizedBlock(nextFinalizedBlock, allActions),
				]);

				blocksProcessed.push(nextFinalizedHead);
			}

			// Now we check for canonicality

			const canonicalHeads = [nextFinalizedHead];

			let parentHash = nextFinalizedBlock.eth_getBlockByNumber.parentHash;

			for (let index = 1; index < finalizationBatchSize; index++) {
				const number = nextFinalizedHeight - index;

				// Load processed blocks by number
				const blocksProcessedForHeight = blocksProcessed.filter((block) => {
					return viem.hexToNumber(block.number) === number;
				});

				// If we have the canonical block we can abort early
				const canonicalHead = blocksProcessedForHeight.find((block) => {
					return isHexEqual(block.hash, parentHash);
				});

				if (canonicalHead) {
					canonicalHeads.unshift(canonicalHead); // Pushes to the start of array

					parentHash = canonicalHead.parent_hash;

					continue;
				}

				log.debug("Canonical head never processed, loading from chain...");

				// Otherwise we load and process the canonical block from the chain

				const canonicalBlock = await getBlockFromChain({ chain, number: viem.numberToHex(number) });

				const head: Head = {
					chain,
					hash: canonicalBlock.eth_getBlockByNumber.hash,
					number: canonicalBlock.eth_getBlockByNumber.number,
					parent_hash: canonicalBlock.eth_getBlockByNumber.parentHash,
				};

				// public_writeUnfinalizedHead accepts a head that the indexer has not finalised and the chain has not finalised
				// public_writeFinalizedHead accepts a head that the indexer has not finalised but the chain _has_ finalised
				// I'ts important to note that both methods push the associated commits after successful processing.

				log.debug("Processing canonical head");

				await Promise.all([
					writeUnfinalizedBlock(canonicalBlock), //
					writeFinalizedBlock(canonicalBlock, allActions),
				]);

				canonicalHeads.unshift(head); // Pushes to the start of array

				blocksProcessed.push(head);

				parentHash = canonicalBlock.eth_getBlockByNumber.parentHash;
			}

			if (!isHexEqual(parentHash, indexerFinalizedBlockHash)) {
				throw new Error("Expected chain to match last finalized canonical anchor");
			}

			if (canonicalHeads.length !== finalizationBatchSize) {
				throw new Error(`Expected to have ${finalizationBatchSize} heads, found ${canonicalHeads.length}`);
			}

			log.debug("Determined canonical chain");

			// Second, we iterate over the canonical list of blocks and verify that each block was processed
			// correctly. To prove this we just need a commit for every event and action that matches the
			// canonical head. This is our common case and what happens under steady operation. However, when
			// there are multiple blocks for the same height because a chain reorganisation occurred we cannot
			// rely on these commits to verify correct processing. This is because we cannot determine the
			// relative ordering of the processing. It could be that the reorganised block was processed after
			// the canonical block leaving our system in an incorrect state. Therefore, in the rare case that
			// we do encounter a chain reorganisation we must process them again.

			// We LIST commits after the blocks because we could've performed processing.

			const commits = await getCommitsAndGarbageCollect(chain, indexerFinalizedBlockHeight);

			// We iterate over the contiguous list of blocks. If we have all the relevant commits we are done.
			// Otherwise load the block from metadata and process it.

			for (const canonicalHead of canonicalHeads) {
				// The fast-path we are looking for:
				// - Only processed the canonical block for this height
				// - There exists a commit for this canonical block for all events/actions

				const blocksProcessedForHeight = blocksProcessed.filter((head) => {
					return viem.hexToNumber(canonicalHead.number) === viem.hexToNumber(head.number);
				});

				const processedOnlyCanonicalBlock = blocksProcessedForHeight.every((head) => {
					return isHexEqual(canonicalHead.hash, head.hash) && isHexEqual(canonicalHead.parent_hash, head.parent_hash);
				});

				const eventsCommittedForHeight = commits.some((commit) => {
					return (
						commit.type === undefined &&
						isHexEqual(canonicalHead.hash, commit.hash) &&
						isHexEqual(canonicalHead.parent_hash, commit.parent_hash) &&
						viem.hexToNumber(canonicalHead.number) === viem.hexToNumber(commit.number)
					);
				});

				const actionsWithoutCommit = allActions.filter((action) => {
					const commitExists = commits.some((commit) => {
						return (
							commit.id === action.id &&
							commit.type === "action" &&
							isHexEqual(canonicalHead.hash, commit.hash) &&
							isHexEqual(canonicalHead.parent_hash, commit.parent_hash) &&
							viem.hexToNumber(canonicalHead.number) === viem.hexToNumber(commit.number)
						);
					});

					return !commitExists;
				});

				if (
					eventsCommittedForHeight &&
					processedOnlyCanonicalBlock &&
					actionsWithoutCommit.length === 0 &&
					blocksProcessedForHeight.length === 1
				) {
					log.debug("Executed fast-path");

					continue;
				}

				log.debug("Fast-path missed for head");
				log.debug(`Events commited for height: ${eventsCommittedForHeight}`);
				log.debug(`Processed only canonical block: ${processedOnlyCanonicalBlock}`);
				log.debug(`Actions without commit (${actionsWithoutCommit.length}): ${actionsWithoutCommit.length === 0}`);
				log.debug(`Blocks processed for height (${blocksProcessedForHeight.length}): ${blocksProcessedForHeight.length === 1}`);

				// Otherwise there is work to be done. Note that this path doesn't have to be optimized because it's rare.
				// Even if we are recovering from downtime, the previous iteration proving canonicality likely already
				// performed all the work required so that we quickly finalize the batch. This path is usually just hit
				// when a block is reorganised which is also rare

				const reorganisedHeads = blocksProcessedForHeight.flatMap((head) => {
					if (isHexEqual(canonicalHead.hash, head.hash)) {
						return []; // Ignore canonical head
					}

					return { chain, number: head.number, hash: head.hash, parent_hash: head.parent_hash };
				});

				const reorganisedPromises = reorganisedHeads.map((head) => getBlockFromMetadataOrChain(head));

				const [canonicalBlock, ...reorganisedBlocks] = await Promise.all([
					getBlockFromMetadataOrChain(canonicalHead), //
					...reorganisedPromises,
				]);
				log.debug("Re-processing heads");

				await Promise.all([
					writeFinalizedBlock(canonicalBlock, actionsWithoutCommit), //
					deleteReorganisedBlocksAndWriteCanonicalBlock(reorganisedBlocks, canonicalBlock),
				]);
			}

			// Finally, we commit the batch and mark it as finalized. We use a conditional to fence this write
			// in the case that we encountered a stop-the-world GC pause that took an hour or something. If that
			// hasn't occurred we renew the current lease by updating the timestamp and immediately claiming the
			// next batch in the same PUT

			const nextBatchFinalizingHeight = Math.min(chainFinalizedHeight, nextFinalizedHeight + FINALIZATION_BATCH_SIZE);

			const updatedManifest: Manifest = {
				finalized_block_height: nextFinalizedHeight,
				finalized_block_hash: nextFinalizedBlock.eth_getBlockByNumber.hash,
				next_finalized_height: nextBatchFinalizingHeight,
				updated_at: Date.now(),
			};

			const manifestPutRes = await opts.metadataStorage.adapter
				.put(manifestKey, JSON.stringify(updatedManifest), { ifMatch: latestManifestEtag })
				.catch((error) => {
					if (error instanceof AdapterError) {
						if (error.tag === "PreconditionFailed") {
							return null;
						}
					}

					throw error;
				});

			if (manifestPutRes === null) {
				return log.debug("Failed to commit finalized batch, aborting...");
			}

			indexerFinalizedBlockHeight = nextFinalizedHeight;
			indexerFinalizedBlockHash = nextFinalizedBlock.eth_getBlockByNumber.hash;

			latestManifestEtag = manifestPutRes.etag;
		}

		log.debug("Indexer finalized, returning...");
	};

	const private_getMetadata: IndexerRpc["request"]["private_getMetadata"] = async () => {
		return {
			version,
			language: "javascript",
		};
	};

	const private_getEvents: IndexerRpc["request"]["private_getEvents"] = async () => {
		return allEvents.map((event) => {
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

	const IncompleteBlockError = createException("Received block with missing required property");

	const private_writeEvents: IndexerRpc["request"]["private_writeEvents"] = async (params) => {
		// TODO: Return an error
		if (allEvents.length === 0) return { failures: [] };

		// TODO: Return errors
		const relevant_events = allEvents.filter((event) => params.events.includes(event.id));
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

		const promises = eventsGroupedByStorageMap.entries().map(async ([storage, grouped_events]) => {
			// For all events that share the same storage adapter we push to the batch
			const batch: any[] = [];

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
							hash: block.eth_getBlockByNumber.hash,
							number: block.eth_getBlockByNumber.number,
							parent_hash: block.eth_getBlockByNumber.parentHash,
							created_at: Date.now(),
						};
					}
				}
			}

			if (batch.length === 0) return;

			const start = Date.now();

			try {
				await retry(() => storage.upsert(batch), 2);
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
							hash: block.eth_getBlockByNumber.hash,
							number: block.eth_getBlockByNumber.number,
							parent_hash: block.eth_getBlockByNumber.parentHash,
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

	// Important to note this method doesn't return an exhaustive list of every key read. It is always possible for the user
	// to write code that reads new keys for a specific block number. The only way to get an exhaustive list is to iterate
	// over all blocks that match the defined filters.

	const private_writeEventsAndGetKeys: IndexerRpc["request"]["private_writeEventsAndGetKeys"] = async (params) => {
		if (allEvents.length === 0) {
			return { results: [], keys: [] };
		}

		if (params.events.length === 0) {
			return { results: [], keys: [] };
		}

		// Filter for relevant events
		const relevant_events = allEvents.filter((event) => params.events.includes(event.id));

		if (relevant_events.length === 0) {
			return { results: [], keys: [] };
		}

		// Load the requested block
		const block = await getBlockFromChain(params.head).catch(() => {
			return null;
		});

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

		const proxy = new Proxy(block, createProxyHandler("")) as Block;

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
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
						created_at: Date.now(),
					};

					return;
				}

				if (events.length === 0) {
					results[event.id + proxy.eth_getBlockByNumber.number] = {
						status: "ok",
						event_id: event.id,
						chain: proxy.eth_chainId,
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
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
						hash: proxy.eth_getBlockByNumber.hash,
						number: proxy.eth_getBlockByNumber.number,
						parent_hash: proxy.eth_getBlockByNumber.parentHash,
						created_at: Date.now(),
					};

					return;
				}

				results[event.id + proxy.eth_getBlockByNumber.number] = {
					status: "ok",
					event_id: event.id,
					chain: proxy.eth_chainId,
					hash: proxy.eth_getBlockByNumber.hash,
					number: proxy.eth_getBlockByNumber.number,
					parent_hash: proxy.eth_getBlockByNumber.parentHash,
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

	const event: Indexer<TBlock>["event"] = (event) => {
		if (!/^[A-Za-z0-9_-]+$/.test(event.id)) {
			throw new Error(`Invalid event id \`${event.id}\`. Only characters A-Z, a-z, 0-9, underscores, and hyphens are permitted.`);
		}

		allEvents.push(event);

		const group = eventsGroupedByStorageMap.get(event.storage) ?? [];
		group.push(event);
		eventsGroupedByStorageMap.set(event.storage, group);

		return event;
	};

	const action: Indexer<TBlock>["action"] = (action) => {
		if (!/^[A-Za-z0-9_-]+$/.test(action.id)) {
			throw new Error(`Invalid action id \`${action.id}\`. Only characters A-Z, a-z, 0-9, underscores, and hyphens are permitted.`);
		}

		if (allActions.some((existing) => existing.id === action.id)) {
			throw new Error(`Duplicate action id \`${action.id}\`.`);
		}

		allActions.push(action);

		return action;
	};

	const rpc: IndexerRpc = {
		request: {
			public_finalize,
			public_getFinalizedHeight,
			public_writeFinalizedHead,
			public_writeUnfinalizedHead,
			public_deleteReorganisedHead,

			private_getEvents,
			private_getMetadata,
			private_writeEvents,
			private_writeEventsAndGetKeys,
		},

		subscribe: {},
	};

	const server = createServer({
		transport: local(rpc),
		quiet: opts.quiet ?? false,
		signingKey: opts.signingKey,
	});

	const indexer: Indexer<TBlock> & IndexerRpc = {
		...rpc,
		event,
		action,
		fetch: server.http,
	};

	return indexer;
}

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export { defineIndexer };
export type { Indexer, Event, Filter, Block, Head, Metadata, Result };
