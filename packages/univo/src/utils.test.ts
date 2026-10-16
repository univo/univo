import { expect, test } from "vitest";
import { queue } from "./utils";

test.concurrent("queue runs tasks serially in submission order without dropping calls", async () => {
	const enqueue = queue();
	const events: string[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	const first = enqueue(async () => {
		events.push("first started");
		await gate;
		events.push("first finished");
		return 1;
	});
	const second = enqueue(() => {
		events.push("second");
		return 2;
	});
	const third = enqueue(() => {
		events.push("third");
		return 3;
	});

	await Promise.resolve();
	expect(events).toEqual(["first started"]);

	release();
	expect(await Promise.all([first, second, third])).toEqual([1, 2, 3]);
	expect(events).toEqual(["first started", "first finished", "second", "third"]);

	expect(await enqueue(() => 4)).toBe(4);
});

test.concurrent("queue rejects failed tasks without blocking later tasks", async () => {
	const enqueue = queue();
	const syncError = new Error("synchronous failure");
	const asyncError = new Error("asynchronous failure");

	const first = enqueue(() => {
		throw syncError;
	});
	const second = enqueue(async () => {
		throw asyncError;
	});
	const third = enqueue(() => "success");

	expect(await Promise.allSettled([first, second, third])).toEqual([
		{ status: "rejected", reason: syncError },
		{ status: "rejected", reason: asyncError },
		{ status: "fulfilled", value: "success" },
	]);
});

test.concurrent("queues are independent", async () => {
	const enqueue = queue();
	const other = queue();
	let release!: () => void;
	const blocked = enqueue(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);

	expect(await other(() => "independent")).toBe("independent");
	release();
	await blocked;
});
