interface Adapter {
	readonly id: string;
	put: (path: string, body: string | ArrayBuffer) => Promise<void>;
	get: (path: string) => Promise<ArrayBuffer | null>;
	list: (opts?: { prefix?: string; cursor?: string; limit?: number }) => Promise<{ keys: string[]; cursor: string | undefined }>;
	delete: (path: string) => Promise<void>;
}

interface Storage {
	put: Adapter["put"];
	get: Adapter["get"];
	list: Adapter["list"];
	delete: Adapter["delete"];
}

function defineAdapter(adapter: Adapter): Adapter {
	return adapter;
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
export type { Adapter, Storage };
