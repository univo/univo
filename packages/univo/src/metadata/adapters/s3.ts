import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

import { AdapterError, defineAdapter } from "../adapters";

type S3Options = {
	bucket: string;
	region: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
};

function s3(opts: S3Options) {
	const client = new AwsClient({
		retries: 0,
		service: "s3",
		initRetryMs: 0,
		region: opts.region,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
	});

	const parser = new XMLParser({ parseTagValue: false });
	const endpoint = new URL(opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`);

	function url(path?: string): URL {
		const target = new URL(endpoint);

		let pathname = target.pathname.replace(/\/+$/, "");

		target.hostname = `${opts.bucket}.${target.hostname}`;

		if (path !== undefined) {
			const encodedPath = path.split("/").map(encodeURIComponent).join("/");
			pathname += `/${encodedPath}`;
		}

		target.pathname = pathname || "/";

		return target;
	}

	return defineAdapter({
		id: "s3",

		async delete(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const target = url(key);

			const res = await client.fetch(target, { method: "DELETE" });

			if (!res.ok || res.status < 200 || res.status >= 300) {
				throw new Error(`S3 DELETE ${target.pathname} failed with ${res.status} ${res.statusText}`);
			}
		},

		async get(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const target = url(key);

			const res = await client.fetch(target, { method: "GET" });

			if (res.status === 404) {
				return null;
			}

			if (!res.ok || res.status < 200 || res.status >= 300) {
				throw new Error(`S3 GET ${target.pathname} failed with ${res.status} ${res.statusText}`);
			}

			const etag = res.headers.get("etag");

			if (etag === null) {
				throw new Error(`S3 GET ${target.pathname} response is missing an ETag header`);
			}

			return {
				body: await res.arrayBuffer(),
				etag,
			};
		},

		async put(path, body, opts) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const target = url(key);
			const headers = new Headers();

			if (opts?.ifMatch !== undefined) {
				headers.set("if-match", opts.ifMatch);
			}

			if (opts?.ifNoneMatch !== undefined) {
				headers.set("if-none-match", opts.ifNoneMatch);
			}

			const res = await client.fetch(target, { method: "PUT", body, headers });

			if (res.status === 412) {
				throw new AdapterError("PreconditionFailed", `Storage precondition failed for path "${key}"`);
			}

			if (!res.ok || res.status < 200 || res.status >= 300) {
				throw new Error(`S3 PUT ${target.pathname} failed with ${res.status} ${res.statusText}`);
			}

			const etag = res.headers.get("etag");

			if (etag === null) {
				throw new Error(`S3 PUT ${target.pathname} response is missing an ETag header`);
			}

			return { etag };
		},

		async list(opts) {
			const target = url();

			target.searchParams.set("list-type", "2");
			target.searchParams.set("encoding-type", "url");

			if (opts?.prefix !== undefined) {
				target.searchParams.set("prefix", opts.prefix.replace(/^\/+/, ""));
			}

			if (opts?.cursor !== undefined) {
				target.searchParams.set("continuation-token", opts.cursor);
			}

			if (opts?.limit !== undefined) {
				target.searchParams.set("max-keys", String(opts.limit));
			}

			const res = await client.fetch(target, { method: "GET" });

			if (!res.ok || res.status < 200 || res.status >= 300) {
				throw new Error(`S3 GET ${target.pathname} failed with ${res.status} ${res.statusText}`);
			}

			const text = await res.text();

			const parsed = parser.parse(text) as {
				ListBucketResult?: {
					IsTruncated?: string;
					NextContinuationToken?: string;
					Contents?: { Key?: string } | { Key?: string }[];
				};
			};

			const result = parsed.ListBucketResult;

			if (result === undefined) {
				throw new Error("S3 list response has no ListBucketResult");
			}

			const contents = Array.isArray(result.Contents) ? result.Contents : result.Contents === undefined ? [] : [result.Contents];
			const keys = contents.flatMap(({ Key }) => (Key === undefined ? [] : [decodeURIComponent(Key)]));
			const nextContinuationToken = result.IsTruncated === "true" ? result.NextContinuationToken : undefined;

			if (result.IsTruncated === "true" && nextContinuationToken === undefined) {
				throw new Error("S3 list response is truncated but has no continuation token");
			}

			return { keys, cursor: nextContinuationToken };
		},
	});
}

export { s3 };
export type { S3Options };
