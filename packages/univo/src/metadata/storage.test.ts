import { beforeEach, describe, expect, test, vi } from "vitest";

import { memory } from "./adapters/memory";
import { defineStorage } from "./storage";
import type { Adapter } from "./storage";

describe("storage", () => {
	let adapter: Adapter;

	beforeEach(() => {
		adapter = memory();
	});

	test("delegates each operation to the adapter", async () => {
		const put = vi.spyOn(adapter, "put");
		const get = vi.spyOn(adapter, "get");
		const list = vi.spyOn(adapter, "list");
		const remove = vi.spyOn(adapter, "delete");
		const storage = defineStorage({ adapter });

		await storage.put("hello.txt", "hello");
		expect(new TextDecoder().decode((await storage.get("hello.txt"))!)).toBe("hello");
		expect(await storage.list("hello")).toEqual(["hello.txt"]);
		await storage.delete("hello.txt");

		expect(put).toHaveBeenCalledWith("hello.txt", "hello");
		expect(get).toHaveBeenCalledWith("hello.txt");
		expect(list).toHaveBeenCalledWith("hello");
		expect(remove).toHaveBeenCalledWith("hello.txt");
	});

	test("normalizes leading slashes", async () => {
		const storage = defineStorage({ adapter });

		await storage.put("/photos/a.jpg", "a");

		expect(new TextDecoder().decode((await storage.get("photos/a.jpg"))!)).toBe("a");
		expect(await storage.list("/photos/")).toEqual(["photos/a.jpg"]);
	});

	test("rejects empty paths", async () => {
		const storage = defineStorage({ adapter });

		await expect(storage.put("", "x")).rejects.toThrow("Storage path must not be empty");
		await expect(storage.get("///")).rejects.toThrow("Storage path must not be empty");
	});
});
