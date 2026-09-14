import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "vitest";

import { server } from "../../../tests/setup";
import { defineStorage } from "../storage";
import type { Storage } from "../storage";
import { r2 } from "./r2";
import { s3 } from "./s3";

const decoder = new TextDecoder();

function s3Server(origin: string, bucketPath = "") {
	const objects = new Map<string, ArrayBuffer>();
	const requests: Request[] = [];
	const handler = http.all(`${origin}/*`, async ({ request }) => {
		requests.push(request.clone());
		const url = new URL(request.url);
		const pathname = url.pathname.slice(bucketPath.length).replace(/^\//, "");
		const key = pathname.split("/").map(decodeURIComponent).join("/");

		if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") ?? "";
			const offset = Number(url.searchParams.get("continuation-token") ?? 0);
			const keys = [...objects.keys()].filter((path) => path.startsWith(prefix)).sort();
			const page = keys.slice(offset, offset + 2);
			const next = offset + page.length;
			const truncated = next < keys.length;
			const contents = page.map((path) => `<Contents><Key>${encodeURIComponent(path)}</Key></Contents>`).join("");
			const token = truncated ? `<NextContinuationToken>${next}</NextContinuationToken>` : "";

			return HttpResponse.xml(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${token}</ListBucketResult>`);
		}

		if (request.method === "PUT") {
			objects.set(key, await request.arrayBuffer());
			return new HttpResponse(null, { status: 200 });
		}

		if (request.method === "GET") {
			const body = objects.get(key);
			return body === undefined ? new HttpResponse(null, { status: 404 }) : new HttpResponse(body);
		}

		if (request.method === "DELETE") {
			objects.delete(key);
			return new HttpResponse(null, { status: 204 });
		}

		return new HttpResponse(null, { status: 405 });
	});

	return {
		objects,
		requests,
		use() {
			server.use(handler);
		},
	};
}

function storageAdapterTestSuite(getStorage: () => Storage) {
	let storage: Storage;

	beforeEach(() => {
		storage = getStorage();
	});

	describe("put and get", () => {
		test("round-trips a string body", async () => {
			await storage.put("hello.txt", "hello, world");
			expect(decoder.decode((await storage.get("hello.txt"))!)).toBe("hello, world");
		});

		test("round-trips an ArrayBuffer body", async () => {
			const body = new Uint8Array([1, 2, 3]).buffer;
			await storage.put("bytes.bin", body);
			expect(new Uint8Array((await storage.get("bytes.bin"))!)).toEqual(new Uint8Array([1, 2, 3]));
		});

		test("returns null for a missing key", async () => {
			expect(await storage.get("missing.txt")).toBeNull();
		});
	});

	describe("list and delete", () => {
		test("filters by prefix and walks every page", async () => {
			for (let i = 0; i < 5; i++) {
				await storage.put(`photos/${i}.jpg`, String(i));
			}
			await storage.put("videos/v.mp4", "v");

			const keys: string[] = [];
			let continuationToken: string | undefined;

			do {
				const page = await storage.list("photos/", continuationToken);
				keys.push(...page.keys);
				continuationToken = page.continuationToken;
			} while (continuationToken !== undefined);

			expect(keys).toEqual(["photos/0.jpg", "photos/1.jpg", "photos/2.jpg", "photos/3.jpg", "photos/4.jpg"]);
		});

		test("deletes a key", async () => {
			await storage.put("photo.jpg", "bytes");
			await storage.delete("photo.jpg");
			expect(await storage.get("photo.jpg")).toBeNull();
		});

		test("handles nested keys with special characters", async () => {
			const path = "photos/holiday (2024) & sun.jpg";
			await storage.put(path, "sun");

			expect(decoder.decode((await storage.get(path))!)).toBe("sun");
			expect(await storage.list("photos/")).toEqual({ keys: [path], continuationToken: undefined });
		});
	});
}

describe("s3", () => {
	const mock = s3Server("https://bucket.s3.test");
	const adapter = s3({
		bucket: "bucket",
		accessKeyId: "access-key",
		secretAccessKey: "secret-key",
		region: "test-region",
		endpoint: "https://s3.test",
		forcePathStyle: false,
	});

	beforeEach(() => {
		mock.objects.clear();
		mock.requests.length = 0;
		mock.use();
	});

	storageAdapterTestSuite(() => defineStorage({ adapter }));

	test("signs requests for S3", async () => {
		await adapter.put("signed.txt", "signed");
		const authorization = mock.requests.at(-1)?.headers.get("authorization");

		expect(authorization).toContain("Credential=access-key/");
		expect(authorization).toContain("/test-region/s3/aws4_request");
	});

	test("supports path-style custom endpoints", async () => {
		const pathStyle = s3Server("https://storage.test", "/base/bucket");
		pathStyle.use();
		const pathStyleAdapter = s3({
			bucket: "bucket",
			accessKeyId: "access-key",
			secretAccessKey: "secret-key",
			endpoint: "https://storage.test/base",
			forcePathStyle: true,
		});

		await pathStyleAdapter.put("nested/key.txt", "value");

		expect(new URL(pathStyle.requests[0]?.url ?? "").pathname).toBe("/base/bucket/nested/key.txt");
	});

	test("throws for provider errors", async () => {
		server.use(http.put("https://bucket.s3.test/failure", () => new HttpResponse(null, { status: 500 })));

		await expect(adapter.put("failure", "x")).rejects.toThrow("S3 PUT /failure failed with 500");
	});
});

describe("r2", () => {
	test("uses the account endpoint and auto region", async () => {
		const mock = s3Server("https://bucket.account.r2.cloudflarestorage.com");
		mock.use();
		const adapter = r2({
			bucket: "bucket",
			accountId: "account",
			accessKeyId: "access-key",
			secretAccessKey: "secret-key",
		});

		await adapter.put("key.txt", "value");

		expect(adapter.id).toBe("r2");
		expect(new URL(mock.requests[0]?.url ?? "").pathname).toBe("/key.txt");
		expect(mock.requests[0]?.headers.get("authorization")).toContain("/auto/s3/aws4_request");
	});
});
