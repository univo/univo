import type { Block, Head, PrivateMetadata, PublicMetadata, Result } from ".";

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
		 * Accepts a chain identifier and caches its current finalized height
		 */
		public_writeFinalizedHeight: (chain: `0x${string}`) => Promise<void>;

		/**
		 * Accepts a finalized head and executes all actions
		 */
		public_writeFinalizedHead: (head: Head) => Promise<void>;

		/**
		 * Accepts a chain identifier and finalizes the indexer
		 */
		public_finalize: (chain: `0x${string}`) => Promise<void>;

		/**
		 * @returns Public metadata about the indexer
		 */
		public_getMetadata: () => Promise<PublicMetadata>;

		/**
		 * @returns Private metadata about the indexer
		 */
		private_getMetadata: () => Promise<PrivateMetadata>;

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

export type { Rpc, IndexerRpc };
