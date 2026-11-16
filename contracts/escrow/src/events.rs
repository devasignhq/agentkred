// Events emitted on every escrow state transition and on contract upgrades.

use crate::types::{RefundReason, SettleOutcome};
use soroban_sdk::{contractevent, Address, BytesN};

/// Emitted when a buyer locks the cap into a new escrow.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowLocked {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub asset: Address,
    pub cap: i128,
    pub floor: i128,
    pub job_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub accept_by: u64,
}

/// Emitted when the seller accepts the job and starts the deliver-by clock.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAccepted {
    #[topic]
    pub escrow_id: u64,
    pub deliver_by: u64,
}

/// Emitted when the seller records a delivery manifest.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDelivered {
    #[topic]
    pub escrow_id: u64,
    pub manifest_hash: BytesN<32>,
    pub dispute_by: u64,
}

/// Emitted when the buyer acknowledges a delivery inside the dispute window.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowAcknowledged {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
}

/// Emitted when the buyer disputes a delivery with a completeness percentage.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowDisputed {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub completeness: u32,
}

/// Terminal event of a settled escrow: the seller's payout and the buyer's remainder.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowSettled {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub outcome: SettleOutcome,
    pub completeness: u32,
    pub payout: i128,
    pub remainder: i128,
}

/// Terminal event of a refunded escrow: the cap returned to the buyer.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub reason: RefundReason,
    pub amount: i128,
}

/// Emitted when the admin swaps the contract's code.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpgraded {
    pub new_wasm_hash: BytesN<32>,
    pub admin: Address,
}
