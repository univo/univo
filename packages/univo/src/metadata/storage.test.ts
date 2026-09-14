import { test } from "vitest";

import { s3 } from "./adapters/s3";
import { defineStorage } from "./storage";

test.concurrent("metadata", async () => {
	const metadataStorage = defineStorage({
		adapter: s3({
			bucket: "",
			accessKeyId: "",
			secretAccessKey: "",
		}),
	});
});
