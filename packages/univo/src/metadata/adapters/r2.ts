import { s3 } from "./s3";
import type { Adapter } from "../storage";

interface R2Options {
	bucket: string;
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
}

function r2(opts: R2Options): Adapter {
	return {
		...s3({
			bucket: opts.bucket,
			accessKeyId: opts.accessKeyId,
			secretAccessKey: opts.secretAccessKey,
			region: "auto",
			endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
		}),
		id: "r2",
	};
}

export { r2 };
export type { R2Options };
