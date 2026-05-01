import { http } from "msw";
import { test } from "vitest";

import { indexer } from ".";
import { server } from "../mocks/node";
import { defineTransport, realtime } from "./realtime";
import { test_getBlock, test_promiseWithResolvers, test_indexer } from "../tests/utils";

test.concurrent("transport makes a request", async () => {
	const transport = defineTransport(process.env.TEST_ETHEREUM_RPC_WSS);
	const data = await transport.request({ method: "eth_chainId", params: [] });
	expect(data).toBe("0x1");
});

test("receives a block", async () => {
	const { promise, resolve } = test_promiseWithResolvers();

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: { upsert: async () => {} },
		handler: (block) => {
			console.log(Number.parseInt(block.eth_getBlockByHash.number, 16));

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
	realtime({ transport, endpoints: [url] });

	await promise;
});

test("retries blocks", async () => {
	const { promise, resolve } = test_promiseWithResolvers();

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

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
	realtime({ transport, endpoints: [url] });

	await promise;
});
