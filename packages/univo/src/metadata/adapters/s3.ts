import { AwsClient } from "aws4fetch";

import { defineAdapter } from "../storage";

interface Options {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;

	region?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
}

function s3(opts: Options) {
	const client = new AwsClient({
		retries: 0,
		initRetryMs: 0,
		accessKeyId: opts.accessKeyId,
		secretAccessKey: opts.secretAccessKey,
	});

	return defineAdapter({
		id: "s3",

		async get() {
			//
		},

		async put() {
			//
		},

		async list() {
			//
		},

		async delete() {
			//
		},
	});
}

export { s3 };
