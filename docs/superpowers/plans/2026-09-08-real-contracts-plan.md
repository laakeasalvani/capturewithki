# Real Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khiara picks a package, presses send, and the client receives the right contract — her real one — and signs it electronically. No payment collection.

**Architecture:** Three contract templates (Wedding, Elopement, Portrait) stored in Firestore, with a package catalogue supplying what varies between the nine packages. The payment system already built stays in the repo, dormant behind a provider seam whose default becomes `off`.

**Tech Stack:** Node 24 ESM, `firebase-functions` v2, `firebase-admin`, `node --test`, Resend, headless Chromium for the signed PDF.

**Spec:** `docs/superpowers/specs/2026-09-08-real-contracts-design.md`

**Builds on:** `2026-09-04-contracts-and-signing-plan.md` and `2026-09-04-retainer-payments-plan.md`, both complete. 227 tests pass at the start of this plan.

## Global Constraints

- **THE REPOSITORY IS PUBLIC.** Verified: an unauthenticated `curl` reads any file in it. **NEVER commit her contract PDFs, their extracted text, or any transcribed contract HTML.** Those are her legal documents. Contract text lives in Firestore only. The scratchpad is the working area and is outside the repo.
- **Never run `firebase deploy`**, never write to Firestore, never open a console. `capturewithki-69dd3` is production; there is no staging project.
- **Never print, log, commit or echo** `RESEND_API_KEY`, `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET`.
- **No build step.** Plain ES modules in `sign/` and `int/`. npm exists only inside `functions/`. Firebase SDK pinned to exactly `10.13.0` in every browser import.
- **Do not modify the root `index.html`.** It carries exactly 131 `data-cms-id` markers; verify with `grep -o data-cms-id index.html | wc -l`.
- **All money is integer cents.** Never floats.
- **`functions/lib/contracts.js` must never import `node:crypto`** or any node-only module — the browser imports it.
- Region is `us-west1` on every function.
- Client-supplied strings reach the DOM via `textContent`, never `innerHTML`.
- Full suite must pass. It is **227** at the start.

## Source material (outside the repo, deliberately)

Extracted contract text, one file per document:

```
<SCRATCHPAD>/contracts/The_Grand_Package_-_Contract.txt
<SCRATCHPAD>/contracts/The_Classic_Package_-_Contract.txt
<SCRATCHPAD>/contracts/The_Intimate_Package_-_Contract.txt
<SCRATCHPAD>/contracts/Elopement_Photography_Contract.txt
<SCRATCHPAD>/contracts/Portrait_Photography_Contract.txt
```

where `<SCRATCHPAD>` is `/private/tmp/claude-501/-Users-laakeasalvani-Desktop-Claude-Website-Files/bf83b1aa-c2af-47db-9401-a05814a62d5e/scratchpad`.

Transcribed templates are written to `<SCRATCHPAD>/templates/` and seeded into Firestore by a human. They are never committed.

## File structure

| File | Responsibility |
|---|---|
| `functions/lib/contracts.js` | **Modify.** Retainer computed from the package line, not the total. |
| `functions/lib/payments.js` | **Modify.** `'off'` becomes a valid provider and the default. |
| `functions/lib/chase.js` | **Modify.** Drop the payment rungs; add `unsigned-escalation`. |
| `functions/lib/packages.js` | **Create.** Pure validation of a catalogue entry and its specs. |
| `functions/index.js` | **Modify.** Photographer stamp in `sendContract`; new `markRetainerReceived`; PDF hook. |
| `sign/sign.js` | **Modify.** No payment language when the provider is off. |
| `int/contracts.js` | **Modify.** Retainer-received control; package picker drives the template. |
| `int/templates.js` | **Create.** Template editor with preview and versioning. |
| `firestore.rules` | **Modify.** Rules for `contractTemplates` versions. |

---

### Task 1: The PDF feasibility spike — write it, a human runs it

**Files:**
- Create: `functions/spike/pdf-spike.md`

**Interfaces:**
- Consumes: nothing
- Produces: a documented yes/no that Task 13 depends on

**Why this is first and why it is not code:** the spec makes the signed PDF in scope and chose headless Chromium. Whether Chromium launches inside the deployed Firebase gen2 Node 24 container **cannot be answered locally** — a local run proves the library imports on a Mac, not that the container can start a browser. Answering it requires a deploy, and deploys here are a human's job. So this task writes the spike and the exact procedure; it does not run it. Nothing in Task 13 is built until the answer exists.

- [ ] **Step 1: Write the spike procedure**

Create `functions/spike/pdf-spike.md` containing exactly this, for a human to follow:

````markdown
# PDF feasibility spike — run this before building the PDF pipeline

Answers one question: does headless Chromium launch inside our deployed Cloud
Function runtime? It cannot be answered locally.

## 1. Add the dependency and the function

```bash
cd functions && npm install puppeteer
```

Add to `functions/index.js`, temporarily:

```js
export const pdfSpike = onCall(
  { region: 'us-west1', memory: '1GiB', timeoutSeconds: 120 },
  async () => {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setContent('<h1>hello</h1>');
    const pdf = await page.pdf({ format: 'Letter' });
    await browser.close();
    console.log('[pdfSpike] bytes:', pdf.length);
    return { bytes: pdf.length };
  }
);
```

## 2. Deploy only this function

```bash
firebase deploy --only functions:pdfSpike --project capturewithki-69dd3
```

## 3. Call it and read the logs

```bash
firebase functions:log --only pdfSpike --project capturewithki-69dd3
```

**PASS:** a byte length over 1000.
**FAIL:** a launch error, a timeout, or a deploy that exceeds the size limit.

## 4. Delete it either way

```bash
firebase functions:delete pdfSpike --project capturewithki-69dd3
```

A leftover callable that launches a browser is an open invitation to run up a bill.

## 5. Record the answer

Write PASS or FAIL, with the log line, into this file before Task 13 begins.

**If FAIL:** do not build the PDF pipeline. The fallback is the permanent tokenized
page, which is already built and already satisfies ESIGN's requirement that a record be
retainable and accurately reproducible. Tell Laakea; do not silently substitute.
````

- [ ] **Step 2: Commit**

```bash
git add functions/spike/pdf-spike.md
git commit -m "Write the PDF spike a human has to run before we build on it"
```

---

### Task 2: The retainer comes from the package line, not the total

**Files:**
- Modify: `functions/lib/contracts.js`
- Modify: `functions/test/contracts.test.js`

