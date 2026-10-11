import { join } from "node:path";
import { hexToNumber } from "viem";
import { promises as fs } from "node:fs";
import type { RpcBlock, RpcTransactionReceipt } from "viem";

import { NodeRpc } from "../src/rpc";
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

export type test_Block = {
	eth_chainId: `0x${string}`;
	eth_getBlockByNumber: RpcBlock<"latest", true>;
	eth_getBlockReceipts: RpcTransactionReceipt[];
};

const node = http<NodeRpc>(process.env.TEST_ETHEREUM_RPC_URL);

export async function test_getBlock(block: { chain: `0x${string}`; number: `0x${string}` | "finalized"; hash?: `0x${string}` }) {
	if (!block.number.startsWith("0x")) {
		const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
			node.request({ method: "eth_getBlockByNumber", params: [block.number, true] }),
			node.request({ method: "eth_getBlockReceipts", params: [block.number] }),
		]);

		if (eth_getBlockByNumber === null) {
			throw new Error("eth_getBlockByNumber is null");
		}

		if (eth_getBlockReceipts === null) {
			throw new Error("eth_getBlockReceipts is null");
		}

		return {
			eth_chainId: block.chain,
			eth_getBlockByNumber,
			eth_getBlockReceipts,
		};
	}

	const cacheDir = "tests/blocks";

	let filename = `${hexToNumber(block.chain)}-${hexToNumber(block.number as `0x${string}`)}`;

	if (typeof block.hash === "string") {
		filename += `-${block.hash}`; // Optionally append block hash if we are testing reorganised blocks
	}

	filename += ".json";

	const cacheFile = join(cacheDir, filename);

	try {
		const cachedData = await fs.readFile(cacheFile, "utf-8");
		return JSON.parse(cachedData) as test_Block;
	} catch {
		// Cache miss or invalid cache, continue to fetch from network
	}

	const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
		node.request({ method: "eth_getBlockByNumber", params: [block.number, true] }),
		node.request({ method: "eth_getBlockReceipts", params: [block.number] }),
	]);

	if (eth_getBlockByNumber === null) {
		throw new Error("eth_getBlockByNumber is null");
	}

	if (eth_getBlockReceipts === null) {
		throw new Error("eth_getBlockReceipts is null");
	}

	const blockData = {
		eth_chainId: block.chain,
		eth_getBlockByNumber,
		eth_getBlockReceipts,
	};

	saveToCache(cacheDir, cacheFile, blockData); // Save to cache without blocking

	return blockData;
}

async function saveToCache(cacheDir: string, cacheFile: string, blockData: any) {
	try {
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.writeFile(cacheFile, JSON.stringify(blockData, null, 2), "utf-8");
	} catch (error) {
		//
	}
}

export function test_metadataStorage() {
	return defineStorage({
		adapter: memory(),
	});
}
