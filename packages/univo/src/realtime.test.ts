import { http } from "msw";
import { test } from "vitest";
import { createStorage } from "unstorage";

import { indexer } from ".";
import { server } from "../vitest.setup";
import { defineTransport, realtime } from "./realtime";
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

	// Mock results endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", () => {
			return Response.json({ success: true, data: null });
		}),
	);

	// Initialise a realtime client
	const transport = defineTransport(process.env.TEST_ETHEREUM_RPC_WSS);
	realtime({ quiet: true, transport, endpoints: [url] });

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

	// Create endpoint
	const { url } = test_indexer(univo);

	// Mock results endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", () => {
			return Response.json({ success: true, data: null });
		}),
	);

	// Initialise a realtime client
	const transport = defineTransport(process.env.TEST_ETHEREUM_RPC_WSS);
	realtime({ quiet: true, transport, endpoints: [url] });

	await promise;
});
