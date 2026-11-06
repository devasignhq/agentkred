// Unit tests for the escrow contract's lifecycle, clocks and authorization.

extern crate std;

use crate::{
    DataKey, Error, EscrowContract, EscrowContractClient, EscrowState, TTL_MARGIN_LEDGERS,
};
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, Ledger};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{symbol_short, Address, BytesN, Env, IntoVal};

const CAP: i128 = 10_000_000;
const DELIVER_S: u64 = 60;
const DISPUTE_S: u64 = 30;
const START: u64 = 1_000_000;

/// Contract, token and parties shared by every test.
struct Fixture {
    env: Env,
    client: EscrowContractClient<'static>,
    contract: Address,
    token: TokenClient<'static>,
    buyer: Address,
    seller: Address,
}

/// Registers the contract and a funded test token with all auths mocked.
fn fixture() -> Fixture {
    // Create the environment at a fixed ledger time
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = START);

    // Register a Stellar asset contract and fund the buyer
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let buyer = Address::generate(&env);
    let seller = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&buyer, &(CAP * 3));

    // Register the escrow contract
    let contract = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract);
    let token = TokenClient::new(&env, &sac.address());

    Fixture {
        env,
        client,
        contract,
        token,
        buyer,
        seller,
    }
}

/// Returns a 32-byte hash filled with `byte`.
fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Locks a standard escrow and returns its id.
fn lock(f: &Fixture) -> u64 {
    f.client.lock(
        &f.buyer,
        &f.seller,
        &f.token.address,
        &CAP,
        &DELIVER_S,
        &DISPUTE_S,
        &hash(&f.env, 1),
    )
}

/// Moves ledger time forward by `seconds`.
fn advance(f: &Fixture, seconds: u64) {
    f.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp += seconds);
}

#[test]
fn lock_moves_cap_into_contract_and_fixes_deadlines() {
    // Lock an escrow
    let f = fixture();
    let id = lock(&f);

    // Check the cap moved from the buyer to the contract
    assert_eq!(f.token.balance(&f.buyer), CAP * 2);
    assert_eq!(f.token.balance(&f.contract), CAP);

    // Check the stored terms and deadlines
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Locked);
    assert_eq!(escrow.cap, CAP);
    assert_eq!(escrow.quote_hash, hash(&f.env, 1));
    assert_eq!(escrow.locked_at, START);
    assert_eq!(escrow.deliver_by, START + DELIVER_S);
    assert_eq!(escrow.dispute_by, None);
}

#[test]
fn lock_assigns_increasing_ids() {
    // Lock two escrows and compare their ids
    let f = fixture();
    assert_eq!(lock(&f), 1);
    assert_eq!(lock(&f), 2);
}

#[test]
fn lock_rejects_invalid_terms() {
    // Set up the contract and token
    let f = fixture();

    // Reject a zero cap
    let zero_cap = f.client.try_lock(
        &f.buyer,
        &f.seller,
        &f.token.address,
        &0,
        &DELIVER_S,
        &DISPUTE_S,
        &hash(&f.env, 1),
    );
    assert_eq!(zero_cap, Err(Ok(Error::InvalidCap)));

    // Reject zero and oversized durations
    let zero_deliver = f.client.try_lock(
        &f.buyer,
        &f.seller,
        &f.token.address,
        &CAP,
        &0,
        &DISPUTE_S,
        &hash(&f.env, 1),
    );
    assert_eq!(zero_deliver, Err(Ok(Error::InvalidDuration)));
    let long_dispute = f.client.try_lock(
        &f.buyer,
        &f.seller,
        &f.token.address,
        &CAP,
        &DELIVER_S,
        &(crate::MAX_DURATION_S + 1),
        &hash(&f.env, 1),
    );
    assert_eq!(long_dispute, Err(Ok(Error::InvalidDuration)));

    // Reject a buyer paying itself
    let same_party = f.client.try_lock(
        &f.buyer,
        &f.buyer,
        &f.token.address,
        &CAP,
        &DELIVER_S,
        &DISPUTE_S,
        &hash(&f.env, 1),
    );
    assert_eq!(same_party, Err(Ok(Error::SameParty)));
}

