import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Storage } from "@storagesdk/core";
import { fs as adapter } from "@storagesdk/adapters/fs";
import type { RpcBlock, RpcTransactionReceipt } from "viem";

import { hexToNumber, retry } from "../src/utils";

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

export async function test_getBlock(block: { chain: `0x${string}`; number: string; hash?: `0x${string}` }) {
	const cacheDir = "tests/blocks";

	let filename = `${hexToNumber(block.chain)}-${hexToNumber(block.number)}`;
	if (typeof block.hash === "string") filename += `-${block.hash}`;
	filename += ".json";

	const cacheFile = join(cacheDir, filename);

	// We don't want to cache block tags like `latest` or `finalized`
	const isBlockNumber = block.number.startsWith("0x");

	if (isBlockNumber) {
		// Try to read from cache first
		try {
			const cachedData = await fs.readFile(cacheFile, "utf-8");
			return JSON.parse(cachedData) as test_Block;
		} catch {
			// Cache miss or invalid cache, continue to fetch from network
		}
	}

	// Fetch from network
	const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
		retry(() => rpc({ id: 1, method: "eth_getBlockByNumber", params: [block.number, true] }), 4),
		retry(() => rpc({ id: 2, method: "eth_getBlockReceipts", params: [block.number] }), 4),
	]);

	if (!eth_getBlockByNumber) throw new Error("eth_getBlockByNumber is null");
	if (!eth_getBlockReceipts) throw new Error("eth_getBlockReceipts is null");

	const blockData: test_Block = {
		eth_chainId: block.chain,
		eth_getBlockByNumber,
		eth_getBlockReceipts,
	};

	if (isBlockNumber) {
		// Save to cache (non-blocking)
		saveToCache(cacheDir, cacheFile, blockData);
	}

	return blockData;
}

async function rpc(opts: { id: number; method: string; params: any[] }) {
	const url = process.env.TEST_ETHEREUM_RPC_URL;

	if (!url) {
		throw new Error("Please set a process.env.TEST_ETHEREUM_RPC_URL");
	}

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", ...opts }),
	});

	if (!res.ok) {
		throw new Error("Failed to get rpc response");
	}

	const json: any = await res.json().catch((cause) => {
		throw new Error("Unable to parse rpc response to json", { cause });
	});

	return json.result;
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
	return new Storage({
		adapter: adapter({
			root: "./.storage",
			folder: crypto.randomUUID(),
		}),
	});
}
