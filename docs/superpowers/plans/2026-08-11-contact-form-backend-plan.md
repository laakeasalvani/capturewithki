# Contact Form Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the live contact form actually deliver — email the inquiry to Khiara with a working Reply, send the couple a warm thank-you, and record every submission so none is ever lost.

**Architecture:** The site stays a static, build-free `index.html` on GitHub Pages. A new `functions/` directory holds one Firebase Cloud Function (`submitInquiry`, HTTPS callable, Node 20) that validates input, applies spam checks, writes to Firestore `inquiries` via the Admin SDK, then sends two emails through Resend. The Firestore write happens BEFORE the emails so a delivery failure can never lose an inquiry. Functions deploy to Firebase separately from the GitHub Pages site.

**Tech Stack:** Firebase Cloud Functions v2 (Node 20), firebase-admin, firebase-functions, Resend HTTP API (via `fetch`, no SDK dependency), Firebase Functions Secrets for the API key. Client side: existing Firebase JS SDK v10.13.0 CDN modules plus `firebase-functions.js` for the callable.

## Global Constraints

- The public site remains build-free: `index.html` and `cms/*.js` are plain ES modules loaded by the browser. npm exists ONLY inside `functions/`.
- Firebase client SDK stays pinned to exactly `10.13.0` in every browser-side import, matching the existing `cms/*.js` files.
- Cloud Functions region is `us-west1`, matching the project's existing Storage bucket location.
- Firestore write happens BEFORE either email send. Never report success to the visitor when nothing was recorded.
- `inquiries` is admin-read-only and client-write-closed. The function writes with the Admin SDK, which bypasses rules.
- The Resend API key is a REAL secret. It lives only in Firebase Functions Secrets as `RESEND_API_KEY`. It must never appear in any committed file, log line, error message, or console output. This is unlike the Firebase web config, which is deliberately public.
- Owner's email, hardcoded: `netherlyk23@gmail.com`.
- Spam handling: honeypot and too-fast submissions return SUCCESS to the caller while writing nothing. Returning an error would teach a bot to retry without the tell.
- Rate limit: more than 5 submissions per hour from one IP is rejected. Store a SHA-256 hash of the IP, never the raw IP.
- No CAPTCHA of any kind — the owner explicitly rejected it.
- The contact form's existing CMS markers (`data-cms-id` on labels, placeholders, dropdown, submit button) must survive untouched. Regressing the live CMS is a task failure.
- The 9 existing `#n1 #n2 #em #ph #dt #cl #ms #send #sent` element ids must not change — CMS markers and this plan both depend on them.

---

## File Structure

```
capturewithki/
  firebase.json                (new — functions config + deploy targets)
  .firebaserc                  (new — pins project capturewithki-69dd3)
  firestore.rules              (modify — add inquiries + rateLimits rules)
  index.html                   (modify — honeypot + render timestamp, replace #send handler)
  functions/
    package.json               (new — Node 20, firebase-admin, firebase-functions)
    .gitignore                 (new — node_modules)
    index.js                   (new — submitInquiry callable, thin: wires the pieces)
    lib/
      validate.js              (new — pure input validation, no I/O)
      spam.js                  (new — honeypot / timing / rate-limit checks)
      email.js                 (new — Resend calls + message templates)
    test/
      validate.test.js         (new — node:test)
      spam.test.js             (new — node:test)
      email.test.js            (new — node:test, template rendering only, no network)
```

`lib/` files are pure and dependency-light so they can be unit tested with Node's built-in test runner — no Firebase emulator, no network. `index.js` stays thin: it is the only file that touches Firestore or the network.

---

### Task 1: Functions scaffold and Firebase project config

**Files:**
- Create: `firebase.json`, `.firebaserc`, `functions/package.json`, `functions/.gitignore`, `functions/index.js`

**Interfaces:**
- Produces: a deployable (but trivial) functions setup that later tasks extend. Establishes Node 20 + region `us-west1`.

- [ ] **Step 1: Create `.firebaserc`**

```json
{
  "projects": {
    "default": "capturewithki-69dd3"
  }
}
```

- [ ] **Step 2: Create `firebase.json`**

```json
{
  "functions": [
    {
      "source": "functions",
      "codebase": "default",
      "runtime": "nodejs20",
      "ignore": ["node_modules", ".git", "*.log", "test"]
    }
  ],
  "firestore": {
    "rules": "firestore.rules"
  },
  "storage": {
    "rules": "storage.rules"
  }
}
```

