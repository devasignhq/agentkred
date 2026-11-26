// Test settings: the local test database, webhooks to local receivers, and files run one at a time over the shared database.

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        env: {
            DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://agentkred:agentkred@localhost:5433/agentkred_test",
            WEBHOOK_ALLOW_INSECURE: "true",
        },
        fileParallelism: false,
    },
});
