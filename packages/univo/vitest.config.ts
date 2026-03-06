import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		root: __dirname,
		// We disable file parallelism because for our tests we initialise a single local tunnel,
		// with parallelism it ends up attempting to create multiple tunnels and throws errors
		fileParallelism: false,
		testTimeout: 60 * 1000,
		setupFiles: ["./vitest.setup.ts"],
	},
});
