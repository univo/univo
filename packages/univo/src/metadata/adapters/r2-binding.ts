import type { R2Bucket } from "@cloudflare/workers-types";

import { AdapterError, defineAdapter } from "../adapters";

interface R2Options {
	binding: R2Bucket;
}

function r2(opts: R2Options) {
	const { binding } = opts;

	return defineAdapter({
		id: "r2-binding",

		async delete(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			await binding.delete(key);
		},

		async get(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const object = await binding.get(key);

			if (object === null) {
				return null;
			}

			return {
				body: await object.arrayBuffer(),
				etag: object.etag,
			};
		},

		async put(path, body, opts) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const onlyIf =
				opts?.ifMatch !== undefined
					? { etagMatches: opts.ifMatch }
					: opts?.ifNoneMatch !== undefined
						? { etagDoesNotMatch: opts.ifNoneMatch }
						: undefined;

			const object = await binding.put(key, body, onlyIf === undefined ? undefined : { onlyIf });

			if (object === null) {
				throw new AdapterError("PreconditionFailed", `Storage precondition failed for path "${key}"`);
			}

			return { etag: object.etag };
		},

		async list(opts) {
			const result = await binding.list({
				limit: opts?.limit,
				cursor: opts?.cursor,
				prefix: opts?.prefix?.replace(/^\/+/, ""),
			});

			return {
				keys: result.objects.map((object) => object.key),
				cursor: result.truncated ? result.cursor : undefined,
			};
		},
	});
}

export { r2 };
export type { R2Options };
