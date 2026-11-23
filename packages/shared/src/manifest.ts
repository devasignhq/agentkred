// Delivery manifests: what the seller delivered, and the hash the contract records at `deliver`.

import { Canonical } from "./canonical.js";

const MANIFEST_DOMAIN = "agentkred.manifest.v1";

/** A seller's delivery manifest for one escrow. */
export interface Manifest {
    escrowId: string;
    artifactSha256: string;
    evidenceUrl: string | null;
}

export class Manifests {
    /** Returns the 32-byte manifest hash passed to the contract's `deliver`. */
    static hash(manifest: Manifest): Buffer {
        return Canonical.hash(MANIFEST_DOMAIN, manifest);
    }
}
