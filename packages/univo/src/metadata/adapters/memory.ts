import { defineAdapter } from "../storage";

function memory() {
	const objects = new Map<string, ArrayBuffer>();

	return defineAdapter({
		id: "memory",

		async put(path, body) {
			const bytes = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
			objects.set(path, bytes.slice(0));
		},

		async get(path) {
			return objects.get(path)?.slice(0) ?? null;
		},

		async list(opts) {
			const offset = Number(opts?.cursor ?? 0);
			const matching = [...objects.keys()].filter((path) => path.startsWith(opts?.prefix ?? "")).sort();
			const keys = matching.slice(offset, opts?.limit === undefined ? undefined : offset + opts.limit);
			const nextOffset = offset + keys.length;
			const cursor = nextOffset < matching.length ? String(nextOffset) : undefined;

			return { keys, cursor };
		},

		async delete(path) {
			objects.delete(path);
		},
	});
}

export { memory };
