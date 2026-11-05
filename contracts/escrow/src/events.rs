// Events emitted on every escrow state transition.

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
    pub quote_hash: BytesN<32>,
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

/// Emitted when the cap is paid out to the seller.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub seller: Address,
    pub payout: i128,
}

/// Emitted when the cap is returned to the buyer.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowRefunded {
    #[topic]
    pub escrow_id: u64,
    pub buyer: Address,
    pub amount: i128,
}
