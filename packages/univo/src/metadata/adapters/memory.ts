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

		async list(prefix = "") {
			const keys = [...objects.keys()].filter((path) => path.startsWith(prefix)).sort();
			return { keys, continuationToken: undefined };
		},

		async delete(path) {
			objects.delete(path);
		},
	});
}

export { memory };
