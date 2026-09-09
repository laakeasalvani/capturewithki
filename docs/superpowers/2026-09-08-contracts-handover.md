# Contracts — what a human has to do before this works

Branch: `contracts-and-payments`. Nothing here is deployed. **The code is finished and
the system does nothing until the steps below are done by hand.**

Everything was built without ever deploying, writing to Firestore, or opening a console,
because `capturewithki-69dd3` is production and there is no staging project.

---

## 1. Three things only Khiara can answer

Do not skip these. Each one lands inside a document a client signs.

### a. Her Grand Package contract names the wrong package

Her PDF reads *"the selected **The Classic** 8-Hour Package"* above the Grand's own 8
hours and 400+ images. Someone copy-pasted from the Classic and missed one word.

The template we built corrects it. **Her PDF still needs fixing** so the two agree — if
a client ever compares the signed contract to the file she sent, they should match.

### b. Every price on her site is a placeholder — her own markup says so

`index.html:110` — *"Pricing is placeholder"*
`index.html:693` — *"PLACEHOLDER PRICING — replace every figure below before launch"*

**No package may be loaded with a price she has not confirmed.** A wrong price here is
not a typo on a website; it is a number in a signed agreement.

### c. The portrait specs are blank in her PDF

Her Portrait contract has empty lines where these should be, and they differ by session
type. Nothing can send a portrait contract until she fills this in:

| Session type | Minutes | Edited images | Locations | Outfit changes |
|---|---|---|---|---|
| Couples | | | | |
| Engagement | | | | |
| Family | | | | |
| Maternity | | | | |
| Senior | | | | |

---

### d. Wedding prices are a floor, not a price — and the code cannot hold a floor

Her site reads *"Starting from $750 / $1,000 / $1,200"* for The Intimate, The Classic and
The Grand. A contract cannot say "starting from": `createContract` sets
`packagePriceCents: pkg.priceCents` (`functions/index.js:560`) and the only money the
caller may supply is `travelFeesCents`.

So confirming the three wedding numbers is not enough. She has to decide:

- **Fixed price per package** — the three figures become real prices, the "starting
  from" wording comes off the site, and nothing needs building; or
- **Quoted per booking** — someone builds a per-contract price field first. Nothing
  ships a wedding contract until that exists.

Elopement ($300) and the five portrait sessions are single figures already and do not
have this problem.

### e. The portrait specs exist on her SITE even though the PDF is blank

`index.html` carries all four required specs for every session type. These are
candidates for her to confirm or correct, **not values to load as-is** — the pricing
above them is flagged placeholder in her own markup:

| Session | Minutes | Edited images | Locations | Outfit changes |
|---|---|---|---|---|
| Couples | 60 | 30–50 | 1 | 1 |
| Engagement | 60 | 75+ | 1 | 2 |
| Family | 60 | 50+ | 1 | **missing** |
| Maternity | 60 | 50+ | 1 | 1 |
| Senior | 30–45 | 25+ | 1 | 2 |

Two real gaps remain: **Family has no outfit-change figure anywhere**, and
`specs.outfitChanges` is required for the portrait template, so a Family contract is
refused until she gives one. And Senior's *"Add a friend: +$25, +15 min"* has no field
in the schema — decide whether it becomes a separate package or is dropped.

---

## 2. The contract templates are NOT in this repository, deliberately

**This repository is public.** That was verified during the build — an unauthenticated
`curl` of `raw.githubusercontent.com` returns files from it. Her contracts are her
terms, her cancellation schedule and her liability limits, so none of that text was ever
committed. Git history is not private just because a file is deleted later.

The three templates are at:

```
~/Desktop/CaptureWithKi Contract Templates/
    wedding.html      serves Intimate, Classic and Grand
    elopement.html
    portrait.html     serves all five session types
```

Each was transcribed from her PDF verbatim and verified by diffing the rendered output
against the extracted PDF text word by word — not by reading it. The only intended
differences are the merge values, the Grand correction above, and PDF header artifacts.

**Keep them out of the repo.** Load them into Firestore by hand.

---

## 3. Loading Firestore by hand

### The templates

For each of the three files, in the Firebase console → Firestore → `contractTemplates`,
create a document whose ID is exactly `wedding`, `elopement` or `portrait` — the code
looks them up by that exact key:

| Field | Value |
|---|---|
| `html` | paste the entire file contents |
| `version` | `1` |
| `isDraft` | `true` — see below |
| `name` | e.g. "Wedding agreement" |

**Leave `isDraft: true` until Khiara has read the template and confirmed it.** A template
marked draft cannot be sent — that guard is the only thing standing between a
half-checked document and a client's inbox. Flip it to `false` only when she has
approved that exact text.

### The packages

In `packages`, one document per package. Nine in total: three wedding, one elopement,
five portrait.

