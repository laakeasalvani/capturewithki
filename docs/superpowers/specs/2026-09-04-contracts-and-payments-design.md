# Contracts, signatures and retainer payments — design

**Date:** 2026-09-04
**Status:** Approved, ready for an implementation plan
**Supersedes:** the "deliberately deferred" note at CLAUDE.md outstanding item #4

---

## What this is

Khiara books a client. Today she has no contract, no way to collect a retainer,
and no record of either. This builds both into `/int/`: she presses one button
on an inquiry, the client gets a link, reads the contract, signs it by typing
their name, and pays the retainer — in one sitting.

Her site already promises the terms this has to honour, at `index.html:964`:

> "A signed agreement and a 30% retainer lock it in. The balance can be split monthly."

That sentence is a commitment to a paying client. The design treats it as a
requirement, not a nice-to-have.

## What this is not

**We do not write the contract's clauses.** Cancellation, image licensing,
liability, rescheduling and force majeure come from a purchased photographer
template or an Oregon attorney. The system takes the words as input and is
responsible only for delivering, signing, hashing and retaining them.

**Card data never touches our code.** Payment happens on a Stripe-hosted
Checkout page. This keeps Khiara in PCI SAQ-A rather than SAQ-D.

**We do not build dunning.** Where installments arrive later, Stripe Billing's
scheduled invoices and retry logic do that work.

---

## Context that shaped the decisions

Gathered 2026-09-04:

| Fact | Consequence |
|---|---|
| No contract or payment process exists today | Building from zero; no migration |
| Next booking is weeks out | Time to build properly, not time for a months-long project |
| ~25–50 bookings expected in 12 months | Automation is worth building; manual chasing will not survive |
| **Khiara has relocated to Hawaii → Oregon** and now shoots local work | **No sales tax and no GET — invoices carry no tax line at all** |
| **She has no Stripe account** | Critical path. Verification takes days and only she can do it |
| Packages run roughly $175–$1,200+ | Retainers of roughly $52–$360 |
| Travel is quoted per trip, at cost | Invoices need free-form line items, not fixed prices |

The Oregon move also means the live site's Hawaii copy is now wrong
(`index.html` lines 579, 661, 979, 1016 — including a travel clause that is
exactly inverted). That is tracked separately and is **not** in this scope, but
the contract's travel clause depends on the answer, so it should land first.

### Decisions taken

| Question | Decision |
|---|---|
| Build or buy | Custom, inside `/int/` |
| Signature capture | Our own signing page; we own the audit trail |
| Contract format | HTML template in Firestore with merge fields |
| Flow | One sitting: open → read → sign → pay |
| Signers | One |
| Payment methods | Cards + Apple Pay / Google Pay / Link. No ACH, no BNPL |
| Tax | None (Oregon) |
| Entry point | "Send contract" button on an inquiry |
| Stalled deals | Auto-remind the client, then alert her |
| Installments | Out of scope for v1; data model must not preclude them |

---

## Architecture

### Files

| File | Purpose |
|---|---|
| `functions/lib/contracts.js` | **Pure.** Merge-field rendering, document hashing, state machine, validation. No Firebase imports. |
| `functions/lib/chase.js` | **Pure.** Which contracts are due a reminder or escalation. Modelled on `escalate.js`. |
| `functions/lib/stripe.js` | Stripe client, Checkout session creation, webhook signature verification. |
| `functions/lib/contract-email.js` | Email bodies, following the conventions already established in `email.js`. |
| `sign/index.html`, `sign/sign.js` | Client-facing signing page. Static, no build step, Firebase SDK pinned to `10.13.0`. |
| `int/contracts.js` | Dashboard tab. |
| `firestore.rules` | Immutability for signed contracts; append-only audit. |

The `lib/` split is not decoration. `escalate.js` earned its keep by making
every timing boundary testable without Firebase, and the same applies here to
money arithmetic and state transitions.

### Cloud Functions

| Function | Type | Auth | Does |
|---|---|---|---|
| `createContract` | `onCall` | Admin | Creates a draft from an inquiry |
| `sendContract` | `onCall` | Admin | Mints token, freezes snapshot, hashes it, emails the client |
| `openContract` | `onCall` | Token | Returns the document; stamps `firstOpenedAt`, increments `openCount` |
| `signContract` | `onCall` | Token | Writes the immutable signature, returns a Checkout URL |
| `stripeWebhook` | `onRequest` | Stripe signature | The **only** thing that may mark a contract paid |
| `chaseContracts` | `onSchedule` | Hourly | Client reminders, escalation to her, Stripe reconciliation |

