// AgentKred escrow: lock a seller-signed quote, run the accept, deliver and dispute clocks, then settle by the payout schedule or refund.
#![no_std]

mod errors;
mod events;
mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod props;

#[cfg(any(test, feature = "testutils"))]
pub mod test_token;

pub use errors::Error;
pub use events::{
    ContractUpgraded, EscrowAccepted, EscrowAcknowledged, EscrowDelivered, EscrowDisputed,
    EscrowLocked, EscrowRefunded, EscrowSettled,
};
pub use types::{
    DataKey, Escrow, EscrowState, PayoutStep, QuoteTerms, RefundReason, SettleOutcome,
};

use soroban_sdk::address_payload::AddressPayload;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, Vec};

/// Longest accepted accept, deliver or dispute duration, in seconds (30 days).
pub const MAX_DURATION_S: u64 = 30 * 24 * 60 * 60;

/// Completeness percentage that an acknowledgement or a silent close settles at.
pub const FULL_COMPLETENESS: u32 = 100;

/// Shortest expected ledger close time, used to turn seconds into ledgers.
pub const SECONDS_PER_LEDGER: u64 = 5;

/// Extra ledgers kept alive past the dispute deadline (about one day).
pub const TTL_MARGIN_LEDGERS: u32 = 17_280;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Sets the admin who may upgrade the contract. Runs once, at deploy.
    pub fn __constructor(env: Env, admin: Address) {
        // Store the admin
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    /// Hands the admin role to `new_admin`. Admin only.
    pub fn set_admin(env: Env, new_admin: Address) {
        // Require the current admin's authorization
        Self::require_admin(&env);

        // Store the new admin
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    /// Returns the current admin.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin is set by the constructor")
    }

    /// Replaces the contract's code with the uploaded WASM `new_wasm_hash`, keeping all storage. Admin only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        // Require the admin's authorization
        let admin = Self::require_admin(&env);

        // Swap the contract's code
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());

        // Emit the upgrade event
        ContractUpgraded {
            new_wasm_hash,
            admin,
        }
        .publish(&env);
    }

    /// Returns the contract version. Bump it with every upgrade.
    pub fn version() -> u32 {
        2
    }

    /// Locks the quoted cap from the buyer against a seller-signed quote and starts the accept-by clock.
    /// The buyer's one authorization covers every term and the token transfer.
    /// @param terms - The quote terms; `sha256` of their XDR encoding must equal `quote_hash`
    /// @param seller_sig - The seller account key's ed25519 signature over `quote_hash`
    /// @returns The new escrow id
    pub fn lock(
        env: Env,
        buyer: Address,
        terms: QuoteTerms,
        quote_hash: BytesN<32>,
        seller_sig: BytesN<64>,
    ) -> Result<u64, Error> {
        // Require the buyer's authorization for the lock and the transfer beneath it
        buyer.require_auth();

        // Check the terms hash to the quote hash the seller signed
        if Self::hash_quote(&env, &terms) != quote_hash {
            return Err(Error::QuoteHashMismatch);
        }

        // Verify the seller's signature over the quote hash with its account key
        let Some(AddressPayload::AccountIdPublicKeyEd25519(seller_key)) = terms.seller.to_payload()
        else {
            return Err(Error::InvalidSeller);
        };
        env.crypto()
            .ed25519_verify(&seller_key, &Bytes::from(quote_hash.clone()), &seller_sig);

        // Validate the quoted terms
        Self::validate_terms(&buyer, &terms)?;

        // Allocate the next escrow id
        let escrow_id = Self::next_id(&env);

        // Fix the accept-by deadline in ledger time and store every term
        let now = env.ledger().timestamp();
        let QuoteTerms {
            seller,
            asset,
            cap,
            floor,
            schedule,
            accept_s,
            deliver_s,
            dispute_s,
            job_id,
        } = terms;
        let escrow = Escrow {
            buyer: buyer.clone(),
            seller: seller.clone(),
            asset: asset.clone(),
            cap,
            floor,
            schedule,
            job_id: job_id.clone(),
            quote_hash: quote_hash.clone(),
            deliver_s,
            dispute_s,
            locked_at: now,
            accept_by: now + accept_s,
            accepted_at: None,
            deliver_by: None,
            delivered_at: None,
            dispute_by: None,
            manifest_hash: None,
            acknowledged_at: None,
            disputed_at: None,
            completeness: None,
            closed_at: None,
            state: EscrowState::Locked,
        };

        // Store the escrow and keep it alive past its last possible deadline
        Self::save(&env, escrow_id, &escrow);
        Self::extend_ttl(&env, escrow_id, accept_s + deliver_s + dispute_s);

        // Pull the cap from the buyer into the contract
        token::Client::new(&env, &asset).transfer(&buyer, env.current_contract_address(), &cap);

        // Emit the lock event
        EscrowLocked {
            escrow_id,
            buyer,
            seller,
            asset,
            cap,
            floor,
            job_id,
            quote_hash,
            accept_by: escrow.accept_by,
        }
        .publish(&env);

        Ok(escrow_id)
    }

    /// Records the seller's acceptance of the job and starts the deliver-by clock.
    pub fn accept(env: Env, escrow_id: u64) -> Result<(), Error> {
        // Load the escrow and require the seller's authorization
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.seller.require_auth();

        // Check the escrow is locked and still inside its accept-by deadline
        if escrow.state != EscrowState::Locked {
            return Err(Error::WrongState);
        }
        let now = env.ledger().timestamp();
        if now >= escrow.accept_by {
            return Err(Error::AcceptDeadlinePassed);
        }

        // Record the acceptance and start the deliver-by clock
        let deliver_by = now + escrow.deliver_s;
        escrow.state = EscrowState::Accepted;
        escrow.accepted_at = Some(now);
        escrow.deliver_by = Some(deliver_by);
        Self::save(&env, escrow_id, &escrow);

        // Emit the acceptance event
        EscrowAccepted {
            escrow_id,
            deliver_by,
        }
        .publish(&env);

        Ok(())
    }

    /// Records the seller's delivery manifest hash and opens the dispute window.
    pub fn deliver(env: Env, escrow_id: u64, manifest_hash: BytesN<32>) -> Result<(), Error> {
        // Load the escrow and require the seller's authorization
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.seller.require_auth();

        // Check the escrow is accepted and still inside its deliver-by deadline
        if escrow.state != EscrowState::Accepted {
            return Err(Error::WrongState);
        }
        let now = env.ledger().timestamp();
        if now >= escrow.deliver_by.unwrap_or(0) {
            return Err(Error::DeliverDeadlinePassed);
        }

        // Record the delivery and start the dispute window
        let dispute_by = now + escrow.dispute_s;
        escrow.state = EscrowState::Delivered;
        escrow.delivered_at = Some(now);
        escrow.dispute_by = Some(dispute_by);
        escrow.manifest_hash = Some(manifest_hash.clone());
        Self::save(&env, escrow_id, &escrow);

        // Emit the delivery event
        EscrowDelivered {
            escrow_id,
            manifest_hash,
            dispute_by,
        }
        .publish(&env);

        Ok(())
    }

    /// Records the buyer's acceptance of a delivery, making the escrow settleable at the cap at once.
    pub fn acknowledge(env: Env, escrow_id: u64) -> Result<(), Error> {
        // Load the escrow and require the buyer's authorization
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.buyer.require_auth();

        // Check the escrow is delivered and its dispute window is still open
        let now = Self::require_dispute_window(&env, &escrow)?;

        // Record the acknowledgement
        escrow.state = EscrowState::Acknowledged;
        escrow.acknowledged_at = Some(now);
        Self::save(&env, escrow_id, &escrow);

        // Emit the acknowledgement event
        EscrowAcknowledged {
            escrow_id,
            buyer: escrow.buyer,
        }
        .publish(&env);

        Ok(())
    }

    /// Records the buyer's dispute at `completeness` percent, making the escrow settleable at that step's payout at once.
    pub fn dispute(env: Env, escrow_id: u64, completeness: u32) -> Result<(), Error> {
        // Load the escrow and require the buyer's authorization
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.buyer.require_auth();

        // Check the escrow is delivered and its dispute window is still open
        let now = Self::require_dispute_window(&env, &escrow)?;

        // Check the completeness is a quoted step below full completion
        if completeness >= FULL_COMPLETENESS
            || Self::payout_for(&escrow.schedule, completeness).is_none()
        {
            return Err(Error::CompletenessNotInSchedule);
        }

        // Record the dispute and its completeness
        escrow.state = EscrowState::Disputed;
        escrow.disputed_at = Some(now);
        escrow.completeness = Some(completeness);
        Self::save(&env, escrow_id, &escrow);

        // Emit the dispute event
        EscrowDisputed {
            escrow_id,
            buyer: escrow.buyer,
            completeness,
        }
        .publish(&env);

        Ok(())
    }

    /// Pays the seller the schedule price for the final completeness and returns the rest to the buyer. Callable by anyone.
    /// @returns The amount paid to the seller
    pub fn settle(env: Env, escrow_id: u64) -> Result<i128, Error> {
        // Load the escrow and work out how it reached settlement
        let mut escrow = Self::load(&env, escrow_id)?;
        let now = env.ledger().timestamp();
        let (outcome, completeness) = match escrow.state {
            EscrowState::Acknowledged => (SettleOutcome::Acknowledged, FULL_COMPLETENESS),
            EscrowState::Disputed => (
                SettleOutcome::Disputed,
                escrow.completeness.ok_or(Error::WrongState)?,
            ),
            EscrowState::Delivered => {
                // Require the dispute window to have closed on a delivery the buyer left unanswered
                if now < escrow.dispute_by.unwrap_or(u64::MAX) {
                    return Err(Error::DisputeWindowOpen);
                }
                (SettleOutcome::Silent, FULL_COMPLETENESS)
            }
            _ => return Err(Error::WrongState),
        };

        // Look up the payout and check it against the floor, the cap and the dispute rule
        let payout =
            Self::payout_for(&escrow.schedule, completeness).ok_or(Error::PayoutOutOfRange)?;
        if payout < escrow.floor
            || payout > escrow.cap
            || (outcome == SettleOutcome::Disputed && payout >= escrow.cap)
        {
            return Err(Error::PayoutOutOfRange);
        }
        let remainder = escrow.cap - payout;

        // Mark the escrow released before moving funds
        escrow.state = EscrowState::Released;
        escrow.closed_at = Some(now);
        Self::save(&env, escrow_id, &escrow);

        // Pay the seller and return the remainder to the buyer
        let token = token::Client::new(&env, &escrow.asset);
        let contract = env.current_contract_address();
        if payout > 0 {
            token.transfer(&contract, &escrow.seller, &payout);
        }
        if remainder > 0 {
            token.transfer(&contract, &escrow.buyer, &remainder);
        }

        // Emit the settlement event
        EscrowSettled {
            escrow_id,
            buyer: escrow.buyer,
            seller: escrow.seller,
            outcome,
            completeness,
            payout,
            remainder,
        }
        .publish(&env);

        Ok(payout)
    }

    /// Returns the cap to the buyer once accept-by passes unaccepted or deliver-by passes undelivered. Callable by anyone.
    /// @returns The amount returned to the buyer
    pub fn refund(env: Env, escrow_id: u64) -> Result<i128, Error> {
        // Load the escrow and check the deadline for its state has passed
        let mut escrow = Self::load(&env, escrow_id)?;
        let now = env.ledger().timestamp();
        let reason = match escrow.state {
            EscrowState::Locked => {
                if now < escrow.accept_by {
                    return Err(Error::AcceptDeadlineNotPassed);
                }
                RefundReason::NotAccepted
            }
            EscrowState::Accepted => {
                if now < escrow.deliver_by.unwrap_or(u64::MAX) {
                    return Err(Error::DeliverDeadlineNotPassed);
                }
                RefundReason::NotDelivered
            }
            _ => return Err(Error::WrongState),
        };

        // Mark the escrow refunded before moving funds
        escrow.state = EscrowState::Refunded;
        escrow.closed_at = Some(now);
        Self::save(&env, escrow_id, &escrow);

        // Return the cap to the buyer
        token::Client::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            &escrow.buyer,
            &escrow.cap,
        );

        // Emit the refund event
        EscrowRefunded {
            escrow_id,
            buyer: escrow.buyer,
            reason,
            amount: escrow.cap,
        }
        .publish(&env);

        Ok(escrow.cap)
    }

    /// Returns the stored escrow for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        Self::load(&env, escrow_id)
    }

    /// Returns the quote hash for `terms`: `sha256` of their XDR encoding. Lets clients check their own encoding.
    pub fn quote_hash(env: Env, terms: QuoteTerms) -> BytesN<32> {
        Self::hash_quote(&env, &terms)
    }

    /// Hashes quote terms the same way `lock` does.
    fn hash_quote(env: &Env, terms: &QuoteTerms) -> BytesN<32> {
        env.crypto().sha256(&terms.clone().to_xdr(env)).to_bytes()
    }

    /// Checks the cap, floor, clocks, parties and payout schedule of a quote.
    fn validate_terms(buyer: &Address, terms: &QuoteTerms) -> Result<(), Error> {
        // Check the cap and floor
        if terms.cap <= 0 {
            return Err(Error::InvalidCap);
        }
        if terms.floor < 0 || terms.floor > terms.cap {
            return Err(Error::InvalidFloor);
        }

        // Check every clock is between one second and the maximum duration
        for duration in [terms.accept_s, terms.deliver_s, terms.dispute_s] {
            if duration == 0 || duration > MAX_DURATION_S {
                return Err(Error::InvalidDuration);
            }
        }

        // Check the buyer is not paying itself
        if *buyer == terms.seller {
            return Err(Error::SameParty);
        }

        Self::validate_schedule(terms)
    }

    /// Checks the payout schedule is ordered, stays within the floor and cap, and pays the cap only at full completeness.
    fn validate_schedule(terms: &QuoteTerms) -> Result<(), Error> {
        // Require a schedule that ends at full completeness paying exactly the cap
        let Some(last) = terms.schedule.last() else {
            return Err(Error::InvalidSchedule);
        };
        if last.completeness != FULL_COMPLETENESS || last.payout != terms.cap {
            return Err(Error::InvalidSchedule);
        }

        // Require a zero-completeness step paying exactly the floor when the floor is below the cap
        if terms.floor < terms.cap {
            let first = terms.schedule.first().ok_or(Error::InvalidSchedule)?;
            if first.completeness != 0 || first.payout != terms.floor {
                return Err(Error::InvalidSchedule);
            }
        }

        // Check each step stays in range and rises in completeness without lowering the payout
        let mut previous: Option<PayoutStep> = None;
        for step in terms.schedule.iter() {
            if step.payout < terms.floor || step.payout > terms.cap {
                return Err(Error::InvalidSchedule);
            }
            if step.completeness < FULL_COMPLETENESS && step.payout >= terms.cap {
                return Err(Error::InvalidSchedule);
            }
            if let Some(prev) = &previous {
                if step.completeness <= prev.completeness || step.payout < prev.payout {
                    return Err(Error::InvalidSchedule);
                }
            }
            previous = Some(step);
        }

        Ok(())
    }

    /// Returns the schedule's payout at exactly `completeness`, or None when no step has it.
    fn payout_for(schedule: &Vec<PayoutStep>, completeness: u32) -> Option<i128> {
        schedule
            .iter()
            .find(|step| step.completeness == completeness)
            .map(|step| step.payout)
    }

    /// Checks the escrow is delivered and inside its dispute window, returning the ledger time.
    fn require_dispute_window(env: &Env, escrow: &Escrow) -> Result<u64, Error> {
        // Check the state
        if escrow.state != EscrowState::Delivered {
            return Err(Error::WrongState);
        }

        // Check the window is still open
        let now = env.ledger().timestamp();
        if now >= escrow.dispute_by.unwrap_or(0) {
            return Err(Error::DisputeWindowClosed);
        }

        Ok(now)
    }

    /// Requires the admin's authorization and returns the admin.
    fn require_admin(env: &Env) -> Address {
        // Load the admin and require its authorization
        let admin = Self::get_admin(env.clone());
        admin.require_auth();
        admin
    }

    /// Reserves and returns the next escrow id.
    fn next_id(env: &Env) -> u64 {
        // Read the current counter and store its successor
        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap_or(1);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        id
    }

    /// Reads an escrow from persistent storage.
    fn load(env: &Env, escrow_id: u64) -> Result<Escrow, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::EscrowNotFound)
    }

    /// Writes an escrow to persistent storage.
    fn save(env: &Env, escrow_id: u64, escrow: &Escrow) {
        env.storage()
            .persistent()
            .set(&DataKey::Escrow(escrow_id), escrow);
    }

    /// Extends the escrow and instance TTL to cover `window_s` seconds plus a margin.
    fn extend_ttl(env: &Env, escrow_id: u64, window_s: u64) {
        // Convert the window to ledgers, add the margin and cap at the network maximum
        let window_ledgers = (window_s / SECONDS_PER_LEDGER) as u32 + 1;
        let ledgers = window_ledgers
            .saturating_add(TTL_MARGIN_LEDGERS)
            .min(env.storage().max_ttl());

        // Extend the escrow entry and the contract instance
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Escrow(escrow_id), ledgers, ledgers);
        env.storage().instance().extend_ttl(ledgers, ledgers);
    }
}
