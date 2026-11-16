// Unit tests for the escrow contract's quote checks, lifecycle, clocks, payout gate and authorization.

extern crate std;

use crate::test_token::{TestToken, TestTokenClient};
use crate::{
    DataKey, Error, Escrow, EscrowContract, EscrowContractClient, EscrowState, PayoutStep,
    QuoteTerms, TTL_MARGIN_LEDGERS,
};
use ed25519_dalek::{Signer, SigningKey};
use soroban_sdk::address_payload::AddressPayload;
use soroban_sdk::testutils::storage::Persistent as _;
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, Events as _, Ledger, MockAuth, MockAuthInvoke,
};
use soroban_sdk::token::TokenClient;
use soroban_sdk::{symbol_short, Address, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec};

pub const CAP: i128 = 10_000_000;
pub const FLOOR: i128 = 2_000_000;
pub const HALF_PAYOUT: i128 = 6_000_000;
pub const ACCEPT_S: u64 = 30;
pub const DELIVER_S: u64 = 60;
pub const DISPUTE_S: u64 = 30;
pub const START: u64 = 1_000_000;

/// Quote hash of `vector_terms`, shared with the TypeScript encoder's test.
const QUOTE_HASH_VECTOR: &str = "59372ce26ddb1a34f8f3567c18798cc49577780600a9ba843a36b099fdba0e12";

/// Contract, token and parties shared by every test.
pub struct Fixture {
    pub env: Env,
    pub client: EscrowContractClient<'static>,
    pub contract: Address,
    pub token: TokenClient<'static>,
    pub buyer: Address,
    pub seller: Address,
    pub seller_key: SigningKey,
    pub admin: Address,
}

/// Registers the contract and a funded test token with all auths mocked.
pub fn fixture() -> Fixture {
    // Create the environment at a fixed ledger time
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| ledger.timestamp = START);

    // Register the test token and fund the buyer
    let token_id = env.register(TestToken, ());
    let buyer = Address::generate(&env);
    TestTokenClient::new(&env, &token_id).mint(&buyer, &(CAP * 3));

    // Create the seller as an account address backed by a known ed25519 key
    let seller_key = SigningKey::from_bytes(&[7; 32]);
    let seller = account_address(&env, &seller_key);

    // Register the escrow contract with its admin
    let admin = Address::generate(&env);
    let contract = env.register(EscrowContract, (&admin,));
    let client = EscrowContractClient::new(&env, &contract);
    let token = TokenClient::new(&env, &token_id);

    Fixture {
        env,
        client,
        contract,
        token,
        buyer,
        seller,
        seller_key,
        admin,
    }
}

/// Credits `amount` of the test token to `to`.
pub fn mint(f: &Fixture, to: &Address, amount: i128) {
    TestTokenClient::new(&f.env, &f.token.address).mint(to, &amount);
}

/// Returns the account (G...) address whose master key is `key`.
pub fn account_address(env: &Env, key: &SigningKey) -> Address {
    let public = BytesN::from_array(env, &key.verifying_key().to_bytes());
    Address::from_payload(env, AddressPayload::AccountIdPublicKeyEd25519(public))
}

/// Returns a 32-byte hash filled with `byte`.
pub fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

/// Builds a payout schedule from `(completeness, payout)` pairs.
pub fn schedule(env: &Env, steps: &[(u32, i128)]) -> Vec<PayoutStep> {
    let mut schedule = Vec::new(env);
    for (completeness, payout) in steps {
        schedule.push_back(PayoutStep {
            completeness: *completeness,
            payout: *payout,
        });
    }
    schedule
}

/// Returns the standard quote: floor at 0%, a 50% step, and the cap at 100%.
pub fn terms(f: &Fixture) -> QuoteTerms {
    QuoteTerms {
        seller: f.seller.clone(),
        asset: f.token.address.clone(),
        cap: CAP,
        floor: FLOOR,
        schedule: schedule(&f.env, &[(0, FLOOR), (50, HALF_PAYOUT), (100, CAP)]),
        accept_s: ACCEPT_S,
        deliver_s: DELIVER_S,
        dispute_s: DISPUTE_S,
        job_id: hash(&f.env, 7),
    }
}

/// Hashes `terms` and signs the hash with `key`.
pub fn sign_with(f: &Fixture, terms: &QuoteTerms, key: &SigningKey) -> (BytesN<32>, BytesN<64>) {
    // Hash the terms the way the contract does
    let quote_hash = f.client.quote_hash(terms);

    // Sign the hash bytes with the ed25519 key
    let signature = key.sign(&quote_hash.to_array()).to_bytes();
    (quote_hash, BytesN::from_array(&f.env, &signature))
}

