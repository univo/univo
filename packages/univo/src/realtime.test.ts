import { test } from "vitest";
import { http as mock_http } from "msw";
import { createStorage } from "unstorage";

import { indexer } from ".";
import { realtime } from "./realtime";
import { wss, http } from "./transport";
import { server } from "../vitest.setup";
import { test_getBlock, test_promiseWithResolvers, test_indexer } from "../tests/utils";

test("receives a block", async () => {
	const { promise, resolve } = test_promiseWithResolvers();

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	server.use(
		mock_http.post("https://api.univo.app/v1/results", () => {
			return Response.json({ success: true, data: null });
		}),
	);

	realtime({
		quiet: true,
		indexer: http(url),
		node: wss(process.env.TEST_ETHEREUM_RPC_WSS),
	});

	await promise;
});

test("retries blocks", async () => {
	const { promise, resolve } = test_promiseWithResolvers();

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	server.use(
		mock_http.post("https://api.univo.app/v1/results", () => {
			return Response.json({ success: true, data: null });
		}),
	);

	realtime({
		quiet: true,
		indexer: http(url),
		node: wss(process.env.TEST_ETHEREUM_RPC_WSS),
	});

	await promise;
});
