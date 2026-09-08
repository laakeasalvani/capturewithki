# Real contracts, no payments — design

**Date:** 2026-09-08
**Status:** Approved, ready for an implementation plan
**Amends:** `2026-09-04-contracts-and-payments-design.md`, which assumed a placeholder
contract and Stripe collection. Khiara has now supplied five real contract PDFs and
does not have a payment processor. Where the two disagree, this document wins.

---

## What changed

She needs one thing: **send a contract, have it signed electronically.** No payment
collection. The contract she sends depends on the package the client chose.

The payment system built under the previous spec stays in the repo, dormant behind
its provider seam, and is switched on later by configuration rather than rebuilt.

## What she supplied

Five PDFs, which are really **three documents**:

| Document | Variants | Client signature blocks | Sections |
|---|---|---|---|
| **Wedding** | The Intimate (4hr / 200+), The Classic (6hr / 300+), The Grand (8hr / 400+) | 2 | 20 |
| **Elopement** | fixed — 2hr, 150+, 1 location | 2 | 22 |
| **Portrait** | Couples, Engagement, Family, Maternity, Senior | 1 | 19 |

The three wedding PDFs are byte-identical except for one paragraph naming the package,
its hours and its image count. Elopement carries sections Wedding does not (Late
Arrival & No-Show, Weather & Unforeseen Circumstances, Location & Access). Portrait is
a distinct document that names its session type in a blank.

### A correction that must be made

**The Grand Package PDF names the wrong package.** It reads *"the selected The Classic
8-Hour Package includes: 8 hours… 400+ edited images."* The hours and image count are
the Grand's; the name is the Classic's. Copy-pasted and one word missed.

The transcription fixes this to "The Grand 8-Hour Package". Laakea must tell Khiara so
her own PDF is corrected too, or the two sources will disagree.

---

## Decisions

| Question | Decision |
|---|---|
| Who signs | **Client 1 only.** Client 2 is named in the contract but does not sign. |
| Her signature | **Pre-applied at send** — name and date stamped into the snapshot *before* hashing |
| Contract date | The **server timestamp of signing** |
| Fee math | Retainer = **30% of the package price only**. Balance = package + travel − retainer |
| Templates | **Three**, one per document. The package catalogue supplies what varies |
| Source of truth | The **template**, edited by Khiara in `/int/`, versioned |
| Payments | **Off.** The built system stays dormant behind the provider seam |
| Money received | A manual **`retainerReceivedAt`** flag she sets — the same field Stripe would later set |
| Signed PDF | **Yes**, emailed to both parties. Headless Chromium, **spike first** |

---

## The package catalogue

Extends the existing `packages` collection. Each package knows which template it uses
and what to write into that template's blanks.

```
packages/{packageId}
  label            "The Grand — 8 Hours"     // exactly as she words it
  templateKey      "wedding" | "elopement" | "portrait"
  priceCents       120000
  order            3
  active           true
  specs:
    packageName    "The Grand 8-Hour Package"   // as it appears IN the contract text
    hours          8                            // wedding/elopement
    editedImages   "400+"
    sessionMinutes 60                           // portrait only
    locations      1                            // portrait only
    outfitChanges  2                            // portrait only
```

`label` is what she picks from; `specs.packageName` is what the contract says. They
differ deliberately — her site says "The Grand — 8 Hours", her contract says "The Grand
8-Hour Package", and neither should be forced to match the other.

**The portrait spec values are unknown.** Edited images, locations and outfit changes
are blank in her PDF and vary by session type. They must come from Khiara before any
portrait contract is sent, and are seeded as a CONFIRM-WITH-KHIARA list exactly as the
package prices already are.

**Her prices are still placeholders.** `index.html:110` and `index.html:693` say so in
her own markup. No package may be seeded with a price she has not confirmed.

---

## Merge fields

One-pass substitution through the existing `renderTemplate`, which escapes every value.
Any placeholder left unfilled makes `sendContract` refuse — a contract with a visible
hole where a clause should be is worse than an error.

**All templates:** `client_1_name`, `client_email`, `client_phone`, `event_date`,
`event_location`, `start_time`, `end_time`, `package_name`, `package_price`,
`retainer`, `travel_fees`, `remaining_balance`, `balance_due_date`,
`photographer_name`, `photographer_signed_date`

**Wedding + Elopement also:** `client_2_name`, `hours`, `edited_images`

**Portrait also:** `session_minutes`, `locations`, `outfit_changes`

`client_2_name` renders as "Not applicable" when empty, so the Client 2 block never
appears as an unsigned blank line on a signed agreement.

### Fee arithmetic

```
packagePriceCents           from the catalogue
travelFeesCents             entered per booking, may be 0
retainerCents  = round(packagePriceCents × 0.30)      // package ONLY, not travel
totalCents     = packagePriceCents + travelFeesCents
balanceCents   = totalCents − retainerCents           // by subtraction, always
```