- [ ] **Step 3: Create `functions/.gitignore`**

```
node_modules/
```

- [ ] **Step 4: Create `functions/package.json`**

```json
{
  "name": "capturewithki-functions",
  "description": "Cloud Functions for CaptureWithKi",
  "type": "module",
  "main": "index.js",
  "engines": { "node": "20" },
  "scripts": {
    "test": "node --test test/*.test.js"
  },
  "dependencies": {
    "firebase-admin": "^12.6.0",
    "firebase-functions": "^6.1.0"
  },
  "private": true
}
```

(The glob form `test/*.test.js` is required on Node 22+; the directory form `test/` fails with `MODULE_NOT_FOUND`.)

- [ ] **Step 5: Create a placeholder `functions/index.js`**

```js
import { onCall } from 'firebase-functions/v2/https';

export const submitInquiry = onCall({ region: 'us-west1' }, async () => {
  return { ok: true };
});
```

- [ ] **Step 6: Install and confirm it loads**

```bash
cd functions && npm install && node --input-type=module -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

Expected: prints `[ 'submitInquiry' ]` with no error.

- [ ] **Step 7: Commit the generated `functions/package-lock.json`**

`npm install` generates `functions/package-lock.json`. Commit it alongside the other files for reproducible deploys — two deploys on different days should pull identical transitive versions.

- [ ] **Step 8: Commit**

```bash
git add firebase.json .firebaserc functions/package.json functions/.gitignore functions/index.js functions/package-lock.json
git commit -m "Add Cloud Functions scaffold for contact form"
```

---

### Task 2: Input validation

**Files:**
- Create: `functions/lib/validate.js`, `functions/test/validate.test.js`

**Interfaces:**
- Produces: `validateInquiry(data)` → `{ valid: true, value: {...} }` or `{ valid: false, error: 'message' }`. Consumed by `index.js` in Task 5. The returned `value` is the cleaned, trimmed payload written to Firestore.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { validateInquiry } from '../lib/validate.js';

test('accepts a complete valid submission', () => {
  const r = validateInquiry({
    name: ' Sarah ', partnerName: 'Michael', email: 'sarah@example.com',
    phone: '8085550123', eventDate: '2026-09-12',
    sessionType: 'Engagement — $175', message: 'Hello!'
  });
  assert.equal(r.valid, true);
  assert.equal(r.value.name, 'Sarah');
  assert.equal(r.value.email, 'sarah@example.com');
});

test('accepts when optional fields are missing', () => {
  const r = validateInquiry({
    name: 'Sarah', email: 'sarah@example.com', phone: '8085550123',
    sessionType: 'Not sure yet'
  });
  assert.equal(r.valid, true);
  assert.equal(r.value.partnerName, '');
  assert.equal(r.value.eventDate, '');
  assert.equal(r.value.message, '');
});

test('rejects a missing name', () => {
  const r = validateInquiry({ email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /name/i);
});

test('rejects a malformed email', () => {
  const r = validateInquiry({ name: 'S', email: 'not-an-email', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /email/i);
});

test('rejects a missing phone', () => {
  const r = validateInquiry({ name: 'S', email: 'a@b.com', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /phone/i);
});

test('rejects absurdly long input', () => {
  const r = validateInquiry({
    name: 'S', email: 'a@b.com', phone: '1', sessionType: 'x',
    message: 'x'.repeat(5001)
  });
  assert.equal(r.valid, false);
  assert.match(r.error, /too long/i);
});

test('coerces non-string input rather than throwing', () => {
  const r = validateInquiry({ name: 123, email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, true);
  assert.equal(r.value.name, '123');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && node --test test/validate.test.js`
Expected: FAIL — cannot find module `../lib/validate.js`

- [ ] **Step 3: Implement**

