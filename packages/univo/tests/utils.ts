import { join } from "node:path";
import { hexToNumber } from "viem";
import { promises as fs } from "node:fs";

import { http } from "../src/transport";
import { defineStorage } from "../src/metadata";
import { memory } from "../src/metadata/adapters/memory";

export function test_promiseWithResolvers() {
	let resolve: (value: any) => void;
	let reject: (reason?: any) => void;

	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	// @ts-ignore
	return { promise, resolve, reject };
}

export function test_metadataStorage() {
	return defineStorage({
		adapter: memory(),
	});
}

const node = http(process.env.TEST_ETHEREUM_RPC_URL);

export async function test_getBlock(head: { chain: `0x${string}`; number: `0x${string}` | "finalized"; hash?: `0x${string}` }) {
	if (!head.number.startsWith("0x")) {
		const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
			node.request({ method: "eth_getBlockByNumber", params: [head.number, true] }),
			node.request({ method: "eth_getBlockReceipts", params: [head.number] }),
		]);

		return {
			eth_chainId: head.chain,
			eth_getBlockByNumber,
			eth_getBlockReceipts,
		};
	}

	const cacheDir = "tests/blocks";

	let filename = `${hexToNumber(head.chain)}-${hexToNumber(head.number as `0x${string}`)}`;

	if (typeof head.hash === "string") {
		filename += `-${head.hash}`; // Optionally append block hash if we are testing reorganised blocks
	}

	filename += ".json";

	const cacheFile = join(cacheDir, filename);

	try {
		const cachedData = await fs.readFile(cacheFile, "utf-8");

		return JSON.parse(cachedData) as {
			eth_chainId: `0x${string}`;
			eth_getBlockByNumber: any;
			eth_getBlockReceipts: any;
		};
	} catch {
		// Cache miss or invalid cache, continue to fetch from network
	}

	const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
		node.request({ method: "eth_getBlockByNumber", params: [head.number, true] }),
		node.request({ method: "eth_getBlockReceipts", params: [head.number] }),
	]);

	const block = {
		eth_chainId: head.chain,
		eth_getBlockByNumber,
		eth_getBlockReceipts,
	};

	try {
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cacheFile, JSON.stringify(block, null, 2), "utf-8");
	} catch (error) {
		//
	}

	return block;
}
