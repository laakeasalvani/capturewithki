# Retainer Payments and Chasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The moment a client signs, they land on a Stripe page and pay the 30% retainer — and if they don't, the system chases them and then tells Khiara.

**Architecture:** A Stripe Checkout session created server-side from the stored contract, never from anything the browser says. Only a signature-verified webhook may mark a contract paid. All chasing decisions live in a pure `chase.js` that takes `(contracts, now)` and returns actions, so every timing boundary is testable without Firebase.

**Tech Stack:** Node 24 ESM, `firebase-functions` v2, `stripe` npm package, `node --test`, Resend.

**Spec:** `docs/superpowers/specs/2026-09-04-contracts-and-payments-design.md`

**This is plan 2 of 2.** Plan 1 (`2026-09-04-contracts-and-signing-plan.md`) must be complete first — this plan modifies `signContract`, which Plan 1 creates.

**Blocked on:** Khiara creating a Stripe account. Test-mode keys work the moment the account exists, so only Task 8 needs verification to have finished.

## Global Constraints

- **Never run a bare `firebase deploy`.** Scope it: `--only functions:<name>`, `--only firestore:rules`.
- **Never print, log, commit or echo `RESEND_API_KEY`, `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`.** All three live in Firebase Functions Secrets.
- **All money is integer cents.** Stripe's `unit_amount` is cents, which matches — do not convert to dollars anywhere.
- **Region is `us-west1`** on every function.
- **No build step.** Plain ES modules in `int/` and `sign/`, Firebase SDK pinned to `10.13.0`.
- **Run `npm test` in `functions/` and read the output.**
- **Cards and wallets only.** No ACH, no Klarna, no Affirm. Wallets come free with cards in Checkout — do not add `payment_method_types` entries for them.
- Khiara is in **Oregon**. No tax line, no Stripe Tax.

## The rule this whole plan exists to protect

**The browser never states an amount, and the browser never says a contract was paid.** The Checkout session is built from the Firestore document; the paid status comes only from a signature-verified webhook. A success redirect can be closed, blocked, or forged by anyone who reads the URL.

## File structure

| File | Responsibility |
|---|---|
| `functions/lib/chase.js` | **Pure.** Which contracts are due a reminder or an escalation. No Firebase, no Stripe. |
| `functions/lib/stripe.js` | Stripe client, Checkout session creation, webhook verification. |
| `functions/lib/contract-email.js` | Extended with reminder and escalation bodies. |
| `functions/index.js` | Adds `stripeWebhook`, `chaseContracts`; modifies `signContract`. |
| `int/contracts.js` | Extended with payment status. |

---

### Task 1: Chase decisions

**Files:**
- Create: `functions/lib/chase.js`
- Test: `functions/test/chase.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `NEVER_OPENED_MS`, `SIGN_REMINDERS_MS`, `PAY_REMINDERS_MS`, `UNPAID_ESCALATION_MS`, `BACKLOG_MS`, `dueActions(contracts, now) → Action[]` where `Action = { contractId, kind, to }` and `kind` is one of `'sign-reminder' | 'pay-reminder' | 'never-opened-alert' | 'unpaid-escalation'`

- [ ] **Step 1: Write the failing test**

```js
// functions/test/chase.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import {
  NEVER_OPENED_MS, SIGN_REMINDERS_MS, PAY_REMINDERS_MS,
  UNPAID_ESCALATION_MS, BACKLOG_MS, dueActions
} from '../lib/chase.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

function contract(extra) {
  return Object.assign({
    id: 'abcdefghij0123456789',
    status: 'sent',
    sentAt: new Date(NOW - 1 * HOUR),
    openCount: 0,
    signReminderCount: 0,
    payReminderCount: 0
  }, extra || {});
}

const kinds = (list) => list.map((a) => a.kind);

test('the thresholds are what the spec says', () => {
  assert.equal(NEVER_OPENED_MS, 48 * HOUR);
  assert.deepEqual(SIGN_REMINDERS_MS, [24 * HOUR, 72 * HOUR]);
  assert.deepEqual(PAY_REMINDERS_MS, [1 * HOUR, 24 * HOUR, 72 * HOUR]);
  assert.equal(UNPAID_ESCALATION_MS, 7 * DAY);
  assert.equal(BACKLOG_MS, 30 * DAY);
});

test('a freshly sent contract is left alone', () => {
  assert.deepEqual(dueActions([contract()], NOW), []);
});

// The inquiry bug, wearing a different hat. Resend returning 200 means
// queued, not delivered, and Gmail reports a spam-filed message as delivered.
// Never-opened is the only signal that survives that failure.
test('a contract nobody has opened alerts HER, not the client', () => {
  const c = contract({ sentAt: new Date(NOW - 49 * HOUR) });
  const actions = dueActions([c], NOW);
  assert.deepEqual(kinds(actions), ['never-opened-alert']);
  assert.equal(actions[0].to, 'owner');
});

