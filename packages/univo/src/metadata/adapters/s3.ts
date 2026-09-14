import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

import { defineAdapter } from "../storage";

interface S3Options {
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;

	endpoint?: string;
	forcePathStyle?: boolean;
}

interface ListObjectsResult {
	ListBucketResult?: {
		Contents?: { Key?: string } | { Key?: string }[];
		IsTruncated?: string;
		NextContinuationToken?: string;
	};
}

function s3(opts: S3Options) {
	const client = new AwsClient({
		retries: 0,
		initRetryMs: 0,
		service: "s3",
		region: opts.region,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
	});

	const endpoint = new URL(opts.endpoint ?? `https://s3.${opts.region}.amazonaws.com`);
	const parser = new XMLParser({ parseTagValue: false });

	function normalizePath(path: string): string {
		const normalized = path.replace(/^\/+/, "");

		if (normalized.length === 0) {
			throw new Error("Storage path must not be empty");
		}

		return normalized;
	}

	function url(path?: string): URL {
		const target = new URL(endpoint);
		const basePath = target.pathname.replace(/\/+$/, "");
		const pathStyle = opts.forcePathStyle ?? false;
		let pathname = basePath;

		if (pathStyle) {
			pathname += `/${encodeURIComponent(opts.bucket)}`;
		} else {
			target.hostname = `${opts.bucket}.${target.hostname}`;
		}

		if (path !== undefined) {
			const encodedPath = path.split("/").map(encodeURIComponent).join("/");
			pathname += `/${encodedPath}`;
		}

		target.pathname = pathname || "/";

		return target;
	}

	return defineAdapter({
		id: "s3",

		async get(path) {
			const target = url(normalizePath(path));
			const response = await client.fetch(target, { method: "GET" });

			if (response.status === 404) {
				return null;
			}

			if (!response.ok) {
				throw new Error(`S3 GET ${target.pathname} failed with ${response.status} ${response.statusText}`);
			}

			return response.arrayBuffer();
		},

		async put(path, body) {
			const target = url(normalizePath(path));
			const response = await client.fetch(target, { method: "PUT", body });

			if (!response.ok) {
				throw new Error(`S3 PUT ${target.pathname} failed with ${response.status} ${response.statusText}`);
			}
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

			const response = await client.fetch(target, { method: "GET" });

			if (!response.ok) {
				throw new Error(`S3 GET ${target.pathname} failed with ${response.status} ${response.statusText}`);
			}

			const parsed = parser.parse(await response.text()) as ListObjectsResult;
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

		async delete(path) {
			const target = url(normalizePath(path));
			const response = await client.fetch(target, { method: "DELETE" });

			if (!response.ok) {
				throw new Error(`S3 DELETE ${target.pathname} failed with ${response.status} ${response.statusText}`);
			}
		},
	});
}

export { s3 };
export type { S3Options };
