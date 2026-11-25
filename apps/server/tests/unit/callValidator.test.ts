// Party call checks: only the right party's signature over exactly the expected call is submitted.

import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/config/errors.js";
import { CallValidator } from "../../src/utils/callValidator.js";
import { escrowClient, signOperation } from "../support/fixtures.js";

const seller = Keypair.random();

/** Returns the status and code of the error `run` throws. */
function rejection(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        return `${(error as ApiError).status} ${(error as ApiError).code}`;
    }
    throw new Error("Expected the call to be rejected");
}

describe("CallValidator", () => {
    it("accepts the seller's signature over exactly this accept", async () => {
        const auth = await signOperation(escrowClient.acceptCall(4n), seller);

        expect(() => CallValidator.validate(auth, escrowClient.acceptCall(4n), seller.publicKey(), 100)).not.toThrow();
    });

    it("rejects another signer, another escrow, another method and an expiring signature", async () => {
        const expected = escrowClient.acceptCall(4n);
        const byStranger = await signOperation(expected, Keypair.random());
        const otherEscrow = await signOperation(escrowClient.acceptCall(5n), seller);
        const otherMethod = await signOperation(escrowClient.acknowledgeCall(4n), seller);
        const expiring = await signOperation(expected, seller, 101);

        expect(rejection(() => CallValidator.validate(byStranger, expected, seller.publicKey(), 100))).toBe("403 wrong_signer");
        expect(rejection(() => CallValidator.validate(otherEscrow, expected, seller.publicKey(), 100))).toBe("422 mismatched_arguments");
        expect(rejection(() => CallValidator.validate(otherMethod, expected, seller.publicKey(), 100))).toBe("422 mismatched_arguments");
        expect(rejection(() => CallValidator.validate(expiring, expected, seller.publicKey(), 100))).toBe("422 auth_expired");
        expect(rejection(() => CallValidator.validate("%%", expected, seller.publicKey(), 100))).toBe("400 malformed_auth");
    });

    it("rejects a deliver whose manifest hash differs from the one expected", async () => {
        const auth = await signOperation(escrowClient.deliverCall(4n, Buffer.alloc(32, 1)), seller);

        expect(rejection(() => CallValidator.validate(auth, escrowClient.deliverCall(4n, Buffer.alloc(32, 2)), seller.publicKey(), 100))).toBe("422 mismatched_arguments");
    });
});
