import { http } from "msw";
import { expect, test, assert } from "vitest";

import { indexer } from ".";
import type { Event } from ".";
import { hexToNumber } from "./utils";
import { blocks } from "../tests/blocks";
import { server } from "../vitest.setup";
import { test_Block, test_getBlock, test_indexer } from "../tests/utils";

test.concurrent("correctly infers the event type", () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	const event = univo.event({
		id: "test",
		storage: { async upsert() {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			return block.eth_getBlockReceipts.map((receipt) => {
				return {
					receipt: receipt.blockHash,
				};
			});
		},
	});

	expectTypeOf(event).toEqualTypeOf<Event<test_Block, { receipt: `0x${string}` }>>;
});

test.concurrent("throws an error if an event with an invalid id is defined", () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	expect(() => {
		univo.event({
			handler: () => [],
			id: "invalidchars()$%^#&!*&@!#",
			storage: { upsert: async () => {} },
			filters: [{ chain: 1, fromBlock: 0 }],
		});
	}).toThrowError;
});

test("public_writeAndReturnBlocks returns no results when provided a block that matches no event filters", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0, toBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async () => {
			assert.fail("There should be no results to submit");
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});
});

test("public_writeAndReturnBlocks returns ok results if we return an empty handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "ok",
						chain: "0x1",
						event_id: "test",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});
});

test("public_writeAndReturnBlocks returns ok results if we successfully upsert events", async () => {
	const upserted: any[] = [];

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block.eth_getBlockByHash.hash],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "ok",
						chain: "0x1",
						event_id: "test",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});

	expect(upserted.length).toBe(1);
});

test("public_writeAndReturnBlocks returns a block_error for all events when failing to load a block", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: async () => {
			throw new Error("Failed to load block");
		},
	});

	univo.event({
		id: "event1",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	univo.event({
		id: "event2",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json: any = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "block_error",
						chain: "0x1",
						event_id: "event1",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
					{
						status: "block_error",
						chain: "0x1",
						event_id: "event2",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			expect(json.results.length).toBe(2);

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});
});

test("public_writeAndReturnBlocks records a handler_error", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => {
			throw new Error("Handler failed");
		},
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "handler_error",
						chain: "0x1",
						event_id: "test",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});
});

test("public_writeAndReturnBlocks returns any upsert errors", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block.eth_getBlockByHash.hash],
		storage: {
			async upsert() {
				throw new Error("Upsert failed");
			},
		},
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "upsert_error",
						chain: "0x1",
						event_id: "test",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});
});

test("public_writeAndReturnBlocks retries upsert errors", async () => {
	let count = 0;
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByHash.hash],
		storage: {
			async upsert() {
				count++;
				throw new Error("Upsert failed");
			},
		},
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json = await request.json();

			expect(json).toStrictEqual({
				endpoint: "https://endpoint.com",
				results: [
					{
						status: "upsert_error",
						chain: "0x1",
						event_id: "test",
						block_number: "0xa",
						block_hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						created_at: expect.any(Number),
					},
				],
			});

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});

	expect(count).toEqual(3);
});

test("public_writeAndReturnBlocks deduplicates events with the same storage adapter", async () => {
	let count = 0;
	let batch = [] as any[];

	const storage = {
		async upsert(events: any[]) {
			count++;
			batch = events;
		},
	};

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		storage,
		id: "event1",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event1-${block.eth_getBlockByHash.hash}`],
	});

	univo.event({
		storage,
		id: "event2",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event2-${block.eth_getBlockByHash.hash}`],
	});

	// Mock univo endpoint
	server.use(
		http.post("https://api.univo.app/v1/results", async ({ request }) => {
			const json: any = await request.json();

			expect(json.results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ status: "ok", event_id: "event1" }),
					expect.objectContaining({ status: "ok", event_id: "event2" }),
				]),
			);

			return Response.json({ success: true, data: null });
		}),
	);

	await test_indexer(univo).request({
		method: "public_writeAndReturnBlocks",
		params: [
			"https://endpoint.com",
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				},
			],
		],
	});

	expect(count).toBe(1);

	expect(batch).toStrictEqual([
		"event1-0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
		"event2-0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
	]);
});

