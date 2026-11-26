-- Move each buyer's webhook off the shared quote row into a table keyed by quote and buyer.

-- CreateTable
CREATE TABLE "buyer_webhooks" (
    "quote_hash" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buyer_webhooks_pkey" PRIMARY KEY ("quote_hash","buyer")
);

-- Copy the existing buyer webhooks across
INSERT INTO "buyer_webhooks" ("quote_hash", "buyer", "url", "secret", "created_at", "updated_at")
SELECT "quote_hash", "buyer", "buyer_webhook_url", "buyer_webhook_secret", "created_at", CURRENT_TIMESTAMP
FROM "quotes"
WHERE "buyer_webhook_url" IS NOT NULL AND "buyer_webhook_secret" IS NOT NULL;

-- AlterTable
ALTER TABLE "quotes" DROP COLUMN "buyer",
DROP COLUMN "buyer_webhook_secret",
DROP COLUMN "buyer_webhook_url";