#[test]
fn lock_requires_buyer_auth_covering_the_transfer() {
    // Lock an escrow and read back the recorded authorizations
    let f = fixture();
    let id = lock(&f);
    let auths = f.env.auths();

    // Check the buyer authorized the lock call itself
    assert_eq!(id, 1);
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.buyer);
    let invocation = &auths[0].1;
    match &invocation.function {
        AuthorizedFunction::Contract((contract, name, _)) => {
            assert_eq!(contract, &f.contract);
            assert_eq!(name, &soroban_sdk::Symbol::new(&f.env, "lock"));
        }
        _ => panic!("expected a contract call"),
    }

    // Check the token transfer is nested under the same authorization
    assert_eq!(invocation.sub_invocations.len(), 1);
    match &invocation.sub_invocations[0].function {
        AuthorizedFunction::Contract((contract, name, args)) => {
            assert_eq!(contract, &f.token.address);
            assert_eq!(name, &symbol_short!("transfer"));
            assert_eq!(
                args,
                &(f.buyer.clone(), f.contract.clone(), CAP).into_val(&f.env)
            );
        }
        _ => panic!("expected a contract call"),
    }
}

#[test]
fn lock_extends_escrow_ttl_past_the_dispute_deadline() {
    // Lock an escrow and read its storage TTL
    let f = fixture();
    let id = lock(&f);
    let ttl = f.env.as_contract(&f.contract, || {
        f.env.storage().persistent().get_ttl(&DataKey::Escrow(id))
    });

    // Check the TTL covers both windows plus the margin
    let window_ledgers = ((DELIVER_S + DISPUTE_S) / crate::SECONDS_PER_LEDGER) as u32;
    assert!(ttl >= window_ledgers + TTL_MARGIN_LEDGERS);
}

#[test]
fn deliver_then_settle_pays_seller_after_window() {
    // Lock and deliver an escrow
    let f = fixture();
    let id = lock(&f);
    advance(&f, 10);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check the delivery was recorded and the window opened
    let delivered = f.client.get_escrow(&id);
    assert_eq!(delivered.state, EscrowState::Delivered);
    assert_eq!(delivered.manifest_hash, Some(hash(&f.env, 2)));
    assert_eq!(delivered.delivered_at, Some(START + 10));
    assert_eq!(delivered.dispute_by, Some(START + 10 + DISPUTE_S));

    // Settle once the window closes
    advance(&f, DISPUTE_S);
    assert_eq!(f.client.settle(&id), CAP);

    // Check the seller was paid and the escrow closed
    assert_eq!(f.token.balance(&f.seller), CAP);
    assert_eq!(f.token.balance(&f.contract), 0);
    let released = f.client.get_escrow(&id);
    assert_eq!(released.state, EscrowState::Released);
    assert_eq!(released.closed_at, Some(START + 10 + DISPUTE_S));
}

#[test]
fn deliver_requires_seller_auth() {
    // Lock and deliver an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check the only authorization recorded is the seller's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.seller);
}

#[test]
fn deliver_fails_after_deliver_by() {
    // Lock an escrow and let deliver-by pass
    let f = fixture();
    let id = lock(&f);
    advance(&f, DELIVER_S);

    // Check a late delivery is rejected
    assert_eq!(
        f.client.try_deliver(&id, &hash(&f.env, 2)),
        Err(Ok(Error::DeliverDeadlinePassed))
    );
}

#[test]
fn deliver_fails_twice() {
    // Lock and deliver an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check a second delivery is rejected
    assert_eq!(
        f.client.try_deliver(&id, &hash(&f.env, 3)),
        Err(Ok(Error::WrongState))
    );
}

#[test]
fn settle_fails_while_window_is_open() {
    // Lock and deliver an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check settle is rejected one second before the window closes
    advance(&f, DISPUTE_S - 1);
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::DisputeWindowOpen)));
}

#[test]
fn settle_fails_before_delivery() {
    // Lock an escrow without delivering
    let f = fixture();
    let id = lock(&f);

    // Check settle is rejected
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn settle_fails_twice() {
    // Lock, deliver and settle an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);
    f.client.settle(&id);

    // Check a second settle is rejected and the seller was paid once
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::WrongState)));
    assert_eq!(f.token.balance(&f.seller), CAP);
}

#[test]
fn settle_needs_no_authorization() {
    // Lock and deliver an escrow, then let the window close
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);

    // Settle with auth mocking disabled
    f.env.set_auths(&[]);
    assert_eq!(f.client.settle(&id), CAP);
    assert_eq!(f.token.balance(&f.seller), CAP);
}

#[test]
fn refund_returns_cap_after_deliver_by() {
    // Lock an escrow and let deliver-by pass
    let f = fixture();
    let id = lock(&f);
    advance(&f, DELIVER_S);

    // Refund the escrow
    assert_eq!(f.client.refund(&id), CAP);

    // Check the buyer got the cap back and the escrow closed
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
    assert_eq!(f.token.balance(&f.contract), 0);
    let refunded = f.client.get_escrow(&id);
    assert_eq!(refunded.state, EscrowState::Refunded);
    assert_eq!(refunded.closed_at, Some(START + DELIVER_S));
}