**Interfaces:**
- Consumes: `computeBalanceCents`, `DEFAULT_RETAINER_PERCENT` (existing)
- Produces: `computeFeeBlock({ packagePriceCents, travelFeesCents, retainerPercent }) → { packagePriceCents, travelFeesCents, retainerCents, totalCents, balanceCents }`

**Why:** `computeRetainerCents(total, 30)` takes 30% of the total. Her contracts list Package Price and Travel Fees as separate lines and label the retainer "(30%)", and the decision is that it is 30% **of the package price alone**. The moment travel is non-zero, the current code prints a wrong number into a signed legal document.

- [ ] **Step 1: Write the failing test**

```js
// Append to functions/test/contracts.test.js
import { computeFeeBlock } from '../lib/contracts.js';

test('the retainer is 30 percent of the package, and travel does not inflate it', () => {
  const f = computeFeeBlock({ packagePriceCents: 120000, travelFeesCents: 5000 });
  assert.equal(f.packagePriceCents, 120000);
  assert.equal(f.travelFeesCents, 5000);
  assert.equal(f.retainerCents, 36000);   // 30% of 120000, NOT of 125000
  assert.equal(f.totalCents, 125000);
  assert.equal(f.balanceCents, 89000);    // 125000 - 36000
});

// The property that matters, checked against an independent integer oracle so it
// cannot agree with the implementation by construction.
test('retainer plus balance always equals package plus travel', () => {
  for (let pkg = 0; pkg <= 200000; pkg += 1301) {
    for (const travel of [0, 1, 4999, 25000]) {
      const f = computeFeeBlock({ packagePriceCents: pkg, travelFeesCents: travel });
      const scaled = pkg * 30;
      const expected = Math.floor(scaled / 100) + ((scaled % 100) >= 50 ? 1 : 0);
      assert.equal(f.retainerCents, expected, 'wrong retainer at pkg=' + pkg);
      assert.equal(f.retainerCents + f.balanceCents, pkg + travel,
        'does not sum at pkg=' + pkg + ' travel=' + travel);
    }
  }
});

test('travel of zero behaves, and a missing travel fee counts as zero', () => {
  assert.equal(computeFeeBlock({ packagePriceCents: 17500, travelFeesCents: 0 }).balanceCents, 12250);
  assert.equal(computeFeeBlock({ packagePriceCents: 17500 }).totalCents, 17500);
});

test('nonsense input yields zeroes rather than a wrong number', () => {
  const bad = computeFeeBlock({ packagePriceCents: -1, travelFeesCents: 0 });
  assert.equal(bad.retainerCents, 0);
  assert.equal(bad.totalCents, 0);
  assert.equal(computeFeeBlock(null).totalCents, 0);
  assert.equal(computeFeeBlock({ packagePriceCents: 12.5 }).totalCents, 0);
  assert.equal(computeFeeBlock({ packagePriceCents: 10000, travelFeesCents: -5 }).totalCents, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/contracts.test.js`
Expected: FAIL — `computeFeeBlock` is not exported

- [ ] **Step 3: Write minimal implementation**

```js
// Append to functions/lib/contracts.js

// The retainer is 30% of the PACKAGE PRICE, never of the total. Her contracts list
// "Package Price" and "Travel Fees" as separate lines and label the retainer "(30%)",
// and the owner's decision is that travel is billed but does not inflate the deposit.
// Computing it from the total would print a number in a signed legal document that
// does not match the label above it.
export function computeFeeBlock(input) {
  const d = input && typeof input === 'object' ? input : {};
  const pkg = d.packagePriceCents;
  const travel = d.travelFeesCents === undefined || d.travelFeesCents === null ? 0 : d.travelFeesCents;
  const pct = Number.isFinite(d.retainerPercent) ? d.retainerPercent : DEFAULT_RETAINER_PERCENT;

  const bad = !Number.isInteger(pkg) || pkg < 0
    || !Number.isInteger(travel) || travel < 0
    || pct < 0 || pct > 100;
  if (bad) {
    return { packagePriceCents: 0, travelFeesCents: 0, retainerCents: 0, totalCents: 0, balanceCents: 0 };
  }

  const retainerCents = Math.round(pkg * pct / 100);
  const totalCents = pkg + travel;
  return {
    packagePriceCents: pkg,
    travelFeesCents: travel,
    retainerCents: retainerCents,
    totalCents: totalCents,
    // By subtraction, always. Computing this independently means the two halves
    // fail to sum on any amount where the percentage lands on a half-cent.
    balanceCents: computeBalanceCents(totalCents, retainerCents)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/contracts.test.js`
Expected: PASS

- [ ] **Step 5: Prove the new test can fail**

Temporarily change `Math.round(pkg * pct / 100)` to `Math.round((pkg + travel) * pct / 100)` — the old, wrong behaviour. Run the tests. The oracle test MUST fail. Restore the correct line and confirm everything passes. Report both outcomes; if it passed while broken, the test is worthless.

- [ ] **Step 6: Run the full suite and commit**

```bash
cd functions && npm test
git add functions/lib/contracts.js functions/test/contracts.test.js
git commit -m "Take the retainer from the package price, not the total"
```

---

### Task 3: Payments off

**Files:**
- Modify: `functions/lib/payments.js`
- Modify: `functions/test/payments.test.js`

**Interfaces:**
- Consumes: `providerName()` (existing)
- Produces: `providerName()` returning `'off' | 'fake' | 'stripe'`, defaulting to `'off'`; `paymentsEnabled() → bool`

**Why:** with no provider configured today, the fake payer throws, `signContract` swallows it, and the client is told *"Khiara will email you a payment link."* That sentence is now false — she is not sending one through this system. Off must be a real state, not a failure that happens to look like one.

- [ ] **Step 1: Write the failing test**

```js
// Append to functions/test/payments.test.js
import { paymentsEnabled } from '../lib/payments.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/payments.test.js`
Expected: FAIL — default is `'fake'`, and `paymentsEnabled` is not exported

- [ ] **Step 3: Write minimal implementation**

In `functions/lib/payments.js`, change the default and add the guard:

```js
export function providerName() {
  // OFF is the default. She has no payment processor, and the previous default of
  // 'fake' meant a real client's signature ended with "Khiara will email you a
  // payment link" — a sentence that is not true of this system.
  const name = process.env.PAYMENT_PROVIDER || 'off';
  if (name !== 'off' && name !== 'fake' && name !== 'stripe') {
    throw new Error('Unknown PAYMENT_PROVIDER: ' + name);
  }
  return name;
}

export function paymentsEnabled() {
  return providerName() !== 'off';
}
```

