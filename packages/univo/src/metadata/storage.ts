type StorageBody = string | ArrayBuffer;

interface ListResult {
	keys: string[];
	cursor: string | undefined;
}

interface ListOptions {
	prefix?: string;
	cursor?: string;
	limit?: number;
}

interface Adapter {
	readonly id: string;
	put: (path: string, body: StorageBody) => Promise<void>;
	get: (path: string) => Promise<ArrayBuffer | null>;
	list: (opts?: ListOptions) => Promise<ListResult>;
	delete: (path: string) => Promise<void>;
}

interface Storage {
	put: Adapter["put"];
	get: Adapter["get"];
	list: Adapter["list"];
	delete: Adapter["delete"];
}

function normalizePath(path: string): string {
	const normalized = path.replace(/^\/+/, "");

	if (normalized.length === 0) {
		throw new Error("Storage path must not be empty");
	}

	return normalized;
}

function normalizePrefix(prefix: string | undefined): string | undefined {
	return prefix?.replace(/^\/+/, "");
}

function normalizeListOptions(opts: ListOptions | undefined): ListOptions | undefined {
	if (opts?.prefix === undefined) return opts;
	return { ...opts, prefix: normalizePrefix(opts.prefix) };
}

function defineAdapter(adapter: Adapter): Adapter {
	return {
		id: adapter.id,
		put: async (path, body) => adapter.put(normalizePath(path), body),
		get: async (path) => adapter.get(normalizePath(path)),
		list: async (opts) => adapter.list(normalizeListOptions(opts)),
		delete: async (path) => adapter.delete(normalizePath(path)),
	};
}

function defineStorage({ adapter }: { adapter: Adapter }): Storage {
	return {
		put: (path, body) => adapter.put(path, body),
		get: (path) => adapter.get(path),
		list: (opts) => adapter.list(opts),
		delete: (path) => adapter.delete(path),
	};
}

export { defineStorage, defineAdapter };
export type { Adapter, ListOptions, ListResult, Storage, StorageBody };