| Field | Notes |
|---|---|
| `label` | what SHE picks from, e.g. "The Grand — 8 Hours" |
| `templateKey` | exactly `wedding`, `elopement` or `portrait` |
| `priceCents` | **cents, not dollars.** $1,200 is `120000`. Confirmed prices only. This is the ONLY price a contract can carry — `createContract` reads `pkg.priceCents` and there is no per-contract override, so a "starting from" figure cannot be represented. See §1d |
| `order` | display order |
| `active` | `true` |
| `specs.packageName` | what the CONTRACT says, e.g. "The Grand 8-Hour Package" |

Then the template-specific specs:

- **wedding and elopement:** `specs.hours`, `specs.editedImages`
- **portrait:** `specs.sessionMinutes`, `specs.editedImages`, `specs.locations`, `specs.outfitChanges`

`label` and `specs.packageName` are deliberately different — her site says "The Grand —
8 Hours" and her contract says "The Grand 8-Hour Package", and neither should be forced
to match the other.

A package missing a required spec, or carrying one that belongs to a different template,
is refused when she tries to use it, with a message naming the field.

---

## 4. Deploy order

1. `firebase deploy --only firestore:rules --project capturewithki-69dd3`
2. Load the templates and packages as above
3. `firebase deploy --only functions --project capturewithki-69dd3`
   — never a bare `firebase deploy`
4. Send a contract to your own address, open it on a phone, sign it, and confirm the
   dashboard shows it correctly at each step
5. Only then flip a template's `isDraft` to `false`

**Payments are off**, but the Stripe secrets must still EXIST or the functions deploy
fails outright:

```
Error: In non-interactive mode but have no value for the secret STRIPE_SECRET_KEY
```

Four functions bind `STRIPE_SECRET_KEY` at deploy time (`signContract`,
`startRetainerPayment`, `stripeWebhook`, `chaseContracts`) and two bind
`STRIPE_WEBHOOK_SECRET`. That binding is deliberate — see the comment at
`functions/index.js:971`. Deploy-time binding is not the same as needing a valid key:
`getStripe()` in `lib/stripe.js` is lazy and only reachable through `getProvider()`'s
`stripe` branch, which `PAYMENT_PROVIDER` unset never takes.

Both secrets were therefore created on 2026-09-08 holding deliberately invalid
placeholders, never read while payments are off:

```
STRIPE_SECRET_KEY      = payments-are-off-not-a-real-key
STRIPE_WEBHOOK_SECRET  = payments-are-off-not-a-real-webhook-secret
```

**Turning payments on means replacing BOTH** via `firebase functions:secrets:set`, then
setting `PAYMENT_PROVIDER` and redeploying. A real key alone will not do it, and the
placeholder will not announce itself — a Stripe call would fail at runtime, not at
deploy. The Stripe implementation is otherwise dormant in the repo, so switching on is
configuration, not a rebuild.

---

## 5. Run the PDF spike before anyone relies on a PDF

`docs/superpowers/plans/2026-09-08-real-contracts-plan.md` Task 1 contains a short
procedure. It answers one question: does headless Chromium actually start inside the
deployed Firebase runtime?

It could not be answered during the build, because answering it requires deploying. A
local test proves the library imports on a Mac, which is not the same question.

**If it works,** build the emailed signed PDF. **If it does not,** the permanent signed
page is already built and already satisfies the legal requirement that a record be
retainable and reproducible — she would not be blocked, and clients would get a link
rather than an attachment.

Delete the spike function either way. A deployed callable that launches a browser is an
easy way to run up a bill.

---

## 6. What is deliberately not built

- **Void and cancel.** The state machine defines them and the dashboard renders their
  badges, but nothing writes them. A client who cancels by phone cannot be marked, and
  the reminder ladder will keep nudging them until it exhausts itself. **This is the
  first thing to build next.**
- **Resend.** Once a contract is `sent` there is no way to send it again — so a typo'd
  email address cannot be recovered from. Related to the above; the same fix covers both.
- **The Templates tab.** The design says Khiara edits clauses herself in `/int/`. That
  was not built, so clause changes go through Laakea and a Firestore edit for now.
- **The signed PDF.** Gated on the spike above.
- **Collecting money.** She marks a retainer received by hand, since nothing can detect
  a Venmo or cheque payment. That flag is the same field Stripe would set later.

---

## 7. Two things worth knowing about how this behaves

**Signed does not mean booked.** Her contracts say the date is not reserved until the
signed agreement *and* the retainer have both arrived. The dashboard says
*"Signed — retainer not yet received. The date is not held."* until she marks the money
in. That is not a limitation; it is what her contract says.

**A blank is refused, not rendered.** Twice during the build an empty value slipped past
the guard that catches unfilled `{{placeholders}}` — because a substituted-but-empty
field leaves no placeholder to find, just a blank line in a signed document. The system
now refuses to send when a required field is empty and names which one.