test('the never-opened alert fires exactly once', () => {
  const c = contract({
    sentAt: new Date(NOW - 49 * HOUR),
    neverOpenedAlertAt: new Date(NOW - 1 * HOUR)
  });
  assert.deepEqual(dueActions([c], NOW), []);
});

test('an opened but unsigned contract nudges the client twice and then stops', () => {
  const base = { status: 'opened', sentAt: new Date(NOW - 25 * HOUR) };
  const first = dueActions([contract(Object.assign({}, base, { signReminderCount: 0 }))], NOW);
  assert.deepEqual(kinds(first), ['sign-reminder']);
  assert.equal(first[0].to, 'client');

  // 25 hours in, the second reminder is not due until 72.
  assert.deepEqual(dueActions([contract(Object.assign({}, base, { signReminderCount: 1 }))], NOW), []);

  const late = Object.assign({}, base, { sentAt: new Date(NOW - 73 * HOUR), signReminderCount: 1 });
  assert.deepEqual(kinds(dueActions([contract(late)], NOW)), ['sign-reminder']);

  const done = Object.assign({}, late, { signReminderCount: 2 });
  assert.deepEqual(dueActions([contract(done)], NOW), []);
});

test('a signed but unpaid contract is chased three times', () => {
  const signed = (hoursAgo, count) => contract({
    status: 'signed',
    sentAt: new Date(NOW - (hoursAgo + 2) * HOUR),
    signedAt: new Date(NOW - hoursAgo * HOUR),
    payReminderCount: count
  });
  assert.deepEqual(kinds(dueActions([signed(2, 0)], NOW)), ['pay-reminder']);
  assert.deepEqual(dueActions([signed(2, 1)], NOW), []);
  assert.deepEqual(kinds(dueActions([signed(25, 1)], NOW)), ['pay-reminder']);
  assert.deepEqual(kinds(dueActions([signed(73, 2)], NOW)), ['pay-reminder']);
  assert.deepEqual(dueActions([signed(73, 3)], NOW), []);
});

// The dangerous state: she has a signed agreement and no money, and the date
// is not actually held.
test('a week-old unpaid signature escalates to her', () => {
  const c = contract({
    status: 'signed',
    sentAt: new Date(NOW - 8 * DAY),
    signedAt: new Date(NOW - 8 * DAY),
    payReminderCount: 3
  });
  const actions = dueActions([c], NOW);
  assert.deepEqual(kinds(actions), ['unpaid-escalation']);
  assert.equal(actions[0].to, 'owner');
});

test('the escalation fires once, not every hour for the rest of time', () => {
  const c = contract({
    status: 'signed',
    sentAt: new Date(NOW - 8 * DAY),
    signedAt: new Date(NOW - 8 * DAY),
    payReminderCount: 3,
    escalatedAt: new Date(NOW - 1 * HOUR)
  });
  assert.deepEqual(dueActions([c], NOW), []);
});

// escalate.js needed exactly this guard, for exactly this reason.
test('the back catalogue cannot flood the first run', () => {
  const ancient = contract({ status: 'signed', sentAt: new Date(NOW - 200 * DAY), signedAt: new Date(NOW - 200 * DAY) });
  assert.deepEqual(dueActions([ancient], NOW), []);
});

test('finished and abandoned contracts are never chased', () => {
  for (const status of ['paid', 'void', 'cancelled', 'draft']) {
    const c = contract({ status: status, sentAt: new Date(NOW - 10 * DAY), signedAt: new Date(NOW - 10 * DAY) });
    assert.deepEqual(dueActions([c], NOW), [], 'chased a ' + status + ' contract');
  }
});

test('a contract missing its timestamps is skipped, not crashed on', () => {
  assert.deepEqual(dueActions([contract({ sentAt: null })], NOW), []);
  assert.deepEqual(dueActions([contract({ status: 'signed', signedAt: undefined })], NOW), []);
  assert.deepEqual(dueActions([null, undefined, {}], NOW), []);
  assert.deepEqual(dueActions(null, NOW), []);
});

