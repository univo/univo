import type { BlockTag, PublicRpcSchema, RpcBlock, RpcBlockNumber, RpcTransactionReceipt } from "viem";

import type { Flatten } from "./utils";
import type { Block, Filter, Head, Metadata, Result } from ".";

type Rpc = {
	/**
	 * All available methods that can be requested
	 */
	request: Record<string, any>;

	/**
	 * All available event types to subscribe to a stream of values
	 */
	subscribe: Record<string, any>;
};

/**
 * Node -----------------------------------------------------------------------------------------------------------------------------------
 */

type NodeRpc = {
	request: {
		[Method in PublicRpcSchema[number] as Exclude<Method["Method"], "eth_getBlockByNumber">]: (
			...params: Method["Parameters"] extends readonly unknown[] ? Method["Parameters"] : []
		) => Promise<Method["ReturnType"]>;
	} & {
		/**
		 * Fetches transaction receipts for a block.
		 * @param block A hexadecimal block number or block tag.
		 * @returns All transaction receipts for the block, or null if the block is not found.
		 */
		eth_getBlockReceipts: (block: RpcBlockNumber | BlockTag) => Promise<RpcTransactionReceipt[] | null>;

		/**
		 * Fetches a non-pending block with full transaction objects.
		 * @param block A hexadecimal block number or block tag other than "pending".
		 * @param includeTransactionObjects Must be true to load full transaction objects instead of hashes.
		 * @returns A block with non-nullable hash and number fields, or null if the block is not found.
		 */
		eth_getBlockByNumber: (
			block: RpcBlockNumber | Exclude<BlockTag, "pending">,
			includeTransactionObjects: true,
		) => Promise<RpcBlock<Exclude<BlockTag, "pending">, true> | null>;
	};

	subscribe: {
		newHeads: RpcBlock<"latest", boolean>;
	};
};

/**
 * Indexer -----------------------------------------------------------------------------------------------------------------------------------
 */

type IndexerRpc = {
	request: {
		/**
		 * Accepts a chain identifier
		 * @returns Height of the last finalized block indexed
		 */
		public_getFinalizedHeight: (chain: `0x${string}`) => Promise<number>;

		/**
		 * Accepts a reorganised block and deletes all related events from storage
		 */
		public_deleteReorganisedHead: (head: Head) => Promise<void>;

		/**
		 * Accepts an unfinalized head and writes all events to storage
		 */
		public_writeUnfinalizedHead: (head: Head) => Promise<void>;

		/**
		 * Accepts a finalized head and executes all actions
		 */
		public_writeFinalizedHead: (head: Head) => Promise<void>;

		/**
		 * Accepts a chain identifier and finalizes the indexer
		 */
		public_finalize: (chain: `0x${string}`) => Promise<void>;

		/**
		 * @returns Specified metadata about the indexer
		 */
		private_getMetadata: () => Promise<Metadata>;

		/**
		 * @returns All events defined on this indexer
		 */
		private_getEvents: () => Promise<{ id: string; filters: Flatten<Filter>[] }[]>;

		/**
		 * Accepts a list of events and a batch of minified block data and writes to storage
		 * @returns A list of failures that occured for each event and block pair
		 */
		private_writeEvents: (params: { events: string[]; blocks: Block[] }) => Promise<{ failures: Result[] }>;

		/**
		 * Accepts a block head and writes events to storage
		 * @returns A list of results and block keys that were accessed as those events were written to storage
		 */
		private_writeEventsAndGetKeys: (params: { events: string[]; head: Head }) => Promise<{ results: Result[]; keys: string[] }>;
	};

	subscribe: Record<string, never>;
};

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export type { Rpc, NodeRpc, IndexerRpc };
