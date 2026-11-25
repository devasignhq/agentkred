// Diffs the live projection against a replay of the stored events and against get_escrow, exiting 1 on any divergence.

import { prisma } from "../config/db.js";
import { ChainIngestor } from "../journal/chainIngestor.js";
import { JournalTools } from "../journal/journalTools.js";

// Catch the journal up, then compare the projection, the replay and the chain
await ChainIngestor.runOnce();
const { escrows, divergences } = await JournalTools.verify();

// Print each divergence and the total
for (const divergence of divergences) {
    console.log(`escrow ${divergence.escrowId} ${divergence.source} ${divergence.field}: journal=${JSON.stringify(divergence.journal)} other=${JSON.stringify(divergence.other)}`);
}
console.log(`Verified ${escrows} escrows: ${divergences.length} divergences`);

await prisma.$disconnect();
process.exitCode = divergences.length === 0 ? 0 : 1;
