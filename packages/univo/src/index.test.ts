import { expect, test } from "vitest";

import { indexer } from ".";
import type { Event } from ".";
import { local } from "./transport";
import { hexToNumber, numberToHex } from "./utils";
import { test_Block, test_getBlock, test_metadataStorage } from "../tests/utils";

test.concurrent("correctly infers the event type", () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block9;
			}

			return block10;
		},
	});

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

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: block10.eth_getBlockByNumber.hash,
					number: block10.eth_getBlockByNumber.number,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted.length).toBe(1);
});

test.concurrent("public_writeUnfinalizedHeads retries upsert errors", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block9;
			}

			return block10;
		},
	});

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

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: block10.eth_getBlockByNumber.hash,
					number: block10.eth_getBlockByNumber.number,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(count).toEqual(2);
});

test.concurrent("public_writeUnfinalizedHeads deduplicates events with the same storage adapter", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block9;
			}

			return block10;
		},
	});

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

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: block10.eth_getBlockByNumber.hash,
					number: block10.eth_getBlockByNumber.number,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
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

test.concurrent("public_writeUnfinalizedHeads tolerates partial block-load failure", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });
	const block11 = await test_getBlock({ chain: "0x1", number: numberToHex(11) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block9;
			}

			if (block.number === numberToHex(11)) {
				throw new Error("Simulating failing to load block 11");
			}

			return block10;
		},
	});

	const upserted: string[] = [];

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.number],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: block10.eth_getBlockByNumber.hash,
					number: block10.eth_getBlockByNumber.number,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
				{
					chain: "0x1",
					hash: block11.eth_getBlockByNumber.hash,
					number: block11.eth_getBlockByNumber.number,
					parent_hash: block11.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted).toStrictEqual([block10.eth_getBlockByNumber.number]);
});

test.concurrent("public_writeUnfinalizedHeads ignores finalized heads", async () => {
	// 1. Chain is finalised at 10
	// 2. Write finalized genesis block as unfinalized

	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block10;
			}

			return block0;
		},
	});

	let upserted = false;

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: () => {
			upserted = true;

			return [];
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block0.eth_chainId,
					hash: block0.eth_getBlockByNumber.hash,
					number: block0.eth_getBlockByNumber.number,
					parent_hash: block0.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted).toBe(false);
});

test.concurrent("public_deleteReorganisedHead deletes events from reorganised blocks", async () => {
	let deleted = false;
	let upserted = false;

	const finalized = await test_getBlock({ chain: "0x1", number: numberToHex(25082726) });

	const reorganised = await test_getBlock({
		chain: "0x1",
		number: numberToHex(25082727),
		hash: "0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334",
	});

	const canonical = await test_getBlock({
		chain: "0x1",
		number: numberToHex(25082727),
		hash: "0x7d7a73e8c978b3dab048c9b987c0f505ad8399dddbe705acfe3baef6773d7358",
	});

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return finalized;
			}

			if (upserted === false) {
				return reorganised;
			}

			return canonical;
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

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: reorganised.eth_getBlockByNumber.hash,
					number: reorganised.eth_getBlockByNumber.number,
					parent_hash: reorganised.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await local(univo).request({
		method: "public_deleteReorganisedHead",
		params: [
			{
				chain: "0x1",
				hash: reorganised.eth_getBlockByNumber.hash,
				number: reorganised.eth_getBlockByNumber.number,
				parent_hash: reorganised.eth_getBlockByNumber.parentHash,
			},
		],
	});

	expect(upserted).toBe(true);
	expect(deleted).toBe(true);
});

test.concurrent("public_deleteReorganisedHead never deletes events from canonical blocks", async () => {
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	await local(univo).request({
		method: "public_deleteReorganisedHead",
		params: [
			{
				chain: "0x1",
				hash: block10.eth_getBlockByNumber.hash,
				number: block10.eth_getBlockByNumber.number,
				parent_hash: block10.eth_getBlockByNumber.parentHash,
			},
		],
	});

	expect(deleted).toBe(false);
});