// Exact boundaries, because off-by-one here means a reminder that never fires.
test('the boundary counts as due', () => {
  const c = contract({ sentAt: new Date(NOW - NEVER_OPENED_MS) });
  assert.deepEqual(kinds(dueActions([c], NOW)), ['never-opened-alert']);
  const justUnder = contract({ sentAt: new Date(NOW - NEVER_OPENED_MS + 1) });
  assert.deepEqual(dueActions([justUnder], NOW), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/chase.test.js`
Expected: FAIL — cannot find module `../lib/chase.js`

- [ ] **Step 3: Write minimal implementation**

```js
// functions/lib/chase.js
//
// Pure. Takes contracts and a clock, returns what to send. No Firebase and no
// Stripe, so every boundary below is testable — which is the only reason
// escalate.js's timing was ever trustworthy.
//
// Reuses toMillis from gallery-expiry.js rather than reimplementing Firestore
// timestamp coercion for a third time.
import { toMillis } from './gallery-expiry.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export const NEVER_OPENED_MS = 48 * HOUR;
export const SIGN_REMINDERS_MS = [24 * HOUR, 72 * HOUR];
export const PAY_REMINDERS_MS = [1 * HOUR, 24 * HOUR, 72 * HOUR];
export const UNPAID_ESCALATION_MS = 7 * DAY;

// Nothing older than this is ever acted on. Without it, the first run after
// deploy mails every client she has ever had. escalate.js needed the same
// guard for the same reason.
export const BACKLOG_MS = 30 * DAY;

// Reminder N is due once `elapsed` passes the Nth threshold. Indexing by the
// count already sent is what stops an hourly job re-sending the same nudge:
// after reminder 0 goes out the count is 1, and threshold[1] is still hours
// away. No lastReminderAt bookkeeping required.
function reminderDue(thresholds, countSoFar, elapsed) {
  if (!Number.isInteger(countSoFar) || countSoFar < 0) return false;
  if (countSoFar >= thresholds.length) return false;
  return elapsed >= thresholds[countSoFar];
}

export function dueActions(contracts, now) {
  if (!Array.isArray(contracts)) return [];
  const out = [];

  for (const c of contracts) {
    if (!c || typeof c !== 'object') continue;
    if (['paid', 'void', 'cancelled', 'draft'].indexOf(c.status) !== -1) continue;

    const sentAt = toMillis(c.sentAt);
    if (sentAt === null) continue;
    if (now - sentAt > BACKLOG_MS) continue;

    // Sent but never opened. This alerts HER, because no signal the sending
    // side produces can tell a spam-filed message from a delivered one.
    if (!c.openCount && c.status === 'sent') {
      if (now - sentAt >= NEVER_OPENED_MS && !c.neverOpenedAlertAt) {
        out.push({ contractId: c.id, kind: 'never-opened-alert', to: 'owner' });
      }
      continue;
    }

    if (c.status === 'opened') {
      if (reminderDue(SIGN_REMINDERS_MS, c.signReminderCount || 0, now - sentAt)) {
        out.push({ contractId: c.id, kind: 'sign-reminder', to: 'client' });
      }
      continue;
    }

    if (c.status === 'signed') {
      const signedAt = toMillis(c.signedAt);
      if (signedAt === null) continue;

      // Escalation first: once it is a week old she needs to know, whether or
      // not another client nudge is also due this hour.
      if (now - signedAt >= UNPAID_ESCALATION_MS && !c.escalatedAt) {
        out.push({ contractId: c.id, kind: 'unpaid-escalation', to: 'owner' });
        continue;
      }
      if (reminderDue(PAY_REMINDERS_MS, c.payReminderCount || 0, now - signedAt)) {
        out.push({ contractId: c.id, kind: 'pay-reminder', to: 'client' });
      }
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/chase.test.js`
Expected: PASS

- [ ] **Step 5: Confirm `toMillis` is importable from where you think it is**

Run: `cd functions && grep -n "export function toMillis\|export {" lib/gallery-expiry.js`
Expected: `toMillis` is exported there. If it is not, do not reimplement it — find where it lives and import from there.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/chase.js functions/test/chase.test.js
git commit -m "Decide when to nudge a client and when to warn her"
```

---

### Task 2: The Stripe client and Checkout sessions

**Files:**
- Create: `functions/lib/stripe.js`
- Test: `functions/test/stripe.test.js`
- Modify: `functions/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `checkoutLineItems(contract) → object[]`, `getStripe() → Stripe`, `createRetainerSession(contract, contractId, successUrl, cancelUrl) → { id, url }`

- [ ] **Step 1: Install Stripe**

```bash
cd functions && npm install stripe
```

- [ ] **Step 2: Write the failing test**

Only the pure part is unit-tested. `createRetainerSession` talks to Stripe and is verified live in Task 8.

```js
// functions/test/stripe.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { checkoutLineItems } from '../lib/stripe.js';

const contract = (extra) => Object.assign({
  clientName: 'Jordan Rivera',
  retainerCents: 36000,
  totalCents: 120000,
  eventDate: '2027-06-12'
}, extra || {});

test('the client is charged the retainer, not the total', () => {
  const items = checkoutLineItems(contract());
  assert.equal(items.length, 1);
  assert.equal(items[0].price_data.unit_amount, 36000);
  assert.equal(items[0].quantity, 1);
});

// Stripe's unit_amount is already cents. Converting to dollars anywhere in
// this path would charge a hundredth of the retainer and nobody would notice
// until reconciliation.
test('the amount is passed in cents, untouched', () => {
  assert.equal(checkoutLineItems(contract({ retainerCents: 5250 }))[0].price_data.unit_amount, 5250);
});

test('the charge is in US dollars', () => {
  assert.equal(checkoutLineItems(contract())[0].price_data.currency, 'usd');
});

test('the client can tell what they are paying for on their statement', () => {
  const name = checkoutLineItems(contract())[0].price_data.product_data.name;
  assert.ok(name.toLowerCase().includes('retainer'));
});

// A zero or nonsense retainer must never reach Stripe as a live charge.
test('a nonsense retainer throws rather than creating a $0 session', () => {
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 0 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: -100 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 12.5 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: null })));
  assert.throws(() => checkoutLineItems(null));
});

test('the retainer can never exceed the total', () => {
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 200000, totalCents: 120000 })));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd functions && node --test test/stripe.test.js`
Expected: FAIL — cannot find module `../lib/stripe.js`

- [ ] **Step 4: Write minimal implementation**

```js
// functions/lib/stripe.js
import Stripe from 'stripe';