`openContract` and `signContract` follow `openGallery`: token in, minimal data
out, and **no reason given on failure**. Telling a caller "expired" rather than
"not found" confirms an id is real, which is what probing looks for. That
reasoning is already written down in `gallery-auth.js` and applies unchanged.

### Data model

```
contracts/{contractId}
  status: draft | sent | opened | signed | paid | void
  inquiryId                          // nullable — see "clients who never inquired"
  clientName, clientEmail, clientPhone
  eventDate, eventLocation
  lineItems: [{ label, amountCents }]
  totalCents, retainerCents, balanceCents
  templateId, templateVersion
  documentSnapshot                   // exact rendered text, frozen at send
  documentHash                       // sha256 of documentSnapshot
  tokenHash                          // sha256 of the token; never the token
  stripeSessionId, stripePaymentIntentId
  sentAt, firstOpenedAt, openCount, signedAt, paidAt
  lastReminderAt
  signReminderCount                  // pre-signature ladder, caps at 2
  payReminderCount                   // pre-payment ladder, caps at 3
  escalatedAt

contracts/{contractId}/audit/{eventId}    // append-only: created|sent|opened|signed|paid|voided
contractTemplates/{templateId}            // HTML with merge fields, versioned
packages/{packageId}                      // label + default amount, editable in /int/
```

`inquiryId` is nullable on purpose. v1 only ships the "Send contract" button on
an inquiry, but a meaningful share of bookings at 25–50/yr will arrive through
Instagram or referral and never touch the contact form. Making the field
optional now means adding a blank-start path later is a UI addition, not a
schema migration.

### Token handling — a deliberate divergence

Gallery passwords use scrypt at cost 2^14. That is correct **there**: they are
eight human-typed characters, shared aloud between a couple, and that is
precisely the shape an offline guessing attack eats.

A contract token is 32 random bytes. Guessing is not a threat at 256 bits, so
scrypt buys latency and nothing else. Contract tokens are stored as a plain
SHA-256 hash, compared with `timingSafeEqual`.

Recording this so it reads as a decision in review rather than an oversight.

---

## The happy path

1. She opens an inquiry in `/int/` and presses **Send Contract**
2. Picks a package (prefills line items), adds travel if any, confirms the total.
   **The retainer auto-computes at 30% and stays editable**
3. Previews the contract exactly as the client will see it
4. Sends. Token minted, snapshot frozen and hashed, email sent via Resend
5. Client opens the link, reads, ticks the ESIGN consent box, types their full
   legal name, presses **"I agree and sign"**
6. `signContract` writes the immutable signature record and returns a Stripe
   Checkout URL; the page redirects there
7. Client pays by card or wallet
8. **`stripeWebhook`** flips the status to `paid`
9. Both parties get the countersigned PDF and a receipt; the dashboard shows the
   date as locked

**Step 8 is load-bearing.** The browser's success redirect can be closed,
blocked or forged, so it is never the source of truth about money. Only the
signature-verified webhook is.

---

## The signature and its audit trail

ESIGN and UETA make an electronic signature enforceable when five things hold.
Each maps to something concrete:

| Requirement | How it is met |
|---|---|
| **Intent to sign** | An affirmative act on a button labelled "I agree and sign". Never a pre-ticked box, never "Submit" |
| **Consent to electronic records** | An explicit disclosure the client accepts, with the disclosure's version recorded |
| **Attribution** | A tokenized link sent only to the email address on the inquiry, plus IP and user-agent |
| **Association with the record** | `documentHash` binds the signature to the exact words shown |
| **Retention** | Immutable snapshot, permanent tokenized page, emailed copy, downloadable PDF |

Written on signing:

```
typedName            // exactly what they typed
signedAt             // SERVER timestamp
ip                   // from X-Forwarded-For
userAgent
documentHash
documentSnapshot
tokenId
consentGiven
consentTextVersion
```

Three things that carry the weight:

**The timestamp is the server's, never the browser's.** This project has already
been bitten once by trusting a client clock — the spam check that would have
binned real clients whose phone ran fast. The consequence here is worse.