#[test]
fn refund_fails_before_deliver_by() {
    // Lock an escrow
    let f = fixture();
    let id = lock(&f);

    // Check refund is rejected one second before deliver-by
    advance(&f, DELIVER_S - 1);
    assert_eq!(
        f.client.try_refund(&id),
        Err(Ok(Error::DeliverDeadlineNotPassed))
    );
}

#[test]
fn refund_fails_after_delivery() {
    // Lock and deliver an escrow, then let deliver-by pass
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DELIVER_S);

    // Check refund is rejected for a delivered escrow
    assert_eq!(f.client.try_refund(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn refund_needs_no_authorization() {
    // Lock an escrow and let deliver-by pass
    let f = fixture();
    let id = lock(&f);
    advance(&f, DELIVER_S);

    // Refund with auth mocking disabled
    f.env.set_auths(&[]);
    assert_eq!(f.client.refund(&id), CAP);
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
}

#[test]
fn unknown_escrow_is_not_found() {
    // Check every entry point rejects an unknown id
    let f = fixture();
    assert_eq!(f.client.try_get_escrow(&9), Err(Ok(Error::EscrowNotFound)));
    assert_eq!(
        f.client.try_deliver(&9, &hash(&f.env, 2)),
        Err(Ok(Error::EscrowNotFound))
    );
    assert_eq!(f.client.try_settle(&9), Err(Ok(Error::EscrowNotFound)));
    assert_eq!(f.client.try_refund(&9), Err(Ok(Error::EscrowNotFound)));
    assert_eq!(f.client.try_acknowledge(&9), Err(Ok(Error::EscrowNotFound)));
}

#[test]
fn acknowledge_then_settle_pays_seller_before_window_closes() {
    // Lock and deliver an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Acknowledge inside the dispute window
    advance(&f, 5);
    f.client.acknowledge(&id);
    let acknowledged = f.client.get_escrow(&id);
    assert_eq!(acknowledged.state, EscrowState::Acknowledged);
    assert_eq!(acknowledged.acknowledged_at, Some(START + 5));

    // Settle immediately without waiting for the window
    assert_eq!(f.client.settle(&id), CAP);

    // Check the seller was paid and the acknowledgement kept on the record
    assert_eq!(f.token.balance(&f.seller), CAP);
    assert_eq!(f.token.balance(&f.contract), 0);
    let released = f.client.get_escrow(&id);
    assert_eq!(released.state, EscrowState::Released);
    assert_eq!(released.acknowledged_at, Some(START + 5));
    assert_eq!(released.closed_at, Some(START + 5));
}

#[test]
fn acknowledge_requires_buyer_auth() {
    // Lock, deliver and acknowledge an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    f.client.acknowledge(&id);

    // Check the only authorization recorded is the buyer's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.buyer);
}

#[test]
fn acknowledge_fails_before_delivery() {
    // Lock an escrow without delivering
    let f = fixture();
    let id = lock(&f);

    // Check acknowledge is rejected
    assert_eq!(f.client.try_acknowledge(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn acknowledge_fails_after_window_closes() {
    // Lock and deliver an escrow, then let the window close
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);

    // Check a late acknowledgement is rejected
    assert_eq!(
        f.client.try_acknowledge(&id),
        Err(Ok(Error::DisputeWindowClosed))
    );
}

#[test]
fn acknowledge_fails_twice() {
    // Lock, deliver and acknowledge an escrow
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    f.client.acknowledge(&id);

    // Check a second acknowledgement is rejected
    assert_eq!(f.client.try_acknowledge(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn acknowledged_escrow_cannot_be_refunded() {
    // Lock, deliver and acknowledge an escrow, then let deliver-by pass
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    f.client.acknowledge(&id);
    advance(&f, DELIVER_S);

    // Check refund is rejected and the cap stays in the contract
    assert_eq!(f.client.try_refund(&id), Err(Ok(Error::WrongState)));
    assert_eq!(f.token.balance(&f.contract), CAP);
}

#[test]
fn silent_settle_leaves_acknowledgement_empty() {
    // Lock and deliver an escrow, then let the window close in silence
    let f = fixture();
    let id = lock(&f);
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);

    // Settle and check no acknowledgement was recorded
    f.client.settle(&id);
    assert_eq!(f.client.get_escrow(&id).acknowledged_at, None);
}
