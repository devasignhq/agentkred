// Drops the escrow projection and rebuilds it from the stored contract events.

import { prisma } from "../config/db.js";
import { JournalTools } from "../journal/journalTools.js";

// Rebuild and report how many events were replayed
const events = await JournalTools.rebuild();
console.log(`Rebuilt the escrow projection from ${events} stored events`);
await prisma.$disconnect();
