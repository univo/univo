interface Adapter {
	readonly id: string;
	delete: (path: string) => Promise<void>;
	get: (path: string) => Promise<ArrayBuffer | null>;
	put: (path: string, body: string | ArrayBuffer) => Promise<void>;
	list: (opts?: { prefix?: string; cursor?: string; limit?: number }) => Promise<{ keys: string[]; cursor: string | undefined }>;
}

function defineAdapter(adapter: Adapter): Adapter {
	return adapter;
}

interface Storage {
	adapter: Adapter;
}

function defineStorage(storage: Storage): Storage {
	return storage;
}

export type { Adapter, Storage };
export { defineStorage, defineAdapter };
