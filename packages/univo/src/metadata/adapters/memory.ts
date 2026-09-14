import { defineAdapter, PreconditionFailedError } from "../../metadata";

function memory() {
	let etag = 0;

	const objects = new Map<string, { body: ArrayBuffer; etag: string }>();

	function normalizePath(path: string): string {
		const normalized = path.replace(/^\/+/, "");

		if (normalized.length === 0) {
			throw new Error("Storage path must not be empty");
		}

		return normalized;
	}

	return defineAdapter({
		id: "memory",

		async put(path, body, opts) {
			const key = normalizePath(path);
			const current = objects.get(key);

			if (opts?.ifMatch !== undefined && current?.etag !== opts.ifMatch) {
				throw new PreconditionFailedError(key);
			}

			if (opts?.ifNoneMatch === "*" && current !== undefined) {
				throw new PreconditionFailedError(key);
			}

			const bytes = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
			const nextEtag = String(etag++);
			objects.set(key, { body: bytes.slice(0), etag: nextEtag });

			return { etag: nextEtag };
		},

		async get(path) {
			const object = objects.get(normalizePath(path));
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
			objects.delete(normalizePath(path));
		},
	});
}

export { memory };
