class PreconditionFailedError extends Error {
	constructor(path: string) {
		super(`Storage precondition failed for path "${path}"`);
		this.name = "PreconditionFailedError";
	}
}

type PutOptions =
	| { ifMatch: string; ifNoneMatch?: never }
	| { ifNoneMatch: "*"; ifMatch?: never }
	| { ifMatch?: never; ifNoneMatch?: never };

interface Adapter {
	readonly id: string;
	delete: (path: string) => Promise<void>;
	get: (path: string) => Promise<{ body: ArrayBuffer; etag: string } | null>;
	put: (path: string, body: string | ArrayBuffer, opts?: PutOptions) => Promise<{ etag: string }>;
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
export { defineStorage, defineAdapter, PreconditionFailedError };