test("private_writeEvents indexes only the events requested", async () => {
	const upserted: any[] = [];
	let event2HandlerCalled = false;

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "event1",
		handler: (block) => [`event1-${block.eth_getBlockByHash.hash}`],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	univo.event({
		id: "event2",
		handler: () => {
			event2HandlerCalled = true;
			return [];
		},
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["event1"],
				blocks: [blocks[0]],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);
	expect(upserted).toStrictEqual([`event1-${blocks[0].eth_getBlockByHash.hash}`]);
	expect(event2HandlerCalled).toBe(false);
});

test.concurrent("private_writeEvents deduplicates events with the same storage adapter", async () => {
	let count = 0;
	let batch = [] as any[];

	const storage = {
		async upsert(events: any[]) {
			count++;
			batch = events;
		},
	};

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		storage,
		id: "event1",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event1-${block.eth_getBlockByHash.hash}`],
	});

	univo.event({
		storage,
		id: "event2",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event2-${block.eth_getBlockByHash.hash}`],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["event1", "event2"],
				blocks: [blocks[0]],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);

	expect(count).toBe(1);

	expect(batch).toStrictEqual([`event1-${blocks[0].eth_getBlockByHash.hash}`, `event2-${blocks[0].eth_getBlockByHash.hash}`]);
});

test.concurrent("private_writeEvents records events", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[22994233]],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);
});

test.concurrent("private_writeEvents ignores events not explicitly requested", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		handler(block) {
			if (hexToNumber(block.eth_getBlockByHash.number) === 1) {
				throw new Error("Test error message");
			}

			return [];
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test-random"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toEqual([]);
});

test.concurrent("private_writeEvents returns handler errors", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		handler(block) {
			if (hexToNumber(block.eth_getBlockByHash.number) === 1) {
				throw new Error("Test error message");
			}

			return [];
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns errors thrown during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		storage: {
			async upsert() {
				throw new Error("Test error message");
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents retries upsert errors", async () => {
	let count = 0;
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		storage: {
			async upsert() {
				count++;
				throw new Error("Test error message");
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
	]);

	expect(count).toEqual(3);
});

test.concurrent("private_writeEvents only returns the handler error if both handler and upsert fail", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		handler: () => {
			throw new Error("Test error message");
		},
		storage: {
			async upsert() {
				throw new Error("Test error message");
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			block_hash: expect.any(String),
			block_number: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns incomplete errors in handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			// The following property exists on the type but isn't provided
			return [block.eth_getBlockByHash.difficulty];
		},
		storage: { upsert: async () => {} },
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x2",
							hash: "0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9",
						},
					},
				] as any,
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x1",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x2",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns swallowed incomplete errors in handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			try {
				return [block.eth_getBlockByHash.difficulty];
			} catch {
				// It's perfectly valid to ignore transformation errors like this, but we still need
				// to be able to detect when we have received an incomplete block

				return [];
			}
		},
		storage: { upsert: async () => {} },
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x2",
							hash: "0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9",
						},
					},
				] as any,
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x1",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x2",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns incomplete errors in upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block],
		storage: {
			upsert: async (blocks) => {
				for (const block of blocks) {
					// The following property exists on the type but isn't provided
					block.eth_getBlockByHash.difficulty;
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x2",
							hash: "0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9",
						},
					},
				] as any,
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x1",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x2",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns swallowed incomplete errors in upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block],
		storage: {
			upsert: async (blocks) => {
				try {
					for (const block of blocks) {
						block.eth_getBlockByHash.difficulty;
					}
				} catch {
					//
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x2",
							hash: "0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9",
						},
					},
				] as any,
			},
		],
	});

	expect(response.failures).toStrictEqual([
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x1",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			block_number: "0x2",
			block_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents doesn't return an error when accessing a provided null property", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByHash.difficulty],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x1",
							difficulty: null,
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByHash: {
							number: "0x2",
							difficulty: null,
							hash: "0xb495a1d7e6663152ae92708da4843337b958146015a2802f4193a410044698c9",
						},
					},
				] as any,
			},
		],
	});

	expect(response.failures).toEqual([]);
});

test.concurrent("private_writeEvents never upserts if handler returns empty event list", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => [],
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		storage: {
			async upsert() {
				throw new Error("Test error message");
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [blocks[0], blocks[1], blocks[2]],
			},
		],
	});

	expect(response.failures).toStrictEqual([]); // Empty array implies successes
});