/// Signs `terms` as the seller and locks them, returning the contract's result.
pub fn try_lock_terms(f: &Fixture, terms: &QuoteTerms) -> Result<u64, Error> {
    // Sign the quote as the seller
    let (quote_hash, signature) = sign_with(f, terms, &f.seller_key);

    // Lock and flatten the client's nested result
    match f.client.try_lock(&f.buyer, terms, &quote_hash, &signature) {
        Ok(Ok(id)) => Ok(id),
        Err(Ok(error)) => Err(error),
        other => panic!("unexpected lock result: {other:?}"),
    }
}

/// Locks the standard quote and returns its escrow id.
pub fn lock(f: &Fixture) -> u64 {
    try_lock_terms(f, &terms(f)).unwrap()
}

/// Locks and accepts the standard quote.
pub fn accepted(f: &Fixture) -> u64 {
    let id = lock(f);
    f.client.accept(&id);
    id
}

/// Locks, accepts and delivers the standard quote.
pub fn delivered(f: &Fixture) -> u64 {
    let id = accepted(f);
    f.client.deliver(&id, &hash(&f.env, 2));
    id
}

/// Moves ledger time forward by `seconds`.
pub fn advance(f: &Fixture, seconds: u64) {
    f.env
        .ledger()
        .with_mut(|ledger| ledger.timestamp += seconds);
}

/// Returns the escrow contract's events from the last invocation as `(name, data map)` pairs.
pub fn escrow_events(f: &Fixture) -> std::vec::Vec<(Symbol, Map<Symbol, Val>)> {
    // Keep the events the escrow contract emitted
    let mut events = std::vec::Vec::new();
    for (contract, topics, data) in f.env.events().all().iter() {
        if contract != f.contract {
            continue;
        }

        // Decode the event name and its data map
        let name = Symbol::try_from_val(&f.env, &topics.get(0).unwrap()).unwrap();
        let data = Map::<Symbol, Val>::try_from_val(&f.env, &data).unwrap();
        events.push((name, data));
    }
    events
}

/// Reads one field of an event's data map.
pub fn field<T: TryFromVal<Env, Val>>(f: &Fixture, data: &Map<Symbol, Val>, key: &str) -> T {
    T::try_from_val(&f.env, &data.get(Symbol::new(&f.env, key)).unwrap())
        .unwrap_or_else(|_| panic!("event field {key} has the wrong type"))
}

/// Returns the contract's outcome or reason enum field as its variant name.
pub fn variant(f: &Fixture, data: &Map<Symbol, Val>, key: &str) -> Symbol {
    let value: Vec<Val> = field(f, data, key);
    Symbol::try_from_val(&f.env, &value.get(0).unwrap()).unwrap()
}

#[test]
fn lock_moves_cap_into_contract_and_fixes_accept_by() {
    // Lock an escrow
    let f = fixture();
    let id = lock(&f);

    // Check the cap moved from the buyer to the contract
    assert_eq!(f.token.balance(&f.buyer), CAP * 2);
    assert_eq!(f.token.balance(&f.contract), CAP);

    // Check the stored terms and the accept-by deadline
    let escrow = f.client.get_escrow(&id);
    let quoted = terms(&f);
    assert_eq!(escrow.state, EscrowState::Locked);
    assert_eq!(escrow.cap, CAP);
    assert_eq!(escrow.floor, FLOOR);
    assert_eq!(escrow.schedule, quoted.schedule);
    assert_eq!(escrow.job_id, quoted.job_id);
    assert_eq!(escrow.quote_hash, f.client.quote_hash(&quoted));
    assert_eq!(escrow.locked_at, START);
    assert_eq!(escrow.accept_by, START + ACCEPT_S);
    assert_eq!(escrow.deliver_by, None);
    assert_eq!(escrow.dispute_by, None);
}

#[test]
fn lock_emits_the_locked_event() {
    // Lock an escrow and read its events
    let f = fixture();
    let id = lock(&f);
    let events = escrow_events(&f);

    // Check one locked event carries the terms and the accept-by deadline
    assert_eq!(events.len(), 1);
    let (name, data) = &events[0];
    assert_eq!(name, &Symbol::new(&f.env, "escrow_locked"));
    assert_eq!(field::<i128>(&f, data, "cap"), CAP);
    assert_eq!(field::<i128>(&f, data, "floor"), FLOOR);
    assert_eq!(field::<u64>(&f, data, "accept_by"), START + ACCEPT_S);
    assert_eq!(id, 1);
}

