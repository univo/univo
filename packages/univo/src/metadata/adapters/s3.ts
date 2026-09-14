import { AwsClient } from "aws4fetch";

import { defineAdapter } from "../storage";
import type { StorageBody } from "../storage";

interface S3Options {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;

	region?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
}

function s3(opts: S3Options) {
	const region = opts.region ?? "us-east-1";
	const client = new AwsClient({
		retries: 0,
		initRetryMs: 0,
		service: "s3",
		region,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
	});

	const endpoint = new URL(opts.endpoint ?? `https://s3.${region}.amazonaws.com`);

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

	async function request(method: string, target: URL, body?: StorageBody): Promise<Response> {
		const response = await client.fetch(target, {
			method,
			...(body === undefined ? {} : { body }),
		});

		if (!response.ok) {
			throw new Error(`S3 ${method} ${target.pathname} failed with ${response.status} ${response.statusText}`);
		}

		return response;
	}

	return defineAdapter({
		id: "s3",

		async get(path) {
			const target = url(path);
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
			await request("PUT", url(path), body);
		},

		async list(prefix) {
			const paths: string[] = [];
			let continuationToken: string | undefined;

			do {
				const target = url();
				target.searchParams.set("list-type", "2");
				target.searchParams.set("encoding-type", "url");

				if (prefix !== undefined) {
					target.searchParams.set("prefix", prefix);
				}

				if (continuationToken !== undefined) {
					target.searchParams.set("continuation-token", continuationToken);
				}

				const xml = await (await request("GET", target)).text();
				paths.push(...extractTags(xml, "Key").map(decodeURIComponent));

				if (extractTag(xml, "IsTruncated") === "true") {
					continuationToken = extractTag(xml, "NextContinuationToken");

					if (continuationToken === undefined) {
						throw new Error("S3 list response is truncated but has no continuation token");
					}
				} else {
					continuationToken = undefined;
				}
			} while (continuationToken !== undefined);

			return paths;
		},

		async delete(path) {
			await request("DELETE", url(path));
		},
	});
}

function extractTag(xml: string, tag: string): string | undefined {
	const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

function extractTags(xml: string, tag: string): string[] {
	return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => decodeXml(match[1] ?? ""));
}

function decodeXml(value: string): string {
	return value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

export { s3 };
export type { S3Options };
