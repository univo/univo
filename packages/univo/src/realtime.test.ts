import { test } from "vitest";
import { createStorage } from "unstorage";

import { indexer } from ".";
import { realtime } from "./realtime";
import { wss, http } from "./transport";
import { test_getBlock, test_promiseWithResolvers, test_indexer } from "../tests/utils";

test.concurrent("receives a block", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const { promise, resolve } = test_promiseWithResolvers();

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: { upsert: async () => {} },
		handler: () => {
			resolve(null);

			return [];
		},
	});

	const { url } = test_indexer(univo);

	realtime({
		quiet: false,
		indexer: http(url),
		node: wss(process.env.TEST_ETHEREUM_RPC_WSS),
	});

	await promise;
});

test.concurrent("retries blocks", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const { promise, resolve } = test_promiseWithResolvers();

	let count = 0;

	univo.event({
		id: "test",
		storage: { async upsert() {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: () => {
			if (count === 0) {
				count++;
				throw new Error();
			}

			resolve(null);

			return [];
		},
	});

	const { url } = test_indexer(univo);

	realtime({
		quiet: true,
		indexer: http(url),
		node: wss(process.env.TEST_ETHEREUM_RPC_WSS),
	});

	await promise;
});