```js
const MAX = { name: 200, partnerName: 200, email: 320, phone: 50, eventDate: 40, sessionType: 200, message: 5000 };

function str(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

export function validateInquiry(data) {
  const d = data || {};
  const value = {
    name: str(d.name),
    partnerName: str(d.partnerName),
    email: str(d.email),
    phone: str(d.phone),
    eventDate: str(d.eventDate),
    sessionType: str(d.sessionType),
    message: str(d.message)
  };

  for (const key of Object.keys(MAX)) {
    if (value[key].length > MAX[key]) {
      return { valid: false, error: 'That ' + key + ' is too long.' };
    }
  }
  if (!value.name) return { valid: false, error: 'Please add your name.' };
  if (!value.email) return { valid: false, error: 'Please add your email.' };
  // Deliberately permissive: one @, no spaces, a dot in the domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { valid: false, error: 'That email address does not look right.' };
  }
  if (!value.phone) return { valid: false, error: 'Please add your phone number.' };

  return { valid: true, value: value };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd functions && node --test test/validate.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/validate.js functions/test/validate.test.js
git commit -m "Add server-side inquiry validation"
```

---

### Task 3: Spam checks

**Files:**
- Create: `functions/lib/spam.js`, `functions/test/spam.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isBotSubmission({ honeypot, renderedAt, now })` → boolean. True when the honeypot has any value, or the form was submitted less than 3000ms after render.
  - `hashIp(ip)` → hex SHA-256 string.
  - `checkRateLimit(db, ipHash, now)` → `Promise<{ allowed: boolean }>`. Consumed by `index.js` in Task 5. Uses Firestore collection `rateLimits`, doc id = `ipHash`, fields `{ count, windowStart }`, 1 hour window, limit 5.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { isBotSubmission, hashIp, checkRateLimit } from '../lib/spam.js';

test('honeypot with any value is a bot', () => {
  assert.equal(isBotSubmission({ honeypot: 'x', renderedAt: 0, now: 999999 }), true);
});

test('submitting faster than 3 seconds is a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: 1000, now: 2500 }), true);
});

test('empty honeypot and a human pause is not a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: 1000, now: 20000 }), false);
});

test('a missing renderedAt is not treated as a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: undefined, now: 20000 }), false);
});

test('hashIp is stable and does not contain the raw ip', () => {
  const h = hashIp('203.0.113.7');
  assert.equal(h, hashIp('203.0.113.7'));
  assert.ok(!h.includes('203'));
  assert.equal(h.length, 64);
});

// Minimal fake Firestore: only what checkRateLimit uses.
function fakeDb(existing) {
  let stored = existing;
  return {
    saved: () => stored,
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: stored !== undefined, data: () => stored };
            },
            async set(v) { stored = v; }
          };
        }
      };
    }
  };
}

test('first submission is allowed and starts a window', async () => {
  const db = fakeDb(undefined);
  const r = await checkRateLimit(db, 'abc', 1000);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 1);
});

test('fifth submission inside the window is allowed', async () => {
  const db = fakeDb({ count: 4, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 2000);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 5);
});

