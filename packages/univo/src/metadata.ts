import { Adapter } from "./metadata/adapters";

type Storage = {
	adapter: Adapter;
};

function defineStorage(storage: Storage): Storage {
	return storage;
}

export type { Storage };
export { defineStorage };