test.concurrent("public_writeFinalizedHeads writes finalized heads", async () => {
	const block0 = await test_getBlock({ chain: "0x1", number: numberToHex(0) });
	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });

	// 1. We are intially finalized at block 0
	// 2. We write the unfinalised block 1
	// 3. Chain finalises block 1
	// 4. We write finalized block 1

	let count = 0;

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				if (count === 0) {
					count++;

					return block0;
				}

				return block1;
			}

			return block1;
		},
	});

	const upserted: string[] = [];

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block1.eth_chainId,
					number: block1.eth_getBlockByNumber.number,
					hash: block1.eth_getBlockByNumber.hash,
					parent_hash: block1.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await local(univo).request({
		method: "public_writeFinalizedHeads",
		params: [
			[
				{
					chain: block1.eth_chainId,
					number: block1.eth_getBlockByNumber.number,
					hash: block1.eth_getBlockByNumber.hash,
					parent_hash: block1.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted).toStrictEqual([block1.eth_getBlockByNumber.hash, block1.eth_getBlockByNumber.hash]);
});

test.concurrent("public_writeFinalizedHeads removes reorganised events", async () => {
	const block25082726 = await test_getBlock({ chain: "0x1", number: numberToHex(25082726) });

	const canonical = await test_getBlock({
		chain: "0x1",
		number: numberToHex(25082727),
		hash: "0x7d7a73e8c978b3dab048c9b987c0f505ad8399dddbe705acfe3baef6773d7358",
	});

	const reorganised = await test_getBlock({
		chain: "0x1",
		number: numberToHex(25082727),
		hash: "0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334",
	});

	const block25082728 = await test_getBlock({ chain: "0x1", number: numberToHex(25082728) });

	// 1. We are initially finalized at 25082726
	// 2. We write the unfinalized reorganised block at 25082727
	// 3. Chain finalises at 25082728
	// 4. Write finalized block 25082727 and return a different canonical block

	let count = 0;
	let deleted = false;
	let upserted = false;

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				if (count === 0) {
					count++;
					return block25082726;
				}

				return block25082728;
			}

			if (upserted === false) {
				return reorganised;
			}

			return canonical;
		},
	});

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert(events) {
				if (events.includes("0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334")) {
					upserted = true;
				}
			},
			async delete(events) {
				if (events.includes("0x9b8a7605b52262203ca0541d5a46b6ceb83f0d55849572bcd5c4633c319c5334")) {
					deleted = true;
				}
			},
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: reorganised.eth_getBlockByNumber.hash,
					number: reorganised.eth_getBlockByNumber.number,
					parent_hash: reorganised.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await local(univo).request({
		method: "public_writeFinalizedHeads",
		params: [
			[
				{
					chain: "0x1",
					hash: canonical.eth_getBlockByNumber.hash,
					number: canonical.eth_getBlockByNumber.number,
					parent_hash: canonical.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted).toBe(true);
	expect(deleted).toBe(true);
});

test.concurrent("public_writeFinalizedHeads throws when receiving heads from different chains", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	await expect(
		local(univo).request({
			method: "public_writeFinalizedHeads",
			params: [
				[
					{
						chain: "0x1",
						number: "0xa",
						hash: "0x4ff4a38b278ab49f7739d3a4ed4e12714386a9fdf72192f2e8f7da7822f10b4d",
						parent_hash: "0x997e47bf4cac509c627753c06385ac866641ec6f883734ff7944411000dc576e",
					},
					{
						chain: "0x2",
						number: "0xb",
						hash: "0x7d7a73e8c978b3dab048c9b987c0f505ad8399dddbe705acfe3baef6773d7358",
						parent_hash: "0x4eaaa6f851ee6686d4fc3cbd5ae740a31fd1431d143c646531bb61ae8965cef3",
					},
				],
			],
		}),
	).rejects.toThrowError();
});

test.concurrent("public_writeFinalizedHeads throws when receiving an unknown head", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async (block) => {
			if (block.number === "finalized") {
				return block9;
			}

			return block10;
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await expect(
		local(univo).request({
			method: "public_writeFinalizedHeads",
			params: [
				[
					{
						chain: block10.eth_chainId,
						number: block10.eth_getBlockByNumber.number,
						hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
						parent_hash: block10.eth_getBlockByNumber.parentHash,
					},
				],
			],
		}),
	).rejects.toThrowError();
});

test.concurrent("public_writeFinalizedHeads throws if it receives a head greater than chain finalization", async () => {
	const block10 = await test_getBlock({ chain: "0x1", number: "0xa" });
	const block11 = await test_getBlock({ chain: "0x1", number: "0xb" });

	// 1. We are finalized at 10
	// 2. We attempt to send 11 as finalised

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async ({ chain, number }) => {
			if (number === "finalized") {
				return block10;
			}

			return await test_getBlock({ chain, number });
		},
	});

	await expect(
		local(univo).request({
			method: "public_writeFinalizedHeads",
			params: [
				[
					{
						chain: block11.eth_chainId,
						number: block11.eth_getBlockByNumber.number,
						hash: block11.eth_getBlockByNumber.hash,
						parent_hash: block11.eth_getBlockByNumber.parentHash,
					},
				],
			],
		}),
	).rejects.toThrowError();
});