**The hash binds the signature to the words.** If the template is later edited,
the stored hash no longer matches the new text, which is what proves the signed
version was not swapped. This is the whole of the tamper-evidence argument.

**Signed contracts are immutable in `firestore.rules` — but field-scoped, not
whole-document.** Once `signedAt` exists, these fields can never change:

```
clientName, clientEmail, eventDate, eventLocation,
lineItems, totalCents, retainerCents, balanceCents,
templateId, templateVersion, documentSnapshot, documentHash,
signedAt, and the entire signature record
```

These must still be writable afterwards, or the payment can never be recorded:

```
status, paidAt, stripeSessionId, stripePaymentIntentId,
openCount, lastReminderAt, reminderCount, escalatedAt
```

This needs the same `affectedKeys` guard already used to pin `seenAt` to
`request.time`. Without it, every later write is refused for carrying an
existing frozen field that has not actually changed — which is exactly the bug
that guard was added to fix the first time.

A blanket "no updates after signing" rule would block the Stripe webhook and
strand every contract at `signed` while the money had already moved.

A typed name is sufficient. ESIGN defines a signature as any "symbol or
process… executed or adopted by a person with the intent to sign." An optional
draw-your-signature canvas can sit alongside it for people who expect one, but
it adds no legal weight.

---

## Failure handling

| State | Meaning | Response |
|---|---|---|
| Sent, never opened | **May be spam-filed** | Alert **her** at 48h so she can text them |
| Opened, not signed | Thinking about it | Client reminders at 24h and 72h, then stop |
| Signed, not paid | **Dangerous** — bound but the date is not held | Client reminders at 1h, 24h, 72h; at 7 days flag the dashboard loudly and email her |
| Paid, webhook missed | Money taken, status stale | `chaseContracts` reconciles against Stripe for anything signed-but-unpaid over ~15 minutes |
| Signed twice | Token replayed | `signContract` is idempotent: returns the existing Checkout URL, never a second signature or session |
| Checkout expired | Stripe sessions expire in 24h | The contract page regenerates a session on demand while unpaid |
| Template edited after send | — | Harmless; the snapshot is frozen at send and the live template is irrelevant |

**"Sent, never opened" is the inquiry bug wearing a different hat.** Resend
returning 200 means queued, not delivered, and Gmail reports a spam-filed
message as delivered. No signal the sending side produces can detect this. So
the system watches the only thing that survives it — whether the client ever
actually opened the document — exactly as `escalateUnreadInquiries` watches
whether an inquiry was ever displayed.

**A signed contract is never auto-voided.** Auto-cancelling something a client
did sign is legally awkward and would burn a slow-but-real client. She decides;
the system only makes the situation impossible to miss.

**Refunds happen in the Stripe dashboard.** We reflect `charge.refunded` and
nothing more. A refund button in `/int/` is too easy to misclick for what it does.

---

## Security

- **The browser never states an amount.** The Checkout session is built from the
  Firestore contract server-side. Otherwise a client pays $1 and holds a signed
  contract.
- **Money is integer cents, never floats.** `balanceCents = totalCents −
  retainerCents`, **by subtraction**. Computing the balance as 70% independently
  means the two do not sum to the total on odd amounts.
- **Webhook verification uses `req.rawBody`,** not parsed JSON. Parsing the body
  first silently breaks signature verification.
- **The restricted Stripe key lives in Firebase Secrets** and falls under hard
  rule #2: never printed, logged, echoed or committed.
- **`escapeHtml` on every merge field.** The client's own name is rendered into
  both the contract HTML and the emails. `email.js` already documents why.
