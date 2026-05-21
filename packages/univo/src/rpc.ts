import { Flatten } from "./utils";
import { Block, Filter, Head, Metadata, Result } from ".";

type Rpc = {
	/**
	 * All available methods to subscripe to an event type and receive a stream of values
	 */
	subscribe: Record<string, any>;

	/**
	 * All available methods of the inteface that can be requested
	 */
	request: Record<string, any>;
};

/**
 * Node -----------------------------------------------------------------------------------------------------------------------------------
 */

interface NodeRpc extends Rpc {
	subscribe: Record<string, any>;

	request: Record<string, any>;
}

/**
 * Indexer -----------------------------------------------------------------------------------------------------------------------------------
 */

interface IndexerRpc extends Rpc {
	subscribe: Record<string, never>;

	request: {
		/**
		 * Accepts a chain identifier
		 * @returns The next unfinalized block in the chain
		 */
		public_getUnfinalizedHeight: (chain: `0x${string}`) => Promise<number>;

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
}

export type { Rpc, NodeRpc, IndexerRpc };
