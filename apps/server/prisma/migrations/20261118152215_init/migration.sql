-- CreateEnum
CREATE TYPE "EscrowState" AS ENUM ('Locked', 'Accepted', 'Delivered', 'Acknowledged', 'Disputed', 'Released', 'Refunded');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('Pending', 'Succeeded', 'Failed');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('Pending', 'Delivered', 'Failed');

-- CreateTable
CREATE TABLE "sellers" (
    "pay_to" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cap_min" BIGINT NOT NULL,
    "cap_max" BIGINT NOT NULL,
    "accept_s" INTEGER NOT NULL,
    "deliver_s" INTEGER NOT NULL,
    "dispute_s" INTEGER NOT NULL,
    "webhook_url" TEXT,
    "webhook_secret" TEXT NOT NULL,
    "signed_at" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sellers_pkey" PRIMARY KEY ("pay_to")
);

-- CreateTable
CREATE TABLE "quotes" (
    "quote_hash" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "buyer" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "buyer_webhook_url" TEXT,
    "buyer_webhook_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("quote_hash")
);

-- CreateTable
CREATE TABLE "chain_events" (
    "id" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ledger_closed_at" TIMESTAMP(3) NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topics" TEXT[],
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingest_cursor" (
    "name" TEXT NOT NULL,
    "cursor" TEXT,
    "ledger" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingest_cursor_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "escrows" (
    "id" BIGINT NOT NULL,
    "buyer" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "cap" BIGINT NOT NULL,
    "floor" BIGINT NOT NULL,
    "job_id" TEXT NOT NULL,
    "quote_hash" TEXT NOT NULL,
    "accept_by" INTEGER NOT NULL,
    "locked_at" INTEGER NOT NULL,
    "lock_tx" TEXT NOT NULL,

    CONSTRAINT "escrows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_transitions" (
    "id" BIGSERIAL NOT NULL,
    "escrow_id" BIGINT NOT NULL,
    "event_id" TEXT NOT NULL,
    "state" "EscrowState" NOT NULL,
    "at" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "escrow_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_transactions" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "escrow_id" BIGINT,
    "hash" TEXT,
    "ledger" INTEGER,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'Pending',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manifests" (
    "hash" TEXT NOT NULL,
    "escrow_id" BIGINT NOT NULL,
    "artifact_sha256" TEXT NOT NULL,
    "evidence_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manifests_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" BIGSERIAL NOT NULL,
    "escrow_id" BIGINT NOT NULL,
    "completeness" INTEGER NOT NULL,
    "evidence_url" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "event_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "escrow_id" BIGINT NOT NULL,
    "quote_hash" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'Pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_seller_idx" ON "quotes"("seller");

-- CreateIndex
CREATE INDEX "chain_events_ledger_id_idx" ON "chain_events"("ledger", "id");

-- CreateIndex
CREATE INDEX "escrows_seller_idx" ON "escrows"("seller");

-- CreateIndex
CREATE INDEX "escrows_buyer_idx" ON "escrows"("buyer");

-- CreateIndex
CREATE INDEX "escrows_quote_hash_idx" ON "escrows"("quote_hash");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_transitions_event_id_key" ON "escrow_transitions"("event_id");

-- CreateIndex
CREATE INDEX "escrow_transitions_escrow_id_ledger_idx" ON "escrow_transitions"("escrow_id", "ledger");

-- CreateIndex
CREATE INDEX "chain_transactions_escrow_id_idx" ON "chain_transactions"("escrow_id");

-- CreateIndex
CREATE INDEX "manifests_escrow_id_idx" ON "manifests"("escrow_id");

-- CreateIndex
CREATE INDEX "disputes_escrow_id_idx" ON "disputes"("escrow_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_event_id_recipient_key" ON "webhook_deliveries"("event_id", "recipient");

-- AddForeignKey
ALTER TABLE "escrow_transitions" ADD CONSTRAINT "escrow_transitions_escrow_id_fkey" FOREIGN KEY ("escrow_id") REFERENCES "escrows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
