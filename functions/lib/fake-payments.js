// The fake payment provider. It does not simulate Stripe's API — it simulates
// the ONE thing that matters about a checkout session: that it can be created,
// and later read back to learn whether it was paid.
//
// getFirestore() is called lazily inside each function, never at module load.
// index.js calls initializeApp() as part of its own top-level code, which
// runs after this module's imports are resolved but before any request is
// handled — the same reasoning lib/stripe.js uses for building its client
// lazily.
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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

// Matches lib/stripe.js's createRetainerSession signature exactly. contract
// and contractId decide the amount and the mapping back to a contract;
// successUrl/cancelUrl are accepted for parity with the real provider but
// unused — there is no external redirect to send them to.
export async function createRetainerSession(contract, contractId, successUrl, cancelUrl) {
  // Checked at session CREATION, not only at completion. Without this, a real
  // client whose contract was signed while PAYMENT_PROVIDER was still 'fake'
  // would be redirected to a page reading "TEST PAYMENT — NO MONEY MOVES".
  // They could never complete it, but they should never SEE it either.
  // Failing here instead means signContract's existing catch tells them their
  // agreement is signed and a payment link will follow — which is true, calm,
  // and leaves the contract in the chase ladder for Khiara.
  if (!fakePayAllowed(contract)) {
    throw new Error('fake provider: this contract is not allowlisted for test payments');
  }

  const db = getFirestore();
  const ref = db.collection('fakeSessions').doc();
  // Recorded once, at creation, from the contract as it exists right now.
  // fakeCheckoutComplete compares the eventual payment against THIS number,
  // not against whatever the contract says later — the same reason a real
  // charge is compared against the amount Stripe actually reports, not
  // re-derived from a document that could have changed in between.
  await ref.set({
    contractId: contractId,
    amountCents: contract.retainerCents,
    status: 'unpaid',
    paymentIntent: 'fake_pi_' + ref.id,
    createdAt: FieldValue.serverTimestamp()
  });
  // contractId and amount ride along in the URL purely so the fake-pay page
  // can show them before the button is pressed. Neither is a secret, and
  // neither one grants anything — the sessionId is what fakeCheckoutComplete
  // actually looks up, and fakePayAllowed re-checks the real contract on the
  // server regardless of what this URL says.
  return {
    id: ref.id,
    url: '/sign/fake-pay/?s=' + ref.id + '&c=' + encodeURIComponent(contractId) +
      '&a=' + encodeURIComponent(String(contract.retainerCents))
  };
}

// The one step a real gateway performs that this stand-in cannot: charging a
// card. Clicking "Pretend to pay" on sign/fake-pay/ is what stands in for
// that moment, via the fakeCheckoutComplete callable in index.js.
export async function completeFakeSession(sessionId) {
  const db = getFirestore();
  await db.collection('fakeSessions').doc(sessionId).update({
    status: 'paid',
    paidAt: FieldValue.serverTimestamp()
  });
}

// Matches lib/stripe.js's (future) retrieveSession shape exactly: same two
// fields, same 'paid'|'unpaid' vocabulary. Reads the document createRetainerSession
// wrote — this is the read-back the brief calls out as exercising Task 6's
// reconciliation path today rather than the day real money is involved.
export async function retrieveSession(sessionId) {
  const db = getFirestore();
  const snap = await db.collection('fakeSessions').doc(sessionId).get();
  if (!snap.exists) return { payment_status: 'unpaid', payment_intent: null };
  const data = snap.data();
  return {
    payment_status: data.status === 'paid' ? 'paid' : 'unpaid',
    payment_intent: typeof data.paymentIntent === 'string' ? data.paymentIntent : null
  };
}