and make `getProvider()` refuse when off:

```js
export function getProvider() {
  const name = providerName();
  if (name === 'off') {
    // Callers must check paymentsEnabled() first. Throwing here rather than
    // returning a no-op provider means a caller that forgot cannot silently
    // half-work.
    throw new Error('getProvider: payments are off');
  }
  // ...existing dispatch unchanged
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/payments.test.js`
Expected: PASS

- [ ] **Step 5: Guard every existing caller**

`signContract`, `startRetainerPayment` and `chaseContracts`'s reconciliation all call `getProvider()`. Each must now check `paymentsEnabled()` first:

- `signContract` — skip session creation entirely, return `checkoutUrl: null`, and log nothing alarming. This is the normal path now, not a failure.
- `startRetainerPayment` — refuse with `failed-precondition` and a message saying payment is not set up.
- `chaseContracts` — skip the reconciliation loop entirely.

Run the module-load check and the full suite:

```bash
cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded')).catch(e => { console.error('FAILED:', e.message); process.exit(1); })"
cd functions && npm test
```

- [ ] **Step 6: Commit**

```bash
git add functions/lib/payments.js functions/test/payments.test.js functions/index.js
git commit -m "Make payments-off a real state rather than a failure"
```

---

### Task 4: Chase the signature, not the money

**Files:**
- Modify: `functions/lib/chase.js`
- Modify: `functions/test/chase.test.js`

**Interfaces:**
- Consumes: `toMillis` from `gallery-expiry.js`
- Produces: `dueActions` emitting `'sign-reminder' | 'never-opened-alert' | 'unsigned-escalation'`; `UNSIGNED_ESCALATION_MS`; `PAY_REMINDERS_MS` and `UNPAID_ESCALATION_MS` removed

**Why:** there is no payment to chase. The two rungs that remain matter more than before — a contract that is never opened may have been spam-filed, and that is the only signal that survives such a failure.

- [ ] **Step 1: Write the failing test**

```js
// In functions/test/chase.test.js — REPLACE the pay-reminder and unpaid-escalation
// tests with these. Delete the old ones; do not leave them asserting removed behaviour.
import { UNSIGNED_ESCALATION_MS } from '../lib/chase.js';

test('a signed contract is never chased — there is nothing left to ask for', () => {
  const c = contract({ status: 'signed', sentAt: new Date(NOW - 5 * DAY), signedAt: new Date(NOW - 4 * DAY) });
  assert.deepEqual(dueActions([c], NOW), []);
});

test('an unsigned contract escalates to her once the nudges are spent', () => {
  const c = contract({
    status: 'opened', sentAt: new Date(NOW - 8 * DAY), openCount: 1, signReminderCount: 2
  });
  const a = dueActions([c], NOW);
  assert.deepEqual(a.map(x => x.kind), ['unsigned-escalation']);
  assert.equal(a[0].to, 'owner');
});

test('the unsigned escalation fires once, not every hour thereafter', () => {
  const c = contract({
    status: 'opened', sentAt: new Date(NOW - 8 * DAY), openCount: 1,
    signReminderCount: 2, escalatedAt: new Date(NOW - 1 * HOUR)
  });
  assert.deepEqual(dueActions([c], NOW), []);
});

test('the escalation waits for the nudges to be spent first', () => {
  const c = contract({
    status: 'opened', sentAt: new Date(NOW - 8 * DAY), openCount: 1, signReminderCount: 0
  });
  assert.deepEqual(dueActions([c], NOW).map(x => x.kind), ['sign-reminder']);
});

test('the removed payment rungs no longer exist', async () => {
  const mod = await import('../lib/chase.js');
  assert.equal(mod.PAY_REMINDERS_MS, undefined);
  assert.equal(mod.UNPAID_ESCALATION_MS, undefined);
  assert.equal(UNSIGNED_ESCALATION_MS, 7 * DAY);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/chase.test.js`
Expected: FAIL — `UNSIGNED_ESCALATION_MS` is not exported

- [ ] **Step 3: Write minimal implementation**

In `functions/lib/chase.js`: delete `PAY_REMINDERS_MS` and `UNPAID_ESCALATION_MS` and the whole `status === 'signed'` branch. Add:

```js
// Replaces the unpaid escalation. The failure this system can actually have is a
// contract that goes out and is never signed — after the nudges are spent, she is
// the only one who can do anything about it.
export const UNSIGNED_ESCALATION_MS = 7 * DAY;
```

and inside the `status === 'opened'` branch, before the reminder ladder:

```js
      // Escalation first: once it is a week old she needs to know, whether or not
      // another nudge is also due this hour.
      if (now - sentAt >= UNSIGNED_ESCALATION_MS
          && (c.signReminderCount || 0) >= SIGN_REMINDERS_MS.length
          && !c.escalatedAt) {
        out.push({ contractId: c.id, kind: 'unsigned-escalation', to: 'owner' });
        continue;
      }
```

Add `'signed'` to the terminal-status filter at the top so a signed contract is never chased.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/chase.test.js`
Expected: PASS

- [ ] **Step 5: Update the caller and its emails**

`chaseContracts` in `functions/index.js` switches on `kind`. Remove the `pay-reminder` and `unpaid-escalation` arms and add `unsigned-escalation`. In `functions/lib/contract-email.js`, delete `payReminderEmail` and `unpaidEscalationEmail`, and add `unsignedEscalationEmail(c)` — to the **owner**, subject `ACTION NEEDED: <name> has not signed`, carrying the client's name, email, phone, when it was sent, how many reminders went out, and a direct `/int/` link. Follow `readyToSignEmail`'s pattern exactly: plain-text body never dropped, table-based HTML, `escapeHtml` on every value, `oneLine` on the subject. Update the covering tests rather than weakening them.

- [ ] **Step 6: Run the full suite and commit**

```bash
cd functions && npm test
git add functions/lib/chase.js functions/test/chase.test.js functions/lib/contract-email.js functions/test/contract-email.test.js functions/index.js
git commit -m "Chase an unsigned contract instead of an unpaid one"
```

---

### Task 5: Package catalogue validation

**Files:**
- Create: `functions/lib/packages.js`
- Test: `functions/test/packages.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `TEMPLATE_KEYS`, `validatePackage(pkg) → { ok, errors }`, `requiredSpecsFor(templateKey) → string[]`

