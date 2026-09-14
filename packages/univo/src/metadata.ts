import { Adapter } from "./metadata/adapters";

interface Storage {
	adapter: Adapter;
}

function defineStorage(storage: Storage): Storage {
	return storage;
}

export type { Storage };
export { defineStorage };
