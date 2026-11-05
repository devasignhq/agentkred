// Minimal AgentKred escrow: lock a cap, record delivery, then settle to the seller or refund the buyer.
#![no_std]

mod errors;
mod events;
mod types;

#[cfg(test)]
mod test;

pub use errors::Error;
pub use events::{EscrowDelivered, EscrowLocked, EscrowRefunded, EscrowReleased};
pub use types::{DataKey, Escrow, EscrowState};

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env};

/// Longest accepted deliver or dispute duration, in seconds (30 days).
pub const MAX_DURATION_S: u64 = 30 * 24 * 60 * 60;

/// Shortest expected ledger close time, used to turn seconds into ledgers.
pub const SECONDS_PER_LEDGER: u64 = 5;

/// Extra ledgers kept alive past the dispute deadline (about one day).
pub const TTL_MARGIN_LEDGERS: u32 = 17_280;

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Locks `cap` of `asset` from the buyer and fixes the deliver and dispute clocks.
    /// The buyer's one authorization covers both this call and the token transfer.
    /// @returns The new escrow id
    pub fn lock(
        env: Env,
        buyer: Address,
        seller: Address,
        asset: Address,
        cap: i128,
        deliver_s: u64,
        dispute_s: u64,
        quote_hash: BytesN<32>,
    ) -> Result<u64, Error> {
        // Require the buyer's authorization for the lock and the transfer beneath it
        buyer.require_auth();

        // Validate the quoted terms
        if cap <= 0 {
            return Err(Error::InvalidCap);
        }
        if deliver_s == 0
            || deliver_s > MAX_DURATION_S
            || dispute_s == 0
            || dispute_s > MAX_DURATION_S
        {
            return Err(Error::InvalidDuration);
        }
        if buyer == seller {
            return Err(Error::SameParty);
        }

        // Allocate the next escrow id
        let escrow_id = Self::next_id(&env);

        // Turn the quoted durations into absolute ledger-time deadlines
        let now = env.ledger().timestamp();
        let escrow = Escrow {
            buyer: buyer.clone(),
            seller: seller.clone(),
            asset: asset.clone(),
            cap,
            quote_hash: quote_hash.clone(),
            dispute_s,
            locked_at: now,
            deliver_by: now + deliver_s,
            delivered_at: None,
            dispute_by: None,
            manifest_hash: None,
            closed_at: None,
            state: EscrowState::Locked,
        };

        // Store the escrow and keep it alive past its last possible deadline
        Self::save(&env, escrow_id, &escrow);
        Self::extend_ttl(&env, escrow_id, deliver_s + dispute_s);

        // Pull the cap from the buyer into the contract
        token::Client::new(&env, &asset).transfer(&buyer, &env.current_contract_address(), &cap);

        // Emit the lock event
        EscrowLocked {
            escrow_id,
            buyer,
            seller,
            asset,
            cap,
            quote_hash,
            deliver_by: escrow.deliver_by,
        }
        .publish(&env);

        Ok(escrow_id)
    }

    /// Records the seller's delivery manifest hash and opens the dispute window.
    pub fn deliver(env: Env, escrow_id: u64, manifest_hash: BytesN<32>) -> Result<(), Error> {
        // Load the escrow and require the seller's authorization
        let mut escrow = Self::load(&env, escrow_id)?;
        escrow.seller.require_auth();

        // Check the escrow is locked and still inside its deliver-by deadline
        if escrow.state != EscrowState::Locked {
            return Err(Error::WrongState);
        }
        let now = env.ledger().timestamp();
        if now >= escrow.deliver_by {
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

    /// Pays the cap to the seller once the dispute window has closed. Callable by anyone.
    /// @returns The amount paid to the seller
    pub fn settle(env: Env, escrow_id: u64) -> Result<i128, Error> {
        // Load the escrow and check it was delivered
        let mut escrow = Self::load(&env, escrow_id)?;
        if escrow.state != EscrowState::Delivered {
            return Err(Error::WrongState);
        }

        // Check the dispute window has closed
        let now = env.ledger().timestamp();
        if now < escrow.dispute_by.unwrap_or(u64::MAX) {
            return Err(Error::DisputeWindowOpen);
        }

        // Mark the escrow released before moving funds
        escrow.state = EscrowState::Released;
        escrow.closed_at = Some(now);
        Self::save(&env, escrow_id, &escrow);

        // Pay the cap to the seller
        token::Client::new(&env, &escrow.asset).transfer(
            &env.current_contract_address(),
            &escrow.seller,
            &escrow.cap,
        );

        // Emit the release event
        EscrowReleased {
            escrow_id,
            seller: escrow.seller,
            payout: escrow.cap,
        }
        .publish(&env);

        Ok(escrow.cap)
    }

    /// Returns the cap to the buyer once deliver-by passes with no delivery. Callable by anyone.
    /// @returns The amount returned to the buyer
    pub fn refund(env: Env, escrow_id: u64) -> Result<i128, Error> {
        // Load the escrow and check it is still awaiting delivery
        let mut escrow = Self::load(&env, escrow_id)?;
        if escrow.state != EscrowState::Locked {
            return Err(Error::WrongState);
        }

        // Check the deliver-by deadline has passed
        let now = env.ledger().timestamp();
        if now < escrow.deliver_by {
            return Err(Error::DeliverDeadlineNotPassed);
        }

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
            amount: escrow.cap,
        }
        .publish(&env);

        Ok(escrow.cap)
    }

    /// Returns the stored escrow for `escrow_id`.
    pub fn get_escrow(env: Env, escrow_id: u64) -> Result<Escrow, Error> {
        Self::load(&env, escrow_id)
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
