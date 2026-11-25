// Journal ingestion over a fake chain: idempotent ingestion, escrows locked before the journal, rebuild and verify.

import { Keypair } from "@stellar/stellar-sdk";
import { EscrowView } from "@agentkred/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/config/db.js";
import { ChainIngestor } from "../../src/journal/chainIngestor.js";
import { JournalTools } from "../../src/journal/journalTools.js";
import { EscrowService } from "../../src/services/escrowService.js";
import { stellar } from "../../src/config/stellar.js";
import { emitAccepted, emitLocked, emitRefunded, emitSettled } from "../support/events.js";
import { FakeChain, resetDatabase } from "../support/fakeChain.js";
import { signedQuote } from "../support/fixtures.js";

const seller = Keypair.random();
const buyer = Keypair.random().publicKey();
let chain: FakeChain;

describe("ChainIngestor", () => {
    beforeEach(async () => {
        await resetDatabase();
        chain = new FakeChain();
        chain.install();
    });

    it("projects a lifecycle once however often it ingests", async () => {
        // Lock, accept and settle escrow 1
        emitLocked(chain, 1n, buyer, signedQuote(seller));
        emitAccepted(chain, 1n, 9_000);
        emitSettled(chain, 1n, buyer, seller.publicKey(), "Acknowledged", 10_000_000n, 0n);

        // Ingest twice
        expect(await ChainIngestor.runOnce()).toBe(3);
        expect(await ChainIngestor.runOnce()).toBe(0);

        expect(await prisma.chainEvent.count()).toBe(3);
        expect(await prisma.escrowTransition.count()).toBe(3);
        expect(await EscrowService.get(1n)).toMatchObject({ state: "Released", deliverBy: 9_000, settlement: { outcome: "Acknowledged", payout: "10000000" } });
    });

    it("reads across pages and records the ledger it reached", async () => {
        // Emit more events than one page holds
        for (let id = 1n; id <= 205n; id++) {
            emitLocked(chain, id, buyer, signedQuote(seller, { jobId: Buffer.alloc(32, Number(id % 250n)) }));
        }

        expect(await ChainIngestor.runOnce()).toBe(205);
        expect(await prisma.escrow.count()).toBe(205);
        expect((await prisma.ingestCursor.findFirst())?.ledger).toBe(chain.latestLedger);
    });

    it("keeps the event but skips the projection for an escrow locked before the journal began", async () => {
        emitRefunded(chain, 42n, buyer, 10_000_000n);

        await ChainIngestor.runOnce();

        expect(await prisma.chainEvent.count()).toBe(1);
        expect(await prisma.escrowTransition.count()).toBe(0);
    });

    it("waits until the journal has read a given ledger", async () => {
        const ledger = emitLocked(chain, 1n, buyer, signedQuote(seller));

        await ChainIngestor.waitForLedger(ledger);

        expect(await prisma.escrow.count()).toBe(1);
    });
});

describe("JournalTools", () => {
    beforeEach(async () => {
        await resetDatabase();
        chain = new FakeChain();
        chain.install();
    });

    it("rebuilds the projection identically from the stored events", async () => {
        // Project two escrows and capture them
        emitLocked(chain, 1n, buyer, signedQuote(seller));
        emitLocked(chain, 2n, buyer, signedQuote(seller, { jobId: Buffer.alloc(32, 3) }));
        emitRefunded(chain, 2n, buyer, 10_000_000n);
        await ChainIngestor.runOnce();
        const before = [await EscrowService.get(1n), await EscrowService.get(2n)];

        // Rebuild and compare
        expect(await JournalTools.rebuild()).toBe(3);
        expect([await EscrowService.get(1n), await EscrowService.get(2n)]).toEqual(before);
    });

    it("reports zero divergence when the chain agrees, and the field that differs when it does not", async () => {
        // Project a locked escrow
        const quote = signedQuote(seller);
        emitLocked(chain, 1n, buyer, quote);
        await ChainIngestor.runOnce();
        const record = await EscrowService.get(1n);

        // Serve get_escrow from the record, then with a moved deadline
        const onChain: EscrowView = {
            ...record,
            cap: BigInt(record.cap),
            floor: BigInt(record.floor),
            schedule: quote.terms.schedule,
        };
        const escrow = stellar.escrow as unknown as { get: (id: bigint) => Promise<EscrowView> };
        escrow.get = async () => onChain;
        expect(await JournalTools.verify()).toEqual({ escrows: 1, divergences: [] });

        escrow.get = async () => ({ ...onChain, acceptBy: onChain.acceptBy + 1 });
        expect((await JournalTools.verify()).divergences).toMatchObject([{ escrowId: "1", source: "chain", field: "acceptBy" }]);
    });
});
