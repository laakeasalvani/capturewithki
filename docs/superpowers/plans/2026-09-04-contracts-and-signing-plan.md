# Contracts and Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khiara presses one button on an inquiry and the client receives a link where they read her contract, type their name, and sign it — with an audit trail that would stand up.

**Architecture:** Pure, browser-safe logic in `functions/lib/contracts.js`; anything using `node:crypto` isolated in `functions/lib/contract-crypto.js`. Four `onCall` Cloud Functions — two admin-only, two authenticated by a 32-byte token. A static signing page under `sign/`. Signed contracts are frozen field-by-field in `firestore.rules`.

**Tech Stack:** Node 24 ESM, `firebase-functions` v2, `firebase-admin`, `node --test`, Resend for email, plain ES modules in the browser with the Firebase SDK pinned to `10.13.0`.

**Spec:** `docs/superpowers/specs/2026-09-04-contracts-and-payments-design.md`

**This is plan 1 of 2.** Plan 2 covers Stripe payment, reconciliation and chasing, and is blocked on Khiara creating a Stripe account. Everything here is unblocked.

## Global Constraints

- **Never run a bare `firebase deploy`.** Scope it: `firebase deploy --only functions --project capturewithki-69dd3`, `--only firestore:rules`.
- **Never print, log, commit or echo `RESEND_API_KEY`.**
- **No build step.** Plain ES modules in `sign/` and `int/`. npm exists only inside `functions/`. Do not introduce a bundler.
- **Firebase client SDK pinned to exactly `10.13.0`** in every browser-side gstatic import.
- **`index.html` carries exactly 131 `data-cms-id` markers.** If you touch it, count before and after with `grep -o data-cms-id index.html | wc -l` — `grep -c` counts lines and reads low.
- **Leave the contact-form ids alone:** `n1 n2 em ph dt cl ms send sent`.
- **Run `npm test` in `functions/` and read the output.** A subagent has already reported passing tests for a command that was erroring.
- **All money is integer cents.** Never floats, never dollars.
- **Region is `us-west1`** on every function, matching the existing exports.
- Khiara is in **Oregon**. No tax line anywhere.

## Two corrections to the spec, applied here

1. **The spec's status list is incomplete.** Its prose says a signed contract "gets marked cancelled but never deleted," but its data model lists only `void`. Voiding an unsigned draft and cancelling a signed agreement are different events with different consequences, so this plan uses **both**: `void` for never-signed, `cancelled` for signed-then-called-off. `signed → void` is forbidden.
2. **`escapeHtml` currently lives in `email.js`.** Task 3 moves it to a shared `lib/html.js` so the browser-safe contract module can use it without importing the email machinery.

## File structure

| File | Responsibility |
|---|---|
| `functions/lib/html.js` | `escapeHtml`, shared. No dependencies. |
| `functions/lib/contracts.js` | **Browser-safe.** Money, validation, merge rendering, state machine. Must never import `node:crypto`. |
| `functions/lib/contract-crypto.js` | **Node only.** Token generation, hashing, verification, document hashing. |
| `functions/lib/contract-email.js` | Email bodies for "ready to sign" and "your signed copy". |
| `functions/index.js` | Adds `createContract`, `sendContract`, `openContract`, `signContract`. |
| `firestore.rules` | Field-scoped immutability for signed contracts. |
| `sign/index.html`, `sign/sign.js` | Client-facing signing page. |
| `int/contracts.js` | Dashboard tab. |

The `contracts.js` / `contract-crypto.js` split is not stylistic. `int/contracts.js` imports `contracts.js` in the browser to preview the retainer as she types. `gallery-auth.js` already records why that matters: *"toMillis lives in gallery-expiry.js because the browser imports that file and must never pull in node:crypto through it."*

---

### Task 1: Money arithmetic

**Files:**
- Create: `functions/lib/contracts.js`
- Test: `functions/test/contracts.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `DEFAULT_RETAINER_PERCENT: number`, `sumLineItems(lineItems) → int`, `computeRetainerCents(totalCents, percent) → int`, `computeBalanceCents(totalCents, retainerCents) → int`

- [ ] **Step 1: Write the failing test**

```js
// functions/test/contracts.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_RETAINER_PERCENT, sumLineItems,
  computeRetainerCents, computeBalanceCents
} from '../lib/contracts.js';

test('the retainer is 30 percent, as the site promises', () => {
  assert.equal(DEFAULT_RETAINER_PERCENT, 30);
});

test('line items add up', () => {
  assert.equal(sumLineItems([{ amountCents: 120000 }, { amountCents: 25000 }]), 145000);
  assert.equal(sumLineItems([]), 0);
});

// A malformed item must not poison the total with NaN. A NaN total silently
// becomes a $0 contract, which is worse than a loud failure.
test('a malformed line item is skipped, not propagated', () => {
  assert.equal(sumLineItems([{ amountCents: 1000 }, { amountCents: '500' }]), 1000);
  assert.equal(sumLineItems([{ amountCents: 1000 }, { amountCents: 1.5 }]), 1000);
  assert.equal(sumLineItems([{ amountCents: 1000 }, null]), 1000);
  assert.equal(sumLineItems(null), 0);
});

test('the retainer on her top package is $360', () => {
  assert.equal(computeRetainerCents(120000, 30), 36000);
});

test('the retainer on her smallest session is $52.50', () => {
  assert.equal(computeRetainerCents(17500, 30), 5250);
});

// THE property that matters. If these two ever fail to sum to the total,
// she is either short-changed or double-charged on every odd amount.
test('retainer and balance always sum exactly to the total', () => {
  for (let total = 0; total <= 200000; total += 7) {
    const retainer = computeRetainerCents(total, 30);
    const balance = computeBalanceCents(total, retainer);
    assert.equal(retainer + balance, total, 'failed at total=' + total);
  }
});

