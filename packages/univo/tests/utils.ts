import { Hono } from "hono";
import { join } from "node:path";
import { http as msw_http, passthrough } from "msw";
import { promises as fs } from "node:fs";
import { serve as start } from "@hono/node-server";
import type { RpcBlock, RpcTransactionReceipt } from "viem";

import { http } from "../src/client";
import { server } from "../vitest.setup";
import type { Indexer, Rpc } from "../src";
import { hexToNumber, iife, raise, retry } from "../src/utils";

server.use(msw_http.all("http://localhost:7483/:key", passthrough));
server.use(msw_http.all(process.env.TEST_ETHEREUM_RPC_URL, passthrough));

export const test_indexer = iife(() => {
	const app = new Hono();
	const cache = new Map<string, Indexer<any>>();

	app.all("/:key", async (context) => {
		const key = context.req.param("key");
		const indexer = cache.get(key);
		if (indexer === undefined) throw new Error("Unknown indexer");
		return await indexer.fetch(context.req.raw);
	});

	start({ fetch: app.fetch, port: 7483 });

	return <TBlock>(indexer: Indexer<TBlock>) => {
		const id = crypto.randomUUID();
		const url = `http://localhost:7483/${id}`;
		cache.set(id, indexer);

		// Signing key should be "test" for all test indexers
		const client = http(url, { signingKey: "test" });

		const request = async <M extends keyof Rpc>(args: { method: M; params: Parameters<Rpc[M]> }) => {
			const full_args = { id: 0, jsonrpc: "2.0", method: args.method, params: args.params } as const;
			const response = await client.request(full_args);
			if (response.error) throw new Error(response.error.message);
			return response.result as ReturnType<Rpc[M]>;
		};

		return { url, request };
	};
});

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
	eth_getBlockByHash: RpcBlock<"latest", true>;
	eth_getBlockReceipts: RpcTransactionReceipt[];
};

export async function test_getBlock(block: { chain: `0x${string}`; number: `0x${string}` }) {
	const cacheDir = ".blocks";
	const cacheFile = join(cacheDir, `${hexToNumber(block.chain)}-${hexToNumber(block.number)}.json`);

	// Try to read from cache first
	try {
		const cachedData = await fs.readFile(cacheFile, "utf-8");
		return JSON.parse(cachedData) as test_Block;
	} catch {
		// Cache miss or invalid cache, continue to fetch from network
	}

	// Fetch from network
	const [eth_getBlockByHash, eth_getBlockReceipts] = await Promise.all([
		retry(rpc, [{ id: 1, method: "eth_getBlockByNumber", params: [block.number, true] }], 4),
		retry(rpc, [{ id: 2, method: "eth_getBlockReceipts", params: [block.number] }], 4),
	]);

	if (!eth_getBlockByHash) throw new Error("eth_getBlockByHash is null");
	if (!eth_getBlockReceipts) throw new Error("eth_getBlockReceipts is null");

	const blockData: test_Block = {
		eth_chainId: block.chain,
		eth_getBlockByHash,
		eth_getBlockReceipts,
	};

	// Save to cache (non-blocking)
	saveToCache(cacheDir, cacheFile, blockData);

	return blockData;
}

async function rpc(opts: { id: number; method: string; params: any[] }) {
	const url = process.env.TEST_ETHEREUM_RPC_URL;
	if (!url) throw new Error("Please set a process.env.TEST_ETHEREUM_RPC_URL");

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", ...opts }),
	});

	if (!res.ok) throw new Error("Failed to get rpc response");
	const json: any = await res.json().catch((cause) => raise("Unable to parse rpc response to json", { cause }));

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