test('sixth submission inside the window is blocked', async () => {
  const db = fakeDb({ count: 5, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 2000);
  assert.equal(r.allowed, false);
});

test('a new window resets the count', async () => {
  const db = fakeDb({ count: 5, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 1000 + 3600001);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && node --test test/spam.test.js`
Expected: FAIL — cannot find module `../lib/spam.js`

- [ ] **Step 3: Implement**

```js
import { createHash } from 'node:crypto';

const MIN_FILL_MS = 3000;
const WINDOW_MS = 3600000;
const MAX_PER_WINDOW = 5;

export function isBotSubmission(opts) {
  const o = opts || {};
  if (o.honeypot) return true;
  if (typeof o.renderedAt !== 'number' || !o.renderedAt) return false;
  return (o.now - o.renderedAt) < MIN_FILL_MS;
}

export function hashIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

export async function checkRateLimit(db, ipHash, now) {
  const ref = db.collection('rateLimits').doc(ipHash);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() : undefined;

  if (!prev || (now - prev.windowStart) >= WINDOW_MS) {
    await ref.set({ count: 1, windowStart: now });
    return { allowed: true };
  }
  if (prev.count >= MAX_PER_WINDOW) {
    return { allowed: false };
  }
  await ref.set({ count: prev.count + 1, windowStart: prev.windowStart });
  return { allowed: true };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd functions && node --test test/spam.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/spam.js functions/test/spam.test.js
git commit -m "Add honeypot, timing and rate-limit spam checks"
```

---

### Task 4: Email templates and Resend delivery

**Files:**
- Create: `functions/lib/email.js`, `functions/test/email.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ownerEmail(inquiry)` → `{ subject, text }`
  - `clientEmail(inquiry)` → `{ subject, text }`
  - `sendEmail({ apiKey, to, replyTo, subject, text })` → `Promise<void>`, throws on non-2xx.
  Consumed by `index.js` in Task 5.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { ownerEmail, clientEmail } from '../lib/email.js';

const full = {
  name: 'Sarah', partnerName: 'Michael', email: 'sarah@example.com',
  phone: '8085550123', eventDate: '2026-09-12',
  sessionType: 'Engagement — $175', message: 'We met hiking.'
};

test('owner subject names both people when a partner is given', () => {
  assert.equal(ownerEmail(full).subject, 'New inquiry — Sarah & Michael');
});

test('owner subject names one person when no partner', () => {
  const one = Object.assign({}, full, { partnerName: '' });
  assert.equal(ownerEmail(one).subject, 'New inquiry — Sarah');
});

test('owner body contains every submitted field', () => {
  const t = ownerEmail(full).text;
  for (const v of ['Sarah', 'Michael', 'sarah@example.com', '8085550123',
                   '2026-09-12', 'Engagement — $175', 'We met hiking.']) {
    assert.ok(t.includes(v), 'missing ' + v);
  }
});

test('owner body marks empty optional fields rather than leaving a blank', () => {
  const sparse = { name: 'Sarah', partnerName: '', email: 'a@b.com',
                   phone: '1', eventDate: '', sessionType: 'Not sure yet', message: '' };
  const t = ownerEmail(sparse).text;
  assert.ok(t.includes('Not given'));
});

test('client email greets by first name and promises 48 hours', () => {
  const e = clientEmail(full);
  assert.ok(e.text.includes('Sarah'));
  assert.match(e.text, /48 hours/);
  assert.ok(e.text.includes('Khiara'));
});

test('client subject is the fixed thank-you line', () => {
  assert.equal(clientEmail(full).subject, 'Thank you for reaching out — CaptureWithKi');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && node --test test/email.test.js`
Expected: FAIL — cannot find module `../lib/email.js`

- [ ] **Step 3: Implement**

```js
const FROM = 'CaptureWithKi <onboarding@resend.dev>';

function orNone(v) {
  return v && String(v).trim() ? String(v) : 'Not given';
}

export function ownerEmail(i) {
  const who = i.partnerName ? i.name + ' & ' + i.partnerName : i.name;
  const text = [
    'New inquiry from the CaptureWithKi contact form.',
    '',
    'Name:       ' + orNone(i.name),
    'Partner:    ' + orNone(i.partnerName),
    'Email:      ' + orNone(i.email),
    'Phone:      ' + orNone(i.phone),
    'Date:       ' + orNone(i.eventDate),
    'Session:    ' + orNone(i.sessionType),
    '',
    'Message:',
    orNone(i.message),
    '',
    'Reply to this email to answer them directly.'
  ].join('\n');
  return { subject: 'New inquiry — ' + who, text: text };
}

export function clientEmail(i) {
  const first = String(i.name || '').split(' ')[0] || 'there';
  const text = [
    'Hi ' + first + ',',
    '',
    'Thank you so much for reaching out — your inquiry came through and I have it.',
    '',
    'I will get back to you within 48 hours.',
    '',
    'Talk soon,',
    'Khiara',
    'CaptureWithKi'
  ].join('\n');
  return { subject: 'Thank you for reaching out — CaptureWithKi', text: text };
}

export async function sendEmail(opts) {
  const body = {
    from: FROM,
    to: [opts.to],
    subject: opts.subject,
    text: opts.text
  };
  if (opts.replyTo) body.reply_to = [opts.replyTo];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + opts.apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    // Deliberately does NOT include the request body or key in the message.
    throw new Error('Resend responded ' + res.status);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd functions && node --test test/email.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add functions/lib/email.js functions/test/email.test.js
git commit -m "Add inquiry email templates and Resend delivery"
```

---

### Task 5: The submitInquiry function

**Files:**
- Modify: `functions/index.js` (replace the Task 1 placeholder entirely)

**Interfaces:**
- Consumes: `validateInquiry` (Task 2); `isBotSubmission`, `hashIp`, `checkRateLimit` (Task 3); `ownerEmail`, `clientEmail`, `sendEmail` (Task 4).
- Produces: callable `submitInquiry`, region `us-west1`, secret `RESEND_API_KEY`. Returns `{ ok: true }` on success (and on silently-discarded bot submissions). Throws `HttpsError` with code `invalid-argument` for validation failures, `resource-exhausted` for rate limiting, `internal` if the Firestore write fails.

- [ ] **Step 1: Replace `functions/index.js`**

```js
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { validateInquiry } from './lib/validate.js';
import { isBotSubmission, hashIp, checkRateLimit } from './lib/spam.js';
import { ownerEmail, clientEmail, sendEmail } from './lib/email.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const OWNER_EMAIL = 'netherlyk23@gmail.com';

initializeApp();
const db = getFirestore();

export const submitInquiry = onCall(
  { region: 'us-west1', secrets: [RESEND_API_KEY], cors: true },
  async (request) => {
    const data = request.data || {};
    const now = Date.now();

    // Bots get a cheerful success and nothing else. An error would just
    // teach them to retry without the tell.
    if (isBotSubmission({ honeypot: data.honeypot, renderedAt: data.renderedAt, now: now })) {
      return { ok: true };
    }

    const check = validateInquiry(data);
    if (!check.valid) {
      throw new HttpsError('invalid-argument', check.error);
    }
    const inquiry = check.value;

    const ip = (request.rawRequest && request.rawRequest.ip) || 'unknown';
    const limit = await checkRateLimit(db, hashIp(ip), now);
    if (!limit.allowed) {
      throw new HttpsError(
        'resource-exhausted',
        'That is a lot of inquiries in a short time. Please try again later, or email hello@capturewithki.com directly.'
      );
    }

    // Record FIRST. A failed email is recoverable; a lost inquiry is not.
    let ref;
    try {
      ref = await db.collection('inquiries').add(Object.assign({}, inquiry, {
        createdAt: FieldValue.serverTimestamp(),
        status: 'new',
        emailToOwnerSent: false,
        emailToClientSent: false
      }));
    } catch (err) {
      throw new HttpsError(
        'internal',
        'Something went wrong saving your inquiry. Please email netherlyk23@gmail.com directly.'
      );
    }

    const key = RESEND_API_KEY.value();
    const errors = [];

    try {
      const m = ownerEmail(inquiry);
      await sendEmail({ apiKey: key, to: OWNER_EMAIL, replyTo: inquiry.email, subject: m.subject, text: m.text });
      await ref.update({ emailToOwnerSent: true });
    } catch (err) {
      errors.push('owner: ' + err.message);
    }

    try {
      const m = clientEmail(inquiry);
      await sendEmail({ apiKey: key, to: inquiry.email, subject: m.subject, text: m.text });
      await ref.update({ emailToClientSent: true });
    } catch (err) {
      errors.push('client: ' + err.message);
    }

    if (errors.length) {
      await ref.update({ emailError: errors.join('; ') });
    }

    // The inquiry is safely recorded either way, so the visitor sees success.
    return { ok: true };
  }
);
```

- [ ] **Step 2: Confirm it loads and the full suite passes**

```bash
cd functions && npm test && node --input-type=module -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

Expected: all 22 tests pass; prints `[ 'submitInquiry' ]`.

- [ ] **Step 3: Commit**

```bash
git add functions/index.js
git commit -m "Add submitInquiry callable function"
```

---

### Task 6: Firestore rules for inquiries and rate limits

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Consumes: the existing `isAdmin()` helper already in the file.
- Produces: `inquiries` readable only by an admin, writable by no client; `rateLimits` closed to all clients.

- [ ] **Step 1: Add both blocks**

Insert immediately before the existing `match /admins/{uid}` block:

```
    // Inquiries hold client contact details, so unlike the CMS collections
    // they are NOT publicly readable. Only the function writes them, via the
    // Admin SDK, which bypasses these rules entirely.
    match /inquiries/{id} {
      allow read: if isAdmin();
      allow write: if false;
    }

    // Spam bookkeeping, written only by the function.
    match /rateLimits/{ipHash} {
      allow read: if false;
      allow write: if false;
    }
```

- [ ] **Step 2: Deploy the rules**

```bash
firebase deploy --only firestore:rules --project capturewithki-69dd3
```

Expected: `Deploy complete!`

- [ ] **Step 3: Verify the public cannot read inquiries**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://firestore.googleapis.com/v1/projects/capturewithki-69dd3/databases/(default)/documents/inquiries"
```

Expected: `403`. Anything else is a task failure — stop and report.

- [ ] **Step 4: Confirm the CMS collections still read publicly**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://firestore.googleapis.com/v1/projects/capturewithki-69dd3/databases/(default)/documents/heroSlides"
```

Expected: `200`. A 403 here means the rules edit broke the live site — stop and report.

- [ ] **Step 5: Commit**

```bash
git add firestore.rules
git commit -m "Close inquiries and rateLimits to client access"
```

---

### Task 7: Wire the browser form to the function

**Files:**
- Modify: `index.html` (honeypot + render timestamp in the contact form markup; replace the `#send` handler in the classic `<script>` block, currently at lines 1105-1117)

**Interfaces:**
- Consumes: callable `submitInquiry` (Task 5).
- Produces: a working end-to-end submission from the live page.

- [ ] **Step 1: Add the honeypot field**

In the contact form, immediately before `<button class="submit" id="send" ...>`, insert:

```html
        <div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" type="text" tabindex="-1" autocomplete="off"></div>
```

- [ ] **Step 2: Hide the honeypot**

Append to the `<style>` block in `<head>`:

```css
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
```

It must be off-screen rather than `display:none` — some bots skip fields that are explicitly hidden.

- [ ] **Step 3: Replace the `#send` handler**

Delete the whole existing `/* ---------- inquiry ---------- */` block (lines 1105-1117, from the comment through the closing `});`) and put in its place:

```js
  /* ---------- inquiry ---------- */
  var formRenderedAt = Date.now();
  var sendBtn = document.getElementById('send');

  sendBtn.addEventListener('click', function(){
    var note = document.getElementById('sent');
    var name = document.getElementById('n1').value.trim();
    var mail = document.getElementById('em').value.trim();
    var phone = document.getElementById('ph').value.trim();

    if(!name || !mail || !phone){
      note.textContent = 'Add your name, email, and phone so Khiara can reply.';
      note.classList.add('show');
      return;
    }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)){
      note.textContent = 'That email address does not look right.';
      note.classList.add('show');
      return;
    }
    // cms/inquiry.js defines this. If the Firebase CDN was unreachable the
    // module never ran, and clicking Send would otherwise throw silently.
    if(typeof window.cmsSubmitInquiry !== 'function'){
      note.textContent = 'The form is not available right now. Please email netherlyk23@gmail.com directly.';
      note.classList.add('show');
      return;
    }

    sendBtn.disabled = true;
    note.textContent = 'Sending…';
    note.classList.add('show');

    window.cmsSubmitInquiry({
      name: name,
      partnerName: document.getElementById('n2').value.trim(),
      email: mail,
      phone: phone,
      eventDate: document.getElementById('dt').value,
      sessionType: document.getElementById('cl').value,
      message: document.getElementById('ms').value.trim(),
      honeypot: document.getElementById('website').value,
      renderedAt: formRenderedAt
    }).then(function(){
      note.textContent = 'Thank you — your inquiry is on its way. Expect a reply within 48 hours.';
      document.getElementById('n1').value = '';
      document.getElementById('n2').value = '';
      document.getElementById('em').value = '';
      document.getElementById('ph').value = '';
      document.getElementById('dt').value = '';
      document.getElementById('ms').value = '';
    }).catch(function(err){
      note.textContent = (err && err.message)
        ? err.message
        : 'Something went wrong. Please email netherlyk23@gmail.com directly.';
    }).then(function(){
      sendBtn.disabled = false;
    });
  });
```

The handler calls `window.cmsSubmitInquiry`, defined in Step 4. The classic script is not a module and cannot import the Firebase SDK itself.

- [ ] **Step 4: Create the module bridge**

Create `cms/inquiry.js`:

```js
import { app } from './firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const functions = getFunctions(app, 'us-west1');
const callable = httpsCallable(functions, 'submitInquiry');

// The contact form lives in index.html's classic (non-module) script, which
// cannot import the SDK, so the callable is handed over on window.
window.cmsSubmitInquiry = function (payload) {
  return callable(payload).then(function (res) { return res.data; });
};
```

- [ ] **Step 5: Load the bridge**

In `index.html`, immediately after the existing `<script type="module" src="cms/main.js"></script>`, add:

```html
<script type="module" src="cms/inquiry.js"></script>
```

- [ ] **Step 6: Verify locally (no deploy needed for this step)**

Serve the worktree and load the contact page. Confirm:
- the honeypot input is not visible and does not appear in the tab order
- clicking Send with empty fields still shows the existing validation message
- clicking Send with a bad email shows the email message
- the CMS still works on this page: labels, placeholders and the dropdown still carry their `data-cms-id` attributes (count them, expect 7 labels + 5 placeholder fields + 1 select)

- [ ] **Step 7: Commit**

```bash
git add index.html cms/inquiry.js
git commit -m "Wire contact form to submitInquiry function"
```

---

### Task 8: Deploy and end-to-end verification

**Files:**
- Modify: `README.md` (document the backend)

**Interfaces:** none — this task deploys and proves the whole path.

- [ ] **Step 1: Confirm the secret exists**

```bash
firebase functions:secrets:access RESEND_API_KEY --project capturewithki-69dd3 >/dev/null && echo "secret present"
```

Expected: `secret present`. If it errors, the owner has not set it yet — stop and report; do not proceed and do not put a key anywhere else.

- [ ] **Step 2: Deploy the function**

```bash
firebase deploy --only functions --project capturewithki-69dd3
```

Expected: `Deploy complete!` and a `submitInquiry` URL in `us-west1`.

- [ ] **Step 3: Real end-to-end submission**

With the site served locally, fill the contact form using a real test email address the tester controls (NOT the owner's). Wait more than 3 seconds before submitting so the timing check passes. Submit.

Confirm all of:
- the page shows the thank-you message and the fields clear
- a new document exists in Firestore `inquiries` with `status: "new"`, `emailToOwnerSent: true`, `emailToClientSent: true`, and no `emailError`
- the test address receives the thank-you email
- the owner's inbox receives the inquiry, and pressing Reply addresses the test address, not Resend

- [ ] **Step 4: Verify the bot path writes nothing**

In the browser console on the contact page:

```js
window.cmsSubmitInquiry({name:'Bot',email:'bot@example.com',phone:'1',sessionType:'x',honeypot:'gotcha',renderedAt:Date.now()}).then(console.log)
```

Expected: logs `{ok: true}`, and NO new document appears in `inquiries`. A document appearing here is a task failure.

- [ ] **Step 5: Verify the rate limit**

Submit 6 valid inquiries in quick succession (waiting >3s each). The 6th must be rejected with the "that is a lot of inquiries" message, and only 5 documents may be added.

- [ ] **Step 6: Verify inquiries stay private**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://firestore.googleapis.com/v1/projects/capturewithki-69dd3/databases/(default)/documents/inquiries"
```

Expected: `403`.

- [ ] **Step 7: Confirm no secret leaked into the repo**

```bash
git -C . grep -rn "re_" -- . ':!*.md' || echo "no Resend key in tracked files"
```

Expected: no key. Any hit is a task failure — stop and report.

- [ ] **Step 8: Document it in `README.md`**

Add after the existing CMS section:

```markdown
## Contact form

Submissions go to a Firebase Cloud Function (`functions/index.js`,
`submitInquiry`, region `us-west1`) which records the inquiry in the
Firestore `inquiries` collection and then sends two emails through Resend:
one to Khiara with the client's address as Reply-To, and a thank-you to the
client.

The inquiry is saved **before** the emails are sent, so a delivery failure
never loses an inquiry — it shows up in the database with `emailError` set.

Inquiries are readable only by a logged-in admin and cannot be written from
a browser at all.

To deploy after changing anything under `functions/`:

```bash
firebase deploy --only functions --project capturewithki-69dd3
```

The Resend API key is stored as a Firebase secret named `RESEND_API_KEY`
and is never committed. To rotate it:

```bash
firebase functions:secrets:set RESEND_API_KEY --project capturewithki-69dd3
firebase deploy --only functions --project capturewithki-69dd3
```

Emails currently send from a `resend.dev` address because the project has no
custom domain. Buying `capturewithki.com` and verifying it in Resend would
let mail come from `hello@capturewithki.com`; only the `FROM` constant in
`functions/lib/email.js` would need changing.
```

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "Document the contact form backend"
```

---

## Deferred to later sub-projects

- **Admin dashboard** — displays these inquiries, marks them read/replied, and surfaces any with `emailError`. Next sub-project; needs its own spec.
- **Client galleries** — secret link + password, auto-expiring. Its own spec.
- **Payments and contracts** — deferred by the owner.
- **Inquiry retention** — nothing prunes old inquiries. Revisit once there are hundreds.
- **CMS-editable auto-reply wording** — hardcoded in `functions/lib/email.js` for now.
