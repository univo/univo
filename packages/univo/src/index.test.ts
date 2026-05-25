import { expect, test } from "vitest";
import { createStorage } from "unstorage";

import { indexer } from ".";
import type { Event } from ".";
import { hexToNumber, numberToHex } from "./utils";
import { test_Block, test_getBlock, test_indexer } from "../tests/utils";

test.concurrent("correctly infers the event type", () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	expect(() => {
		univo.event({
			handler: () => [],
			id: "invalidchars()$%^#&!*&@!#",
			storage: { upsert: async () => {} },
			filters: [{ chain: 1, fromBlock: 0 }],
		});
	}).toThrowError;
});

test.concurrent("public_writeUnfinalizedHeads upserts events", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const upserted: any[] = [];

	univo.event({
		id: "test",
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	await test_indexer(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
					parentHash: "0x997e47bf4cac509c627753c06385ac866641ec6f883734ff7944411000dc576e",
				},
			],
		],
	});

	expect(upserted.length).toBe(1);
});

test.concurrent("public_writeUnfinalizedHeads retries upsert errors", async () => {
	const univo = indexer({ quiet: false, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	let count = 0;

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert() {
				if (count < 2) {
					count++;
					throw new Error();
				}
			},
		},
	});

	await test_indexer(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
					parentHash: "0x997e47bf4cac509c627753c06385ac866641ec6f883734ff7944411000dc576e",
				},
			],
		],
	});

	expect(count).toEqual(2);
});

test.concurrent("public_writeUnfinalizedHeads deduplicates events with the same storage adapter", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	let count = 0;
	let batch = [] as any[];

	const storage = {
		async upsert(events: any[]) {
			count++;
			batch = events;
		},
	};

	univo.event({
		storage,
		id: "event1",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event1-${block.eth_getBlockByNumber.hash}`],
	});

	univo.event({
		storage,
		id: "event2",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event2-${block.eth_getBlockByNumber.hash}`],
	});

	await test_indexer(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					number: "0xa",
					hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
					parentHash: "0x997e47bf4cac509c627753c06385ac866641ec6f883734ff7944411000dc576e",
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

test.concurrent("public_deleteReorganisedHead deletes events from reorganised blocks", async () => {
	let deleted = false;
	let upserted = false;

	const metadataStorage = createStorage();

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage,
		getBlock: async () => {
			if (upserted === false) {
				return await test_getBlock({
					chain: "0x1",
					number: "0x17ebb67",
					hash: "0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334", // Reorged
				});
			}

			return await test_getBlock({
				chain: "0x1",
				number: "0x17ebb67",
				hash: "0x7d7a73e8c978b3dab048c9b987c0f505ad8399dddbe705acfe3baef6773d7358", // Canonical
			});
		},
	});

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert() {
				upserted = true;
			},
			async delete() {
				deleted = true;
			},
		},
	});

	const client = test_indexer(univo);

	await client.request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					number: "0x17ebb67",
					hash: "0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334", // Reorged
					parentHash: "0x4eaaa6f851ee6686d4fc3cbd5ae740a31fd1431d143c646531bb61ae8965cef3",
				},
			],
		],
	});

	await client.request({
		method: "public_deleteReorganisedHead",
		params: [
			{
				chain: "0x1",
				number: "0x17ebb67",
				hash: "0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334", // Reorged
				parentHash: "0x4eaaa6f851ee6686d4fc3cbd5ae740a31fd1431d143c646531bb61ae8965cef3",
			},
		],
	});

	expect(upserted).toBe(true);
	expect(deleted).toBe(true);
});

test.concurrent("public_deleteReorganisedHead never deletes events from canonical blocks", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	let deleted = false;

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert() {
				//
			},
			async delete() {
				deleted = true;
			},
		},
	});

	await test_indexer(univo).request({
		method: "public_deleteReorganisedHead",
		params: [
			{
				chain: "0x1",
				number: "0xa",
				hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
				parentHash: "0x997e47bf4cac509c627753c06385ac866641ec6f883734ff7944411000dc576e",
			},
		],
	});

	expect(deleted).toBe(false);
});

test.concurrent("private_writeEvents indexes only the events requested", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const upserted: any[] = [];
	let event2HandlerCalled = false;

	univo.event({
		id: "event1",
		handler: (block) => [`event1-${block.eth_getBlockByNumber.hash}`],
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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["event1"],
				blocks: [block0],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);
	expect(upserted).toStrictEqual([`event1-${block0.eth_getBlockByNumber.hash}`]);
	expect(event2HandlerCalled).toBe(false);
});