**Why:** a package drives which contract a client signs and what its blanks say. A package missing a spec produces a contract with a hole in it, and `sendContract` would refuse it at send time — better to refuse it at save time, where she can see why.

- [ ] **Step 1: Write the failing test**

```js
// functions/test/packages.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { TEMPLATE_KEYS, validatePackage, requiredSpecsFor } from '../lib/packages.js';

const wedding = (extra) => Object.assign({
  label: 'The Grand — 8 Hours', templateKey: 'wedding', priceCents: 120000, order: 3,
  specs: { packageName: 'The Grand 8-Hour Package', hours: 8, editedImages: '400+' }
}, extra || {});

const portrait = (extra) => Object.assign({
  label: 'Maternity', templateKey: 'portrait', priceCents: 20000, order: 1,
  specs: { packageName: 'Maternity Session', sessionMinutes: 60, editedImages: '30+', locations: 1, outfitChanges: 2 }
}, extra || {});

test('there are exactly three templates', () => {
  assert.deepEqual(TEMPLATE_KEYS, ['wedding', 'elopement', 'portrait']);
});

test('each template declares what it needs filled in', () => {
  assert.deepEqual(requiredSpecsFor('wedding'), ['packageName', 'hours', 'editedImages']);
  assert.deepEqual(requiredSpecsFor('elopement'), ['packageName', 'hours', 'editedImages']);
  assert.deepEqual(requiredSpecsFor('portrait'),
    ['packageName', 'sessionMinutes', 'editedImages', 'locations', 'outfitChanges']);
  assert.deepEqual(requiredSpecsFor('nope'), []);
});

test('a complete package validates', () => {
  assert.equal(validatePackage(wedding()).ok, true);
  assert.equal(validatePackage(portrait()).ok, true);
});

test('an unknown or missing template key is refused', () => {
  assert.equal(validatePackage(wedding({ templateKey: 'invoice' })).ok, false);
  assert.equal(validatePackage(wedding({ templateKey: '' })).ok, false);
  assert.equal(validatePackage(wedding({ templateKey: null })).ok, false);
});

// This is the point of the file: a missing spec becomes a blank in a signed contract.
test('a package missing any required spec is refused, and the error names it', () => {
  const noHours = wedding({ specs: { packageName: 'X', editedImages: '400+' } });
  const r = validatePackage(noHours);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('hours'));

  const noOutfits = portrait({ specs: {
    packageName: 'X', sessionMinutes: 60, editedImages: '30+', locations: 1 } });
  assert.equal(validatePackage(noOutfits).ok, false);
  assert.ok(validatePackage(noOutfits).errors.join(' ').includes('outfitChanges'));
});

test('a portrait spec is not accepted on a wedding package and vice versa', () => {
  const w = wedding({ specs: { packageName: 'X', sessionMinutes: 60, editedImages: '1' } });
  assert.equal(validatePackage(w).ok, false);
});

test('price and label are checked, and hostile input is survived not crashed on', () => {
  assert.equal(validatePackage(wedding({ priceCents: 0 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: -1 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: 12.5 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: '120000' })).ok, false);
  assert.equal(validatePackage(wedding({ label: '' })).ok, false);
  assert.equal(validatePackage(wedding({ label: 'x'.repeat(300) })).ok, false);
  assert.equal(validatePackage(wedding({ specs: null })).ok, false);
  assert.equal(validatePackage(null).ok, false);
  assert.equal(validatePackage('nope').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/packages.test.js`
Expected: FAIL — cannot find module `../lib/packages.js`

- [ ] **Step 3: Write minimal implementation**

```js
// functions/lib/packages.js
//
// Pure and browser-safe — int/contracts.js imports this to validate before saving,
// the same way it imports contracts.js. No node-only modules.

export const TEMPLATE_KEYS = ['wedding', 'elopement', 'portrait'];

const SPECS = {
  wedding:   ['packageName', 'hours', 'editedImages'],
  elopement: ['packageName', 'hours', 'editedImages'],
  portrait:  ['packageName', 'sessionMinutes', 'editedImages', 'locations', 'outfitChanges']
};

export function requiredSpecsFor(templateKey) {
  // hasOwnProperty, so 'constructor' is not a template.
  if (!Object.prototype.hasOwnProperty.call(SPECS, templateKey)) return [];
  return SPECS[templateKey].slice();
}

export const MAX_PACKAGE_LABEL = 200;
export const MAX_SPEC_VALUE = 120;

export function validatePackage(pkg) {
  const errors = [];
  const d = pkg && typeof pkg === 'object' ? pkg : {};

  const label = typeof d.label === 'string' ? d.label.trim() : '';
  if (!label) errors.push('A package needs a name.');
  else if (label.length > MAX_PACKAGE_LABEL) errors.push('That package name is too long.');

  const key = typeof d.templateKey === 'string' ? d.templateKey : '';
  if (TEMPLATE_KEYS.indexOf(key) === -1) {
    errors.push('Pick which contract this package uses: ' + TEMPLATE_KEYS.join(', ') + '.');
  }

  if (!Number.isInteger(d.priceCents) || d.priceCents <= 0) {
    errors.push('The price must be a whole number of cents above zero.');
  }

  const specs = d.specs && typeof d.specs === 'object' ? d.specs : null;
  if (!specs) {
    errors.push('This package is missing its contract details.');
  } else {
    // Every required spec must be present and non-empty. A missing one becomes a
    // blank in a contract someone signs, so it is refused here rather than at send.
    for (const name of requiredSpecsFor(key)) {
      const v = specs[name];
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (!s) errors.push('Missing contract detail: ' + name + '.');
      else if (s.length > MAX_SPEC_VALUE) errors.push('That value is too long: ' + name + '.');
    }
    // A spec the chosen template has no place for is a sign the wrong template was
    // picked — a portrait's outfitChanges on a wedding contract has nowhere to go.
    const allowed = requiredSpecsFor(key);
    for (const name of Object.keys(specs)) {
      if (allowed.indexOf(name) === -1) {
        errors.push('That detail does not belong on this contract: ' + name + '.');
      }
    }
  }

  return { ok: errors.length === 0, errors: errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/packages.test.js`
Expected: PASS

- [ ] **Step 5: Confirm browser-safety**

