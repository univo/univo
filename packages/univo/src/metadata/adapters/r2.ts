import { s3 } from "./s3";
import type { Adapter } from "../adapters";

interface R2Options {
	bucket: string;
	endpoint?: string;
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
}

function r2(opts: R2Options): Adapter {
	const adapter = s3({
		region: "auto",
		bucket: opts.bucket,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
		endpoint: opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`,
	});

	return { ...adapter, id: "r2" };
}

export { r2 };
export type { R2Options };