let client = null;

// Constructed lazily. Building it at module load would need the secret at
// deploy time, and every function importing this file would then require the
// STRIPE_SECRET_KEY binding whether or not it charges anything.
export function getStripe() {
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return client;
}

export function checkoutLineItems(contract) {
  const c = contract && typeof contract === 'object' ? contract : null;
  if (!c) throw new Error('checkoutLineItems: no contract');

  const cents = c.retainerCents;
  // Checked here rather than trusted, because this number becomes a real
  // charge on a real card.
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error('checkoutLineItems: retainerCents must be a positive whole number of cents');
  }
  if (Number.isInteger(c.totalCents) && cents > c.totalCents) {
    throw new Error('checkoutLineItems: retainer exceeds the total');
  }

  return [{
    quantity: 1,
    price_data: {
      currency: 'usd',
      // unit_amount is CENTS. c.retainerCents is already cents. No conversion.
      unit_amount: cents,
      product_data: {
        name: 'Booking retainer — CaptureWithKi',
        description: c.eventDate ? ('Photography on ' + c.eventDate) : 'Photography booking'
      }
    }
  }];
}

// successUrl and cancelUrl are passed in fully formed. The token belongs to
// the caller: building it into a URL inside this file would mean a library
// that handles secrets, and it would need string substitution nobody can test.
export async function createRetainerSession(contract, contractId, successUrl, cancelUrl) {
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: checkoutLineItems(contract),
    customer_email: contract.clientEmail,
    // Ties the payment back to the contract in the webhook, and again in the
    // Stripe dashboard where she will look when something is confusing.
    client_reference_id: contractId,
    metadata: { contractId: contractId },
    payment_intent_data: { metadata: { contractId: contractId } },
    // Cards only. Apple Pay, Google Pay and Link ride along with 'card' at no
    // extra cost and no extra configuration — do NOT list them separately.
    payment_method_types: ['card'],
    success_url: successUrl,
    cancel_url: cancelUrl
  }, {
    // Stripe deduplicates on this key, so a retried call cannot create a
    // second session and charge the client twice.
    idempotencyKey: 'retainer_' + contractId
  });
  return { id: session.id, url: session.url };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd functions && node --test test/stripe.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add functions/lib/stripe.js functions/test/stripe.test.js functions/package.json functions/package-lock.json
git commit -m "Build a Checkout session from the stored contract, never the browser"
```

---

### Task 3: Store the Stripe secrets

**Files:** none — this is configuration

**Interfaces:**
- Produces: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Firebase Functions Secrets

- [ ] **Step 1: Get a restricted test-mode key**

In the Stripe dashboard with **test mode on**: Developers → API keys → Create restricted key. Grant **write** on Checkout Sessions, Payment Intents, and Events; **read** on Charges. Nothing else. A full secret key would let anything holding it move her money.

- [ ] **Step 2: Store it**

```bash
cd ~/capturewithki && firebase functions:secrets:set STRIPE_SECRET_KEY --project capturewithki-69dd3
```

Paste at the prompt. **Do not echo it, put it in a file, or pass it as a command argument** — hard rule #2 covers this key exactly as it covers `RESEND_API_KEY`.

- [ ] **Step 3: Create the webhook secret placeholder**

The real value comes from Task 4 Step 4, once the endpoint URL exists. Set a placeholder now so deploys do not fail on a missing binding:

```bash
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project capturewithki-69dd3
```

- [ ] **Step 4: Verify both exist without printing them**

```bash
firebase functions:secrets:access STRIPE_SECRET_KEY --project capturewithki-69dd3 | wc -c
```

Expected: a character count over 30. **`wc -c`, not `cat`** — this confirms the secret is set without putting it in your scrollback.

---

### Task 4: `stripeWebhook` — the only thing that may mark a contract paid

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `getStripe` (Task 2), `canTransition` (Plan 1 Task 4)
- Produces: HTTPS endpoint `stripeWebhook`

- [ ] **Step 1: Add the function**

```js
import { getStripe } from './lib/stripe.js';

