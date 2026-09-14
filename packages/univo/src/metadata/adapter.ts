type AdapterErrorTag = "PreconditionFailed";

class AdapterError<Tag extends AdapterErrorTag = AdapterErrorTag> extends Error {
	readonly tag: Tag;

	constructor(tag: Tag, message: string) {
		super(message);
		this.name = "AdapterError";
		this.tag = tag;
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

export type { Adapter };
export { AdapterError, defineAdapter };
