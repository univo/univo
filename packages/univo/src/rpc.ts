import { Flatten } from "./utils";
import { Block, Filter, Head, Metadata, Result } from ".";

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
		/**
		 * @returns The chain identifier of the node
		 */
		eth_chainId: () => Promise<`0x${string}`>;

		/**
		 * Accepts a block tag and boolean for including receipts
		 * @returns A block with optional receipts
		 */
		eth_getBlockByNumber: (number: string, receipts: boolean) => Promise<{ hash: `0x${string}`; number: `0x${string}`; parentHash: `0x${string}` }>;

		/**
		 * Accepts a block hash and boolean for including receipts
		 * @returns A block with optional receipts
		 */
		eth_getBlockByHash: (hash: `0x${string}`, receipts: boolean) => Promise<{ hash: `0x${string}`; number: `0x${string}`; parentHash: `0x${string}` }>;
	};

	subscribe: {
		newHeads: Head;
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
		public_getFinalizedHeight: (chain: `0x${string}`) => Promise<number | null>;

		/**
		 * Accepts a reorganised block and deletes all related events from storage
		 */
		public_deleteReorganisedHead: (head: Head) => Promise<void>;

		/**
		 * Accepts a list of the latest block heads and writes all events to storage
		 */
		public_writeUnfinalizedHeads: (heads: Head[]) => Promise<void>;

		/**
		 * Accepts a chain of finalized heads and upserts canonical events and deletes reorganised events
		 */
		public_writeFinalizedHeads: (heads: Head[]) => Promise<void>;

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
		 * Accepts a raw block directly from the chain and writes events to storage
		 * @returns A list of the block keys that were accessed as events are written to storage
		 */
		private_writeEventsAndGetKeys: (params: { events: string[]; block: Block }) => Promise<{ results: Result[]; keys: string[] }>;
	};

	subscribe: Record<string, never>;
};

/**
 * Exports -----------------------------------------------------------------------------------------------------------------------------------
 */

export type { Rpc, NodeRpc, IndexerRpc };
