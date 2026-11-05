// Storage keys and the per-escrow record kept by the escrow contract.

use soroban_sdk::{contracttype, Address, BytesN};

/// Lifecycle state of a single escrow.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowState {
    Locked,
    Delivered,
    Released,
    Refunded,
}

/// Terms, deadlines and progress of one escrowed job.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub buyer: Address,
    pub seller: Address,
    pub asset: Address,
    pub cap: i128,
    pub quote_hash: BytesN<32>,
    pub dispute_s: u64,
    pub locked_at: u64,
    pub deliver_by: u64,
    pub delivered_at: Option<u64>,
    pub dispute_by: Option<u64>,
    pub manifest_hash: Option<BytesN<32>>,
    pub closed_at: Option<u64>,
    pub state: EscrowState,
}

/// Storage keys used by the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    NextId,
    Escrow(u64),
}
