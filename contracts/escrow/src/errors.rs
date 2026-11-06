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
}