test.concurrent("public_writeFinalizedHeads deletes finalized metadata blocks after successful processing", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });
	const block11 = await test_getBlock({ chain: "0x1", number: numberToHex(11) });

	const metadataStorage = test_metadataStorage();

	// 1. Chain is finalised at 9
	// 2. Write unfinalized 10
	// 3. Chain finalizes at 11
	// 4. Write finalized 10

	let count = 0;

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage,
		getBlock: async (block) => {
			if (block.number === "finalized") {
				if (count === 0) {
					count++;
					return block9;
				}

				return block11;
			}

			return block10;
		},
	});

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: { upsert: async () => {} },
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(await metadataStorage.list({ prefix: "/blocks/v1/0x1" }).then((result) => result.items)).not.toStrictEqual([]);

	await local(univo).request({
		method: "public_writeFinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(await metadataStorage.list({ prefix: "/blocks/v1/0x1" }).then((result) => result.items)).toStrictEqual([]);
});

test.concurrent("public_writeFinalizedHeads rejects wrong parent linkage between adjacent finalized heads", async () => {
	const block10 = await test_getBlock({ chain: "0x1", number: "0xa" });
	const block11 = await test_getBlock({ chain: "0x1", number: "0xb" });

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage: test_metadataStorage(),
		getBlock: async ({ chain, number }) => {
			if (number === "finalized") {
				return block11;
			}

			return await test_getBlock({ chain, number });
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
				{
					chain: block11.eth_chainId,
					number: block11.eth_getBlockByNumber.number,
					hash: block11.eth_getBlockByNumber.hash,
					parent_hash: block11.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await expect(
		local(univo).request({
			method: "public_writeFinalizedHeads",
			params: [
				[
					{
						chain: block10.eth_chainId,
						number: block10.eth_getBlockByNumber.number,
						hash: block10.eth_getBlockByNumber.hash,
						parent_hash: block10.eth_getBlockByNumber.parentHash,
					},
					{
						chain: block11.eth_chainId,
						number: block11.eth_getBlockByNumber.number,
						hash: block11.eth_getBlockByNumber.hash,
						parent_hash: block10.eth_getBlockByNumber.parentHash,
					},
				],
			],
		}),
	).rejects.toThrowError();
});

test.concurrent("public_writeFinalizedHeads is idempotent when called twice with the same finalized window", async () => {
	const block9 = await test_getBlock({ chain: "0x1", number: numberToHex(9) });
	const block10 = await test_getBlock({ chain: "0x1", number: numberToHex(10) });
	const block11 = await test_getBlock({ chain: "0x1", number: numberToHex(11) });

	const metadataStorage = test_metadataStorage();

	// 1. Chain is finalized at 9
	// 2. Write unfinalized 10
	// 3. Chain finalizes at 11
	// 4. Write finalized 10 twice without error

	let count = 0;

	const univo = indexer({
		quiet: true,
		signingKey: "test",
		metadataStorage,
		getBlock: async (block) => {
			if (block.number === "finalized") {
				if (count === 0) {
					count++;
					return block9;
				}

				return block11;
			}

			return block10;
		},
	});

	const upserted: string[] = [];

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.hash],
		storage: {
			async upsert(events) {
				upserted.push(...events);
			},
		},
	});

	await local(univo).request({
		method: "public_writeUnfinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await local(univo).request({
		method: "public_writeFinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	await local(univo).request({
		method: "public_writeFinalizedHeads",
		params: [
			[
				{
					chain: block10.eth_chainId,
					number: block10.eth_getBlockByNumber.number,
					hash: block10.eth_getBlockByNumber.hash,
					parent_hash: block10.eth_getBlockByNumber.parentHash,
				},
			],
		],
	});

	expect(upserted).toStrictEqual([block10.eth_getBlockByNumber.hash, block10.eth_getBlockByNumber.hash]);
});

test.concurrent("private_writeEvents indexes only the events requested", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns errors thrown during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents retries upsert errors", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "upsert_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);

	expect(count).toEqual(3);
});