// onRequest, not onCall: Stripe posts a raw signed body and knows nothing
// about the callable protocol.
export const stripeWebhook = onRequest(
  { region: 'us-west1', secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) { res.status(400).send('missing signature'); return; }

    let event;
    try {
      // req.rawBody, NOT req.body. Firebase parses JSON before this handler
      // runs, and re-serialising it produces different bytes — the signature
      // then fails to verify for reasons that look like a Stripe bug.
      event = getStripe().webhooks.constructEvent(
        req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      // Never log the body of a failed verification — an unverified payload is
      // attacker-controlled.
      console.warn('[stripeWebhook] signature verification failed');
      res.status(400).send('bad signature');
      return;
    }

    if (event.type !== 'checkout.session.completed' && event.type !== 'charge.refunded') {
      // 200, deliberately. Anything else makes Stripe retry an event we will
      // never care about, forever.
      res.status(200).send('ignored');
      return;
    }

    const object = event.data.object;
    const contractId = (object.metadata && object.metadata.contractId)
      || object.client_reference_id;
    if (!isValidContractId(contractId || '')) {
      console.warn('[stripeWebhook] event carried no usable contract id:', event.id);
      res.status(200).send('no contract');
      return;
    }

    const ref = db.collection('contracts').doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) {
      console.warn('[stripeWebhook] unknown contract:', contractId);
      res.status(200).send('unknown contract');
      return;
    }
    const contract = snap.data();

    if (event.type === 'charge.refunded') {
      await ref.collection('audit').add({
        event: 'refunded', at: FieldValue.serverTimestamp(),
        stripeEventId: event.id, amountCents: object.amount_refunded
      });
      console.log('[stripeWebhook] refund recorded:', contractId);
      res.status(200).send('ok');
      return;
    }

    // Idempotent. Stripe retries on any non-2xx and can deliver the same
    // event more than once even on success.
    if (contract.status === 'paid') { res.status(200).send('already paid'); return; }

    // Defence in depth: the session was built server-side from this document,
    // so this should always match. If it ever does not, something is wrong
    // enough that recording it as paid would be worse than failing loudly.
    if (object.amount_total !== contract.retainerCents) {
      console.error('[stripeWebhook] AMOUNT MISMATCH on', contractId,
        'expected', contract.retainerCents, 'got', object.amount_total);
      res.status(200).send('amount mismatch');
      return;
    }

    // Out-of-order delivery is real: a webhook can arrive before signContract
    // has finished writing. Refusing here means the reconciliation sweep in
    // Task 6 picks it up moments later, which is correct.
    if (!canTransition(contract.status, 'paid')) {
      console.warn('[stripeWebhook] cannot pay from status:', contract.status, contractId);
      res.status(200).send('not payable yet');
      return;
    }

    await ref.update({
      status: 'paid',
      paidAt: FieldValue.serverTimestamp(),
      stripePaymentIntentId: object.payment_intent || null
    });
    await ref.collection('audit').add({
      event: 'paid', at: FieldValue.serverTimestamp(),
      stripeEventId: event.id, amountCents: object.amount_total
    });

    console.log('[stripeWebhook] paid:', contractId);
    res.status(200).send('ok');
  }
);
```

- [ ] **Step 2: Deploy it, scoped**

```bash
firebase deploy --only functions:stripeWebhook --project capturewithki-69dd3
```

- [ ] **Step 3: Register the endpoint with Stripe**

Copy the deployed URL from the output. In the Stripe dashboard (**test mode**): Developers → Webhooks → Add endpoint. Paste the URL and subscribe to exactly `checkout.session.completed` and `charge.refunded`.

- [ ] **Step 4: Store the real signing secret**

Stripe shows a signing secret starting `whsec_`. Store it, replacing the placeholder:

```bash
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project capturewithki-69dd3
firebase deploy --only functions:stripeWebhook --project capturewithki-69dd3
```

The redeploy is required — a running function keeps the secret version it started with.

- [ ] **Step 5: Verify rejection before verifying acceptance**

```bash
curl -X POST -H "stripe-signature: t=1,v1=deadbeef" -d '{"forged":true}' <the deployed URL>
```

Expected: **HTTP 400, `bad signature`.** If this returns 200, anyone on the internet can mark contracts paid. Stop and fix it before going further.

Then use Stripe's "Send test webhook" for `checkout.session.completed` and confirm a 200 in the dashboard's delivery log.

- [ ] **Step 6: Commit**

```bash
git add functions/index.js
git commit -m "Let only a signed Stripe webhook mark a contract paid"
```

---

### Task 5: Send the client to Checkout after signing

**Files:**
- Modify: `functions/index.js` (`signContract`, from Plan 1 Task 11)
- Modify: `sign/sign.js`

**Interfaces:**
- Consumes: `createRetainerSession` (Task 2)
- Produces: `signContract` now returns `{ ok, signedAt, checkoutUrl }` where `checkoutUrl` may be `null`

- [ ] **Step 1: Add session creation after the signature is recorded**

Insert into `signContract`, **after** the signature write succeeds and **before** the confirmation email:

```js
// AFTER the signature is safely recorded, never before. If Stripe is down,
// the client has still signed and that fact must survive — a failure here
// costs a redirect, not an agreement.
const back = SITE_ORIGIN + '/sign/?t=' + token;
let checkoutUrl = null;
try {
  const session = await createRetainerSession(
    contract, ref.id, back + '&paid=1', back
  );
  checkoutUrl = session.url;
  await ref.update({ stripeSessionId: session.id });
} catch (err) {
  console.warn('[signContract] could not create checkout session:', describeError(err));
  // Deliberately swallowed. The pay-reminder ladder in Task 6 will chase this
  // client, and Task 7's dashboard shows her the contract as signed-unpaid.
}
```

Then change the return to `return { ok: true, signedAt: Date.now(), checkoutUrl: checkoutUrl };`

Add the import alongside the others: `import { createRetainerSession } from './lib/stripe.js';`

- [ ] **Step 2: Redirect from the signing page**

```js
// sign/sign.js, after a successful signContract call
if (result.data.checkoutUrl) {
  window.location.href = result.data.checkoutUrl;
} else {
  // Stripe was unreachable. Say something true rather than something
  // reassuring: the agreement IS signed, and the money is not paid.
  showMessage(
    'Your agreement is signed. We could not open the payment page just now — ' +
    'Khiara will email you a link to pay the retainer shortly.'
  );
}
```

- [ ] **Step 3: Do NOT treat the success redirect as payment**

When the page loads with `?paid=1`, it may say "thank you, we're confirming your payment" — but it must **read the real status from `openContract`** before claiming the date is held. The redirect is a hint; the webhook is the fact.

- [ ] **Step 4: Add the secret binding to `signContract`**

Its `onCall` options need `secrets: ['RESEND_API_KEY', 'STRIPE_SECRET_KEY']`.

- [ ] **Step 5: Deploy and commit**

```bash
cd functions && npm test
firebase deploy --only functions:signContract --project capturewithki-69dd3
git add functions/index.js functions/lib/stripe.js functions/test/stripe.test.js sign/sign.js
git commit -m "Send a client straight to Checkout once they have signed"
```

---

### Task 6: `chaseContracts` — reminders, escalation, reconciliation

**Files:**
- Modify: `functions/index.js`
- Modify: `functions/lib/contract-email.js`

**Interfaces:**
- Consumes: `dueActions` (Task 1), `getStripe` (Task 2)
- Produces: scheduled function `chaseContracts`; `signReminderEmail`, `payReminderEmail`, `neverOpenedAlertEmail`, `unpaidEscalationEmail` in `contract-email.js`

- [ ] **Step 1: Add the four email bodies**

Each returns `{ subject, text, html }` and is built exactly like `readyToSignEmail` in `contract-email.js`: a plain-text body that is never dropped, a table-based HTML body with inline styles and the `C`/`SERIF`/`SANS` tokens, `escapeHtml` on every interpolated value, and `oneLine` on the subject.

| Function | To | Subject | Must contain |
|---|---|---|---|
| `signReminderEmail(c)` | client | `A quick reminder about your CaptureWithKi agreement` | Their name, the event date, the sign link, and one line saying the date is not held until it is signed and the retainer paid. Warm, not chasing. |
| `payReminderEmail(c)` | client | `Your CaptureWithKi retainer is still outstanding` | Their name, the retainer amount via `formatCents`, a fresh payment link, and the date. States plainly that the date is not yet held. |
| `neverOpenedAlertEmail(c)` | **owner** | `<name> has not opened their contract` | Client name, email, phone, when it was sent, and a direct `/int/` link. Must say in one line: *the email may have been filed as spam — consider texting them.* That sentence is the entire point of the alert. |
| `unpaidEscalationEmail(c)` | **owner** | `ACTION NEEDED: <name> signed but has not paid` | Client name and contact details, when they signed, the retainer amount, how many reminders have gone out, and a direct `/int/` link. Must state that the date is **not held**. |

The two owner emails carry no marketing framing and no soft language. She is being told something is wrong, and the subject line has to survive being skimmed on a phone.

```js
export function unpaidEscalationEmail(c) {
  const name = oneLine(c.clientName);
  const amount = formatCents(c.retainerCents);
  const subject = 'ACTION NEEDED: ' + name + ' signed but has not paid';
  const link = 'https://capturewithki.com/int/#contracts';

  const text = [
    name + ' signed their agreement a week ago and the retainer is still unpaid.',
    '',
    'Retainer: ' + amount,
    'Email: ' + oneLine(c.clientEmail),
    'Phone: ' + oneLine(c.clientPhone || 'not given'),
    'Reminders sent: ' + (c.payReminderCount || 0),
    '',
    'THE DATE IS NOT HELD.',
    '',
    link
  ].join('\n');

  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;"><tr><td align="center">' +
      '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
        'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
        '<tr><td style="font-family:' + SERIF + ';font-size:20px;color:' + C.ink + ';">' +
          escapeHtml(name) + ' signed but has not paid' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
          'Signed a week ago. Retainer of ' + escapeHtml(amount) + ' is still outstanding after ' +
          escapeHtml(String(c.payReminderCount || 0)) + ' reminders.' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:15px;font-weight:bold;color:' + C.ink + ';padding-top:16px;">' +
          'The date is not held.' +
        '</td></tr>' +
        '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:16px;">' +
          escapeHtml(oneLine(c.clientEmail)) + '<br>' +
          escapeHtml(oneLine(c.clientPhone || 'no phone given')) +
        '</td></tr>' +
        '<tr><td style="padding-top:24px;">' +
          '<a href="' + link + '" style="font-family:' + SANS + ';font-size:15px;background:' +
            C.khaki + ';color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
            'Open the dashboard</a>' +
        '</td></tr>' +
      '</table></td></tr></table>';

  return { subject: subject, text: text, html: html };
}
```

- [ ] **Step 2: Add the scheduled function**

```js
import { dueActions } from './lib/chase.js';

