import { name, version } from "../package.json";

export function createLogger(opts: { quiet: boolean }) {
	return {
		debug(...any: any[]) {
			if (!opts.quiet && process.env.LOG_LEVEL === "DEBUG") {
				console.log(`[${name}@${version}] DEBUG`, ...any);
			}
		},
		info(...any: any[]) {
			if (!opts.quiet && (process.env.LOG_LEVEL === "DEBUG" || process.env.LOG_LEVEL === "INFO")) {
				console.log(`[${name}@${version}] INFO`, ...any);
			}
		},
		warn(...any: any[]) {
			if (!opts.quiet && (process.env.LOG_LEVEL === "DEBUG" || process.env.LOG_LEVEL === "INFO" || process.env.LOG_LEVEL === "WARN")) {
				console.log(`[${name}@${version}] WARN`, ...any);
			}
		},
		error(...any: any[]) {
			// Making the decision to ignore the `quiet` option for errors.

			if (
				process.env.LOG_LEVEL === "DEBUG" ||
				process.env.LOG_LEVEL === "INFO" ||
				process.env.LOG_LEVEL === "WARN" ||
				process.env.LOG_LEVEL === "ERROR"
			) {
				console.log(`[${name}@${version}] ERROR`, ...any);
			}
		},
	};
}

const encoder = new TextEncoder();

/**
 * Assertion function.
 *
 * @example
 * ```ts
 * // You can just use the return value in an expression:
 * let dialog = assert(dialogRef.current) // throws if `false | null | undefined`
 * // >> Element
 * ```
 *
 * @example
 * // It still works to assert other boolean conditions
 * let value = Math.random() > 0.5 ? "hello" : false
 * // value is `string | false`
 * assert(typeof value === 'string')
 * // value is `string`
 */
export function assert(condition: boolean, message?: string): asserts condition;
export function assert<T>(value: T | null | undefined, message?: string): NonNullable<T>;
export function assert<T>(value: T, message?: string): T {
	if (value === false || value === null || value === undefined) {
		throw new Error(message ?? `Assertion failed: value is ${String(value)}`);
	}

	return value;
}

export const iife = <T>(fn: () => T): T => fn();

export type Prettify<T> = unknown & {
	[K in keyof T]: T[K];
};

export async function getSignature(opts: { body: string | ArrayBuffer; key: string }) {
	const keyData = encoder.encode(opts.key);
	const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

	if (typeof opts.body === "string") {
		const dataToAuthenticate = encoder.encode(opts.body);
		const hmac = await crypto.subtle.sign("HMAC", key, dataToAuthenticate);
		return [...new Uint8Array(hmac)].map((binary) => binary.toString(16).padStart(2, "0")).join("");
	}

	const hmac = await crypto.subtle.sign("HMAC", key, opts.body);
	return [...new Uint8Array(hmac)].map((binary) => binary.toString(16).padStart(2, "0")).join("");
}

export async function verifySignature(opts: { body: string | ArrayBuffer; key: string; signature: string }) {
	const keyData = encoder.encode(opts.key);
	const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);

	const pairs = opts.signature.match(/[\da-f]{2}/gi);
	if (!pairs) return false;

	if (typeof opts.body === "string") {
		const dataToAuthenticate = encoder.encode(opts.body);
		const hmac = new Uint8Array(pairs.map((byte) => Number.parseInt(byte, 16))).buffer;
		return await crypto.subtle.verify("HMAC", key, hmac, dataToAuthenticate);
	}

	const hmac = new Uint8Array(pairs.map((byte) => Number.parseInt(byte, 16))).buffer;
	return await crypto.subtle.verify("HMAC", key, hmac, opts.body);
}

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

export function isAddressEqual(a: `0x${string}`, b: `0x${string}`) {
	return a.toLowerCase() === b.toLowerCase();
}

/**
 * Retries a function n number of times before giving up
 */
export async function retry<T extends (...arg0: any[]) => any>(
	fn: T,
	args: Parameters<T>,
	retries: number,
	__count = 1,
): Promise<Awaited<ReturnType<T>>> {
	try {
		return await fn(...args);
	} catch (error) {
		if (__count > retries) throw error;
		await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** __count));
		return retry(fn, args, retries, __count + 1);
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