test.concurrent("private_writeEvents only returns the handler error if both handler and upsert fail", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "handler_error",
			event_id: "test",
			chain: expect.any(String),
			hash: expect.any(String),
			number: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns incomplete errors in handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => {
			// The following property exists on the type but isn't provided
			return [block.eth_getBlockByNumber.difficulty];
		},
		storage: { upsert: async () => {} },
	});

	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await local(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block1.eth_getBlockByNumber.hash,
							number: block1.eth_getBlockByNumber.number,
							parentHash: block1.eth_getBlockByNumber.parentHash,
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block2.eth_getBlockByNumber.hash,
							number: block2.eth_getBlockByNumber.number,
							parentHash: block2.eth_getBlockByNumber.parentHash,
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
			number: "0x1",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			number: "0x2",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns swallowed incomplete errors in handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await local(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block1.eth_getBlockByNumber.hash,
							number: block1.eth_getBlockByNumber.number,
							parentHash: block1.eth_getBlockByNumber.parentHash,
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block2.eth_getBlockByNumber.hash,
							number: block2.eth_getBlockByNumber.number,
							parentHash: block2.eth_getBlockByNumber.parentHash,
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
			number: "0x1",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			number: "0x2",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns incomplete errors in upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await local(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block1.eth_getBlockByNumber.hash,
							number: block1.eth_getBlockByNumber.number,
							parentHash: block1.eth_getBlockByNumber.parentHash,
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block2.eth_getBlockByNumber.hash,
							number: block2.eth_getBlockByNumber.number,
							parentHash: block2.eth_getBlockByNumber.parentHash,
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
			number: "0x1",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			number: "0x2",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents returns swallowed incomplete errors in upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const block1 = await test_getBlock({ chain: "0x1", number: numberToHex(1) });
	const block2 = await test_getBlock({ chain: "0x1", number: numberToHex(2) });

	const response = await local(univo).request({
		method: "private_writeEvents",
		params: [
			{
				events: ["test"],
				blocks: [
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block1.eth_getBlockByNumber.hash,
							number: block1.eth_getBlockByNumber.number,
							parentHash: block1.eth_getBlockByNumber.parentHash,
						},
					},
					{
						eth_chainId: "0x1",
						eth_getBlockByNumber: {
							hash: block2.eth_getBlockByNumber.hash,
							number: block2.eth_getBlockByNumber.number,
							parentHash: block2.eth_getBlockByNumber.parentHash,
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
			number: "0x1",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
		{
			status: "incomplete_error",
			event_id: "test",
			chain: "0x1",
			number: "0x2",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEvents doesn't return an error when accessing a provided null property", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.difficulty],
	});

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["event1"],
				head: {
					chain: "0x1",
					hash: block0.eth_getBlockByNumber.hash,
					number: block0.eth_getBlockByNumber.number,
					parent_hash: block0.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "event1",
			number: "0x0",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);

	expect(upserted).toStrictEqual([`event1-${block0.eth_getBlockByNumber.hash}`]);
	expect(event2HandlerCalled).toBe(false);
});

test.concurrent("private_writeEventsAndGetKeys never upserts if handler returns empty event list", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block0.eth_getBlockByNumber.hash,
					number: block0.eth_getBlockByNumber.number,
					parent_hash: block0.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x0",
			hash: expect.any(String),
			parent_hash: expect.any(String),
			created_at: expect.any(Number),
		},
	]);
});

test.concurrent("private_writeEventsAndGetKeys records minimum keys from matching filters", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		handler: () => [],
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [block.eth_getBlockByNumber.baseFeePerGas],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.baseFeePerGas",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawals keys during handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during handler", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records block keys during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records transaction keys during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.transactions/from",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records withdrawal keys during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockByNumber.withdrawals/address",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records receipt keys during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/from",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records log keys during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId", //
		"eth_getBlockByNumber.number",
		"eth_getBlockReceipts/logs/address",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full block when using JSON.stringify", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByNumber.transactions)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals when using JSON.stringify", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockByNumber.withdrawals)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts when using JSON.stringify", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

	univo.event({
		id: "test",
		storage: { upsert: async () => {} },
		filters: [{ chain: 1, fromBlock: 0 }],
		handler: (block) => [JSON.stringify(block.eth_getBlockReceipts)],
	});

	const block22994233 = await test_getBlock({ chain: "0x1", number: numberToHex(22994233) });

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs when using JSON.stringify", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full blocks during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full withdrawals during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipts during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys records full receipt logs during upsert", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
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
		"eth_getBlockByNumber.parentHash",
	]);
});

test.concurrent("private_writeEventsAndGetKeys returns accessed properties that are undefined", async () => {
	const univo = indexer({
		quiet: true,
		signingKey: "test",
		getBlock: test_getBlock,
		metadataStorage: test_metadataStorage(),
	});

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

	const response = await local(univo).request({
		method: "private_writeEventsAndGetKeys",
		params: [
			{
				events: ["test"],
				head: {
					chain: "0x1",
					hash: block22994233.eth_getBlockByNumber.hash,
					number: block22994233.eth_getBlockByNumber.number,
					parent_hash: block22994233.eth_getBlockByNumber.parentHash,
				},
			},
		],
	});

	expect(response.results).toStrictEqual([
		{
			status: "ok",
			chain: "0x1",
			event_id: "test",
			number: "0x15edd39",
			parent_hash: expect.any(String),
			hash: "0x0393419cabd72fe7736c333bed50df0d4c616c6be1f4d2048adb29643112d9ad",
			created_at: expect.any(Number),
		},
	]);

	expect(response.keys).toStrictEqual([
		"eth_chainId",
		"eth_getBlockByNumber.number",
		"anotherPropertyThatDoesntExist",
		"eth_getBlockByNumber.propertyThatIsCurrentlyUndefined",
		"eth_getBlockByNumber.hash",
		"eth_getBlockByNumber.parentHash",
	]);
});
