import { test } from "vitest";
import { createStorage } from "unstorage";

import { indexer } from ".";
import { realtime } from "./realtime";
import { wss, http } from "./transport";
import { test_getBlock, test_promiseWithResolvers, test_indexer } from "../tests/utils";
import { NodeRpc } from "./rpc";
import { hexToNumber, numberToHex } from "./utils";

test.concurrent("receives the latest block", async () => {
	const univo = indexer({ quiet: false, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const { promise, resolve } = test_promiseWithResolvers();

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: { upsert: async () => {} },
		handler: (block) => {
			resolve(null);

			return [block.eth_getBlockByNumber.number];
		},
	});

	const { url } = test_indexer(univo);

	realtime({ quiet: false, indexer: http(url), node: wss(process.env.TEST_ETHEREUM_RPC_WSS) });

	await promise;
});

test.concurrent("finalises blocks", { timeout: 1 * 60 * 1000 }, async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const { promise, resolve } = test_promiseWithResolvers();

	let count = 0;

	univo.event({
		id: "test",
		storage: { async upsert() {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: () => {
			count++;

			// We should process 13 blocks (12 + the finalised block)

			if (count === 13) {
				resolve(null);
			}

			return [];
		},
	});

	const url = test_indexer(univo).url;
	const node = wss<NodeRpc>(process.env.TEST_ETHEREUM_RPC_WSS);

	// We load a block that was finalized recently and submit it as unfinalized. When we start our realtime client
	// it should see that indexer lags the finalized chain and submits the the newly finalized heads for processing

	const [chainId, finalizedBlock] = await Promise.all([
		node.request({ method: "eth_chainId", params: [] }),
		node.request({ method: "eth_getBlockByNumber", params: ["finalized", false] }),
	]);

	const finalizedBlockNumber = numberToHex(hexToNumber(finalizedBlock.number) - 12);
	const block = await node.request({ method: "eth_getBlockByNumber", params: [finalizedBlockNumber, false] });

	await test_indexer(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: chainId,
					hash: block.hash,
					number: block.number,
					parentHash: block.parentHash,
				},
			],
		],
	});

	realtime({ quiet: true, node, indexer: http(url) });

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

	realtime({ quiet: true, indexer: http(url), node: wss(process.env.TEST_ETHEREUM_RPC_WSS) });

	await promise;
});