test("private_writeEventsAndGetKeys indexes only the events requested", async () => {
	const upserted: any[] = [];
	let event2HandlerCalled = false;

	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "event1",
		handler: (block) => [`event1-${block.eth_getBlockByHash.hash}`],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	univo.event({
		id: "event2",
		handler: () => {
			event2HandlerCalled = true;
			return [];
		},
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["event1"], block: blocks[0] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "event1",
			block_number: "0x0",
			created_at: expect.any(Number),
			block_hash: expect.any(String),
		},
	]);

	expect(upserted).toStrictEqual([`event1-${blocks[0].eth_getBlockByHash.hash}`]);
	expect(event2HandlerCalled).toBe(false);
});

test.concurrent("private_writeEventsAndGetKeys never upserts if handler returns empty event list", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => [],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert() {
				throw new Error("Test error message");
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[0] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x0",
			created_at: expect.any(Number),
			block_hash: expect.any(String),
		},
	]);
});

test.concurrent("private_writeEventsAndGetKeys records minimum keys from matching filters", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByHash.baseFeePerGas],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.baseFeePerGas",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return block.eth_getBlockByHash.transactions.map((transaction) => {
				return transaction.from;
			});
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawals keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return (block.eth_getBlockByHash.withdrawals || []).map((withdrawal) => {
				return withdrawal.address;
			});
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return block.eth_getBlockReceipts.map((receipt) => {
				return receipt.from;
			});
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return block.eth_getBlockReceipts.flatMap((receipt) => {
				return receipt.logs.map((log) => {
					return log.address;
				});
			});
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByHash.hash;
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByHash.transactions.map((transaction: any) => {
						transaction.from;
					});
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawal keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByHash.withdrawals?.map((withdrawal: any) => {
						withdrawal.address;
					});
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockReceipts.map((receipt: any) => {
						receipt.from;
					});
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockReceipts.flatMap((receipt: any) => {
						receipt.logs.map((log: any) => {
							log.address;
						});
					});
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full block when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId",
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.hash",
		"eth_getBlockByHash.parentHash",
		"eth_getBlockByHash.sha3Uncles",
		"eth_getBlockByHash.miner",
		"eth_getBlockByHash.stateRoot",
		"eth_getBlockByHash.transactionsRoot",
		"eth_getBlockByHash.receiptsRoot",
		"eth_getBlockByHash.logsBloom",
		"eth_getBlockByHash.difficulty",
		"eth_getBlockByHash.gasLimit",
		"eth_getBlockByHash.gasUsed",
		"eth_getBlockByHash.timestamp",
		"eth_getBlockByHash.extraData",
		"eth_getBlockByHash.mixHash",
		"eth_getBlockByHash.nonce",
		"eth_getBlockByHash.baseFeePerGas",
		"eth_getBlockByHash.withdrawalsRoot",
		"eth_getBlockByHash.blobGasUsed",
		"eth_getBlockByHash.excessBlobGas",
		"eth_getBlockByHash.parentBeaconBlockRoot",
		"eth_getBlockByHash.requestsHash",
		"eth_getBlockByHash.size",
		"eth_getBlockByHash.uncles",
		"eth_getBlockByHash.transactions/type",
		"eth_getBlockByHash.transactions/chainId",
		"eth_getBlockByHash.transactions/nonce",
		"eth_getBlockByHash.transactions/gas",
		"eth_getBlockByHash.transactions/maxFeePerGas",
		"eth_getBlockByHash.transactions/maxPriorityFeePerGas",
		"eth_getBlockByHash.transactions/to",
		"eth_getBlockByHash.transactions/value",
		"eth_getBlockByHash.transactions/accessList",
		"eth_getBlockByHash.transactions/input",
		"eth_getBlockByHash.transactions/r",
		"eth_getBlockByHash.transactions/s",
		"eth_getBlockByHash.transactions/yParity",
		"eth_getBlockByHash.transactions/v",
		"eth_getBlockByHash.transactions/hash",
		"eth_getBlockByHash.transactions/blockHash",
		"eth_getBlockByHash.transactions/blockNumber",
		"eth_getBlockByHash.transactions/transactionIndex",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.transactions/gasPrice",
		"eth_getBlockByHash.withdrawals/index",
		"eth_getBlockByHash.withdrawals/validatorIndex",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.withdrawals/amount",
		"eth_getBlockReceipts/type",
		"eth_getBlockReceipts/status",
		"eth_getBlockReceipts/cumulativeGasUsed",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockReceipts/logsBloom",
		"eth_getBlockReceipts/transactionHash",
		"eth_getBlockReceipts/transactionIndex",
		"eth_getBlockReceipts/blockHash",
		"eth_getBlockReceipts/blockNumber",
		"eth_getBlockReceipts/gasUsed",
		"eth_getBlockReceipts/effectiveGasPrice",
		"eth_getBlockReceipts/from",
		"eth_getBlockReceipts/to",
		"eth_getBlockReceipts/contractAddress",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full transactions when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByHash.transactions)],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.transactions/type",
		"eth_getBlockByHash.transactions/chainId",
		"eth_getBlockByHash.transactions/nonce",
		"eth_getBlockByHash.transactions/gas",
		"eth_getBlockByHash.transactions/maxFeePerGas",
		"eth_getBlockByHash.transactions/maxPriorityFeePerGas",
		"eth_getBlockByHash.transactions/to",
		"eth_getBlockByHash.transactions/value",
		"eth_getBlockByHash.transactions/accessList",
		"eth_getBlockByHash.transactions/input",
		"eth_getBlockByHash.transactions/r",
		"eth_getBlockByHash.transactions/s",
		"eth_getBlockByHash.transactions/yParity",
		"eth_getBlockByHash.transactions/v",
		"eth_getBlockByHash.transactions/hash",
		"eth_getBlockByHash.transactions/blockHash",
		"eth_getBlockByHash.transactions/blockNumber",
		"eth_getBlockByHash.transactions/transactionIndex",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.transactions/gasPrice",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByHash.withdrawals)],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.withdrawals/index",
		"eth_getBlockByHash.withdrawals/validatorIndex",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.withdrawals/amount",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockReceipts)],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/type",
		"eth_getBlockReceipts/status",
		"eth_getBlockReceipts/cumulativeGasUsed",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockReceipts/logsBloom",
		"eth_getBlockReceipts/transactionHash",
		"eth_getBlockReceipts/transactionIndex",
		"eth_getBlockReceipts/blockHash",
		"eth_getBlockReceipts/blockNumber",
		"eth_getBlockReceipts/gasUsed",
		"eth_getBlockReceipts/effectiveGasPrice",
		"eth_getBlockReceipts/from",
		"eth_getBlockReceipts/to",
		"eth_getBlockReceipts/contractAddress",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return block.eth_getBlockReceipts.map((receipt) => {
				return JSON.stringify(receipt.logs);
			});
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full blocks during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block);
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId",
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.hash",
		"eth_getBlockByHash.parentHash",
		"eth_getBlockByHash.sha3Uncles",
		"eth_getBlockByHash.miner",
		"eth_getBlockByHash.stateRoot",
		"eth_getBlockByHash.transactionsRoot",
		"eth_getBlockByHash.receiptsRoot",
		"eth_getBlockByHash.logsBloom",
		"eth_getBlockByHash.difficulty",
		"eth_getBlockByHash.gasLimit",
		"eth_getBlockByHash.gasUsed",
		"eth_getBlockByHash.timestamp",
		"eth_getBlockByHash.extraData",
		"eth_getBlockByHash.mixHash",
		"eth_getBlockByHash.nonce",
		"eth_getBlockByHash.baseFeePerGas",
		"eth_getBlockByHash.withdrawalsRoot",
		"eth_getBlockByHash.blobGasUsed",
		"eth_getBlockByHash.excessBlobGas",
		"eth_getBlockByHash.parentBeaconBlockRoot",
		"eth_getBlockByHash.requestsHash",
		"eth_getBlockByHash.size",
		"eth_getBlockByHash.uncles",
		"eth_getBlockByHash.transactions/type",
		"eth_getBlockByHash.transactions/chainId",
		"eth_getBlockByHash.transactions/nonce",
		"eth_getBlockByHash.transactions/gas",
		"eth_getBlockByHash.transactions/maxFeePerGas",
		"eth_getBlockByHash.transactions/maxPriorityFeePerGas",
		"eth_getBlockByHash.transactions/to",
		"eth_getBlockByHash.transactions/value",
		"eth_getBlockByHash.transactions/accessList",
		"eth_getBlockByHash.transactions/input",
		"eth_getBlockByHash.transactions/r",
		"eth_getBlockByHash.transactions/s",
		"eth_getBlockByHash.transactions/yParity",
		"eth_getBlockByHash.transactions/v",
		"eth_getBlockByHash.transactions/hash",
		"eth_getBlockByHash.transactions/blockHash",
		"eth_getBlockByHash.transactions/blockNumber",
		"eth_getBlockByHash.transactions/transactionIndex",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.transactions/gasPrice",
		"eth_getBlockByHash.withdrawals/index",
		"eth_getBlockByHash.withdrawals/validatorIndex",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.withdrawals/amount",
		"eth_getBlockReceipts/type",
		"eth_getBlockReceipts/status",
		"eth_getBlockReceipts/cumulativeGasUsed",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockReceipts/logsBloom",
		"eth_getBlockReceipts/transactionHash",
		"eth_getBlockReceipts/transactionIndex",
		"eth_getBlockReceipts/blockHash",
		"eth_getBlockReceipts/blockNumber",
		"eth_getBlockReceipts/gasUsed",
		"eth_getBlockReceipts/effectiveGasPrice",
		"eth_getBlockReceipts/from",
		"eth_getBlockReceipts/to",
		"eth_getBlockReceipts/contractAddress",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full transactions during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block.eth_getBlockByHash.transactions);
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.transactions/type",
		"eth_getBlockByHash.transactions/chainId",
		"eth_getBlockByHash.transactions/nonce",
		"eth_getBlockByHash.transactions/gas",
		"eth_getBlockByHash.transactions/maxFeePerGas",
		"eth_getBlockByHash.transactions/maxPriorityFeePerGas",
		"eth_getBlockByHash.transactions/to",
		"eth_getBlockByHash.transactions/value",
		"eth_getBlockByHash.transactions/accessList",
		"eth_getBlockByHash.transactions/input",
		"eth_getBlockByHash.transactions/r",
		"eth_getBlockByHash.transactions/s",
		"eth_getBlockByHash.transactions/yParity",
		"eth_getBlockByHash.transactions/v",
		"eth_getBlockByHash.transactions/hash",
		"eth_getBlockByHash.transactions/blockHash",
		"eth_getBlockByHash.transactions/blockNumber",
		"eth_getBlockByHash.transactions/transactionIndex",
		"eth_getBlockByHash.transactions/from",
		"eth_getBlockByHash.transactions/gasPrice",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block.eth_getBlockByHash.withdrawals);
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockByHash.withdrawals/index",
		"eth_getBlockByHash.withdrawals/validatorIndex",
		"eth_getBlockByHash.withdrawals/address",
		"eth_getBlockByHash.withdrawals/amount",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block.eth_getBlockReceipts);
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/type",
		"eth_getBlockReceipts/status",
		"eth_getBlockReceipts/cumulativeGasUsed",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockReceipts/logsBloom",
		"eth_getBlockReceipts/transactionHash",
		"eth_getBlockReceipts/transactionIndex",
		"eth_getBlockReceipts/blockHash",
		"eth_getBlockReceipts/blockNumber",
		"eth_getBlockReceipts/gasUsed",
		"eth_getBlockReceipts/effectiveGasPrice",
		"eth_getBlockReceipts/from",
		"eth_getBlockReceipts/to",
		"eth_getBlockReceipts/contractAddress",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockReceipts.map((receipt: any) => {
						JSON.stringify(receipt.logs);
					});
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByHash.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockReceipts/logs/topics",
		"eth_getBlockReceipts/logs/data",
		"eth_getBlockReceipts/logs/blockHash",
		"eth_getBlockReceipts/logs/blockNumber",
		"eth_getBlockReceipts/logs/blockTimestamp",
		"eth_getBlockReceipts/logs/transactionHash",
		"eth_getBlockReceipts/logs/transactionIndex",
		"eth_getBlockReceipts/logs/logIndex",
		"eth_getBlockReceipts/logs/removed",
		"eth_getBlockByHash.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys returns accessed properties that are undefined", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					(block as any).anotherPropertyThatDoesntExist;
					(block.eth_getBlockByHash as any).propertyThatIsCurrentlyUndefined;
				}
			},
		},
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: blocks[22994233] }],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			block_number: "0x15edd39",
			created_at: expect.any(Number),
			block_hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId",
		"eth_getBlockByHash.number",
		"anotherPropertyThatDoesntExist",
		"eth_getBlockByHash.propertyThatIsCurrentlyUndefined",
		"eth_getBlockByHash.hash",
	]);
});
