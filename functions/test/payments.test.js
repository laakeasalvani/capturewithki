import { test } from 'node:test';
import assert from 'node:assert';
import { fakePayAllowed, FAKE_ALLOWLIST, providerName, paymentsEnabled, getProvider, markContractPaid } from '../lib/payments.js';

test('the allowlist is small and explicit', () => {
  assert.ok(Array.isArray(FAKE_ALLOWLIST));
  assert.ok(FAKE_ALLOWLIST.length > 0);
  assert.ok(FAKE_ALLOWLIST.length <= 4);
  for (const a of FAKE_ALLOWLIST) assert.match(a, /^[^\s@]+@[^\s@]+$/);
});

// Pins the exact two addresses the brief requires, so a future edit that
// swaps in a different (even if still short) list is caught.
test('the allowlist is exactly Laakea and Khiara, nobody else', () => {
  const lower = FAKE_ALLOWLIST.map((a) => a.toLowerCase());
  assert.deepEqual(lower.slice().sort(), ['capturewithki@gmail.com', 'laakeasalvani@gmail.com']);
});

test('only an allowlisted address may fake-pay', () => {
  assert.equal(fakePayAllowed({ clientEmail: FAKE_ALLOWLIST[0] }), true);
  assert.equal(fakePayAllowed({ clientEmail: 'realbride@example.com' }), false);
});

// If the allowlist were case- or whitespace-sensitive, a real address that
// merely differed in case could slip through. It must not.
test('the allowlist match is case and whitespace insensitive', () => {
  assert.equal(fakePayAllowed({ clientEmail: '  ' + FAKE_ALLOWLIST[0].toUpperCase() + ' ' }), true);
});

test('a missing or malformed email can never fake-pay', () => {
  assert.equal(fakePayAllowed({ clientEmail: '' }), false);
  assert.equal(fakePayAllowed({ clientEmail: null }), false);
  assert.equal(fakePayAllowed({}), false);
  assert.equal(fakePayAllowed(null), false);
});

// A near-miss must not pass. Substring matching here would be a disaster.
test('an address merely containing an allowlisted one is refused', () => {
  assert.equal(fakePayAllowed({ clientEmail: FAKE_ALLOWLIST[0] + '.evil.com' }), false);
  assert.equal(fakePayAllowed({ clientEmail: 'x' + FAKE_ALLOWLIST[0] }), false);
});

// Prefix/suffix variants that a naive .includes() or .startsWith()/.endsWith()
// implementation would also wrongly accept.
test('an allowlisted address embedded in a longer local part or domain is refused', () => {
  assert.equal(fakePayAllowed({ clientEmail: 'evil+' + FAKE_ALLOWLIST[0] }), false);
  assert.equal(fakePayAllowed({ clientEmail: FAKE_ALLOWLIST[1].replace('@', '@evil.') }), false);
});

test('the provider is switched by env alone, among the recognised values', () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  assert.equal(providerName(), 'fake');
  process.env.PAYMENT_PROVIDER = 'stripe';
  assert.equal(providerName(), 'stripe');
  process.env.PAYMENT_PROVIDER = 'nonsense';
  // An unrecognised value must NOT silently fall through to off or fake, or
  // a typo in configuration becomes a payment system that takes no money.
  assert.throws(() => providerName());
  delete process.env.PAYMENT_PROVIDER;
});

// A stubbed provider that always returned 'fake' regardless of env would
// pass the previous test's first two assertions by coincidence. This checks
// the throw specifically carries the bad value, which a hardcoded throw
// could not fake.
test('the throw names the unrecognised value', () => {
  process.env.PAYMENT_PROVIDER = 'paypal';
  assert.throws(() => providerName(), /paypal/);
  delete process.env.PAYMENT_PROVIDER;
});

test('getProvider returns exactly two methods, matching the env selection', () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  const fake = getProvider();
  assert.deepEqual(Object.keys(fake).sort(), ['createRetainerSession', 'retrieveSession']);
  assert.equal(typeof fake.createRetainerSession, 'function');
  assert.equal(typeof fake.retrieveSession, 'function');

  process.env.PAYMENT_PROVIDER = 'stripe';
  const stripe = getProvider();
  assert.deepEqual(Object.keys(stripe).sort(), ['createRetainerSession', 'retrieveSession']);
  assert.equal(typeof stripe.createRetainerSession, 'function');
  assert.equal(typeof stripe.retrieveSession, 'function');
  // The two providers must be genuinely different implementations, not the
  // same function wearing two names.
  assert.notEqual(fake.createRetainerSession, stripe.createRetainerSession);
  assert.notEqual(fake.retrieveSession, stripe.retrieveSession);
  delete process.env.PAYMENT_PROVIDER;
});