Run: `cd functions && grep -n "node:" lib/packages.js`
Expected: **no output.** The dashboard imports this file directly.

- [ ] **Step 6: Run the full suite and commit**

```bash
cd functions && npm test
git add functions/lib/packages.js functions/test/packages.test.js
git commit -m "Refuse a package that would leave a blank in a signed contract"
```

---

### Task 6: Transcribe the Wedding contract

**Files:**
- Create: `<SCRATCHPAD>/templates/wedding.html` — **NOT in the repo**

**Interfaces:**
- Consumes: the merge-field names from the spec
- Produces: a template whose rendered output matches her PDF's text

**THE REPOSITORY IS PUBLIC.** This file is her legal document. It is written to the scratchpad and seeded into Firestore by a human. **Do not `git add` it. Do not put contract text in a commit message.**

- [ ] **Step 1: Read the source**

`<SCRATCHPAD>/contracts/The_Grand_Package_-_Contract.txt` is the base. The Classic and Intimate differ **only** in the SERVICES & PACKAGE paragraph — confirm that yourself:

```bash
diff <SCRATCHPAD>/contracts/The_Intimate_Package_-_Contract.txt <SCRATCHPAD>/contracts/The_Classic_Package_-_Contract.txt
```

Expected: one hunk, naming the package, hours and image count. That difference becomes merge fields; everything else is shared text.

- [ ] **Step 2: Transcribe**

Write `<SCRATCHPAD>/templates/wedding.html` as semantic HTML — `<h1>` for the title, `<h2>` per section, `<p>` for paragraphs, `<ul>` for the inclusion list. No inline styles; the signing page's CSS styles it.

**Rules:**
- Reproduce every clause **verbatim**. You are transcribing a legal document, not editing one. Do not fix grammar, do not reword, do not reorder, do not summarise.
- **One correction only:** the source reads *"the selected The Classic 8-Hour Package"*. It must become `{{package_name}}`, which the catalogue fills with "The Grand 8-Hour Package". That original text is a copy-paste error in her PDF — the Grand's hours and image count above a Classic name.
- The stray line `Khiara Salvani` appearing mid-document (a header/footer artifact of the PDF) is **not** part of the contract. Leave it out.
- Merge fields: `{{client_1_name}}`, `{{client_2_name}}`, `{{client_email}}`, `{{client_phone}}`, `{{event_date}}`, `{{event_location}}`, `{{start_time}}`, `{{end_time}}`, `{{package_name}}`, `{{hours}}`, `{{edited_images}}`, `{{package_price}}`, `{{retainer}}`, `{{travel_fees}}`, `{{remaining_balance}}`, `{{balance_due_date}}`, `{{photographer_name}}`, `{{photographer_signed_date}}`
- Names must match that list exactly and use only lowercase letters and underscores — `renderTemplate`'s regex is `/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi`, so `{{client-1}}` or `{{1st_name}}` would ship as visible literal text.
- The signature block: the Photographer column shows `{{photographer_name}}` and `{{photographer_signed_date}}`. Client 1's shows the placeholders the signing page fills after signing. **Client 2 is named only** — render `{{client_2_name}}` as text with no signature line, because only Client 1 signs.

- [ ] **Step 3: Verify by diffing, not by reading**

11,000 characters of legal text is exactly where an eye slips. Render the template with sample values and diff its text against the source:

```bash
cd /Users/laakeasalvani/capturewithki/.worktrees/contracts-and-payments/functions
node --input-type=module -e "
import { renderTemplate } from './lib/contracts.js';
import { readFileSync, writeFileSync } from 'node:fs';
const SP='<SCRATCHPAD>';
const html = renderTemplate(readFileSync(SP+'/templates/wedding.html','utf8'), {
  client_1_name:'Jordan Rivera', client_2_name:'Sam Rivera', client_email:'j@example.com',
  client_phone:'555-0100', event_date:'June 12, 2027', event_location:'Cannon Beach, Oregon',
  start_time:'2:00 PM', end_time:'10:00 PM', package_name:'The Grand 8-Hour Package',
  hours:'8', edited_images:'400+', package_price:'\$1,200.00', retainer:'\$360.00',
  travel_fees:'\$0.00', remaining_balance:'\$840.00', balance_due_date:'May 29, 2027',
  photographer_name:'Khiara Salvani', photographer_signed_date:'September 8, 2026'
});
const left = html.match(/\{\{[^}]*\}\}/g);
console.log('unfilled placeholders:', left ? left.join(',') : 'none');
writeFileSync(SP+'/templates/wedding.rendered.txt',
  html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,\"'\").replace(/\s+/g,' ').trim());
"
```

Then compare word-by-word against the source with the same normalisation applied, and account for **every** difference. Expected differences are only: the corrected package name, the omitted `Khiara Salvani` artifact, and the blanks now carrying values. Any other difference is a transcription error — report it, do not accept it.

- [ ] **Step 4: Report and hand over**

Write to the report: the diff result, every difference and why it is expected, and the confirmation that `unfilled placeholders: none`. State plainly that the file is in the scratchpad and was deliberately not committed.

- [ ] **Step 5: Commit nothing**

There is no commit for this task. Confirm with `git status --short` that the repo is unchanged, and say so.

---

### Task 7: Transcribe the Elopement contract

**Files:**
- Create: `<SCRATCHPAD>/templates/elopement.html` — **NOT in the repo**

**Interfaces:** as Task 6.

**THE REPOSITORY IS PUBLIC.** Same rule: scratchpad only, never committed.

- [ ] **Step 1: Read the source**

`<SCRATCHPAD>/contracts/Elopement_Photography_Contract.txt`. It is a **different document** from the wedding one, not a variant — it carries three sections the wedding contract does not: LATE ARRIVAL & NO-SHOW, WEATHER & UNFORESEEN CIRCUMSTANCES, and LOCATION & ACCESS. Transcribe what is actually there; do not copy the wedding template and edit it.

- [ ] **Step 2: Transcribe**

Same rules as Task 6, with these differences:
- Its package paragraph reads *"the selected The Elopement Package includes: 2 hours… 150+ edited images… 1 Location"*. The package name, hours and image count still become `{{package_name}}`, `{{hours}}` and `{{edited_images}}` so the catalogue drives them.
- Its retainer paragraph says "elopement date" where the wedding one says "wedding date". Keep her wording.
- **No correction is needed in this document.** Transcribe it exactly.
- Same merge-field list as Task 6.

- [ ] **Step 3: Verify by diffing**

