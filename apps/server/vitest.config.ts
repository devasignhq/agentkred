// Test settings: the local test database by default, and files run one at a time over the shared database.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://agentkred:agentkred@localhost:5433/agentkred_test" },
        fileParallelism: false,
    },
});
