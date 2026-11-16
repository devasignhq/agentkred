// Property tests: random schedules and call sequences at random ledger times must keep every escrow invariant.

extern crate std;

use crate::test::{
    account_address, advance, escrow_events, field, fixture, hash, mint, schedule, sign_with,
    try_lock_terms, Fixture,
};
use crate::{Error, EscrowState, QuoteTerms, FULL_COMPLETENESS};
use ed25519_dalek::SigningKey;
use proptest::prelude::*;
use soroban_sdk::Symbol;

/// One call a party might make, preceded by a ledger-time jump.
#[derive(Clone, Debug)]
enum Action {
    Accept,
    Deliver,
    Acknowledge,
    Dispute(u32),
    Settle,
    Refund,
}

/// Generated quote: cap, floor, the interior schedule steps and the three clocks.
#[derive(Clone, Debug)]
struct Quote {
    cap: i128,
    floor: i128,
    steps: std::vec::Vec<(u32, i128)>,
    clocks: (u64, u64, u64),
}

/// Generates a valid quote, including floors equal to the cap.
fn quote_strategy() -> impl Strategy<Value = Quote> {
    (1i128..1_000_000_000, 0u8..=100, any::<bool>())
        .prop_flat_map(|(cap, floor_pct, floor_is_cap)| {
            // Derive the floor and the room left for interior payouts
            let floor = if floor_is_cap {
                cap
            } else {
                cap * floor_pct as i128 / 101
            };
            let points = proptest::collection::btree_set(1u32..FULL_COMPLETENESS, 0..6);
            let payouts = proptest::collection::vec(floor..cap.max(floor + 1), 0..6);
            let clocks = (1u64..120, 1u64..120, 1u64..120);
            (Just(cap), Just(floor), points, payouts, clocks)
        })
        .prop_map(|(cap, floor, points, mut payouts, clocks)| {
            // Build the full schedule: floor at 0, sorted interior steps, cap at 100
            let mut steps = std::vec::Vec::new();
            if floor < cap {
                steps.push((0, floor));
                payouts.sort();
                for (completeness, payout) in points.into_iter().zip(payouts) {
                    steps.push((completeness, payout));
                }
            }
            steps.push((FULL_COMPLETENESS, cap));
            Quote {
                cap,
                floor,
                steps,
                clocks,
            }
        })
}

/// Generates a call with a completeness drawn from 0 to 101 for disputes.
fn action_strategy() -> impl Strategy<Value = Action> {
    prop_oneof![
        Just(Action::Accept),
        Just(Action::Deliver),
        Just(Action::Acknowledge),
        (0u32..=101).prop_map(Action::Dispute),
        Just(Action::Settle),
        Just(Action::Refund),
    ]
}

/// Builds the quote terms for `quote` against the fixture's seller and token.
fn quote_terms(f: &Fixture, quote: &Quote) -> QuoteTerms {
    QuoteTerms {
        seller: f.seller.clone(),
        asset: f.token.address.clone(),
        cap: quote.cap,
        floor: quote.floor,
        schedule: schedule(&f.env, &quote.steps),
        accept_s: quote.clocks.0,
        deliver_s: quote.clocks.1,
        dispute_s: quote.clocks.2,
        job_id: hash(&f.env, 7),
    }
}

/// Runs one call, ignoring contract errors, and returns the escrow events it emitted.
fn run(f: &Fixture, id: u64, action: &Action) -> std::vec::Vec<Symbol> {
    // Make the call through the fallible client
    let ok = match action {
        Action::Accept => f.client.try_accept(&id).is_ok(),
        Action::Deliver => f.client.try_deliver(&id, &hash(&f.env, 2)).is_ok(),
        Action::Acknowledge => f.client.try_acknowledge(&id).is_ok(),
        Action::Dispute(completeness) => f.client.try_dispute(&id, completeness).is_ok(),
        Action::Settle => f.client.try_settle(&id).is_ok(),
        Action::Refund => f.client.try_refund(&id).is_ok(),
    };

    // Return the event names of a successful call
    if !ok {
        return std::vec::Vec::new();
    }
    escrow_events(f).into_iter().map(|(name, _)| name).collect()
}