#[test]
fn lock_assigns_increasing_ids() {
    // Lock two escrows and compare their ids
    let f = fixture();
    assert_eq!(lock(&f), 1);
    assert_eq!(lock(&f), 2);
}

#[test]
fn lock_rejects_terms_changed_after_signing() {
    // Sign the standard quote
    let f = fixture();
    let signed = terms(&f);
    let (quote_hash, signature) = sign_with(&f, &signed, &f.seller_key);

    // Build tampered copies of every term
    let mut tampered = std::vec::Vec::new();
    let mut cap = signed.clone();
    cap.cap += 1;
    tampered.push(cap);
    let mut floor = signed.clone();
    floor.floor -= 1;
    tampered.push(floor);
    let mut steps = signed.clone();
    steps.schedule = schedule(&f.env, &[(0, FLOOR), (60, HALF_PAYOUT), (100, CAP)]);
    tampered.push(steps);
    let mut clock = signed.clone();
    clock.dispute_s += 1;
    tampered.push(clock);
    let mut job = signed.clone();
    job.job_id = hash(&f.env, 8);
    tampered.push(job);
    let mut seller = signed.clone();
    seller.seller = account_address(&f.env, &SigningKey::from_bytes(&[9; 32]));
    tampered.push(seller);

    // Check each one fails the quote hash check
    for terms in tampered {
        assert_eq!(
            f.client.try_lock(&f.buyer, &terms, &quote_hash, &signature),
            Err(Ok(Error::QuoteHashMismatch))
        );
    }
}

#[test]
fn lock_rejects_a_signature_from_another_key() {
    // Sign the standard quote with a key that is not the seller's
    let f = fixture();
    let quoted = terms(&f);
    let forger = SigningKey::from_bytes(&[9; 32]);
    let (quote_hash, signature) = sign_with(&f, &quoted, &forger);

    // Check the host rejects the signature and nothing moves
    let result = f
        .client
        .try_lock(&f.buyer, &quoted, &quote_hash, &signature);
    assert!(matches!(result, Err(Err(_))));
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
}

#[test]
fn lock_rejects_a_contract_seller() {
    // Quote with a contract address as the seller
    let f = fixture();
    let mut quoted = terms(&f);
    quoted.seller = Address::generate(&f.env);

    // Check the contract refuses a seller with no account key
    assert_eq!(try_lock_terms(&f, &quoted), Err(Error::InvalidSeller));
}

#[test]
fn lock_rejects_invalid_terms() {
    // Set up the contract and token
    let f = fixture();

    // Reject a zero cap
    let mut zero_cap = terms(&f);
    zero_cap.cap = 0;
    assert_eq!(try_lock_terms(&f, &zero_cap), Err(Error::InvalidCap));

    // Reject a negative floor and a floor above the cap
    let mut negative_floor = terms(&f);
    negative_floor.floor = -1;
    assert_eq!(
        try_lock_terms(&f, &negative_floor),
        Err(Error::InvalidFloor)
    );
    let mut high_floor = terms(&f);
    high_floor.floor = CAP + 1;
    assert_eq!(try_lock_terms(&f, &high_floor), Err(Error::InvalidFloor));

    // Reject zero and oversized clocks
    let mut zero_accept = terms(&f);
    zero_accept.accept_s = 0;
    assert_eq!(
        try_lock_terms(&f, &zero_accept),
        Err(Error::InvalidDuration)
    );
    let mut long_deliver = terms(&f);
    long_deliver.deliver_s = crate::MAX_DURATION_S + 1;
    assert_eq!(
        try_lock_terms(&f, &long_deliver),
        Err(Error::InvalidDuration)
    );
    let mut zero_dispute = terms(&f);
    zero_dispute.dispute_s = 0;
    assert_eq!(
        try_lock_terms(&f, &zero_dispute),
        Err(Error::InvalidDuration)
    );

    // Reject a buyer paying itself
    let quoted = terms(&f);
    let (quote_hash, signature) = sign_with(&f, &quoted, &f.seller_key);
    assert_eq!(
        f.client
            .try_lock(&f.seller, &quoted, &quote_hash, &signature),
        Err(Ok(Error::SameParty))
    );
}

