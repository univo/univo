import { s3 } from "./s3";

interface Options {
	bucket: string;
	accountId: string;
	accessKeyId: string;
	secretAccessKey: string;
}

function r2(opts: Options) {
	return s3({
		bucket: opts.bucket,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
	});
}

export { r2 };