// ---------------------------------------------------------------------------
// markContractPaid — the shared decision, tested without Firestore.
//
// A fake db that only supports the exact call shape markContractPaid uses:
// db.collection('contracts').doc(id).get(). Anything else throws, so a
// change to the call shape (wrong collection name, an extra write) fails
// the test instead of slipping through.
// ---------------------------------------------------------------------------
function fakeDb(contractsById) {
  const seen = { collection: null, doc: null, updated: false, set: false };
  return {
    seen: () => seen,
    collection(name) {
      seen.collection = name;
      if (name !== 'contracts') throw new Error('unexpected collection: ' + name);
      return {
        doc(id) {
          seen.doc = id;
          const ref = {
            id: id,
            // markContractPaid must never write. If it ever calls update or
            // set on the ref it read, that is the bug this guards against.
            update() { seen.updated = true; throw new Error('markContractPaid must not write'); },
            set() { seen.set = true; throw new Error('markContractPaid must not write'); },
            async get() {
              const data = contractsById[id];
              return { exists: data !== undefined, data: () => data };
            }
          };
          return ref;
        }
      };
    }
  };
}

test('an unknown contract id is refused', async () => {
  const db = fakeDb({});
  const result = await markContractPaid(db, 'missing', { amountCents: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-contract');
});

test('a contract already paid is refused — idempotent against retries and double-taps', async () => {
  const db = fakeDb({ c1: { status: 'paid', retainerCents: 1000 } });
  const result = await markContractPaid(db, 'c1', { amountCents: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-paid');
});

test('a payment amount that does not match the retainer is refused', () => {
  const db = fakeDb({ c1: { status: 'signed', retainerCents: 36000 } });
  return markContractPaid(db, 'c1', { amountCents: 100 }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'amount-mismatch');
  });
});

test('a status that cannot transition to paid is refused, even with the right amount', async () => {
  // 'draft' has no path to 'paid' in canTransition — this is the out-of-order
  // guard: a webhook or fake-pay callback arriving before signing finished.
  const db = fakeDb({ c1: { status: 'draft', retainerCents: 36000 } });
  const result = await markContractPaid(db, 'c1', { amountCents: 36000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-payable-from-draft');
});

test('a signed contract with the exact retainer amount is accepted, and only decided — not written', async () => {
  const db = fakeDb({ c1: { status: 'signed', retainerCents: 36000, clientEmail: 'bride@example.com' } });
  const result = await markContractPaid(db, 'c1', { amountCents: 36000 });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ok');
  assert.equal(result.contract.clientEmail, 'bride@example.com');
  assert.equal(result.ref.id, 'c1');
  // The decision function itself never called update/set on the ref.
  assert.equal(db.seen().updated, false);
  assert.equal(db.seen().set, false);
});

test('cancelled cannot be paid retroactively', async () => {
  const db = fakeDb({ c1: { status: 'cancelled', retainerCents: 36000 } });
  const result = await markContractPaid(db, 'c1', { amountCents: 36000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-payable-from-cancelled');
});

test('the fake provider refuses to create a session for a real client', async () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  const fake = getProvider();
  await assert.rejects(
    () => fake.createRetainerSession(
      { clientEmail: 'bride@example.com', retainerCents: 36000 },
      'abcdefghij0123456789', 'https://example.com/ok', 'https://example.com/back'
    ),
    /fake provider: this contract is not allowlisted/
  );
  delete process.env.PAYMENT_PROVIDER;
});

test('payments are OFF by default, not fake', () => {
  delete process.env.PAYMENT_PROVIDER;
  assert.equal(providerName(), 'off');
  assert.equal(paymentsEnabled(), false);
});

test('the other two providers still resolve and count as enabled', () => {
  process.env.PAYMENT_PROVIDER = 'fake';
  assert.equal(providerName(), 'fake');
  assert.equal(paymentsEnabled(), true);
  process.env.PAYMENT_PROVIDER = 'stripe';
  assert.equal(providerName(), 'stripe');
  assert.equal(paymentsEnabled(), true);
  delete process.env.PAYMENT_PROVIDER;
});

test('an unrecognised value still throws rather than silently falling back', () => {
  process.env.PAYMENT_PROVIDER = 'nonsense';
  assert.throws(() => providerName());
  assert.throws(() => paymentsEnabled());
  delete process.env.PAYMENT_PROVIDER;
});

test('asking for a provider while payments are off is refused loudly', () => {
  delete process.env.PAYMENT_PROVIDER;
  assert.throws(() => getProvider(), /off/i);
});