#[test]
fn lock_rejects_invalid_schedules() {
    // List schedules that break each rule, with the standard floor and cap
    let f = fixture();
    let bad: [&[(u32, i128)]; 11] = [
        &[],
        &[(0, FLOOR), (50, HALF_PAYOUT)],
        &[(0, FLOOR), (100, CAP - 1)],
        &[(50, HALF_PAYOUT), (100, CAP)],
        &[(0, FLOOR + 1), (100, CAP)],
        &[(0, FLOOR), (50, HALF_PAYOUT), (50, HALF_PAYOUT), (100, CAP)],
        &[(0, FLOOR), (60, HALF_PAYOUT), (50, HALF_PAYOUT), (100, CAP)],
        &[
            (0, FLOOR),
            (40, HALF_PAYOUT),
            (60, HALF_PAYOUT - 1),
            (100, CAP),
        ],
        &[(0, FLOOR), (50, CAP), (100, CAP)],
        &[(0, FLOOR), (50, FLOOR - 1), (100, CAP)],
        &[(0, FLOOR), (100, CAP), (101, CAP)],
    ];

    // Check each one is refused before any funds move
    for steps in bad {
        let mut quoted = terms(&f);
        quoted.schedule = schedule(&f.env, steps);
        assert_eq!(
            try_lock_terms(&f, &quoted),
            Err(Error::InvalidSchedule),
            "{steps:?}"
        );
    }
    assert_eq!(f.token.balance(&f.contract), 0);
}

#[test]
fn lock_accepts_a_floor_equal_to_the_cap_with_a_single_step() {
    // Quote a floor equal to the cap with only the full-completeness step
    let f = fixture();
    let mut quoted = terms(&f);
    quoted.floor = CAP;
    quoted.schedule = schedule(&f.env, &[(100, CAP)]);

    // Check the lock succeeds
    assert_eq!(try_lock_terms(&f, &quoted), Ok(1));

    // Check a zero step is still refused when it would pay the cap below full completeness
    quoted.schedule = schedule(&f.env, &[(0, CAP), (100, CAP)]);
    assert_eq!(try_lock_terms(&f, &quoted), Err(Error::InvalidSchedule));
}

#[test]
fn lock_requires_buyer_auth_covering_the_transfer() {
    // Lock an escrow and read back the recorded authorizations
    let f = fixture();
    lock(&f);
    let auths = f.env.auths();

    // Check the buyer authorized the lock call itself
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.buyer);
    let invocation = &auths[0].1;
    match &invocation.function {
        AuthorizedFunction::Contract((contract, name, _)) => {
            assert_eq!(contract, &f.contract);
            assert_eq!(name, &Symbol::new(&f.env, "lock"));
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
fn lock_extends_escrow_ttl_past_the_last_possible_deadline() {
    // Lock an escrow and read its storage TTL
    let f = fixture();
    let id = lock(&f);
    let ttl = f.env.as_contract(&f.contract, || {
        f.env.storage().persistent().get_ttl(&DataKey::Escrow(id))
    });

    // Check the TTL covers all three clocks plus the margin
    let window_ledgers = ((ACCEPT_S + DELIVER_S + DISPUTE_S) / crate::SECONDS_PER_LEDGER) as u32;
    assert!(ttl >= window_ledgers + TTL_MARGIN_LEDGERS);
}

#[test]
fn quote_hash_matches_the_cross_language_vector() {
    // Build fixed terms from fixed keys
    let env = Env::default();
    let seller = account_address(&env, &SigningKey::from_bytes(&[7; 32]));
    let asset = Address::from_payload(&env, AddressPayload::ContractIdHash(hash(&env, 2)));
    let vector_terms = QuoteTerms {
        seller,
        asset,
        cap: CAP,
        floor: FLOOR,
        schedule: schedule(&env, &[(0, FLOOR), (50, HALF_PAYOUT), (100, CAP)]),
        accept_s: ACCEPT_S,
        deliver_s: DELIVER_S,
        dispute_s: DISPUTE_S,
        job_id: hash(&env, 3),
    };

    // Hash them through the contract and compare against the shared vector
    let contract = env.register(EscrowContract, (Address::generate(&env),));
    let client = EscrowContractClient::new(&env, &contract);
    let digest = client.quote_hash(&vector_terms).to_array();
    let hex: std::string::String = digest.iter().map(|b| std::format!("{b:02x}")).collect();
    assert_eq!(hex, QUOTE_HASH_VECTOR);
}

#[test]
fn accept_starts_the_deliver_by_clock() {
    // Lock an escrow and accept it before accept-by
    let f = fixture();
    let id = lock(&f);
    advance(&f, 10);
    f.client.accept(&id);
    let events = escrow_events(&f);

    // Check the acceptance and the deliver-by deadline were recorded
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Accepted);
    assert_eq!(escrow.accepted_at, Some(START + 10));
    assert_eq!(escrow.deliver_by, Some(START + 10 + DELIVER_S));

    // Check the accepted event carries the deadline
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, Symbol::new(&f.env, "escrow_accepted"));
    assert_eq!(
        field::<u64>(&f, &events[0].1, "deliver_by"),
        START + 10 + DELIVER_S
    );
}