export const chaseContracts = onSchedule(
  {
    region: 'us-west1', schedule: 'every 1 hours',
    secrets: ['RESEND_API_KEY', 'STRIPE_SECRET_KEY']
  },
  async () => {
    const now = Date.now();

    // Only live states. 'paid', 'void' and 'cancelled' are never chased, and
    // fetching them would grow this query without bound as the years pass.
    const snap = await db.collection('contracts')
      .where('status', 'in', ['sent', 'opened', 'signed'])
      .get();

    const contracts = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));

    // Reconciliation first. A missed webhook must be repaired BEFORE the
    // chase logic runs, or she emails a client demanding money they paid.
    for (const c of contracts) {
      if (c.status !== 'signed' || !c.stripeSessionId) continue;
      const signedAt = c.signedAt && c.signedAt.toMillis ? c.signedAt.toMillis() : null;
      if (signedAt === null || now - signedAt < 15 * 60000) continue;
      try {
        const session = await getStripe().checkout.sessions.retrieve(c.stripeSessionId);
        if (session.payment_status === 'paid') {
          console.warn('[chaseContracts] webhook was missed, repairing:', c.id);
          await db.collection('contracts').doc(c.id).update({
            status: 'paid', paidAt: FieldValue.serverTimestamp(),
            stripePaymentIntentId: session.payment_intent || null
          });
          c.status = 'paid'; // so dueActions below skips it this run too
        }
      } catch (err) {
        console.warn('[chaseContracts] could not reconcile', c.id, describeError(err));
      }
    }

    const actions = dueActions(contracts, now);
    console.log('[chaseContracts] scanned', contracts.length, 'due', actions.length);

    for (const action of actions) {
      const c = contracts.find((x) => x.id === action.contractId);
      if (!c) continue;
      const ref = db.collection('contracts').doc(c.id);
      try {
        if (action.kind === 'sign-reminder') {
          await sendMail(c.clientEmail, signReminderEmail(c));
          await ref.update({ signReminderCount: (c.signReminderCount || 0) + 1,
                             lastReminderAt: FieldValue.serverTimestamp() });
        } else if (action.kind === 'pay-reminder') {
          await sendMail(c.clientEmail, payReminderEmail(c));
          await ref.update({ payReminderCount: (c.payReminderCount || 0) + 1,
                             lastReminderAt: FieldValue.serverTimestamp() });
        } else if (action.kind === 'never-opened-alert') {
          await sendMail(OWNER_EMAIL, neverOpenedAlertEmail(c));
          await ref.update({ neverOpenedAlertAt: FieldValue.serverTimestamp() });
        } else if (action.kind === 'unpaid-escalation') {
          await sendMail(OWNER_EMAIL, unpaidEscalationEmail(c));
          await ref.update({ escalatedAt: FieldValue.serverTimestamp() });
        }
        await ref.collection('audit').add({
          event: action.kind, at: FieldValue.serverTimestamp()
        });
      } catch (err) {
        // One failed send must not abandon the rest of the queue.
        console.warn('[chaseContracts] action failed', action.kind, c.id, describeError(err));
      }
    }
  }
);
```

Use the existing owner-address constant from `escalateUnreadInquiries` rather than declaring a new one:

Run: `grep -n "capturewithki@gmail.com\|OWNER_EMAIL" functions/index.js`

- [ ] **Step 3: Prove the counter actually stops the ladder**

Deploy, then create a test contract with `status: 'opened'`, `sentAt` 25 hours ago, `signReminderCount: 0`. Wait for two hourly runs.

Expected: **exactly one** reminder email, and `signReminderCount` is `1`. If two arrive, the count is not being written and every client will be nagged hourly.

- [ ] **Step 4: Deploy and commit**

```bash
cd functions && npm test
firebase deploy --only functions:chaseContracts --project capturewithki-69dd3
git add functions/index.js functions/lib/contract-email.js
git commit -m "Chase an unpaid retainer, then tell her when chasing has not worked"
```

---

### Task 7: Payment status in the dashboard

**Files:**
- Modify: `int/contracts.js`

**Interfaces:**
- Consumes: the `status`, `paidAt`, `escalatedAt`, `neverOpenedAlertAt` fields
- Produces: visible payment state per contract

- [ ] **Step 1: Show the states honestly**

| State | How it must read |
|---|---|
| `sent`, never opened, over 48h | **"Not opened yet — the email may not have arrived."** Loud. This is the one that means she should text them. |
| `opened`, unsigned | "Read, not signed yet" |
| `signed`, unpaid | **"Signed — retainer NOT paid. The date is not held."** The most dangerous state in the system; it must not look like success. |
| `paid` | "Booked — retainer paid" with the date and amount |
| `cancelled` | "Cancelled", with the signed record still reachable |

- [ ] **Step 2: Never show a signed-unpaid contract as booked**

A green tick next to a signed-but-unpaid contract is how she double-books a date. Signed and paid are different colours, different words, and sorted apart.

- [ ] **Step 3: Add a copy-the-payment-link action**

For signed-unpaid contracts, let her copy the Checkout URL so she can text it. Sessions expire after 24 hours — if `stripeSessionId` is older than that, the button must create a fresh session rather than hand her a dead link.

- [ ] **Step 4: Verify against real data**

Walk one contract through send → open → sign → pay in Stripe test mode, and confirm the dashboard reads correctly at each step.

- [ ] **Step 5: Commit**

```bash
git add int/contracts.js
git commit -m "Never let a signed but unpaid contract look like a booking"
```

---

### Task 8: Go live

**Files:** none — this is verification

**Blocked on:** Khiara's Stripe account being fully verified with payouts enabled.

- [ ] **Step 1: Confirm the account is genuinely ready**

In her Stripe dashboard: payouts enabled, bank account attached, and the statement descriptor reading `CAPTUREWITHKI`. An unrecognisable descriptor gets charges reported as fraud.

- [ ] **Step 2: Swap in live keys**

Create a **live-mode** restricted key with the same narrow permissions as Task 3, register a **live-mode** webhook endpoint at the same URL, and set both secrets:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY --project capturewithki-69dd3
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project capturewithki-69dd3
firebase deploy --only functions:signContract,functions:stripeWebhook,functions:chaseContracts --project capturewithki-69dd3
```