/// Checks balances, the payout gate and the terminal event once an escrow has closed.
fn check_closed(f: &Fixture, quote: &Quote, buyer_start: i128) {
    // Check the contract holds nothing for the closed escrow
    let escrow = f.client.get_escrow(&1);
    assert_eq!(f.token.balance(&f.contract), 0);

    // Check a settled escrow paid within the gate and conserved the cap
    let seller_paid = f.token.balance(&f.seller);
    let buyer_back = f.token.balance(&f.buyer) - (buyer_start - quote.cap);
    assert_eq!(seller_paid + buyer_back, quote.cap);
    match escrow.state {
        EscrowState::Released => {
            assert!(quote.floor <= seller_paid && seller_paid <= quote.cap);
            if escrow.completeness.is_some() {
                assert!(seller_paid < quote.cap);
            }
        }
        EscrowState::Refunded => assert_eq!(seller_paid, 0),
        other => panic!("escrow did not close: {other:?}"),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(128))]

    /// Any call sequence at any ledger times keeps the escrow invariants and can always be closed.
    #[test]
    fn any_call_sequence_keeps_the_invariants(
        quote in quote_strategy(),
        calls in proptest::collection::vec((0u64..150, action_strategy()), 0..12),
    ) {
        // Fund the buyer for the generated cap and lock the quote
        let f = fixture();
        mint(&f, &f.buyer, quote.cap);
        let buyer_start = f.token.balance(&f.buyer);
        let id = try_lock_terms(&f, &quote_terms(&f, &quote)).unwrap();
        let accept_by = f.client.get_escrow(&id).accept_by;

        // Run every call, tracking set deadlines and terminal events
        let mut deliver_by = None;
        let mut dispute_by = None;
        let mut terminal = 0;
        for (seconds, action) in &calls {
            advance(&f, *seconds);
            for name in run(&f, id, action) {
                if name == Symbol::new(&f.env, "escrow_settled") || name == Symbol::new(&f.env, "escrow_refunded") {
                    terminal += 1;
                }
            }

            // Check no deadline moves once it has been set
            let escrow = f.client.get_escrow(&id);
            prop_assert_eq!(escrow.accept_by, accept_by);
            deliver_by = deliver_by.or(escrow.deliver_by);
            dispute_by = dispute_by.or(escrow.dispute_by);
            prop_assert_eq!(escrow.deliver_by, deliver_by);
            prop_assert_eq!(escrow.dispute_by, dispute_by);
        }

        // Jump past every deadline and close the escrow if the calls left it open
        advance(&f, quote.clocks.0 + quote.clocks.1 + quote.clocks.2);
        for action in [Action::Settle, Action::Refund] {
            for name in run(&f, id, &action) {
                if name == Symbol::new(&f.env, "escrow_settled") || name == Symbol::new(&f.env, "escrow_refunded") {
                    terminal += 1;
                }
            }
        }

        // Check exactly one terminal event and the closing balances
        prop_assert_eq!(terminal, 1);
        check_closed(&f, &quote, buyer_start);
    }

    /// Any dispute that is accepted settles strictly below the cap and at or above the floor.
    #[test]
    fn an_accepted_dispute_pays_below_the_cap(quote in quote_strategy(), completeness in 0u32..=101) {
        // Lock, accept and deliver the quote
        let f = fixture();
        mint(&f, &f.buyer, quote.cap);
        let id = try_lock_terms(&f, &quote_terms(&f, &quote)).unwrap();
        f.client.accept(&id);
        f.client.deliver(&id, &hash(&f.env, 2));

        // Dispute, skipping completeness values the schedule does not quote
        if f.client.try_dispute(&id, &completeness).is_err() {
            return Ok(());
        }

        // Settle and check the payout and the event split
        let payout = f.client.settle(&id);
        let events = escrow_events(&f);
        prop_assert!(quote.floor <= payout && payout < quote.cap);
        prop_assert_eq!(field::<i128>(&f, &events[0].1, "payout"), payout);
        prop_assert_eq!(field::<i128>(&f, &events[0].1, "remainder"), quote.cap - payout);
    }

    /// Changing any term after the seller signed fails the quote hash check.
    #[test]
    fn any_tampered_term_fails_the_quote_hash(quote in quote_strategy(), which in 0usize..9, delta in 1u64..1_000) {
        // Sign the generated quote as the seller
        let f = fixture();
        let signed = quote_terms(&f, &quote);
        let (quote_hash, signature) = sign_with(&f, &signed, &f.seller_key);

        // Change one term
        let mut tampered = signed.clone();
        match which {
            0 => tampered.seller = account_address(&f.env, &SigningKey::from_bytes(&[9; 32])),
            1 => tampered.asset = f.buyer.clone(),
            2 => tampered.cap += delta as i128,
            3 => tampered.floor -= delta as i128,
            4 => tampered.schedule.push_back(crate::PayoutStep { completeness: 101, payout: 0 }),
            5 => tampered.accept_s += delta,
            6 => tampered.deliver_s += delta,
            7 => tampered.dispute_s += delta,
            _ => tampered.job_id = hash(&f.env, 8),
        }

        // Check the lock is refused before anything else is checked
        prop_assert_eq!(
            f.client.try_lock(&f.buyer, &tampered, &quote_hash, &signature),
            Err(Ok(Error::QuoteHashMismatch))
        );
    }
}
