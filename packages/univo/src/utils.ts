import { name, version } from "../package.json";

export function createLogger(opts: { quiet: boolean; prefix?: string }) {
	let prefix = `[${name}@${version}]`;

	if (opts.prefix !== undefined) {
		prefix += ` ${opts.prefix}`;
	}

	return {
		debug(...any: any[]) {
			if (opts.quiet) {
				return;
			}

			if (process.env.LOG_LEVEL === "DEBUG") {
				console.log(`${opts.prefix} DEBUG`, ...any);
			}
		},
		info(...any: any[]) {
			if (opts.quiet) {
				return;
			}

			if (process.env.LOG_LEVEL === "DEBUG" || process.env.LOG_LEVEL === "INFO") {
				console.log(`${opts.prefix} INFO`, ...any);
			}
		},
		warn(...any: any[]) {
			if (opts.quiet) {
				return;
			}

			if (process.env.LOG_LEVEL === "DEBUG" || process.env.LOG_LEVEL === "INFO" || process.env.LOG_LEVEL === "WARN") {
				console.log(`${opts.prefix} WARN`, ...any);
			}
		},
		error(...any: any[]) {
			if (opts.quiet) {
				return;
			}

			if (process.env.LOG_LEVEL === "DEBUG" || process.env.LOG_LEVEL === "INFO" || process.env.LOG_LEVEL === "WARN" || process.env.LOG_LEVEL === "ERROR") {
				console.log(`${opts.prefix} ERROR`, ...any);
			}
		},
	};
}

export const iife = <T>(fn: () => T): T => fn();

export type Prettify<T> = unknown & {
	[K in keyof T]: T[K];
};

export function hexToNumber(hex: string) {
	return Number.parseInt(hex, 16);
}

export function numberToHex(number: number) {
	return `0x${number.toString(16)}` as `0x${string}`;
}

export function mutex(fn: (...args: any[]) => Promise<void>) {
	let locked = false;

	return async (...args: any[]) => {
		if (locked) return;
		locked = true;
		await fn(...args);
		locked = false;
	};
}

export function isHexEqual(a: `0x${string}`, b: `0x${string}`) {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * Retries a function n number of times before giving up
 */
export async function retry<T>(fn: () => Promise<T>, retries: number, __count = 1): Promise<T> {
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

export function raise(...args: [Error] | Parameters<typeof Error>): never {
	if (args[0] instanceof Error) throw args[0];
	throw new Error(...(args as Parameters<typeof Error>));
}

export function nonNullable<Type>(value: Type): value is NonNullable<Type> {
	return value !== null && value !== undefined;
}

export async function compress(input: string): Promise<ArrayBuffer> {
	const compressed = new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Response(compressed).arrayBuffer();
}

export async function decompress(input: ArrayBuffer): Promise<string> {
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