**This changes existing code.** `computeRetainerCents(total, 30)` currently takes 30%
of the total. With travel as a separate line that is wrong the moment travel is
non-zero, and the wrong number is printed in a signed legal document. The retainer must
be computed from the package line alone.

`balance_due_date` defaults to 14 days before the event date, matching what her site
already promises, and stays editable.

---

## Signatures

Her documents have three signature blocks. Only one of them is a live electronic
signature.

**Photographer** — her name and the send date are stamped into the snapshot by
`sendContract`, *before* `documentHash` is computed. Her countersignature is therefore
covered by the same tamper-evidence as the client's, and the client receives an already
countersigned agreement. She is the party offering the terms; the client accepts them.

**Client 1** — the live signature. Unchanged from the existing implementation: a
tokenized link, an affirmative act, a typed legal name, and an audit record carrying
server timestamp, IP, user agent, and the document hash.

**Client 2** — named, not signed. Rendered as text, with no signature line presented.

---

## Payments off

`providerName()` gains a third value, `'off'`, and it is the **default**.

Today with no provider configured the fake payer throws, `signContract` swallows it,
and the client is told *"Khiara will email you a payment link."* That sentence would now
be false. With `'off'`:

- `signContract` does not attempt a session and returns `checkoutUrl: null` without an error
- the signing page shows no pay button and never mentions payment
- `startRetainerPayment` refuses
- `chaseContracts` skips reconciliation entirely

The contract text still states the 30% retainer terms, because those are her terms —
the system simply does not collect it.

### `retainerReceivedAt`

She marks it when the money arrives, however it arrives. Only then does a contract read
**"Booked — date held."** Until then it reads **"Signed — retainer not yet received,"**
which is what her own contract requires: *"the date is not reserved until the signed
Agreement and required retainer have been received."*

Nothing can detect a Venmo, Zelle or cheque payment automatically — those have no usable
API — so a person must say so. The flag is provider-agnostic on purpose: when Stripe is
switched on, the webhook sets this same field and the dashboard needs no change.

---

## Template editing and versioning

Templates live in `contractTemplates/{key}` and Khiara edits them in `/int/` with a
preview, the way she already edits her site.

**Every save writes a new version rather than overwriting.** A contract stores the
`templateVersion` it was rendered from, and its frozen `documentSnapshot` is what is
displayed and hashed — so a signed contract always shows the words that were signed,
no matter how many times the template is edited afterwards. This is already guaranteed
by the snapshot; versioning makes the provenance legible.

The `isDraft` guard stays: a template marked draft cannot be sent.

---

## Chasing

`dueActions` drops `pay-reminder` and `unpaid-escalation` — there is no payment to chase.

It keeps, and these matter more now:

- **`never-opened-alert`** — a contract sent and never opened may have been spam-filed.
  No signal the sending side produces can detect that; whether it was opened is the only
  one that survives. This is why `escalateUnreadInquiries` exists.
- **`sign-reminder`** — two nudges, then stop.

A new **`unsigned-escalation`** tells Khiara when a contract has sat unsigned past the
reminders, replacing the unpaid escalation with the equivalent for this system.

---

## The signed PDF

Emailed to both parties on signing: the rendered contract with the signature block
filled in, plus an audit page carrying the typed name, server timestamp, IP, user agent
and document hash.

**Headless Chromium in a Cloud Function, and the feasibility spike is task one.**
Whether Chromium launches in the deployed Firebase gen2 Node 24 runtime cannot be
answered locally — a local test proves the library imports on a Mac, not that the
container can start a browser. Nothing is built on top until that question is answered.

Rejected: laying the PDF out programmatically with a pure-JS library. It is certain to
work, but it means maintaining the contract's layout twice — once as HTML for the
signing page, once as PDF code — and the two will drift the first time she edits a
clause.

**If the spike fails**, the fallback is the permanent tokenized page, which is already
built and already satisfies ESIGN's requirement that the record be retainable and
accurately reproducible. She would not be blocked.

---

## Out of scope

- Collecting money. The Stripe implementation stays dormant, not deleted.
- A second electronic signature for Client 2.
- Her countersigning after the client rather than before.
- Installments.
- Void and cancel controls — still missing, still the first thing to build after this.

## Testing

Unit tests, `node --test`, in `functions/test/`, matching the existing 227:

- **Fee arithmetic** — the retainer comes from the package line alone; retainer plus
  balance equals package plus travel exactly; travel of zero behaves; odd amounts round
  once and only once.
- **Template rendering** — every merge field for all three templates; an unfilled
  placeholder refuses the send; a client name containing HTML is escaped; a client named
  `{{package_price}}` cannot read another field.
- **Catalogue** — a package missing its template key, or naming an unknown one, is refused.
- **Chase decisions** — the removed rungs never fire; the kept ones fire at their exact
  boundaries.
- **Provider `off`** — no session is attempted, no payment language reaches the client.

The transcribed legal text is verified by **diffing the rendered output against the
extracted PDF text**, not by reading it — 11,000 characters of clauses is exactly where
an eye slips.
