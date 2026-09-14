interface Adapter {
	id: string;
	put: () => void;
	get: () => void;
	list: () => void;
	delete: () => void;
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

export { defineStorage, defineAdapter };
