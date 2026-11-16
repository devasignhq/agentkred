// Minimal token for tests: SEP-41 balance and transfer without trustlines, so account-address sellers can be paid.

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

/// Storage key for one holder's balance.
#[contracttype]
enum BalanceKey {
    Balance(Address),
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    /// Credits `amount` to `to` without any authorization.
    pub fn mint(env: Env, to: Address, amount: i128) {
        // Add the amount to the holder's balance
        let balance = Self::balance(env.clone(), to.clone());
        Self::write(&env, &to, balance + amount);
    }

    /// Returns the balance held by `id`.
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&BalanceKey::Balance(id))
            .unwrap_or(0)
    }

    /// Moves `amount` from `from` to `to` with `from`'s authorization.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        // Require the sender's authorization
        from.require_auth();

        // Debit the sender, refusing an overdraft
        let from_balance = Self::balance(env.clone(), from.clone());
        if amount < 0 || from_balance < amount {
            panic!("insufficient balance");
        }
        Self::write(&env, &from, from_balance - amount);

        // Credit the receiver
        let to_balance = Self::balance(env.clone(), to.clone());
        Self::write(&env, &to, to_balance + amount);
    }

    /// Writes a holder's balance.
    fn write(env: &Env, id: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&BalanceKey::Balance(id.clone()), &amount);
    }
}