Same procedure as Task 6 Step 3, substituting `elopement.html` and elopement-appropriate sample values (`package_name:'The Elopement Package'`, `hours:'2'`, `edited_images:'150+'`). Expected differences: only the blanks now carrying values. **There is no expected text correction in this document** — any wording difference at all is a transcription error.

- [ ] **Step 4: Report and hand over.** As Task 6 Step 4.

- [ ] **Step 5: Commit nothing.** Confirm `git status --short` shows the repo unchanged.

---

### Task 8: Transcribe the Portrait contract

**Files:**
- Create: `<SCRATCHPAD>/templates/portrait.html` — **NOT in the repo**

**Interfaces:** as Task 6, but a different merge-field set.

**THE REPOSITORY IS PUBLIC.** Scratchpad only.

- [ ] **Step 1: Read the source**

`<SCRATCHPAD>/contracts/Portrait_Photography_Contract.txt`. This document differs from the other two in three ways that matter:

1. **One client, not two.** "Client Name", one signature pair. There is no Client 2 anywhere — do not invent one.
2. **The photographer is pre-filled** as "Khiara Salvani" in the source. It still becomes `{{photographer_name}}`, so one mechanism fills it everywhere.
3. **Its spec list is blank in the source.** The lines read `60. Min Session`, ` Edited Images`, ` Number of Locations`, ` Number of Outfit Changes` — the numbers were never filled in. These become `{{session_minutes}}`, `{{edited_images}}`, `{{locations}}` and `{{outfit_changes}}`, supplied per session type by the catalogue.

It also names its five session types in prose: *"Couples, Engagement, Family, Maternity, or Senior"*, with a `Package / Session Name: ___` blank that becomes `{{package_name}}`.

- [ ] **Step 2: Transcribe**

Same verbatim rules. Merge fields for this template:

`{{client_1_name}}`, `{{client_email}}`, `{{client_phone}}`, `{{event_date}}`, `{{event_location}}`, `{{start_time}}`, `{{end_time}}`, `{{package_name}}`, `{{session_minutes}}`, `{{edited_images}}`, `{{locations}}`, `{{outfit_changes}}`, `{{package_price}}`, `{{retainer}}`, `{{travel_fees}}`, `{{remaining_balance}}`, `{{balance_due_date}}`, `{{photographer_name}}`, `{{photographer_signed_date}}`

**No `{{client_2_name}}`** — this contract has one client. Including it would render "Not applicable" in a document that never had a second client.

- [ ] **Step 3: Verify by diffing.** Same procedure, with portrait sample values.

- [ ] **Step 4: Report, and flag what only Khiara knows**

Her PDF leaves the spec numbers blank, so `session_minutes`, `edited_images`, `locations` and `outfit_changes` are **unknown for all five session types**. List them in the report as a CONFIRM-WITH-KHIARA table with a row per session type, exactly as the package prices already are. No portrait contract can be sent until she supplies them.

- [ ] **Step 5: Commit nothing.** Confirm `git status --short` shows the repo unchanged.

---

### Task 9: Send the right contract, countersigned

**Files:**
- Modify: `functions/index.js` (`createContract`, `sendContract`)

**Interfaces:**
- Consumes: `computeFeeBlock` (Task 2), `validatePackage` (Task 5), `renderTemplate`, `canTransition`, `hashDocument`, `generateToken`, `hashToken`
- Produces: `createContract` taking `packageId` and `travelFeesCents`; `sendContract` choosing its template from the package

**Why:** the package now decides which contract a client signs and what its blanks say, and her countersignature must be inside the hash.

- [ ] **Step 1: `createContract` takes a package**

It currently takes free-form `lineItems`. Change it to take `packageId` and `travelFeesCents`, load the package, and derive the fee block:

```js
    const pkgSnap = await db.collection('packages').doc(String(d.packageId || '')).get();
    if (!pkgSnap.exists) throw new HttpsError('not-found', 'No such package.');
    const pkg = pkgSnap.data();
    const check = validatePackage(pkg);
    if (!check.ok) {
      // Refused here rather than at send: a package missing a spec produces a
      // contract with a visible blank in it, and she can fix the package.
      throw new HttpsError('failed-precondition',
        'That package is not ready to send: ' + check.errors.join(' '));
    }

    const fees = computeFeeBlock({
      packagePriceCents: pkg.priceCents,
      travelFeesCents: Number.isInteger(d.travelFeesCents) ? d.travelFeesCents : 0
    });
    if (fees.totalCents <= 0) throw new HttpsError('invalid-argument', 'That total is not valid.');
```

Store on the contract: `packageId`, `templateKey: pkg.templateKey`, `packageLabel: pkg.label`, `specs: pkg.specs`, and every field of `fees`.

**Keep the existing `clientName` field exactly as it is** — it already means Client 1, and it is read in 21 places across `openContract`, `sign.js`, the email builders and the dashboard, all of which are reviewed and working. Renaming it to `client1Name` would touch every one of those for no benefit. Add only `client2Name` (optional, may be empty). The merge field is still `{{client_1_name}}`, fed from `contract.clientName`.

- [ ] **Step 2: `sendContract` picks the template and stamps her signature**

Load `contractTemplates/{contract.templateKey}` instead of a caller-supplied `templateId`. Keep the `isDraft` refusal. Build the merge fields from the contract and its specs, and **stamp her countersignature before hashing**:

```js
    // Stamped in BEFORE the snapshot is hashed, so her countersignature is covered
    // by the same tamper-evidence as the client's. She is the party offering these
    // terms; the client accepts them, so the document goes out already countersigned.
    const sentDate = new Date();
    const fields = {
      client_1_name: contract.clientName,
      client_2_name: contract.client2Name || 'Not applicable',
      client_email: contract.clientEmail,
      client_phone: contract.clientPhone || 'Not given',
      event_date: contract.eventDate,
      event_location: contract.eventLocation,
      start_time: contract.startTime || 'To be confirmed',
      end_time: contract.endTime || 'To be confirmed',
      package_name: contract.specs.packageName,
      package_price: formatCents(contract.packagePriceCents),
      retainer: formatCents(contract.retainerCents),
      travel_fees: formatCents(contract.travelFeesCents),
      remaining_balance: formatCents(contract.balanceCents),
      balance_due_date: contract.balanceDueDate,
      photographer_name: PHOTOGRAPHER_NAME,
      photographer_signed_date: formatLongDate(sentDate)
    };
    // Template-specific specs.
    if (contract.templateKey === 'portrait') {
      fields.session_minutes = String(contract.specs.sessionMinutes);
      fields.locations = String(contract.specs.locations);
      fields.outfit_changes = String(contract.specs.outfitChanges);
      fields.edited_images = String(contract.specs.editedImages);
    } else {
      fields.hours = String(contract.specs.hours);
      fields.edited_images = String(contract.specs.editedImages);
    }
```

