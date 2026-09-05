// One interface, two implementations. Which one runs is decided by
// PAYMENT_PROVIDER alone, so moving to real money is configuration.
//
// The important part is what is NOT varied: markContractPaid is shared. The
// real webhook and the fake checkout both call it, so the logic that decides
// a contract is paid is written once and tested once.
import { canTransition } from './contracts.js';
import { getStripe } from './stripe.js';
import { createRetainerSession as stripeCreateRetainerSession } from './stripe.js';
import {
  createRetainerSession as fakeCreateRetainerSession,
  retrieveSession as fakeRetrieveSession
} from './fake-payments.js';

// The ONLY addresses that may complete a fake payment. There is no staging
// project — the fake payer lives in production — so this list, not an
// environment check, is what stands between a real client and a button that
// pretends to take their money.
export const FAKE_ALLOWLIST = [
  'laakeasalvani@gmail.com',
  'capturewithki@gmail.com'
];

export function fakePayAllowed(contract) {
  const email = contract && typeof contract.clientEmail === 'string'
    ? contract.clientEmail.trim().toLowerCase()
    : '';
  if (!email) return false;
  // Exact match on the whole address. indexOf/includes here would let
  // "laakeasalvani@gmail.com.attacker.example" through.
  return FAKE_ALLOWLIST.some((a) => a.toLowerCase() === email);
}

export function providerName() {
  const name = process.env.PAYMENT_PROVIDER || 'fake';
  if (name !== 'fake' && name !== 'stripe') {
    // Loud, not silent. A typo that quietly selected the fake provider would
    // be a live payment system that never takes any money.
    throw new Error('Unknown PAYMENT_PROVIDER: ' + name);
  }
  return name;
}

// Wraps checkout.sessions.retrieve() into the same minimal shape the fake
// provider returns, so a caller (fakeCheckoutComplete today, the real
// webhook and Task 6's reconciliation later) never needs to know which
// provider it is talking to.
async function stripeRetrieveSession(sessionId) {
  const session = await getStripe().checkout.sessions.retrieve(sessionId);
  const intent = session.payment_intent;
  return {
    // Stripe also reports 'no_payment_required' and other non-'paid' values;
    // everything except an explicit 'paid' is treated as unpaid rather than
    // trusted.
    payment_status: session.payment_status === 'paid' ? 'paid' : 'unpaid',
    payment_intent: typeof intent === 'string'
      ? intent
      : (intent && typeof intent.id === 'string' ? intent.id : null)
  };
}

// Selects the implementation. Both branches return an object with EXACTLY
// these two methods — that is what makes the swap a swap rather than two
// unrelated code paths that happen to share a name.
export function getProvider() {
  if (providerName() === 'stripe') {
    return {
      createRetainerSession: stripeCreateRetainerSession,
      retrieveSession: stripeRetrieveSession
    };
  }
  return {
    createRetainerSession: fakeCreateRetainerSession,
    retrieveSession: fakeRetrieveSession
  };
}

// Shared by both providers. Everything that decides whether a contract
// becomes paid lives here and nowhere else.
export async function markContractPaid(db, contractId, payment) {
  const ref = db.collection('contracts').doc(contractId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'unknown-contract' };
  const contract = snap.data();

  // Idempotent. Stripe retries, and a client can double-tap a fake pay button.
  if (contract.status === 'paid') return { ok: false, reason: 'already-paid' };

  // Defence in depth. The session was built server-side from this document,
  // so a mismatch means something is wrong enough that recording a payment
  // would be worse than refusing one.
  if (payment.amountCents !== contract.retainerCents) {
    return { ok: false, reason: 'amount-mismatch' };
  }

  // Out-of-order arrival is real: a webhook can land before signContract has
  // finished writing. Refusing here is correct — reconciliation picks it up.
  if (!canTransition(contract.status, 'paid')) {
    return { ok: false, reason: 'not-payable-from-' + contract.status };
  }

  return { ok: true, reason: 'ok', contract: contract, ref: ref };
}