- **Clients get no direct Firestore access.** Everything goes through functions.
- **No rate limit on token lookup — deliberate.** The gallery password limiter
  was removed (`0b0e8e6`) after causing a real bug (`bfd839b`, "gallery password
  being refused when it was correct"). A 256-bit token is not brute-forceable,
  so a limiter here would add a failure mode and buy nothing.

---

## Chasing (`chase.js`)

A pure function of `(contracts, now) → actions`, so every boundary is testable
without Firebase. Mirrors `escalate.js`, including:

- A **30-day ceiling**, so the back catalogue cannot flood the first run. This
  guard was needed in `escalate.js` for the same reason.
- Reminders capped, and **counted separately per ladder** —
  `signReminderCount` caps at 2, `payReminderCount` at 3. A single shared
  counter would mean a client who used both nudges before signing arrives at
  the payment stage already capped and is never chased for the retainer, which
  is the one thing this system exists to collect.
- An alarm she learns to ignore is worse than none.
- The **dashboard badge is the primary signal**; email to her is the backup.
  Maintainer alerts stay reserved for genuine system failures.

---

## Testing

`node --test` under `functions/test/`, matching the existing suite. Beyond the
happy path:

- **Hostile input** — client names containing HTML, newlines, 10,000
  characters, empty strings, unicode; amounts negative, zero, non-numeric,
  fractional cents; event dates in the past; tokens of the wrong length and
  shape. This project has already shipped validation that crashed on hostile
  input once, from a plan rather than an implementation.
- **Money arithmetic** — rounding at odd totals; retainer and balance always
  summing exactly to the total.
- **Webhooks** — replay, bad signature, unknown event type, and **out-of-order
  delivery** where `paid` arrives before `signed`.
- **`chase.js` boundaries** — exactly at 24h, 48h, 72h, 7d, and the 30-day
  ceiling.
- **Idempotency** — signing twice, paying twice, webhook delivered twice.

Then a full pass in **Stripe test mode**, and finally one live-mode charge she
makes to herself and refunds, before any client sees it.

Per hard rule #7: run `npm test` in `functions/` and read the output. A subagent
has already once reported passing tests for a command that was erroring.

---

## Rollout order

1. **Khiara creates the Stripe account.** Start immediately — see appendix
2. **She obtains the contract** — purchased template or Oregon attorney
3. Build against Stripe test mode while 1 and 2 are in flight
4. Transcribe her contract into the HTML template
5. Live-mode self-test: charge $1, refund it
6. First real client

Steps 1 and 2 are hers, both have real lead time, and everything else waits on
them. That is why they are first.

---

## Out of scope for v1

- **Installments.** The site promises them and the data model leaves room, but
  v1 ships retainer-only. When built, Stripe Billing's scheduled invoices and
  retry logic do the dunning; we do not hand-roll it.
- **The balance invoice.** She sends it manually until installments land.
- **Blank-start contracts** for clients who never inquired. Schema supports it;
  UI comes later.
- **Two signers.** One signer is enough per the decision above.
- **Refunds from `/int/`.** Stripe dashboard only.
- **Updating the site's Hawaii copy.** Tracked separately, but it should land
  before the contract's travel clause is written.

---

## Appendix: Stripe account setup — steps for Khiara

Laakea cannot do these. Stripe needs her legal identity and her bank account,
and hard rule #3 says her logins are hers.

**Before starting, have ready:**
- Her legal name and date of birth
- Her Social Security Number (a sole proprietor may use an SSN; an EIN is only
  needed if she has registered a business entity)
- Her Oregon home or business address
- Her bank account and routing numbers
- Her phone

**Steps:**

1. Go to **stripe.com** and press **Sign up** (top right).
2. Enter her email, full name, and a password. Use a password she does not use
   anywhere else. Country: **United States**.
3. Confirm the email Stripe sends her.
4. Turn on two-factor authentication when asked. Choose the phone-text option
   if she is unsure. Do not skip it — this account moves money.
5. Stripe asks what the business is. Answer roughly:
   - Type of business: **Individual / Sole proprietor** (unless she has
     registered an LLC in Oregon, in which case pick that and use its EIN)
   - Industry: **Photography** — or the closest option under professional
     services
   - Website: **capturewithki.com**
   - What she sells: wedding and portrait photography services
6. Enter her address, date of birth, and SSN. Stripe needs these by law to
   verify identity. This is normal.
7. Add the bank account that should receive her money. Double-check the routing
   and account numbers — a typo here delays payouts by days.
8. Set the statement descriptor — the text clients see on their card statement.
   Use **CAPTUREWITHKI**. If it says something unrecognisable, clients report
   the charge as fraud.
9. When Stripe says the account is complete, **tell Laakea**. Do not send him a
   password or an API key by message.

Stripe's exact button wording changes from time to time; the order of these
steps is stable even when a label is not.

**Then, and only when she asks him to:** Laakea creates a *restricted* API key
in the Stripe dashboard, stores it in Firebase Functions Secrets, and never
prints or commits it.

Verification usually completes within a day or two but can take longer if
Stripe asks for a photo of her ID. This is why it goes first.