#[test]
fn accept_requires_seller_auth() {
    // Lock and accept an escrow
    let f = fixture();
    accepted(&f);

    // Check the only authorization recorded is the seller's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.seller);
}

#[test]
fn accept_fails_at_accept_by() {
    // Lock an escrow and let accept-by arrive
    let f = fixture();
    let id = lock(&f);
    advance(&f, ACCEPT_S);

    // Check a late acceptance is rejected
    assert_eq!(
        f.client.try_accept(&id),
        Err(Ok(Error::AcceptDeadlinePassed))
    );
}

#[test]
fn accept_fails_twice() {
    // Lock and accept an escrow
    let f = fixture();
    let id = accepted(&f);

    // Check a second acceptance is rejected
    assert_eq!(f.client.try_accept(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn deliver_records_the_manifest_and_opens_the_window() {
    // Lock and accept an escrow, then deliver
    let f = fixture();
    let id = accepted(&f);
    advance(&f, 10);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check the delivery was recorded and the window opened
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Delivered);
    assert_eq!(escrow.manifest_hash, Some(hash(&f.env, 2)));
    assert_eq!(escrow.delivered_at, Some(START + 10));
    assert_eq!(escrow.dispute_by, Some(START + 10 + DISPUTE_S));
}

#[test]
fn deliver_requires_seller_auth() {
    // Lock, accept and deliver an escrow
    let f = fixture();
    delivered(&f);

    // Check the only authorization recorded is the seller's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.seller);
}

#[test]
fn deliver_fails_before_accept() {
    // Lock an escrow without accepting it
    let f = fixture();
    let id = lock(&f);

    // Check delivery is rejected
    assert_eq!(
        f.client.try_deliver(&id, &hash(&f.env, 2)),
        Err(Ok(Error::WrongState))
    );
}

#[test]
fn deliver_fails_at_deliver_by() {
    // Lock and accept an escrow, then let deliver-by arrive
    let f = fixture();
    let id = accepted(&f);
    advance(&f, DELIVER_S);

    // Check a late delivery is rejected
    assert_eq!(
        f.client.try_deliver(&id, &hash(&f.env, 2)),
        Err(Ok(Error::DeliverDeadlinePassed))
    );
}

#[test]
fn deliver_fails_twice() {
    // Lock, accept and deliver an escrow
    let f = fixture();
    let id = delivered(&f);

    // Check a second delivery is rejected
    assert_eq!(
        f.client.try_deliver(&id, &hash(&f.env, 3)),
        Err(Ok(Error::WrongState))
    );
}

#[test]
fn acknowledge_then_settle_pays_the_cap_at_once() {
    // Deliver an escrow and acknowledge it inside the window
    let f = fixture();
    let id = delivered(&f);
    advance(&f, 5);
    f.client.acknowledge(&id);
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Acknowledged);
    assert_eq!(escrow.acknowledged_at, Some(START + 5));

    // Settle immediately without waiting for the window
    assert_eq!(f.client.settle(&id), CAP);
    let events = escrow_events(&f);

    // Check the seller got the cap and the escrow closed with the acknowledgement kept
    assert_eq!(f.token.balance(&f.seller), CAP);
    assert_eq!(f.token.balance(&f.contract), 0);
    let released = f.client.get_escrow(&id);
    assert_eq!(released.state, EscrowState::Released);
    assert_eq!(released.acknowledged_at, Some(START + 5));
    assert_eq!(released.closed_at, Some(START + 5));

    // Check the settlement event reports an acknowledged full payout
    assert_eq!(events.len(), 1);
    let (name, data) = &events[0];
    assert_eq!(name, &Symbol::new(&f.env, "escrow_settled"));
    assert_eq!(
        variant(&f, data, "outcome"),
        Symbol::new(&f.env, "Acknowledged")
    );
    assert_eq!(field::<u32>(&f, data, "completeness"), 100);
    assert_eq!(field::<i128>(&f, data, "payout"), CAP);
    assert_eq!(field::<i128>(&f, data, "remainder"), 0);
}

#[test]
fn acknowledge_requires_buyer_auth() {
    // Deliver and acknowledge an escrow
    let f = fixture();
    let id = delivered(&f);
    f.client.acknowledge(&id);

    // Check the only authorization recorded is the buyer's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.buyer);
}

#[test]
fn acknowledge_fails_outside_the_delivered_window() {
    // Check acknowledge is rejected before delivery
    let f = fixture();
    let id = accepted(&f);
    assert_eq!(f.client.try_acknowledge(&id), Err(Ok(Error::WrongState)));

    // Check acknowledge is rejected once the window closes
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);
    assert_eq!(
        f.client.try_acknowledge(&id),
        Err(Ok(Error::DisputeWindowClosed))
    );
}

