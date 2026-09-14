import { AdapterError, defineAdapter } from "../adapters";

function memory() {
	let etag = 0;

	const objects = new Map<string, { body: ArrayBuffer; etag: string }>();

	return defineAdapter({
		id: "memory",

		async put(path, body, opts) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const current = objects.get(key);

			if (opts?.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
				throw new AdapterError("PreconditionFailed", `Storage precondition failed for path "${key}"`);
			}

			if (opts?.ifNoneMatch === "*" && current !== undefined) {
				throw new AdapterError("PreconditionFailed", `Storage precondition failed for path "${key}"`);
			}

			const bytes = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
			const nextEtag = String(etag++);
			objects.set(key, { body: bytes.slice(0), etag: nextEtag });

			return { etag: nextEtag };
		},

		async get(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			const object = objects.get(key);

			return object === undefined ? null : { body: object.body.slice(0), etag: object.etag };
		},

		async list(opts) {
			const offset = Number(opts?.cursor ?? 0);
			const prefix = opts?.prefix?.replace(/^\/+/, "") ?? "";
			const matching = [...objects.keys()].filter((path) => path.startsWith(prefix)).sort();
			const keys = matching.slice(offset, opts?.limit === undefined ? undefined : offset + opts.limit);
			const nextOffset = offset + keys.length;
			const cursor = nextOffset < matching.length ? String(nextOffset) : undefined;

			return { keys, cursor };
		},

		async delete(path) {
			const key = path.replace(/^\/+/, "");

			if (key.length === 0) {
				throw new Error("Storage path must not be empty");
			}

			objects.delete(key);
		},
	});
}

export { memory };