The test-mode webhook secret will not verify live events. Both must change together.

- [ ] **Step 3: Verify forgery is still rejected in live mode**

Repeat the `curl` from Task 4 Step 5 against the live endpoint. Expected: **400**.

- [ ] **Step 4: One real end-to-end charge**

Replace the placeholder template with the real contract (`isDraft: false`), create a contract to Khiara's own email for **$1**, sign it, and pay with a real card. Confirm: the dashboard reads `paid`, the money appears in Stripe, and the audit subcollection holds `created`, `sent`, `opened`, `signed`, `paid`.

- [ ] **Step 5: Refund it**

Refund in the Stripe dashboard and confirm a `refunded` audit row appears.

- [ ] **Step 6: Update `CLAUDE.md`**

Move "Payments / invoicing / deposits / contracts" out of **Known outstanding work** and into the **Shipped** table. Record what is deliberately not built: installments, the balance invoice, blank-start contracts, two signers, and refunds from `/int/`.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "Take a real retainer"
```

---

## Done when

- Signing redirects straight to Stripe Checkout, and paying marks the contract `paid`
- A forged webhook returns 400
- A missed webhook is repaired within ~15 minutes by reconciliation
- An unopened contract alerts Khiara at 48 hours
- A signed-unpaid contract is chased three times and then escalated at 7 days
- No reminder is ever sent twice for the same rung
- The dashboard never shows signed-unpaid as booked
- `npm test` passes in `functions/`, output read rather than summarised

## Explicitly not built

- **Installments.** Her site promises them; the schema leaves room. When built, Stripe Billing's scheduled invoices and retry logic do the dunning — do not hand-roll it.
- **The balance invoice.** Manual until installments land.
- **Refunds from `/int/`.** Stripe dashboard only.
- **ACH, Klarna, Affirm.** Decided against.