#[test]
fn acknowledge_fails_twice() {
    // Deliver and acknowledge an escrow
    let f = fixture();
    let id = delivered(&f);
    f.client.acknowledge(&id);

    // Check a second acknowledgement is rejected
    assert_eq!(f.client.try_acknowledge(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn dispute_then_settle_pays_the_schedule_price_and_returns_the_rest() {
    // Deliver an escrow and dispute it at 50% inside the window
    let f = fixture();
    let id = delivered(&f);
    advance(&f, 5);
    f.client.dispute(&id, &50);
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Disputed);
    assert_eq!(escrow.completeness, Some(50));
    assert_eq!(escrow.disputed_at, Some(START + 5));

    // Settle immediately
    assert_eq!(f.client.settle(&id), HALF_PAYOUT);
    let events = escrow_events(&f);

    // Check the seller got the 50% price and the buyer got the remainder
    assert_eq!(f.token.balance(&f.seller), HALF_PAYOUT);
    assert_eq!(f.token.balance(&f.buyer), CAP * 2 + (CAP - HALF_PAYOUT));
    assert_eq!(f.token.balance(&f.contract), 0);

    // Check the settlement event reports the disputed split
    assert_eq!(events.len(), 1);
    let data = &events[0].1;
    assert_eq!(
        variant(&f, data, "outcome"),
        Symbol::new(&f.env, "Disputed")
    );
    assert_eq!(field::<u32>(&f, data, "completeness"), 50);
    assert_eq!(field::<i128>(&f, data, "payout"), HALF_PAYOUT);
    assert_eq!(field::<i128>(&f, data, "remainder"), CAP - HALF_PAYOUT);
}

#[test]
fn dispute_at_zero_pays_the_floor() {
    // Deliver an escrow and dispute it at 0%
    let f = fixture();
    let id = delivered(&f);
    f.client.dispute(&id, &0);

    // Check settle pays the floor and returns the rest
    assert_eq!(f.client.settle(&id), FLOOR);
    assert_eq!(f.token.balance(&f.seller), FLOOR);
    assert_eq!(f.token.balance(&f.buyer), CAP * 2 + (CAP - FLOOR));
}

#[test]
fn dispute_at_zero_with_a_zero_floor_returns_the_whole_cap() {
    // Lock, accept and deliver a quote with no floor
    let f = fixture();
    let mut quoted = terms(&f);
    quoted.floor = 0;
    quoted.schedule = schedule(&f.env, &[(0, 0), (100, CAP)]);
    let id = try_lock_terms(&f, &quoted).unwrap();
    f.client.accept(&id);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Dispute at 0% and settle
    f.client.dispute(&id, &0);
    assert_eq!(f.client.settle(&id), 0);

    // Check the buyer got the whole cap back
    assert_eq!(f.token.balance(&f.seller), 0);
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
}

#[test]
fn dispute_requires_buyer_auth() {
    // Deliver and dispute an escrow
    let f = fixture();
    let id = delivered(&f);
    f.client.dispute(&id, &50);

    // Check the only authorization recorded is the buyer's
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.buyer);
}

#[test]
fn dispute_rejects_completeness_not_in_the_schedule() {
    // Deliver an escrow
    let f = fixture();
    let id = delivered(&f);

    // Check unquoted steps and full completeness are rejected
    for completeness in [30, 100, 101] {
        assert_eq!(
            f.client.try_dispute(&id, &completeness),
            Err(Ok(Error::CompletenessNotInSchedule))
        );
    }
}

#[test]
fn dispute_is_rejected_when_the_floor_equals_the_cap() {
    // Lock, accept and deliver a quote whose floor equals the cap
    let f = fixture();
    let mut quoted = terms(&f);
    quoted.floor = CAP;
    quoted.schedule = schedule(&f.env, &[(100, CAP)]);
    let id = try_lock_terms(&f, &quoted).unwrap();
    f.client.accept(&id);
    f.client.deliver(&id, &hash(&f.env, 2));

    // Check any dispute is rejected
    assert_eq!(
        f.client.try_dispute(&id, &0),
        Err(Ok(Error::CompletenessNotInSchedule))
    );
}

#[test]
fn dispute_fails_outside_the_delivered_window() {
    // Check dispute is rejected before delivery
    let f = fixture();
    let id = accepted(&f);
    assert_eq!(f.client.try_dispute(&id, &50), Err(Ok(Error::WrongState)));

    // Check dispute is rejected once the window closes
    f.client.deliver(&id, &hash(&f.env, 2));
    advance(&f, DISPUTE_S);
    assert_eq!(
        f.client.try_dispute(&id, &50),
        Err(Ok(Error::DisputeWindowClosed))
    );
}

#[test]
fn dispute_fails_after_acknowledge() {
    // Deliver and acknowledge an escrow
    let f = fixture();
    let id = delivered(&f);
    f.client.acknowledge(&id);

    // Check the buyer cannot dispute afterwards
    assert_eq!(f.client.try_dispute(&id, &50), Err(Ok(Error::WrongState)));
}

#[test]
fn silent_settle_after_the_window_pays_the_cap() {
    // Deliver an escrow and let the window close in silence
    let f = fixture();
    let id = delivered(&f);
    advance(&f, DISPUTE_S);

    // Settle and check the seller got the cap with no acknowledgement recorded
    assert_eq!(f.client.settle(&id), CAP);
    let events = escrow_events(&f);
    assert_eq!(f.token.balance(&f.seller), CAP);
    assert_eq!(f.token.balance(&f.contract), 0);
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Released);
    assert_eq!(escrow.acknowledged_at, None);

    // Check the settlement event reports a silent close
    assert_eq!(events.len(), 1);
    assert_eq!(
        variant(&f, &events[0].1, "outcome"),
        Symbol::new(&f.env, "Silent")
    );
}