test('a nonsense percentage yields nothing rather than a wrong number', () => {
  assert.equal(computeRetainerCents(120000, -5), 0);
  assert.equal(computeRetainerCents(120000, 150), 0);
  assert.equal(computeRetainerCents(-1, 30), 0);
  assert.equal(computeRetainerCents(1.5, 30), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/contracts.test.js`
Expected: FAIL — cannot find module `../lib/contracts.js`

- [ ] **Step 3: Write minimal implementation**

```js
// functions/lib/contracts.js
//
// Pure and BROWSER-SAFE. `int/contracts.js` imports this file to preview the
// retainer as she types, so it must never import node:crypto or anything else
// node-only. Crypto lives in contract-crypto.js for exactly this reason —
// the same split gallery-expiry.js already needed.
//
// All money is integer cents. Dollars-as-floats put 0.1 + 0.2 into an invoice.

export const DEFAULT_RETAINER_PERCENT = 30;

export function sumLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  let total = 0;
  for (const item of lineItems) {
    const cents = item ? item.amountCents : null;
    // Skipped rather than coerced. Number('') is 0 and Number('x') is NaN,
    // and a NaN total renders as a $0 contract nobody notices.
    if (!Number.isInteger(cents)) continue;
    total += cents;
  }
  return total;
}

export function computeRetainerCents(totalCents, percent) {
  if (!Number.isInteger(totalCents) || totalCents < 0) return 0;
  const pct = Number.isFinite(percent) ? percent : DEFAULT_RETAINER_PERCENT;
  if (pct < 0 || pct > 100) return 0;
  return Math.round(totalCents * pct / 100);
}

// By subtraction, deliberately. Computing this as 70% independently means the
// two halves fail to sum to the total on any amount where 30% lands on a
// half-cent — she would be quietly short a penny on a fraction of bookings.
export function computeBalanceCents(totalCents, retainerCents) {
  if (!Number.isInteger(totalCents) || !Number.isInteger(retainerCents)) return 0;
  return totalCents - retainerCents;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/contracts.test.js`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add functions/lib/contracts.js functions/test/contracts.test.js
git commit -m "Compute retainer and balance in whole cents"
```

---

### Task 2: Contract input validation

**Files:**
- Modify: `functions/lib/contracts.js`
- Modify: `functions/test/contracts.test.js`

**Interfaces:**
- Consumes: `sumLineItems` from Task 1
- Produces: `isValidContractId(id) → bool`, `validateContractInput(input) → { ok: bool, errors: string[] }`, and the constants `MAX_NAME`, `MAX_LINE_ITEMS`, `MAX_TOTAL_CENTS`

- [ ] **Step 1: Write the failing test**

```js
// Append to functions/test/contracts.test.js
import { isValidContractId, validateContractInput, MAX_TOTAL_CENTS } from '../lib/contracts.js';

function goodInput(extra) {
  return Object.assign({
    clientName: 'Jordan Rivera',
    clientEmail: 'jordan@example.com',
    eventDate: '2027-06-12',
    eventLocation: 'Cannon Beach, OR',
    lineItems: [{ label: 'The Grand — 8 hours', amountCents: 120000 }]
  }, extra || {});
}

test('a normal booking validates', () => {
  assert.equal(validateContractInput(goodInput()).ok, true);
});

test('a contract id is constrained, because it becomes a Firestore path', () => {
  assert.equal(isValidContractId('abcdefghij0123456789'), true);
  assert.equal(isValidContractId('../../admins/xyz'), false);
  assert.equal(isValidContractId('short'), false);
  assert.equal(isValidContractId(''), false);
  assert.equal(isValidContractId(null), false);
});

// Hostile input. This project has already shipped validation that crashed on
// it once, from a plan rather than an implementation.
test('hostile names are rejected or survived, never crashed on', () => {
  assert.equal(validateContractInput(goodInput({ clientName: '' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: '   ' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: 'x'.repeat(10000) })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: null })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: { a: 1 } })).ok, false);
  // These are legitimate and must pass — escaping is rendering's job, not validation's.
  assert.equal(validateContractInput(goodInput({ clientName: "Siobhán O'Brien-Núñez" })).ok, true);
  assert.equal(validateContractInput(goodInput({ clientName: '<script>alert(1)</script>' })).ok, true);
});

test('an unusable email is rejected', () => {
  assert.equal(validateContractInput(goodInput({ clientEmail: 'nope' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: '' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: 'a@b' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: 'a@b.co' })).ok, true);
});

test('line items must be present, sane, and finite in number', () => {
  assert.equal(validateContractInput(goodInput({ lineItems: [] })).ok, false);
  assert.equal(validateContractInput(goodInput({ lineItems: null })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Travel', amountCents: -100 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Travel', amountCents: 12.5 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: '', amountCents: 100 }]
  })).ok, false);
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ label: 'Item', amountCents: 100 });
  assert.equal(validateContractInput(goodInput({ lineItems: many })).ok, false);
});

// A zero-total contract is almost certainly a mistake, and an implausible
// total is almost certainly a units error — someone passing dollars as cents.
test('the total must be plausible', () => {
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Free', amountCents: 0 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Oops', amountCents: MAX_TOTAL_CENTS + 1 }]
  })).ok, false);
});

test('errors are reported as a list, not a single message', () => {
  const result = validateContractInput({ clientName: '', clientEmail: 'nope', lineItems: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/contracts.test.js`
Expected: FAIL — `isValidContractId` is not exported

- [ ] **Step 3: Write minimal implementation**

```js
// Append to functions/lib/contracts.js

export const MAX_NAME = 200;
export const MAX_LOCATION = 300;
export const MAX_LINE_LABEL = 120;
export const MAX_LINE_ITEMS = 20;
export const MAX_TOTAL_CENTS = 10000000; // $100,000 — far above her top package

// A contract id arrives from a query string, becomes a Firestore path, and is
// embedded in an email link. Its shape is not negotiable. Same reasoning, and
// same regex, as isValidGalleryId.
export function isValidContractId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{16,40}$/.test(id);
}

function trimmedString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateContractInput(input) {
  const errors = [];
  const d = input && typeof input === 'object' ? input : {};

  const name = trimmedString(d.clientName);
  if (!name) errors.push('A client name is required.');
  else if (name.length > MAX_NAME) errors.push('That client name is too long.');

  // Deliberately loose. A strict RFC-5322 regex rejects real addresses, and
  // the only check that actually matters is whether the emailed link arrives.
  const email = trimmedString(d.clientEmail);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.push('That email address will not work.');
  }

  if (trimmedString(d.eventLocation).length > MAX_LOCATION) {
    errors.push('That location is too long.');
  }

  const items = Array.isArray(d.lineItems) ? d.lineItems : null;
  if (!items || items.length === 0) {
    errors.push('A contract needs at least one line item.');
  } else if (items.length > MAX_LINE_ITEMS) {
    errors.push('That is too many line items.');
  } else {
    for (const item of items) {
      const label = trimmedString(item ? item.label : null);
      if (!label) { errors.push('Every line item needs a label.'); break; }
      if (label.length > MAX_LINE_LABEL) { errors.push('A line item label is too long.'); break; }
      if (!Number.isInteger(item.amountCents) || item.amountCents < 0) {
        errors.push('Every line item needs a whole-cent amount of zero or more.');
        break;
      }
    }
  }

  const total = sumLineItems(items);
  if (total <= 0) errors.push('The total must be more than zero.');
  if (total > MAX_TOTAL_CENTS) errors.push('That total looks wrong — is it in cents?');

  return { ok: errors.length === 0, errors: errors };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/contracts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add functions/lib/contracts.js functions/test/contracts.test.js
git commit -m "Refuse contract input that would produce a broken agreement"
```

---

### Task 3: Share escapeHtml, then render merge fields

**Files:**
- Create: `functions/lib/html.js`
- Modify: `functions/lib/email.js` (remove its local `escapeHtml`, import instead)
- Modify: `functions/lib/contracts.js`
- Modify: `functions/test/contracts.test.js`

**Interfaces:**
- Consumes: nothing new
- Produces: `escapeHtml(v) → string` from `lib/html.js`; `renderTemplate(templateHtml, fields) → string` from `lib/contracts.js`

- [ ] **Step 1: Move `escapeHtml` into its own module**

Create `functions/lib/html.js` and move the **existing** `escapeHtml` function out of `email.js` into it **verbatim** — do not retype or "improve" it. Add the export keyword if needed. Then in `email.js`, delete the local definition and add at the top:

```js
import { escapeHtml } from './html.js';
```

`email.js` re-exports it if anything else imported it from there:

```js
export { escapeHtml };
```

- [ ] **Step 2: Run the existing email tests to prove the move changed nothing**

Run: `cd functions && node --test test/email.test.js`
Expected: PASS, with the same number of tests as before the move. If any fail, the function was not moved verbatim — revert and redo.

- [ ] **Step 3: Write the failing test for merge rendering**

```js
// Append to functions/test/contracts.test.js
import { renderTemplate } from '../lib/contracts.js';

test('a placeholder is replaced with its value', () => {
  assert.equal(
    renderTemplate('<p>For {{client_name}}</p>', { client_name: 'Jordan' }),
    '<p>For Jordan</p>'
  );
});

test('whitespace inside the braces is tolerated', () => {
  assert.equal(renderTemplate('{{ client_name }}', { client_name: 'Jordan' }), 'Jordan');
});

// The client's own name goes into the contract HTML. email.js already
// documents why this matters: text cannot be markup, but HTML can.
test('values are escaped', () => {
  assert.equal(
    renderTemplate('{{client_name}}', { client_name: '<script>alert(1)</script>' }),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});

// A client named "{{total}}" must not be able to read another field. One
// substitution pass, never recursive.
test('a value containing a placeholder is not expanded again', () => {
  assert.equal(
    renderTemplate('{{client_name}}', { client_name: '{{total}}', total: '$1,200' }),
    '{{total}}'
  );
});

// Blanking an unknown placeholder would ship a contract with a silent hole
// where a clause used to be. Leaving it visible makes the mistake loud.
test('an unknown placeholder is left visible, not blanked', () => {
  assert.equal(renderTemplate('<p>{{mystery}}</p>', {}), '<p>{{mystery}}</p>');
});

test('rendering survives nonsense input', () => {
  assert.equal(renderTemplate(null, {}), '');
  assert.equal(renderTemplate('<p>hi</p>', null), '<p>hi</p>');
  assert.equal(renderTemplate('{{client_name}}', { client_name: null }), '');
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd functions && node --test test/contracts.test.js`
Expected: FAIL — `renderTemplate` is not exported

- [ ] **Step 5: Write minimal implementation**

```js
// Add near the top of functions/lib/contracts.js
import { escapeHtml } from './html.js';

// Append to functions/lib/contracts.js

const FIELD = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export function renderTemplate(templateHtml, fields) {
  if (typeof templateHtml !== 'string') return '';
  const f = fields && typeof fields === 'object' ? fields : {};
  // String.replace with a function makes exactly one pass, which is the whole
  // defence against a client named "{{total}}" reading a field they should
  // not see. Do not reach for a while-loop that re-renders until stable.
  return templateHtml.replace(FIELD, function (whole, name) {
    const key = String(name).toLowerCase();
    // hasOwnProperty, not `key in f` — otherwise {{constructor}} resolves
    // through the prototype chain and renders something absurd.
    if (!Object.prototype.hasOwnProperty.call(f, key)) return whole;
    return escapeHtml(f[key]);
  });
}
```

- [ ] **Step 6: Run the full suite**

Run: `cd functions && npm test`
Expected: PASS, every file. Read the output — do not trust a summary.

- [ ] **Step 7: Commit**

```bash
git add functions/lib/html.js functions/lib/email.js functions/lib/contracts.js functions/test/contracts.test.js
git commit -m "Render contract merge fields without letting a client name inject markup"
```

---

### Task 4: The status state machine

**Files:**
- Modify: `functions/lib/contracts.js`
- Modify: `functions/test/contracts.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `STATUSES: string[]`, `canTransition(from, to) → bool`

- [ ] **Step 1: Write the failing test**

```js
// Append to functions/test/contracts.test.js
import { STATUSES, canTransition } from '../lib/contracts.js';

test('every status is accounted for', () => {
  assert.deepEqual(
    STATUSES,
    ['draft', 'sent', 'opened', 'signed', 'paid', 'void', 'cancelled']
  );
});

test('a contract moves forward through the normal path', () => {
  assert.equal(canTransition('draft', 'sent'), true);
  assert.equal(canTransition('sent', 'opened'), true);
  assert.equal(canTransition('opened', 'signed'), true);
  assert.equal(canTransition('signed', 'paid'), true);
});

test('a contract never moves backwards', () => {
  assert.equal(canTransition('signed', 'opened'), false);
  assert.equal(canTransition('paid', 'signed'), false);
  assert.equal(canTransition('opened', 'draft'), false);
});

// The spec is explicit: auto-voiding something a client actually signed is
// legally awkward and would burn a slow-but-real client. A signed agreement
// can only be CANCELLED, which is a decision she makes and a record that keeps.
test('a signed contract can never be voided, only cancelled', () => {
  assert.equal(canTransition('signed', 'void'), false);
  assert.equal(canTransition('paid', 'void'), false);
  assert.equal(canTransition('signed', 'cancelled'), true);
  assert.equal(canTransition('paid', 'cancelled'), true);
});

test('an unsigned contract can be voided', () => {
  assert.equal(canTransition('draft', 'void'), true);
  assert.equal(canTransition('sent', 'void'), true);
  assert.equal(canTransition('opened', 'void'), true);
});

test('terminal states are terminal', () => {
  assert.equal(canTransition('void', 'sent'), false);
  assert.equal(canTransition('cancelled', 'paid'), false);
});

test('an unknown status transitions nowhere', () => {
  assert.equal(canTransition('nonsense', 'sent'), false);
  assert.equal(canTransition(null, 'sent'), false);
  assert.equal(canTransition('draft', 'nonsense'), false);
  assert.equal(canTransition('constructor', 'sent'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/contracts.test.js`
Expected: FAIL — `STATUSES` is not exported

- [ ] **Step 3: Write minimal implementation**

```js
// Append to functions/lib/contracts.js

export const STATUSES = ['draft', 'sent', 'opened', 'signed', 'paid', 'void', 'cancelled'];

// `void` means never signed and killed off. `cancelled` means signed and then
// called off — a different event with different consequences, which is why
// signed can never reach `void`.
const TRANSITIONS = {
  draft:     ['sent', 'void'],
  sent:      ['opened', 'void'],
  opened:    ['signed', 'void'],
  signed:    ['paid', 'cancelled'],
  paid:      ['cancelled'],
  void:      [],
  cancelled: []
};

export function canTransition(from, to) {
  // hasOwnProperty, so 'constructor' and 'toString' are not statuses.
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, from)) return false;
  return TRANSITIONS[from].indexOf(to) !== -1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/contracts.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add functions/lib/contracts.js functions/test/contracts.test.js
git commit -m "Let a signed contract be cancelled but never voided"
```

---

### Task 5: Tokens and document hashing

**Files:**
- Create: `functions/lib/contract-crypto.js`
- Test: `functions/test/contract-crypto.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: `TOKEN_BYTES: number`, `generateToken() → string`, `isValidTokenShape(t) → bool`, `hashToken(t) → string|null`, `verifyToken(t, hash) → bool`, `hashDocument(html) → string`

- [ ] **Step 1: Write the failing test**

```js
// functions/test/contract-crypto.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import {
  TOKEN_BYTES, generateToken, isValidTokenShape,
  hashToken, verifyToken, hashDocument
} from '../lib/contract-crypto.js';

test('a token is 32 random bytes', () => {
  assert.equal(TOKEN_BYTES, 32);
});

// 32 bytes in base64url is 43 characters with no padding.
test('a token is 43 url-safe characters', () => {
  const t = generateToken();
  assert.equal(t.length, 43);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.includes('='), false);
});

test('tokens do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateToken());
  assert.equal(seen.size, 1000);
});

test('token shape is checked before anything touches Firestore', () => {
  assert.equal(isValidTokenShape(generateToken()), true);
  assert.equal(isValidTokenShape('too-short'), false);
  assert.equal(isValidTokenShape('a'.repeat(44)), false);
  assert.equal(isValidTokenShape('../../etc/passwd'), false);
  assert.equal(isValidTokenShape(''), false);
  assert.equal(isValidTokenShape(null), false);
});

test('hashing a token is stable and 64 hex characters', () => {
  const t = generateToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(t), hashToken(generateToken()));
});

test('hashing nonsense yields null rather than a usable hash', () => {
  assert.equal(hashToken(''), null);
  assert.equal(hashToken(null), null);
  assert.equal(hashToken(42), null);
});

test('a token verifies against its own hash and nothing else', () => {
  const t = generateToken();
  assert.equal(verifyToken(t, hashToken(t)), true);
  assert.equal(verifyToken(generateToken(), hashToken(t)), false);
});

// Buffer.from(str, 'hex') silently truncates at the first non-hex character,
// so a stored hash of "zz" would become a zero-length buffer and could
// compare equal to another zero-length buffer. The length check comes first.
test('a malformed stored hash never verifies', () => {
  const t = generateToken();
  assert.equal(verifyToken(t, ''), false);
  assert.equal(verifyToken(t, 'z'.repeat(64)), false);
  assert.equal(verifyToken(t, 'ab'), false);
  assert.equal(verifyToken(t, null), false);
  assert.equal(verifyToken('', ''), false);
});

test('a document hash changes when a single character changes', () => {
  const a = hashDocument('<p>Total: $1,200</p>');
  const b = hashDocument('<p>Total: $1,300</p>');
  assert.notEqual(a, b);
  assert.equal(a, hashDocument('<p>Total: $1,200</p>'));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd functions && node --test test/contract-crypto.test.js`
Expected: FAIL — cannot find module `../lib/contract-crypto.js`

- [ ] **Step 3: Write minimal implementation**

```js
// functions/lib/contract-crypto.js
//
// Node only. Kept apart from contracts.js because the browser imports that
// file and must never pull node:crypto in through it.
//
// Note the divergence from gallery-auth.js, which scrypts its passwords at
// cost 2^14. That is right THERE: gallery passwords are 8 human-typed
// characters shared aloud between a couple, exactly the shape an offline
// guessing attack eats. A contract token is 32 random bytes — 256 bits — so
// guessing is not a threat and scrypt would buy latency and nothing else.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32;

export function generateToken() {
  // base64url, so it survives a query string without escaping. No modulo and
  // therefore no rejection sampling needed — unlike generatePassword, which
  // maps bytes onto a 31-letter alphabet and does need it.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isValidTokenShape(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function hashToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyToken(token, expectedHash) {
  // Length is checked BEFORE Buffer.from, because Buffer.from(s, 'hex')
  // truncates silently at the first non-hex character — a stored hash of
  // 'zz' would otherwise become an empty buffer that compares equal to
  // another empty buffer.
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = hashToken(token);
  if (!actual) return false;
  // timingSafeEqual rather than ===, so the time taken cannot be used to
  // learn the hash a character at a time. Same reasoning as verifyPassword.
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// The binding between a signature and the exact words that were signed. If
// the template is edited later, this no longer matches the new text, which is
// what proves the signed version was not swapped.
export function hashDocument(html) {
  return 'sha256:' + createHash('sha256').update(String(html), 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd functions && node --test test/contract-crypto.test.js`
Expected: PASS

- [ ] **Step 5: Prove the browser-safety split actually holds**

Run: `cd functions && grep -n "node:" lib/contracts.js`
Expected: **no output.** If `contracts.js` imports anything node-only, the dashboard breaks the moment it loads the module, and it breaks in the browser where the error is least visible.

- [ ] **Step 6: Commit**

```bash
git add functions/lib/contract-crypto.js functions/test/contract-crypto.test.js
git commit -m "Mint contract tokens and bind a signature to the words signed"
```

---

### Task 6: Firestore rules — freeze a signed contract field by field

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Consumes: `STATUSES` naming from Task 4
- Produces: rules enforcing that frozen fields never change after `signedAt` exists

- [ ] **Step 1: Read the existing rules and find the admin helper**

Run: `grep -n "function isAdmin\|function signedIn\|admins" firestore.rules`
Expected: an existing admin predicate. **Reuse it — do not define a second one.**

- [ ] **Step 2: Add the contracts rules**

```
// Contracts. Clients never read Firestore directly — the signing page talks
// only to Cloud Functions, which use the Admin SDK and bypass these rules
// entirely. So these constrain the DASHBOARD, and the dashboard alone.
match /contracts/{contractId} {

  // Everything that must be identical to what the client actually signed.
  function frozenFields() {
    return [
      'clientName', 'clientEmail', 'eventDate', 'eventLocation',
      'lineItems', 'totalCents', 'retainerCents', 'balanceCents',
      'templateId', 'templateVersion',
      'documentSnapshot', 'documentHash', 'tokenHash', 'signedAt'
    ];
  }

  // Once signed, the frozen list is untouchable. Everything else — status,
  // paidAt, openCount, the reminder counters — must STILL be writable, or
  // the payment could never be recorded and every contract would strand at
  // 'signed' while the money had already moved.
  //
  // The affectedKeys() guard is load-bearing. Without it, an update that
  // merely CARRIES an unchanged frozen field is refused, which is the exact
  // bug this project already hit when seenAt was pinned to request.time.
  function frozenFieldsUnchanged() {
    return !('signedAt' in resource.data)
      || !request.resource.data.diff(resource.data).affectedKeys().hasAny(frozenFields());
  }

  allow read:   if isAdmin();
  allow create: if isAdmin();
  allow update: if isAdmin() && frozenFieldsUnchanged();
  // A contract is a legal record. It is cancelled, never deleted.
  allow delete: if false;

  // Append-only, and only ever written by the Admin SDK.
  match /audit/{eventId} {
    allow read: if isAdmin();
    allow create, update, delete: if false;
  }
}

match /contractTemplates/{templateId} {
  allow read, write: if isAdmin();
}

match /packages/{packageId} {
  allow read, write: if isAdmin();
}
```

- [ ] **Step 3: Verify in the Rules Playground before deploying**

Open the Firebase console → Firestore → Rules → **Rules Playground**, and run these four simulations against `capturewithki-69dd3`. All four must behave as stated:

| Simulation | Expected |
|---|---|
| `update` on `contracts/testdoc` changing `status` only, doc has `signedAt` | **Allow** |
| `update` on `contracts/testdoc` changing `totalCents`, doc has `signedAt` | **Deny** |
| `update` on `contracts/testdoc` changing `totalCents`, doc has **no** `signedAt` | **Allow** |
| `delete` on `contracts/testdoc` | **Deny** |

The third one is the one people get wrong — an unsigned draft must stay fully editable.

- [ ] **Step 4: Deploy the rules, scoped**

```bash
firebase deploy --only firestore:rules --project capturewithki-69dd3
```

- [ ] **Step 5: Commit**

```bash
git add firestore.rules
git commit -m "Freeze the terms a client signed, without blocking payment updates"
```

---

### Task 7: Contract emails

**Files:**
- Create: `functions/lib/contract-email.js`
- Test: `functions/test/contract-email.test.js`

**Interfaces:**
- Consumes: `escapeHtml` from `lib/html.js` (Task 3)
- Produces: `readyToSignEmail({ clientName, signUrl, eventDate, totalCents, retainerCents }) → { subject, text, html }`, `signedCopyEmail({ clientName, contractUrl, signedAt }) → { subject, text, html }`, `formatCents(cents) → string`

- [ ] **Step 1: Read the conventions you must follow**

Run: `sed -n '30,60p' functions/lib/email.js`

These constraints are already documented there and are not negotiable: no `<style>` block and no classes (Gmail strips the head), everything inline, layout in tables (Outlook renders with Word), fonts limited to the site's own fallback stacks, and **`text` is never dropped** — HTML-only mail is penalised by spam filters. Reuse the `C` colour tokens and the `SERIF`/`SANS` stacks.

- [ ] **Step 2: Write the failing test**

```js
// functions/test/contract-email.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { formatCents, readyToSignEmail, signedCopyEmail } from '../lib/contract-email.js';

test('cents render as dollars with a thousands separator', () => {
  assert.equal(formatCents(120000), '$1,200.00');
  assert.equal(formatCents(5250), '$52.50');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('a nonsense amount never renders as NaN in a client email', () => {
  assert.equal(formatCents(null), '$0.00');
  assert.equal(formatCents('1200'), '$0.00');
  assert.equal(formatCents(12.5), '$0.00');
});

const ready = () => readyToSignEmail({
  clientName: 'Jordan Rivera',
  signUrl: 'https://capturewithki.com/sign/?t=abc',
  eventDate: '2027-06-12',
  totalCents: 120000,
  retainerCents: 36000
});

test('the ready-to-sign email carries both a text and an HTML body', () => {
  const mail = ready();
  assert.ok(mail.subject.length > 0);
  assert.ok(mail.text.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.html.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.text.includes('$360.00'));
  assert.ok(mail.html.includes('$360.00'));
});

// Same lesson email.js already learned: text cannot be markup, but HTML can.
test('a hostile client name cannot inject markup into the email', () => {
  const mail = readyToSignEmail({
    clientName: '<img src=x onerror=alert(1)>',
    signUrl: 'https://capturewithki.com/sign/?t=abc',
    eventDate: '2027-06-12',
    totalCents: 120000,
    retainerCents: 36000
  });
  assert.equal(mail.html.includes('<img src=x'), false);
  assert.ok(mail.html.includes('&lt;img'));
});

// A newline in a single-line field must not be able to forge a Subject line.
test('a newline in the name cannot break the subject', () => {
  const mail = readyToSignEmail({
    clientName: 'Jordan\nBcc: someone@example.com',
    signUrl: 'https://capturewithki.com/sign/?t=abc',
    eventDate: '2027-06-12', totalCents: 120000, retainerCents: 36000
  });
  assert.equal(mail.subject.includes('\n'), false);
  assert.equal(mail.subject.includes('\r'), false);
});

test('the signed-copy email links back to the permanent record', () => {
  const mail = signedCopyEmail({
    clientName: 'Jordan Rivera',
    contractUrl: 'https://capturewithki.com/sign/?t=abc',
    signedAt: new Date(Date.UTC(2026, 8, 4, 19, 30))
  });
  assert.ok(mail.text.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.html.includes('https://capturewithki.com/sign/?t=abc'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd functions && node --test test/contract-email.test.js`
Expected: FAIL — cannot find module `../lib/contract-email.js`

- [ ] **Step 4: Write the implementation**

Create `functions/lib/contract-email.js`. Import `escapeHtml` from `./html.js`, and copy the `C`, `SERIF` and `SANS` constants from `email.js` (or export them from `email.js` and import them — either is fine, but do not invent new colours).

```js
import { escapeHtml } from './html.js';

// Strip CR/LF from anything that becomes a single line, so a crafted name
// cannot forge a Subject header or an extra labelled line. Same defence, and
// same reasoning, as oneLine() in email.js.
function oneLine(v) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
}

export function formatCents(cents) {
  if (!Number.isInteger(cents)) return '$0.00';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-$' : '$') + grouped + '.' + rest;
}
```

Then build both emails. `readyToSignEmail` in full, as the pattern for the second:

```js
export function readyToSignEmail(o) {
  const d = o || {};
  const name = oneLine(d.clientName);
  const url = oneLine(d.signUrl);
  const date = oneLine(d.eventDate);
  const total = formatCents(d.totalCents);
  const retainer = formatCents(d.retainerCents);

  // oneLine on the subject, so a name containing a newline cannot forge a
  // header. Not escapeHtml — a subject is not markup.
  const subject = 'Your CaptureWithKi agreement is ready to sign';

  // Never dropped. HTML-only mail is penalised by spam filters and unreadable
  // to anyone whose client is set to plain text.
  const text = [
    'Hi ' + name + ',',
    '',
    'Your photography agreement is ready. You can read and sign it here:',
    url,
    '',
    'Date: ' + date,
    'Total: ' + total,
    'Retainer due on signing: ' + retainer,
    '',
    'Once it is signed and the retainer is paid, your date is held.',
    '',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');

  // No <style> block, no classes — Gmail strips the head. Tables, because
  // Outlook renders with Word. Fonts are the site's own fallback stacks.
  const html =
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="background:' + C.bg + ';padding:24px 0;">' +
      '<tr><td align="center">' +
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
          'style="background:' + C.paper + ';border:1px solid ' + C.line + ';padding:32px;">' +
          '<tr><td style="font-family:' + SERIF + ';font-size:22px;color:' + C.ink + ';">' +
            'Your agreement is ready' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:15px;color:' + C.ink + ';padding-top:16px;">' +
            'Hi ' + escapeHtml(name) + ', your photography agreement is ready to read and sign.' +
          '</td></tr>' +
          '<tr><td style="padding-top:24px;">' +
            '<a href="' + escapeHtml(url) + '" ' +
               'style="font-family:' + SANS + ';font-size:15px;background:' + C.khaki + ';' +
               'color:#fff;padding:12px 20px;text-decoration:none;display:inline-block;">' +
              'Read and sign' +
            '</a>' +
          '</td></tr>' +
          '<tr><td style="font-family:' + SANS + ';font-size:14px;color:' + C.muted + ';padding-top:24px;">' +
            'Date: ' + escapeHtml(date) + '<br>' +
            'Total: ' + escapeHtml(total) + '<br>' +
            'Retainer due on signing: ' + escapeHtml(retainer) +
          '</td></tr>' +
        '</table>' +
      '</td></tr>' +
    '</table>';

  return { subject: subject, text: text, html: html };
}
```

`signedCopyEmail` follows the same shape: subject `Your signed CaptureWithKi agreement`, a text body confirming the signing date and linking to the permanent record, and an HTML body built from the same tables and tokens. Every interpolated value goes through `escapeHtml` in HTML and `oneLine` in the subject.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd functions && node --test test/contract-email.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add functions/lib/contract-email.js functions/test/contract-email.test.js
git commit -m "Write the contract emails in text and table-based HTML"
```

---

### Task 8: `createContract` — a draft from an inquiry

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `validateContractInput`, `sumLineItems`, `computeRetainerCents`, `computeBalanceCents`, `DEFAULT_RETAINER_PERCENT` (Tasks 1–2); the existing `requireAdmin` and `describeError` helpers in `index.js`
- Produces: callable `createContract({ inquiryId?, clientName, clientEmail, clientPhone?, eventDate?, eventLocation?, lineItems, retainerPercent? }) → { contractId }`

- [ ] **Step 1: Add the import and the function**

```js
// with the other imports in functions/index.js
import {
  validateContractInput, sumLineItems, computeRetainerCents,
  computeBalanceCents, DEFAULT_RETAINER_PERCENT, isValidContractId
} from './lib/contracts.js';

export const createContract = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);

    const d = request.data || {};
    const check = validateContractInput(d);
    if (!check.ok) {
      // She is the only caller, so unlike the client-facing paths this one
      // says exactly what is wrong. There is no id to probe for here.
      throw new HttpsError('invalid-argument', check.errors.join(' '));
    }

    const lineItems = d.lineItems.map(function (item) {
      return { label: String(item.label).trim().slice(0, 120), amountCents: item.amountCents };
    });
    const totalCents = sumLineItems(lineItems);
    const percent = Number.isFinite(d.retainerPercent) ? d.retainerPercent : DEFAULT_RETAINER_PERCENT;
    const retainerCents = computeRetainerCents(totalCents, percent);

    const doc = {
      status: 'draft',
      inquiryId: typeof d.inquiryId === 'string' && d.inquiryId ? d.inquiryId : null,
      clientName: String(d.clientName).trim().slice(0, 200),
      clientEmail: String(d.clientEmail).trim().slice(0, 254),
      clientPhone: typeof d.clientPhone === 'string' ? d.clientPhone.trim().slice(0, 40) : '',
      eventDate: typeof d.eventDate === 'string' ? d.eventDate.trim().slice(0, 40) : '',
      eventLocation: typeof d.eventLocation === 'string' ? d.eventLocation.trim().slice(0, 300) : '',
      lineItems: lineItems,
      totalCents: totalCents,
      retainerCents: retainerCents,
      // By subtraction. Never recomputed as a second percentage.
      balanceCents: computeBalanceCents(totalCents, retainerCents),
      retainerPercent: percent,
      openCount: 0,
      signReminderCount: 0,
      payReminderCount: 0,
      createdAt: FieldValue.serverTimestamp()
    };

    let ref;
    try {
      ref = await db.collection('contracts').add(doc);
    } catch (err) {
      console.warn('[createContract] could not write:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    await ref.collection('audit').add({
      event: 'created', at: FieldValue.serverTimestamp(), by: request.auth.uid
    });

    console.log('[createContract] drafted:', ref.id);
    return { contractId: ref.id };
  }
);
```

If `FieldValue` is not already imported in `index.js`, add `import { FieldValue } from 'firebase-admin/firestore';`. Check first — it may already be there.

- [ ] **Step 2: Verify it deploys and the module loads**

Run: `cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded'))"`
Expected: `loaded`. A syntax error or a bad import surfaces here rather than in a failed deploy.

- [ ] **Step 3: Run the full suite**

Run: `cd functions && npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "Draft a contract from an inquiry"
```

---

### Task 8b: Seed a contract template and her packages

**Files:**
- Create: `functions/seed/contract-template-placeholder.html`
- Create: `functions/seed/seed.md`

**Interfaces:**
- Consumes: the merge-field names `sendContract` passes in Task 9
- Produces: one document in `contractTemplates`, and one document per package in `packages`

**Why this task exists:** Task 9 reads `contractTemplates/{templateId}` and Task 13 reads `packages`. Without this, both fail on first run. And Khiara does not have her real contract yet — so this seeds a **placeholder** that unblocks every remaining task while she buys one.

- [ ] **Step 1: Write the placeholder template**

Create `functions/seed/contract-template-placeholder.html`. It must use exactly the merge-field names `sendContract` supplies in Task 9 — `client_name`, `client_email`, `event_date`, `event_location`, `total`, `retainer`, `balance`, `line_items` — and no others, because Task 9 refuses to send a template with an unfilled placeholder.

```html
<div style="border:3px solid #b00; padding:16px; margin-bottom:24px;">
  <strong>PLACEHOLDER — NOT A REAL AGREEMENT.</strong>
  This text exists so the system can be built and tested. It has no legal
  effect and must be replaced before any client sees it.
</div>

<h1>Photography Agreement</h1>
<p>Between <strong>CaptureWithKi</strong> and <strong>{{client_name}}</strong>
   ({{client_email}}).</p>

<h2>The booking</h2>
<p>Date: {{event_date}}<br>Location: {{event_location}}</p>
<p>Services: {{line_items}}</p>

<h2>Payment</h2>
<p>Total: <strong>{{total}}</strong><br>
   Retainer due on signing: <strong>{{retainer}}</strong><br>
   Balance: <strong>{{balance}}</strong></p>

<h2>Placeholder clauses</h2>
<p>Cancellation, rescheduling, image licensing, liability and force majeure
   clauses belong here. They must come from a purchased photographer template
   or an Oregon attorney. Do not write them yourself, and do not let Claude
   write them.</p>
```

- [ ] **Step 2: Create the template document**

In the Firebase console → Firestore, create `contractTemplates/placeholder` with:

```
html:      <the file contents from Step 1, pasted>
version:   1
name:      "PLACEHOLDER — replace before use"
isDraft:   true
```

- [ ] **Step 3: Make it impossible to send the placeholder by accident**

Add this guard to `sendContract` in `functions/index.js`, immediately after the template is loaded:

```js
// A placeholder contract reaching a real client would be worse than no
// system at all — she would believe she had an agreement and have nothing.
if (tpl.isDraft === true) {
  throw new HttpsError('failed-precondition',
    'That contract template is still marked a draft. Replace it with the real agreement first.');
}
```

For development, flip `isDraft` to `false` on the placeholder **only while testing against your own email address**, and set it back to `true` before finishing the session.

- [ ] **Step 4: Seed her packages**

Read the real package names and prices out of the live site rather than inventing them:

Run: `grep -n -B4 -A8 'Starting from' index.html | sed 's/<[^>]*>/ /g'`

For each package found, create a document in `packages` with:

```
label:       "The Grand — 8 hours"     // exactly as the site words it
amountCents: 120000                     // "$1,200" → 120000. Cents, not dollars.
order:       1
```

The only package confirmed while writing this plan is **The Grand, 8 hours, from $1,200**. The site also shows amounts at $175, $200, $225, $300, $750 and $1,000 — read the surrounding markup for their real names rather than guessing. **If the site's wording and the price do not clearly pair up, stop and ask Laakea.** A wrong package price becomes a wrong contract.

- [ ] **Step 5: Write the replacement instructions**

Create `functions/seed/seed.md` recording: which document is the placeholder, that `isDraft: true` is what blocks it from sending, and the exact steps to swap in the real contract — paste the real HTML into `contractTemplates/<new id>`, set `version: 1` and `isDraft: false`, then leave the placeholder in place as a draft rather than deleting it.

- [ ] **Step 6: Commit**

```bash
git add functions/seed/ functions/index.js
git commit -m "Seed a placeholder contract template that cannot be sent by accident"
```

---

### Task 9: `sendContract` — freeze, hash, and email

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `renderTemplate`, `canTransition` (Tasks 3–4); `generateToken`, `hashToken`, `hashDocument` (Task 5); `readyToSignEmail`, `formatCents` (Task 7)
- Produces: callable `sendContract({ contractId, templateId }) → { ok: true, signUrl }`

- [ ] **Step 1: Add the function**

```js
import { renderTemplate, canTransition } from './lib/contracts.js';
import { generateToken, hashToken, hashDocument } from './lib/contract-crypto.js';
import { readyToSignEmail, formatCents } from './lib/contract-email.js';

const SITE_ORIGIN = 'https://capturewithki.com';

export const sendContract = onCall(
  { region: 'us-west1', cors: true, secrets: ['RESEND_API_KEY'] },
  async (request) => {
    await requireAdmin(request);

    const d = request.data || {};
    const contractId = typeof d.contractId === 'string' ? d.contractId.trim() : '';
    if (!isValidContractId(contractId)) {
      throw new HttpsError('invalid-argument', 'That contract id is not valid.');
    }

    const ref = db.collection('contracts').doc(contractId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such contract.');
    const contract = snap.data();

    if (!canTransition(contract.status, 'sent')) {
      throw new HttpsError('failed-precondition', 'That contract cannot be sent from its current state.');
    }

    const templateId = typeof d.templateId === 'string' ? d.templateId.trim() : '';
    const tplSnap = await db.collection('contractTemplates').doc(templateId).get();
    if (!tplSnap.exists) throw new HttpsError('not-found', 'No such contract template.');
    const tpl = tplSnap.data();

    // Rendered ONCE, here, and stored. From this moment the live template is
    // irrelevant to this contract: editing a clause later cannot change what
    // this client agreed to, and the hash is what proves it.
    const documentSnapshot = renderTemplate(tpl.html, {
      client_name: contract.clientName,
      client_email: contract.clientEmail,
      event_date: contract.eventDate,
      event_location: contract.eventLocation,
      total: formatCents(contract.totalCents),
      retainer: formatCents(contract.retainerCents),
      balance: formatCents(contract.balanceCents),
      line_items: contract.lineItems
        .map(function (i) { return i.label + ' — ' + formatCents(i.amountCents); })
        .join('; ')
    });

    // A placeholder the template asked for and the data could not fill would
    // ship a contract with a visible hole in it. Refuse instead.
    const unfilled = documentSnapshot.match(/\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/gi);
    if (unfilled) {
      throw new HttpsError('failed-precondition',
        'The template has placeholders nothing filled in: ' + unfilled.join(', '));
    }

    const token = generateToken();
    const signUrl = SITE_ORIGIN + '/sign/?t=' + token;

    try {
      await ref.update({
        status: 'sent',
        templateId: templateId,
        templateVersion: tpl.version || 1,
        documentSnapshot: documentSnapshot,
        documentHash: hashDocument(documentSnapshot),
        // Only the hash. The token itself exists in exactly one place after
        // this line returns: the client's email.
        tokenHash: hashToken(token),
        sentAt: FieldValue.serverTimestamp()
      });
    } catch (err) {
      console.warn('[sendContract] could not update:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    const mail = readyToSignEmail({
      clientName: contract.clientName,
      signUrl: signUrl,
      eventDate: contract.eventDate,
      totalCents: contract.totalCents,
      retainerCents: contract.retainerCents
    });
    // Reuse whatever send helper email.js already exposes — do not write a
    // second Resend client.
    await sendMail(contract.clientEmail, mail);

    await ref.collection('audit').add({
      event: 'sent', at: FieldValue.serverTimestamp(), by: request.auth.uid
    });

    console.log('[sendContract] sent:', contractId);
    // Returned so she can copy the link and text it to them as well. Resend
    // returning 200 means queued, not delivered — this project already learned
    // that the hard way.
    return { ok: true, signUrl: signUrl };
  }
);
```

- [ ] **Step 2: Find the real send helper and use its actual name**

Run: `grep -n "^export function\|^export async function\|resend\|fetch(" functions/lib/email.js | head -20`

Replace the placeholder `sendMail(...)` call above with whatever `email.js` actually exports. **Do not create a second Resend client.**

- [ ] **Step 3: Verify the module loads**

Run: `cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded'))"`
Expected: `loaded`

- [ ] **Step 4: Commit**

```bash
git add functions/index.js
git commit -m "Freeze and hash a contract at the moment it is sent"
```

---

### Task 10: `openContract` — the client reads it

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: `isValidTokenShape`, `verifyToken` (Task 5)
- Produces: callable `openContract({ token }) → { contractId, clientName, documentSnapshot, totalCents, retainerCents, eventDate, status, signedAt }`

- [ ] **Step 1: Add the function**

```js
// hashToken is in this list too. Task 9 already imported it, so omitting it
// here still runs — but only if the tasks are done in order, and that is not
// a property to rely on. Merge this with the existing import line rather than
// adding a second one for the same module.
import { isValidTokenShape, verifyToken, hashToken } from './lib/contract-crypto.js';

// One message for every refusal. Saying "expired" rather than "not found"
// confirms a token is real, which is what probing is looking for. Same
// reasoning as GALLERY_DENIED.
const CONTRACT_DENIED = 'That link is not valid. Please check the email again.';

export const openContract = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    const d = request.data || {};
    const token = typeof d.token === 'string' ? d.token.trim() : '';

    // Checked before touching Firestore.
    if (!isValidTokenShape(token)) throw new HttpsError('permission-denied', CONTRACT_DENIED);

    // No rate limit here, deliberately, and for a different reason than the
    // galleries. A gallery password is 8 characters from a 31-letter alphabet;
    // this token is 256 bits. Guessing is not a threat, and the limiter that
    // was removed from openGallery had already refused a correct password once.
    const hash = hashToken(token);
    let found = null;
    try {
      const q = await db.collection('contracts').where('tokenHash', '==', hash).limit(1).get();
      if (!q.empty) found = q.docs[0];
    } catch (err) {
      console.warn('[openContract] lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    if (!found) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    const contract = found.data();

    // Verified again in constant time even though the query already matched,
    // so this path does not depend on Firestore's comparison semantics.
    if (!verifyToken(token, contract.tokenHash)) {
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }
    if (['void', 'cancelled'].indexOf(contract.status) !== -1) {
      console.log('[openContract] refused, state:', contract.status);
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }

    // Stamped before returning. This is the ONLY signal that survives a
    // spam-filed email — escalateUnreadInquiries exists because no signal the
    // sending side produces can detect that failure.
    const update = { openCount: (contract.openCount || 0) + 1 };
    if (!contract.firstOpenedAt) update.firstOpenedAt = FieldValue.serverTimestamp();
    if (contract.status === 'sent') update.status = 'opened';
    try {
      await found.ref.update(update);
      await found.ref.collection('audit').add({
        event: 'opened', at: FieldValue.serverTimestamp()
      });
    } catch (err) {
      // Logged, not thrown. Failing to record the open must never stop a
      // client reading the agreement they were sent.
      console.warn('[openContract] could not stamp open:', describeError(err));
    }

    return {
      contractId: found.id,
      clientName: contract.clientName,
      documentSnapshot: contract.documentSnapshot,
      totalCents: contract.totalCents,
      retainerCents: contract.retainerCents,
      eventDate: contract.eventDate,
      status: contract.status,
      signedAt: contract.signedAt ? contract.signedAt.toMillis() : null
    };
  }
);
```

- [ ] **Step 2: Create the index Firestore will demand**

The `where('tokenHash', '==', ...)` query needs a single-field index, which Firestore creates automatically — but confirm. Deploy, call the function once with a valid token, and check the logs:

Run: `firebase functions:log --only openContract --project capturewithki-69dd3`
Expected: no `FAILED_PRECONDITION ... requires an index` error. If one appears, follow the console link it prints.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Let a client open their contract, and record that they did"
```

---

### Task 11: `signContract` — the signature and its audit trail

**Files:**
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: everything from Tasks 4, 5 and 7
- Produces: callable `signContract({ token, typedName, consent }) → { ok: true, signedAt }`

- [ ] **Step 1: Add the function**

```js
export const signContract = onCall(
  { region: 'us-west1', cors: true, secrets: ['RESEND_API_KEY'] },
  async (request) => {
    const d = request.data || {};
    const token = typeof d.token === 'string' ? d.token.trim() : '';
    const typedName = typeof d.typedName === 'string' ? d.typedName.trim().slice(0, 200) : '';
    const consent = d.consent === true;

    if (!isValidTokenShape(token)) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    if (!typedName) throw new HttpsError('invalid-argument', 'Please type your full legal name.');
    if (!consent) {
      throw new HttpsError('invalid-argument', 'Please agree to sign electronically first.');
    }

    const hash = hashToken(token);
    const q = await db.collection('contracts').where('tokenHash', '==', hash).limit(1).get();
    if (q.empty) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    const ref = q.docs[0].ref;
    const contract = q.docs[0].data();

    if (!verifyToken(token, contract.tokenHash)) {
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }

    // Idempotent. A replayed token, a double-tap, or a client who hits back
    // and signs again must never produce a second signature record.
    if (contract.signedAt) {
      return { ok: true, signedAt: contract.signedAt.toMillis() };
    }
    if (!canTransition(contract.status, 'signed')) {
      throw new HttpsError('failed-precondition', CONTRACT_DENIED);
    }

    // The IP comes from the request, never from the browser. Everything a
    // client can set is evidence about them, not evidence they supply.
    const raw = request.rawRequest || {};
    const forwarded = (raw.headers && raw.headers['x-forwarded-for']) || '';
    const ip = String(forwarded).split(',')[0].trim() || raw.ip || 'unknown';
    const userAgent = String((raw.headers && raw.headers['user-agent']) || '').slice(0, 500);

    try {
      await ref.update({
        status: 'signed',
        // The SERVER's clock. This project has already been bitten once by
        // trusting a browser clock, in the spam check that would have binned
        // real clients whose phone ran fast. The stakes here are higher.
        signedAt: FieldValue.serverTimestamp(),
        signature: {
          typedName: typedName,
          ip: ip,
          userAgent: userAgent,
          // Copied, not referenced. The audit record must stand alone even if
          // every other field were somehow altered.
          documentHash: contract.documentHash,
          consentGiven: true,
          consentTextVersion: 'esign-disclosure-v1'
        }
      });
      await ref.collection('audit').add({
        event: 'signed', at: FieldValue.serverTimestamp(),
        typedName: typedName, ip: ip, documentHash: contract.documentHash
      });
    } catch (err) {
      console.warn('[signContract] could not record signature:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    const mail = signedCopyEmail({
      clientName: contract.clientName,
      contractUrl: SITE_ORIGIN + '/sign/?t=' + token,
      signedAt: new Date()
    });
    try {
      // The same helper you identified in Task 9 Step 2, not a new one.
      await sendMail(contract.clientEmail, mail);
    } catch (err) {
      // Logged, not thrown. The signature is already recorded and valid; a
      // failed confirmation email must not make the client think it did not work.
      console.warn('[signContract] confirmation email failed:', describeError(err));
    }

    console.log('[signContract] signed:', ref.id);
    return { ok: true, signedAt: Date.now() };
  }
);
```

- [ ] **Step 2: Import `signedCopyEmail`**

Add it to the `contract-email.js` import line added in Task 9.

- [ ] **Step 3: Verify the module loads and the suite passes**

Run: `cd functions && node --input-type=module -e "import('./index.js').then(() => console.log('loaded'))" && npm test`
Expected: `loaded`, then PASS

- [ ] **Step 4: Deploy, scoped**

```bash
firebase deploy --only functions:createContract,functions:sendContract,functions:openContract,functions:signContract --project capturewithki-69dd3
```

- [ ] **Step 5: Commit**

```bash
git add functions/index.js
git commit -m "Record a signature with the evidence that makes it stand up"
```

---

### Task 12: The signing page

**Files:**
- Create: `sign/index.html`
- Create: `sign/sign.js`

**Interfaces:**
- Consumes: `openContract`, `signContract` (Tasks 10–11)
- Produces: the page at `https://capturewithki.com/sign/?t=<token>`

- [ ] **Step 1: Build the page**

Plain HTML, no build step. Firebase SDK pinned to exactly `10.13.0`, matching every other gstatic import in the project. The page must contain, in order:

1. Her wordmark, and the client's name
2. The contract itself, rendered from `documentSnapshot`
3. The **ESIGN consent disclosure**, with an unticked checkbox — never pre-ticked, because a pre-ticked box is not an affirmative act and it is the affirmative act that proves intent
4. A text input for the client's **full legal name**
5. A button reading exactly **"I agree and sign"** — not "Submit", not "Continue". The label is part of the evidence of intent
6. After signing: a confirmation, the signed date, and a note that a copy has been emailed

The consent disclosure text must say that they agree to sign electronically, that they may request a paper copy, and that they may withdraw consent before signing.

- [ ] **Step 2: Render the snapshot safely**

```js
// documentSnapshot was rendered server-side by renderTemplate, which escaped
// every client-supplied value. The remaining HTML is the template's own, and
// the template is admin-authored. So innerHTML is correct here — but ONLY
// because of that. Never point this at anything a client can write.
document.getElementById('contract-body').innerHTML = data.documentSnapshot;
```

- [ ] **Step 3: Disable the button while the call is in flight**

```js
// Without this, a double-tap on a slow phone connection fires signContract
// twice. The function is idempotent so the second call is harmless, but the
// client sees two spinners and assumes it failed.
btn.disabled = true;
```

- [ ] **Step 4: Verify against a real contract**

Create a test contract through the console, send it to your own email address, open the link on a **phone**, and check:

- The contract is readable without horizontal scrolling
- The button does nothing until both the checkbox is ticked and a name is typed
- Signing twice (back button, then sign again) does not create a second signature — check the `audit` subcollection has exactly one `signed` event
- An invalid token shows the same message as a well-formed but unknown one

- [ ] **Step 5: Commit**

```bash
git add sign/index.html sign/sign.js
git commit -m "Let a client read and sign their agreement on a phone"
```

---

### Task 13: The dashboard tab

**Files:**
- Create: `int/contracts.js`
- Modify: `int/index.html`
- Modify: `int/dashboard.js`

**Interfaces:**
- Consumes: all four callables; `computeRetainerCents`, `formatCents`
- Produces: a Contracts tab, and a **Send Contract** button on each inquiry

- [ ] **Step 1: Add the tab, following the existing pattern**

Run: `grep -n "tab\|nav" int/dashboard.js | head -20` and copy how `inquiries.js` and `galleries.js` register themselves. Do not invent a new tab mechanism.

- [ ] **Step 2: Build the send flow**

From an inquiry: prefill name, email, phone, date and location from the inquiry document; let her pick a package from `packages`, add free-form line items for travel; show the running total and the auto-computed 30% retainer, both editable; preview the rendered contract; then send.

The retainer preview imports `computeRetainerCents` from `functions/lib/contracts.js` **in the browser** — which is exactly why that file must stay free of `node:crypto`.

- [ ] **Step 3: Show status honestly**

Each contract shows: status, when it was sent, **whether it has ever been opened**, and when it was signed. Never-opened is the state that matters most — it is the one that means the email may never have arrived.

- [ ] **Step 4: Verify the CMS marker count is untouched**

Run: `grep -o data-cms-id index.html | wc -l`
Expected: **131**. If you did not edit `index.html` this is unchanged, but check anyway — this is the count that breaks her ability to edit her own site.

- [ ] **Step 5: Verify end to end**

Send a real contract to your own address from the dashboard, sign it, and confirm the dashboard shows `signed` with the correct timestamp.

- [ ] **Step 6: Commit**

```bash
git add int/contracts.js int/index.html int/dashboard.js
git commit -m "Send a contract from an inquiry and watch what happens to it"
```

---

### Task 14: The signed PDF — spike first

**Files:**
- Modify: `functions/index.js`
- Modify: `functions/package.json`

**Interfaces:**
- Consumes: `documentSnapshot`, `signature` from Task 11
- Produces: `generateContractPdf` — an async function writing a PDF to Storage

**This task starts with a spike, because the answer is genuinely uncertain.** Puppeteer needs Chromium, and whether it runs in the deployed Firebase gen2 Node 24 runtime is a question to answer before building a pipeline on top of it — not after.

- [ ] **Step 1: Spike — does Puppeteer run in the deployed runtime at all?**

Add a temporary function that launches Puppeteer, renders `<h1>hello</h1>` to a PDF buffer, logs the byte length, and returns. Deploy it with 1GiB memory and a 120s timeout:

```js
export const pdfSpike = onCall(
  { region: 'us-west1', memory: '1GiB', timeoutSeconds: 120 },
  async () => {
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setContent('<h1>hello</h1>');
    const pdf = await page.pdf({ format: 'Letter' });
    await browser.close();
    console.log('[pdfSpike] bytes:', pdf.length);
    return { bytes: pdf.length };
  }
);
```

```bash
cd functions && npm install puppeteer
firebase deploy --only functions:pdfSpike --project capturewithki-69dd3
```

Call it and read the logs. **Expected: a byte length over 1000.**

- [ ] **Step 2: Branch on the spike's result**

**If it worked:** build the real function. Render `documentSnapshot` plus a signature block (typed name, server timestamp, IP, document hash) to a PDF, write it to Storage under `contracts/<contractId>.pdf`, and attach it to the signed-copy email. Then delete `pdfSpike`.

**If it failed:** do not fight it. Remove `puppeteer`, and instead build the signature block into the signed-copy email's HTML body and keep the permanent tokenized page as the retained record. That already satisfies ESIGN's requirement that the record be retainable and accurately reproducible — the PDF is a convention clients expect, not a legal necessity. **Record the failure and this decision in the commit message**, then raise adding a PDF later with Laakea rather than deciding it silently.

- [ ] **Step 3: Delete the spike either way**

```bash
firebase functions:delete pdfSpike --project capturewithki-69dd3
```

A leftover callable that launches a browser is an open invitation to run up a bill.

- [ ] **Step 4: Run the full suite and commit**

```bash
cd functions && npm test
git add functions/index.js functions/package.json functions/package-lock.json
git commit -m "Deliver a signed PDF copy"   # or: "Deliver the signed copy as HTML; Puppeteer will not run in the runtime"
```

---

## Done when

- She can open an inquiry, press Send Contract, pick a package, preview, and send
- The client receives an email, opens it on a phone, reads the contract, ticks consent, types their name, and signs
- The dashboard shows sent / opened / signed with real timestamps
- The signed record carries typed name, server timestamp, IP, user agent, and the document hash
- Editing the template afterwards does not change any sent contract
- `npm test` passes in `functions/`, with the output read rather than summarised
- The four Rules Playground simulations in Task 6 behave as specified

## Explicitly not in this plan

Stripe, payment, reminders, escalation, and reconciliation. All of that is plan 2, which is blocked on Khiara's Stripe account. Until it lands, **a signed contract is not a paid one**, and the dashboard must not imply the date is held.