Add `const PHOTOGRAPHER_NAME = 'Khiara Salvani';` near `SITE_ORIGIN`. Add a `formatLongDate(d)` helper producing e.g. `September 8, 2026`.

Keep the existing unfilled-placeholder refusal exactly as it is — it is what stops a contract going out with a hole in it, and it now also catches a template/spec mismatch.

- [ ] **Step 3: Verify the module loads and the suite passes**

```bash
cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded')).catch(e => { console.error('FAILED:', e.message); process.exit(1); })"
cd functions && npm test
```

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "Send the contract the package chooses, already countersigned"
```

---

### Task 10: Mark the retainer received

**Files:**
- Modify: `functions/index.js`
- Modify: `firestore.rules`

**Interfaces:**
- Consumes: `requireAdmin`, `describeError`, `FieldValue`
- Produces: callable `markRetainerReceived({ contractId, received })` → `{ ok }`

**Why:** her contracts say the date is not reserved until the signed agreement **and** the retainer have been received. She collects that money outside this system — by Venmo, cheque, whatever — and nothing can detect those automatically. So a person marks it, and only then may the dashboard say the date is held.

The field is deliberately provider-agnostic: when Stripe is switched on, the webhook sets this same field and the dashboard needs no change.

- [ ] **Step 1: Add the callable**

```js
export const markRetainerReceived = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);
    const d = request.data || {};
    const contractId = typeof d.contractId === 'string' ? d.contractId.trim() : '';
    if (!isValidContractId(contractId)) {
      throw new HttpsError('invalid-argument', 'That contract id is not valid.');
    }
    const received = d.received !== false; // default true; pass false to undo a mistake

    const ref = db.collection('contracts').doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such contract.');
    if (!snap.data().signedAt) {
      throw new HttpsError('failed-precondition',
        'That contract has not been signed yet.');
    }

    try {
      await ref.update({
        retainerReceivedAt: received ? FieldValue.serverTimestamp() : FieldValue.delete(),
        retainerReceivedBy: received ? request.auth.uid : FieldValue.delete()
      });
      await ref.collection('audit').add({
        event: received ? 'retainer-received' : 'retainer-unmarked',
        at: FieldValue.serverTimestamp(), by: request.auth.uid
      });
    } catch (err) {
      console.warn('[markRetainerReceived] could not update:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    console.log('[markRetainerReceived]', received ? 'marked:' : 'unmarked:', contractId);
    return { ok: true };
  }
);
```

- [ ] **Step 2: Keep the new fields writable**

`firestore.rules`'s `frozenFields()` is a FREEZE list — anything absent from it stays writable. Confirm by reading that `retainerReceivedAt` and `retainerReceivedBy` are **not** in it, and report both by name. Do not add them.

- [ ] **Step 3: Verify and commit**

```bash
cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded')).catch(e => { console.error('FAILED:', e.message); process.exit(1); })"
cd functions && npm test
git add functions/index.js
git commit -m "Let her record a retainer that arrived some other way"
```

---

### Task 11: The signing page says nothing about payment

**Files:**
- Modify: `sign/sign.js`, `sign/index.html`
- Modify: `functions/index.js` (`openContract` return)

**Interfaces:**
- Consumes: `paymentsEnabled()` (Task 3)
- Produces: `openContract` returning `paymentsOn: bool`

**Why:** with payments off, every sentence about paying is false. The page must simply not mention it.

- [ ] **Step 1: Tell the page**

Add `paymentsOn: paymentsEnabled()` to `openContract`'s return, and drop `needsPayment` to `false` whenever payments are off.

- [ ] **Step 2: Hide the payment surface**

In `sign/sign.js`, when `paymentsOn` is false: never show the pay block, never render the "we couldn't open the payment page" message, and never mention a payment link. The signed-unpaid confirmation becomes simply *"Signed"* with the date, and a line stating what the contract itself states — that the date is held once the retainer reaches Khiara. Do not claim the date is held.

- [ ] **Step 3: Verify by reading and report**

You cannot load the page here. Report explicitly:
- With `paymentsOn: false`, list every string the client can see on the confirm panel.
- Confirm none of them promises a payment link, a payment page, or a held date.
- Confirm the pay button is not merely hidden by CSS but never shown.

- [ ] **Step 4: Commit**

```bash
git add sign/sign.js sign/index.html functions/index.js
git commit -m "Stop the signing page mentioning a payment it will not take"
```

---

### Task 12: The dashboard — packages, template picker, retainer control

**Files:**
- Modify: `int/contracts.js`
- Create: `int/templates.js`
- Modify: `int/index.html`, `int/dashboard.js`, `int/dashboard.css`

**Interfaces:**
- Consumes: `validatePackage`, `computeFeeBlock`, `markRetainerReceived`
- Produces: the Contracts tab driven by packages; a Templates tab

**Why:** she picks a package rather than typing line items, and she needs to mark a retainer received and edit her own contract text.

- [ ] **Step 1: Composer changes**

Replace the free-form line-item editor with: a **package picker** (from `packages`, showing label and price), a **travel fee** field in dollars, and a read-only fee block showing Package Price, Retainer (30%), Travel Fees, Remaining Balance and Balance Due Date. Compute it with the **imported** `computeFeeBlock` — do not reimplement the arithmetic in the browser. `balance_due_date` defaults to 14 days before the event date and stays editable.

Show which contract the chosen package will send (`templateKey`), so she can see that picking "Maternity" sends the Portrait agreement.

- [ ] **Step 2: Status and the retainer control**

Statuses read:

| State | Label |
|---|---|
| sent, never opened, >48h | **"Not opened yet — the email may not have arrived."** Loud. |
| opened, unsigned | "Read, not signed yet" |
| signed, no retainer marked | "Signed — retainer not yet received. The date is not held." |
| signed, retainer marked | "Booked — date held" |

Add a **"Retainer received"** control on signed contracts calling `markRetainerReceived`, and a way to undo it. Signed-without-retainer and booked must be visually distinct — different colour, different words. Never show signed-alone as booked; her own contract says the date is not reserved until the retainer arrives.

- [ ] **Step 3: The Templates tab**

`int/templates.js`, registered exactly the way `inquiries`/`galleries`/`settings`/`contracts` are in `int/dashboard.js` — read that file and copy the mechanism; do not invent a new one.

It lists the three templates, opens one in a `<textarea>`, shows a live preview rendered with sample values through the **imported** `renderTemplate`, and saves. **Every save writes a new version** rather than overwriting: bump `version`, and copy the previous `html` into `contractTemplates/{key}/versions/{version}`. A contract already sent is unaffected — its frozen `documentSnapshot` is what it renders and what was hashed.

Warn before saving that this changes the contract future clients will sign.

- [ ] **Step 4: Escaping**

`clientName`, `client2Name` and `signature.typedName` are typed by strangers into a public form. Every one of them reaches the DOM via `textContent`, never `innerHTML`. Grep `int/contracts.js` and `int/templates.js` for `innerHTML` and justify every hit in your report.

- [ ] **Step 5: Verify**

```bash
cd /Users/laakeasalvani/capturewithki/.worktrees/contracts-and-payments
grep -o data-cms-id index.html | wc -l    # must be 131 — the root file must be untouched
cd functions && npm test
```

Report: the innerHTML audit, the 131 count, and a trace of what a signed-but-unmarked contract renders as.

- [ ] **Step 6: Commit**

```bash
git add int/
git commit -m "Pick a package, watch the contract, mark the money in"
```

---

### Task 13: The signed PDF — GATED on Task 1

**Files:**
- Modify: `functions/index.js`, `functions/package.json`

**Interfaces:**
- Consumes: `documentSnapshot`, `signature` from the signed contract
- Produces: a PDF written to Storage and attached to the confirmation email

**DO NOT START THIS TASK until `functions/spike/pdf-spike.md` records a PASS.** If it records FAIL, or has not been run, stop and report that — do not substitute an approach nobody chose.

- [ ] **Step 1: Confirm the gate**

Read `functions/spike/pdf-spike.md`. If it does not say PASS with a byte count, stop here and report.

- [ ] **Step 2: Build it**

Render `documentSnapshot` plus a signature block and an audit page — typed name, server timestamp, IP, user agent, document hash — to a PDF. Reuse `sign/sign.css` so the PDF matches the page the client actually read. Write it to Storage at `contracts/{contractId}.pdf` and attach it to the signed-copy email to **both** the client and `OWNER_EMAIL`.

Generate it **after** the signature is committed, in its own try/catch that logs and does not throw. A failed PDF must never cost a client their signature.

- [ ] **Step 3: Verify and commit**

```bash
cd functions && npm test
git add functions/index.js functions/package.json functions/package-lock.json
git commit -m "Send both parties a PDF of what was signed"
```

---

### Task 14: The seeding handover — nothing works until a human loads this

**Files:**
- Create: `functions/seed/real-contracts-seed.md`

**Interfaces:**
- Consumes: the three transcribed templates (Tasks 6–8) and the catalogue schema (Task 5)
- Produces: the document a human follows to make the system live

**Why this task exists:** Tasks 6–8 write templates to the scratchpad and Task 12 builds an editor for them, but **nothing in this plan puts a single template or package into Firestore** — subagents may not write there, and the repository is public so the contract text cannot be committed. Without this document the system is complete and inert.

- [ ] **Step 1: Write the seeding guide**

Create `functions/seed/real-contracts-seed.md`. It carries **no contract text** — only instructions, because this file IS committed to a public repository. It must contain:

1. **Where the templates are**: `<SCRATCHPAD>/templates/{wedding,elopement,portrait}.html`, and a warning that the scratchpad is temporary — copy them somewhere safe before it is cleared.
2. **How to load each one**: create `contractTemplates/wedding` with fields `html` (paste the file), `version: 1`, `name`, `isDraft: true`. Same for `elopement` and `portrait`. Leave `isDraft: true` until she has read the rendered contract end to end — the guard in `sendContract` is what stops a half-checked template reaching a client.
3. **The nine packages**, as a table she fills in and then creates in `packages`. Each needs `label`, `templateKey`, `priceCents`, `order`, `active`, and its `specs`.
4. **A CONFIRM-WITH-KHIARA section, placed ABOVE the loading steps**, listing everything unknown:
   - **Every price is unconfirmed.** Her own markup says so at `index.html:110` and `index.html:693`. Nine prices needed.
   - **All five portrait session types are missing their specs**: edited images, locations, outfit changes. Her PDF left them blank.
   - **The Grand PDF names the wrong package** — the template corrects it to "The Grand 8-Hour Package"; her PDF still says "The Classic". She should fix her copy so the two sources agree.
5. **How to verify before going live**: send a contract to Laakea's own address, open it on a phone, read the whole thing against her PDF, sign it, and confirm the audit row.

- [ ] **Step 2: Confirm no contract text leaked into the repo**

```bash
cd /Users/laakeasalvani/capturewithki/.worktrees/contracts-and-payments
grep -rniE "non-refundable|force majeure|laser" functions/seed/ docs/ 2>/dev/null | grep -v "real-contracts-seed.md:" || echo "clean"
git log -p --all | grep -ci "non-refundable" || echo "0 occurrences in history"
```

Both must come back clean. If contract text has reached the repository at any point, **stop and report it** — the repo is public and history is not private just because the file was later deleted.

- [ ] **Step 3: Commit**

```bash
git add functions/seed/real-contracts-seed.md
git commit -m "Write down how to load the real contracts, and what is still unknown"
```

---

## Done when

- She picks a package and the right one of three contracts goes out, already countersigned
- A client opens it on a phone, ticks consent, types their name, and signs
- The retainer is 30% of the package price, and retainer plus balance equals package plus travel exactly
- Nothing anywhere mentions a payment this system will not take
- She can mark a retainer received, and only then does it read "Booked — date held"
- She can edit her own contract text, and a signed contract still shows the words that were signed
- `npm test` passes in `functions/`, output read rather than summarised
- **No contract text is in the repository.** Verify: `git log -p | grep -i "non-refundable"` returns nothing.

## Explicitly not in this plan

- Collecting money. The Stripe implementation stays dormant, not deleted.
- A second electronic signature for Client 2.
- Void and cancel controls — still missing, still the first thing to build after this.
- Installments.