#[test]
fn settle_fails_while_the_window_is_open() {
    // Deliver an escrow
    let f = fixture();
    let id = delivered(&f);

    // Check settle is rejected one second before the window closes
    advance(&f, DISPUTE_S - 1);
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::DisputeWindowOpen)));
}

#[test]
fn settle_fails_before_delivery() {
    // Check settle is rejected while locked and while accepted
    let f = fixture();
    let id = lock(&f);
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::WrongState)));
    f.client.accept(&id);
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn settle_fails_twice() {
    // Deliver and settle an escrow after the window
    let f = fixture();
    let id = delivered(&f);
    advance(&f, DISPUTE_S);
    f.client.settle(&id);

    // Check a second settle is rejected and the seller was paid once
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::WrongState)));
    assert_eq!(f.token.balance(&f.seller), CAP);
}

#[test]
fn settle_needs_no_authorization() {
    // Deliver an escrow and let the window close
    let f = fixture();
    let id = delivered(&f);
    advance(&f, DISPUTE_S);

    // Settle with auth mocking disabled
    f.env.set_auths(&[]);
    assert_eq!(f.client.settle(&id), CAP);
    assert_eq!(f.token.balance(&f.seller), CAP);
}

#[test]
fn settle_refuses_a_payout_outside_the_gate() {
    // Dispute an escrow, then corrupt its stored schedule so the disputed step pays the cap
    let f = fixture();
    let id = delivered(&f);
    f.client.dispute(&id, &50);
    f.env.as_contract(&f.contract, || {
        let key = DataKey::Escrow(id);
        let mut escrow: Escrow = f.env.storage().persistent().get(&key).unwrap();
        escrow.schedule = schedule(&f.env, &[(0, FLOOR), (50, CAP), (100, CAP)]);
        f.env.storage().persistent().set(&key, &escrow);
    });

    // Check the gate refuses the payout and the cap stays in the contract
    assert_eq!(f.client.try_settle(&id), Err(Ok(Error::PayoutOutOfRange)));
    assert_eq!(f.token.balance(&f.contract), CAP);
}

#[test]
fn refund_returns_the_cap_when_accept_by_passes() {
    // Lock an escrow and let accept-by pass unaccepted
    let f = fixture();
    let id = lock(&f);
    advance(&f, ACCEPT_S);

    // Refund and check the buyer got the cap back
    assert_eq!(f.client.refund(&id), CAP);
    let events = escrow_events(&f);
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
    assert_eq!(f.token.balance(&f.contract), 0);
    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.state, EscrowState::Refunded);
    assert_eq!(escrow.closed_at, Some(START + ACCEPT_S));

    // Check the refund event names the missed acceptance
    assert_eq!(events.len(), 1);
    let (name, data) = &events[0];
    assert_eq!(name, &Symbol::new(&f.env, "escrow_refunded"));
    assert_eq!(
        variant(&f, data, "reason"),
        Symbol::new(&f.env, "NotAccepted")
    );
    assert_eq!(field::<i128>(&f, data, "amount"), CAP);
}

#[test]
fn refund_fails_before_accept_by() {
    // Lock an escrow
    let f = fixture();
    let id = lock(&f);

    // Check refund is rejected one second before accept-by
    advance(&f, ACCEPT_S - 1);
    assert_eq!(
        f.client.try_refund(&id),
        Err(Ok(Error::AcceptDeadlineNotPassed))
    );
}

