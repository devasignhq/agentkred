// Fuzzes random quotes and call sequences at random ledger times against the escrow's payout, balance and clock invariants.
#![no_main]

use agentkred_escrow::test_token::{TestToken, TestTokenClient};
use agentkred_escrow::{EscrowContract, EscrowContractClient, EscrowState, PayoutStep, QuoteTerms};
use arbitrary::Arbitrary;
use ed25519_dalek::{Signer, SigningKey};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::address_payload::AddressPayload;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger};
use soroban_sdk::{Address, BytesN, Env, Symbol, TryFromVal, Vec};

/// Raw fuzz input, normalized into a valid quote and a call sequence.
#[derive(Arbitrary, Debug)]
struct Input {
    cap: u32,
    floor_pct: u8,
    floor_is_cap: bool,
    interior: std::vec::Vec<(u8, u32)>,
    clocks: (u8, u8, u8),
    calls: std::vec::Vec<(u8, u8, u8)>,
}

/// Builds a valid schedule: the floor at 0, sorted interior steps below the cap, the cap at 100.
fn build_schedule(cap: i128, floor: i128, interior: &[(u8, u32)]) -> std::vec::Vec<(u32, i128)> {
    // Keep only the full-completeness step when the floor equals the cap
    if floor == cap {
        return std::vec![(100, cap)];
    }

    // Map raw points into distinct completeness values from 1 to 99 and sorted payouts below the cap
    let mut points: std::vec::Vec<u32> =
        interior.iter().map(|(c, _)| 1 + (*c as u32 % 99)).collect();
    points.sort();
    points.dedup();
    let span = cap - floor;
    let mut payouts: std::vec::Vec<i128> = interior
        .iter()
        .take(points.len())
        .map(|(_, p)| floor + (*p as i128 % span))
        .collect();
    payouts.sort();

    // Join the floor step, the interior steps and the cap step
    let mut steps = std::vec![(0, floor)];
    steps.extend(points.into_iter().zip(payouts));
    steps.push((100, cap));
    steps
}

/// Counts the escrow's settle and refund events from the last invocation.
fn terminal_events(env: &Env, contract: &Address) -> u32 {
    // Count the escrow contract's settled and refunded events
    let mut count = 0;
    for (emitter, topics, _) in env.events().all().iter() {
        let name = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
        if emitter == *contract
            && (name == Symbol::new(env, "escrow_settled")
                || name == Symbol::new(env, "escrow_refunded"))
        {
            count += 1;
        }
    }
    count
}

fuzz_target!(|input: Input| {
    // Normalize the input into a quote
    let cap = 1 + input.cap as i128;
    let floor = if input.floor_is_cap {
        cap
    } else {
        cap * input.floor_pct as i128 / 256
    };
    let steps = build_schedule(cap, floor, &input.interior);
    let clocks = (
        1 + input.clocks.0 as u64,
        1 + input.clocks.1 as u64,
        1 + input.clocks.2 as u64,
    );

    // Set up the environment, the token, the parties and the contract
    let env = Env::default();
    env.mock_all_auths();
    let token_id = env.register(TestToken, ());
    let token = TestTokenClient::new(&env, &token_id);
    let buyer = Address::generate(&env);
    token.mint(&buyer, &cap);
    let seller_key = SigningKey::from_bytes(&[7; 32]);
    let seller_public = BytesN::from_array(&env, &seller_key.verifying_key().to_bytes());
    let seller = Address::from_payload(
        &env,
        AddressPayload::AccountIdPublicKeyEd25519(seller_public),
    );
    let contract = env.register(EscrowContract, (Address::generate(&env),));
    let client = EscrowContractClient::new(&env, &contract);

    // Build, sign and lock the quote
    let mut schedule = Vec::new(&env);
    for (completeness, payout) in &steps {
        schedule.push_back(PayoutStep {
            completeness: *completeness,
            payout: *payout,
        });
    }
    let terms = QuoteTerms {
        seller: seller.clone(),
        asset: token_id.clone(),
        cap,
        floor,
        schedule,
        accept_s: clocks.0,
        deliver_s: clocks.1,
        dispute_s: clocks.2,
        job_id: BytesN::from_array(&env, &[3; 32]),
    };
    let quote_hash = client.quote_hash(&terms);
    let signature = BytesN::from_array(&env, &seller_key.sign(&quote_hash.to_array()).to_bytes());
    let id = client.lock(&buyer, &terms, &quote_hash, &signature);
    let accept_by = client.get_escrow(&id).accept_by;

    // Run each call after its time jump, counting terminal events and checking deadlines stay fixed
    let mut terminal = 0;
    let mut deliver_by = None;
    let mut dispute_by = None;
    let mut calls: std::vec::Vec<(u8, u8, u8)> = input.calls;
    calls.push((255, 4, 0));
    calls.push((255, 5, 0));
    for (seconds, action, completeness) in calls {
        // Jump ledger time and make the call
        env.ledger()
            .with_mut(|ledger| ledger.timestamp += seconds as u64);
        let ok = match action % 6 {
            0 => client.try_accept(&id).is_ok(),
            1 => client
                .try_deliver(&id, &BytesN::from_array(&env, &[2; 32]))
                .is_ok(),
            2 => client.try_acknowledge(&id).is_ok(),
            3 => client
                .try_dispute(&id, &(completeness as u32 % 102))
                .is_ok(),
            4 => client.try_settle(&id).is_ok(),
            _ => client.try_refund(&id).is_ok(),
        };

        // Count the terminal events a successful call emitted
        if ok {
            terminal += terminal_events(&env, &contract);
        }

        // Check no deadline moves once it has been set
        let escrow = client.get_escrow(&id);
        assert_eq!(escrow.accept_by, accept_by);
        deliver_by = deliver_by.or(escrow.deliver_by);
        dispute_by = dispute_by.or(escrow.dispute_by);
        assert_eq!(escrow.deliver_by, deliver_by);
        assert_eq!(escrow.dispute_by, dispute_by);
    }

    // Close the escrow if the calls left it open, then check it emitted one terminal event
    env.ledger()
        .with_mut(|ledger| ledger.timestamp += clocks.0 + clocks.1 + clocks.2);
    if client.try_settle(&id).is_ok() || client.try_refund(&id).is_ok() {
        terminal += terminal_events(&env, &contract);
    }
    assert_eq!(terminal, 1);

    // Check the cap was conserved and the payout stayed inside the gate
    let escrow = client.get_escrow(&id);
    let paid = token.balance(&seller);
    assert_eq!(token.balance(&contract), 0);
    assert_eq!(paid + token.balance(&buyer), cap);
    match escrow.state {
        EscrowState::Released => {
            assert!(floor <= paid && paid <= cap);
            if escrow.completeness.is_some() {
                assert!(paid < cap);
            }
        }
        EscrowState::Refunded => assert_eq!(paid, 0),
        other => panic!("escrow did not close: {other:?}"),
    }
});
