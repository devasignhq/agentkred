// The Prisma client for the journal database, connected through the node-postgres driver adapter.

import { PrismaPg } from "@prisma/adapter-pg";
import { Env } from "./env.js";
import { PrismaClient } from "../generated/prisma/client.js";

export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: Env.databaseUrl() }) });

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
