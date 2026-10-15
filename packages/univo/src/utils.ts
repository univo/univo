import { name, version } from "../package.json";

export function createLogger(opts: { quiet?: boolean; prefix?: string }) {
	const noop = (..._: any[]) => {};

	if (opts.quiet === true) {
		return {
			debug: noop,
			info: noop,
			warn: noop,
			error: noop,
		};
	}

	let prefix = `[${name}@${version}]`;

	if (opts.prefix !== undefined) {
		prefix += ` ${opts.prefix}`;
	}

	const debug = (...any: any[]) => console.log(`${prefix} DEBUG`, ...any);
	const info = (...any: any[]) => console.log(`${prefix} INFO`, ...any);
	const warn = (...any: any[]) => console.log(`${prefix} WARN`, ...any);
	const error = (...any: any[]) => console.log(`${prefix} ERROR`, ...any);

	if (typeof process !== "undefined" && process.env) {
		if (process.env.LOG_LEVEL === "ERROR") {
			return {
				debug: noop,
				info: noop,
				warn: noop,
				error,
			};
		}

		if (process.env.LOG_LEVEL === "WARN" || process.env.LOG_LEVEL === "WARNING") {
			return {
				debug: noop,
				info: noop,
				warn,
				error,
			};
		}

		if (process.env.LOG_LEVEL === "INFO") {
			return {
				debug: noop,
				info,
				warn,
				error,
			};
		}

		if (process.env.LOG_LEVEL === "DEBUG") {
			return {
				debug,
				info,
				warn,
				error,
			};
		}
	}

	// No LOG_LEVEL specified. Only log if `quiet: false` and default to DEBUG log level.
	// Note that usually happens in a browser context where no `process` is defined

	if (opts.quiet === false) {
		return {
			debug,
			info,
			warn,
			error,
		};
	}

	return {
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
	};
}

export const iife = <T>(fn: () => T): T => fn();

export type Prettify<T> = unknown & {
	[K in keyof T]: T[K];
};

export function mutex(fn: (...args: any[]) => void | Promise<void>) {
	let locked = false;

	return async (...args: any[]) => {
		if (locked) {
			return;
		}

		locked = true;

		try {
			await fn(...args);
		} finally {
			locked = false;
		}
	};
}

export function isHexEqual(a: `0x${string}`, b: `0x${string}`) {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * Retries a function n number of times before giving up
 */
export async function retry<T>(fn: () => Promise<T> | T, retries: number, __count = 1): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (__count > retries) throw error;
		await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** __count));
		return retry(fn, retries, __count + 1);
	}
}

type CamelToSnake<T extends string, P extends string = ""> = string extends T
	? string
	: T extends `${infer C0}${infer R}`
		? CamelToSnake<R, `${P}${C0 extends Lowercase<C0> ? "" : "_"}${Lowercase<C0>}`>
		: P;

export type Flatten<T> = {
	[K in keyof T as CamelToSnake<Extract<K, string>>]: T[K];
};

export async function compress(input: string): Promise<ArrayBuffer> {
	const compressed = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Response(compressed).arrayBuffer();
}

export async function decompress(input: ArrayBuffer | Blob): Promise<string> {
	if (input instanceof Blob) {
		const decompressed = input.stream().pipeThrough(new DecompressionStream("gzip"));
		return new Response(decompressed).text();
	}

	const decompressed = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(decompressed).text();
}

export const decoder = new TextDecoder();

/**
 * Normalizes a hex string to lowercase and an optional length
 */
export const normalizeHex = (hex: `0x${string}`, length?: number): `0x${string}` => {
	if (length === undefined) {
		return hex.toLowerCase() as `0x${string}`;
	}

	return `0x${hex.slice(2).toLowerCase().padStart(length, "0")}`;
};