test.concurrent("private_writeEvents deduplicates events with the same storage adapter", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	let count = 0;
	let batch = [] as any[];

	const storage = {
		async upsert(events: any[]) {
			count++;
			batch = events;
		},
	};

	univo.event({
		storage,
		id: "event1",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event1-${block.eth_getBlockByNumber.hash}`],
	});

	univo.event({
		storage,
		id: "event2",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [`event2-${block.eth_getBlockByNumber.hash}`],
	});

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["event1", "event2"],
				blocks: [block0],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);

	expect(count).toBe(1);

	expect(batch).toStrictEqual([`event1-${block0.eth_getBlockByNumber.hash}`, `event2-${block0.eth_getBlockByNumber.hash}`]);
});

test.concurrent("private_writeEvents records events", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block22994233],
			},
		],
	});

	expect(response.failures).toStrictEqual([]);
});

test.concurrent("private_writeEvents ignores events not explicitly requested", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		handler(block) {
			if (hexToNumber(block.eth_getBlockByNumber.number) === 1) {
				throw new Error("Test error message");
			}

			return [];
		},
	});

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test-random"],
				blocks: [block0, block1, block2],
			},
		],
	});

	expect(response.failures).toEqual([]);
});

test.concurrent("private_writeEvents returns handler errors", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0, toBlock: 2 }],
		handler(block) {
			if (hexToNumber(block.eth_getBlockByNumber.number) === 1) {
				throw new Error("Test error message");
			}

			return [];
		},
	});

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block0, block1, block2],
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block0, block1, block2],
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	let count = 0;

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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block0, block1, block2],
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block0, block1, block2],
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			// The following property exists on the type but isn't provided
			return [block.eth_getBlockByNumber.difficulty];
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
						eth_getBlockByNumber: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			try {
				return [block.eth_getBlockByNumber.difficulty];
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
						eth_getBlockByNumber: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block],
		storage: {
			upsert: async (blocks) => {
				for (const block of blocks) {
					// The following property exists on the type but isn't provided
					block.eth_getBlockByNumber.difficulty;
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
						eth_getBlockByNumber: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block],
		storage: {
			upsert: async (blocks) => {
				try {
					for (const block of blocks) {
						block.eth_getBlockByNumber.difficulty;
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
						eth_getBlockByNumber: {
							number: "0x1",
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.difficulty],
	});

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							number: "0x1",
							difficulty: null,
							hash: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3",
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await test_indexer(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [block0, block1, block2],
			},
		],
	});

	expect(response.failures).toStrictEqual([]); // Empty array implies successes
});

test.concurrent("private_writeEventsAndGetKeys indexes only the events requested", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	const upserted: any[] = [];
	let event2HandlerCalled = false;

	univo.event({
		id: "event1",
		handler: (block) => [`event1-${block.eth_getBlockByNumber.hash}`],
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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["event1"], block: block0 }],
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

	expect(upserted).toStrictEqual([`event1-${block0.eth_getBlockByNumber.hash}`]);
	expect(event2HandlerCalled).toBe(false);
});

test.concurrent("private_writeEventsAndGetKeys never upserts if handler returns empty event list", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block0 }],
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
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.baseFeePerGas],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.baseFeePerGas",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return block.eth_getBlockByNumber.transactions.map((transaction) => {
				return transaction.from;
			});
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawals keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler(block) {
			return (block.eth_getBlockByNumber.withdrawals || []).map((withdrawal) => {
				return withdrawal.address;
			});
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during handler", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByNumber.hash;
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByNumber.transactions.map((transaction: any) => {
						transaction.from;
					});
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawal keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					block.eth_getBlockByNumber.withdrawals?.map((withdrawal: any) => {
						withdrawal.address;
					});
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full block when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
		"eth_getBlockByNumber.sha3Uncles",
		"eth_getBlockByNumber.miner",
		"eth_getBlockByNumber.stateRoot",
		"eth_getBlockByNumber.transactionsRoot",
		"eth_getBlockByNumber.receiptsRoot",
		"eth_getBlockByNumber.logsBloom",
		"eth_getBlockByNumber.difficulty",
		"eth_getBlockByNumber.gasLimit",
		"eth_getBlockByNumber.gasUsed",
		"eth_getBlockByNumber.timestamp",
		"eth_getBlockByNumber.extraData",
		"eth_getBlockByNumber.mixHash",
		"eth_getBlockByNumber.nonce",
		"eth_getBlockByNumber.baseFeePerGas",
		"eth_getBlockByNumber.withdrawalsRoot",
		"eth_getBlockByNumber.blobGasUsed",
		"eth_getBlockByNumber.excessBlobGas",
		"eth_getBlockByNumber.parentBeaconBlockRoot",
		"eth_getBlockByNumber.requestsHash",
		"eth_getBlockByNumber.size",
		"eth_getBlockByNumber.uncles",
		"eth_getBlockByNumber.transactions/type",
		"eth_getBlockByNumber.transactions/chainId",
		"eth_getBlockByNumber.transactions/nonce",
		"eth_getBlockByNumber.transactions/gas",
		"eth_getBlockByNumber.transactions/maxFeePerGas",
		"eth_getBlockByNumber.transactions/maxPriorityFeePerGas",
		"eth_getBlockByNumber.transactions/to",
		"eth_getBlockByNumber.transactions/value",
		"eth_getBlockByNumber.transactions/input",
		"eth_getBlockByNumber.transactions/r",
		"eth_getBlockByNumber.transactions/s",
		"eth_getBlockByNumber.transactions/yParity",
		"eth_getBlockByNumber.transactions/v",
		"eth_getBlockByNumber.transactions/hash",
		"eth_getBlockByNumber.transactions/blockHash",
		"eth_getBlockByNumber.transactions/blockNumber",
		"eth_getBlockByNumber.transactions/transactionIndex",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.transactions/gasPrice",
		"eth_getBlockByNumber.transactions/accessList/address",
		"eth_getBlockByNumber.transactions/accessList/storageKeys",
		"eth_getBlockByNumber.transactions/blobVersionedHashes",
		"eth_getBlockByNumber.transactions/maxFeePerBlobGas",
		"eth_getBlockByNumber.withdrawals/index",
		"eth_getBlockByNumber.withdrawals/validatorIndex",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.withdrawals/amount",
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
		"eth_getBlockReceipts/blobGasUsed",
		"eth_getBlockReceipts/blobGasPrice",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full transactions when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByNumber.transactions)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/type",
		"eth_getBlockByNumber.transactions/chainId",
		"eth_getBlockByNumber.transactions/nonce",
		"eth_getBlockByNumber.transactions/gas",
		"eth_getBlockByNumber.transactions/maxFeePerGas",
		"eth_getBlockByNumber.transactions/maxPriorityFeePerGas",
		"eth_getBlockByNumber.transactions/to",
		"eth_getBlockByNumber.transactions/value",
		"eth_getBlockByNumber.transactions/input",
		"eth_getBlockByNumber.transactions/r",
		"eth_getBlockByNumber.transactions/s",
		"eth_getBlockByNumber.transactions/yParity",
		"eth_getBlockByNumber.transactions/v",
		"eth_getBlockByNumber.transactions/hash",
		"eth_getBlockByNumber.transactions/blockHash",
		"eth_getBlockByNumber.transactions/blockNumber",
		"eth_getBlockByNumber.transactions/transactionIndex",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.transactions/gasPrice",
		"eth_getBlockByNumber.transactions/accessList/address",
		"eth_getBlockByNumber.transactions/accessList/storageKeys",
		"eth_getBlockByNumber.transactions/blobVersionedHashes",
		"eth_getBlockByNumber.transactions/maxFeePerBlobGas",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByNumber.withdrawals)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/index",
		"eth_getBlockByNumber.withdrawals/validatorIndex",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.withdrawals/amount",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockReceipts)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
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
		"eth_getBlockReceipts/blobGasUsed",
		"eth_getBlockReceipts/blobGasPrice",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs when using JSON.stringify", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
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
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full blocks during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
		"eth_getBlockByNumber.sha3Uncles",
		"eth_getBlockByNumber.miner",
		"eth_getBlockByNumber.stateRoot",
		"eth_getBlockByNumber.transactionsRoot",
		"eth_getBlockByNumber.receiptsRoot",
		"eth_getBlockByNumber.logsBloom",
		"eth_getBlockByNumber.difficulty",
		"eth_getBlockByNumber.gasLimit",
		"eth_getBlockByNumber.gasUsed",
		"eth_getBlockByNumber.timestamp",
		"eth_getBlockByNumber.extraData",
		"eth_getBlockByNumber.mixHash",
		"eth_getBlockByNumber.nonce",
		"eth_getBlockByNumber.baseFeePerGas",
		"eth_getBlockByNumber.withdrawalsRoot",
		"eth_getBlockByNumber.blobGasUsed",
		"eth_getBlockByNumber.excessBlobGas",
		"eth_getBlockByNumber.parentBeaconBlockRoot",
		"eth_getBlockByNumber.requestsHash",
		"eth_getBlockByNumber.size",
		"eth_getBlockByNumber.uncles",
		"eth_getBlockByNumber.transactions/type",
		"eth_getBlockByNumber.transactions/chainId",
		"eth_getBlockByNumber.transactions/nonce",
		"eth_getBlockByNumber.transactions/gas",
		"eth_getBlockByNumber.transactions/maxFeePerGas",
		"eth_getBlockByNumber.transactions/maxPriorityFeePerGas",
		"eth_getBlockByNumber.transactions/to",
		"eth_getBlockByNumber.transactions/value",
		"eth_getBlockByNumber.transactions/input",
		"eth_getBlockByNumber.transactions/r",
		"eth_getBlockByNumber.transactions/s",
		"eth_getBlockByNumber.transactions/yParity",
		"eth_getBlockByNumber.transactions/v",
		"eth_getBlockByNumber.transactions/hash",
		"eth_getBlockByNumber.transactions/blockHash",
		"eth_getBlockByNumber.transactions/blockNumber",
		"eth_getBlockByNumber.transactions/transactionIndex",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.transactions/gasPrice",
		"eth_getBlockByNumber.transactions/accessList/address",
		"eth_getBlockByNumber.transactions/accessList/storageKeys",
		"eth_getBlockByNumber.transactions/blobVersionedHashes",
		"eth_getBlockByNumber.transactions/maxFeePerBlobGas",
		"eth_getBlockByNumber.withdrawals/index",
		"eth_getBlockByNumber.withdrawals/validatorIndex",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.withdrawals/amount",
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
		"eth_getBlockReceipts/blobGasUsed",
		"eth_getBlockReceipts/blobGasPrice",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full transactions during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block.eth_getBlockByNumber.transactions);
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/type",
		"eth_getBlockByNumber.transactions/chainId",
		"eth_getBlockByNumber.transactions/nonce",
		"eth_getBlockByNumber.transactions/gas",
		"eth_getBlockByNumber.transactions/maxFeePerGas",
		"eth_getBlockByNumber.transactions/maxPriorityFeePerGas",
		"eth_getBlockByNumber.transactions/to",
		"eth_getBlockByNumber.transactions/value",
		"eth_getBlockByNumber.transactions/input",
		"eth_getBlockByNumber.transactions/r",
		"eth_getBlockByNumber.transactions/s",
		"eth_getBlockByNumber.transactions/yParity",
		"eth_getBlockByNumber.transactions/v",
		"eth_getBlockByNumber.transactions/hash",
		"eth_getBlockByNumber.transactions/blockHash",
		"eth_getBlockByNumber.transactions/blockNumber",
		"eth_getBlockByNumber.transactions/transactionIndex",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.transactions/gasPrice",
		"eth_getBlockByNumber.transactions/accessList/address",
		"eth_getBlockByNumber.transactions/accessList/storageKeys",
		"eth_getBlockByNumber.transactions/blobVersionedHashes",
		"eth_getBlockByNumber.transactions/maxFeePerBlobGas",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					JSON.stringify(block.eth_getBlockByNumber.withdrawals);
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/index",
		"eth_getBlockByNumber.withdrawals/validatorIndex",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.withdrawals/amount",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
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
		"eth_getBlockReceipts/blobGasUsed",
		"eth_getBlockReceipts/blobGasPrice",
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs during upsert", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

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

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
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
		"eth_getBlockByNumber.hash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys returns accessed properties that are undefined", async () => {
	const univo = indexer({ quiet: true, signingKey: "test", getBlock: test_getBlock, metadataStorage: createStorage() });

	univo.event({
		id: "test",
		handler: (block) => [block],
		filters: [{ chain: 1, fromBlock: 0 }],
		storage: {
			async upsert(batch) {
				for (const block of batch) {
					(block as any).anotherPropertyThatDoesntExist;
					(block.eth_getBlockByNumber as any).propertyThatIsCurrentlyUndefined;
				}
			},
		},
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await test_indexer(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [{ events: ["test"], block: block22994233 }],
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
		"eth_getBlockByNumber.number",
		"anotherPropertyThatDoesntExist",
		"eth_getBlockByNumber.propertyThatIsCurrentlyUndefined",
		"eth_getBlockByNumber.hash",
	]);
});