#[test]
fn refund_returns_the_cap_when_deliver_by_passes() {
    // Accept an escrow and let deliver-by pass undelivered
    let f = fixture();
    let id = accepted(&f);
    advance(&f, DELIVER_S);

    // Refund and check the buyer got the cap back
    assert_eq!(f.client.refund(&id), CAP);
    let events = escrow_events(&f);
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);

    // Check the refund event names the missed delivery
    assert_eq!(events.len(), 1);
    assert_eq!(
        variant(&f, &events[0].1, "reason"),
        Symbol::new(&f.env, "NotDelivered")
    );
}

#[test]
fn refund_fails_before_deliver_by() {
    // Accept an escrow
    let f = fixture();
    let id = accepted(&f);

    // Check refund is rejected one second before deliver-by
    advance(&f, DELIVER_S - 1);
    assert_eq!(
        f.client.try_refund(&id),
        Err(Ok(Error::DeliverDeadlineNotPassed))
    );
}

#[test]
fn refund_fails_after_delivery() {
    // Deliver an escrow and let every deadline pass
    let f = fixture();
    let id = delivered(&f);
    advance(&f, ACCEPT_S + DELIVER_S + DISPUTE_S);

    // Check refund is rejected for a delivered escrow
    assert_eq!(f.client.try_refund(&id), Err(Ok(Error::WrongState)));
}

#[test]
fn refund_needs_no_authorization() {
    // Lock an escrow and let accept-by pass
    let f = fixture();
    let id = lock(&f);
    advance(&f, ACCEPT_S);

    // Refund with auth mocking disabled
    f.env.set_auths(&[]);
    assert_eq!(f.client.refund(&id), CAP);
    assert_eq!(f.token.balance(&f.buyer), CAP * 3);
}

#[test]
fn unknown_escrow_is_not_found() {
    // Check every entry point rejects an unknown id
    let f = fixture();
    let missing = Some(Ok(Error::EscrowNotFound));
    assert_eq!(f.client.try_get_escrow(&9).err(), missing);
    assert_eq!(f.client.try_accept(&9).err(), missing);
    assert_eq!(f.client.try_deliver(&9, &hash(&f.env, 2)).err(), missing);
    assert_eq!(f.client.try_acknowledge(&9).err(), missing);
    assert_eq!(f.client.try_dispute(&9, &50).err(), missing);
    assert_eq!(f.client.try_settle(&9).err(), missing);
    assert_eq!(f.client.try_refund(&9).err(), missing);
}

#[test]
fn constructor_sets_the_admin() {
    // Check the admin passed at deploy is stored
    let f = fixture();
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
fn set_admin_requires_admin_auth_and_moves_the_role() {
    // Hand the admin role to a new address
    let f = fixture();
    let new_admin = Address::generate(&f.env);
    f.client.set_admin(&new_admin);

    // Check the old admin authorized it and the role moved
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(f.client.get_admin(), new_admin);
}

#[test]
fn upgrade_swaps_to_uploaded_wasm() {
    // Load the built contract WASM, skipping when it has not been built
    let wasm_path = "../../target/wasm32v1-none/release/agentkred_escrow.wasm";
    let Ok(wasm) = std::fs::read(wasm_path) else {
        std::println!("Skipping upgrade_swaps_to_uploaded_wasm: WASM not found at {wasm_path}");
        return;
    };

    // Upload the WASM and upgrade to it as the admin
    let f = fixture();
    let wasm_hash = f.env.deployer().upload_contract_wasm(wasm.as_slice());
    f.client.upgrade(&wasm_hash);

    // Check the admin authorized the upgrade and the contract still answers
    let auths = f.env.auths();
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
#[should_panic(expected = "MissingValue")]
fn upgrade_fails_for_wasm_that_was_never_uploaded() {
    // Upgrade to a hash with no uploaded WASM behind it
    let f = fixture();
    f.client.upgrade(&hash(&f.env, 9));
}

#[test]
fn upgrade_requires_admin_auth() {
    // Authorize the call as an unrelated address only
    let f = fixture();
    let stranger = Address::generate(&f.env);
    let wasm_hash = hash(&f.env, 9);
    let result = f
        .client
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &f.contract,
                fn_name: "upgrade",
                args: (wasm_hash.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_upgrade(&wasm_hash);

    // Check the upgrade was refused
    assert!(result.is_err());
}

#[test]
fn version_reports_the_code_version() {
    // Check the version of this build
    let f = fixture();
    assert_eq!(f.client.version(), 2);
}
