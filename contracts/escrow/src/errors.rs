// Error codes returned by the AgentKred escrow contract.

use soroban_sdk::contracterror;

/// Error codes for the escrow contract. Values are ABI — never renumber one.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    EscrowNotFound = 1,
    InvalidCap = 2,
    InvalidDuration = 3,
    SameParty = 4,
    WrongState = 5,
    DeliverDeadlinePassed = 6,
    DeliverDeadlineNotPassed = 7,
    DisputeWindowOpen = 8,
    DisputeWindowClosed = 9,
    QuoteHashMismatch = 10,
    InvalidSeller = 11,
    InvalidFloor = 12,
    InvalidSchedule = 13,
    CompletenessNotInSchedule = 14,
    AcceptDeadlinePassed = 15,
    AcceptDeadlineNotPassed = 16,
    PayoutOutOfRange = 17,
}
