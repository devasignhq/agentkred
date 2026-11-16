// Storage keys, quote terms and the per-escrow record kept by the escrow contract.

use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Lifecycle state of a single escrow.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum EscrowState {
    Locked,
    Accepted,
    Delivered,
    Acknowledged,
    Disputed,
    Released,
    Refunded,
}

/// One step of the payout schedule: what the seller is paid at a given completeness percentage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayoutStep {
    pub completeness: u32,
    pub payout: i128,
}

/// The seller-signed quote terms. `sha256` of their XDR encoding is the quote hash.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuoteTerms {
    pub seller: Address,
    pub asset: Address,
    pub cap: i128,
    pub floor: i128,
    pub schedule: Vec<PayoutStep>,
    pub accept_s: u64,
    pub deliver_s: u64,
    pub dispute_s: u64,
    pub job_id: BytesN<32>,
}

/// How a settled escrow reached its payout.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SettleOutcome {
    Acknowledged,
    Silent,
    Disputed,
}

/// Which deadline a refunded escrow missed.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RefundReason {
    NotAccepted,
    NotDelivered,
}

/// Terms, deadlines and progress of one escrowed job.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub buyer: Address,
    pub seller: Address,
    pub asset: Address,
    pub cap: i128,
    pub floor: i128,
    pub schedule: Vec<PayoutStep>,
    pub job_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub deliver_s: u64,
    pub dispute_s: u64,
    pub locked_at: u64,
    pub accept_by: u64,
    pub accepted_at: Option<u64>,
    pub deliver_by: Option<u64>,
    pub delivered_at: Option<u64>,
    pub dispute_by: Option<u64>,
    pub manifest_hash: Option<BytesN<32>>,
    pub acknowledged_at: Option<u64>,
    pub disputed_at: Option<u64>,
    pub completeness: Option<u32>,
    pub closed_at: Option<u64>,
    pub state: EscrowState,
}

/// Storage keys used by the contract.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    NextId,
    Escrow(u64),
    Admin,
}
