# Seed data for contracts and packages

This directory holds **files**, not Firestore writes. `capturewithki-69dd3` is
the live production project and there is no staging project, so nothing in
this task touched the Firebase console or ran a `firebase` command. A human
loads these files into Firestore by hand at deploy time, following the steps
below.

## What's here

- `contract-template-placeholder.html` — the placeholder contract body. It
  uses only the eight merge fields Task 9's `sendContract` fills in:
  `client_name`, `client_email`, `event_date`, `event_location`, `total`,
  `retainer`, `balance`, `line_items`. Nothing else. It opens with a loud
  red-bordered warning block and its clause section says plainly that
  cancellation, rescheduling, image licensing, liability, and force majeure
  text must come from a purchased photographer template or an Oregon
  attorney — neither Laakea nor Claude writes that text.
- `packages.json` — a JSON array of packages to seed into the `packages`
  collection. See "Packages extracted" below for what's in it and why it's
  only one entry.

## Which document is the placeholder, and what blocks it from sending

The placeholder is meant to become Firestore document `contractTemplates/placeholder`.
The field `isDraft: true` on that document is what stops it from ever reaching
a real client — Task 9 adds a guard to `sendContract` (not this task; the
plan originally ordered that guard into this step, but `sendContract` does
not exist until Task 9 is written, so the guard is being carried forward into
that task instead). Until that guard exists, **do not point any sender at
this template**, draft or otherwise.

## Steps a human takes to load the template and packages

1. Open the Firebase console for `capturewithki-69dd3` → Firestore Database.
2. Create a document at path `contractTemplates/placeholder` with these fields:
   - `html` (string) — paste the full contents of `contract-template-placeholder.html`
     verbatim.
   - `version` (number) — `1`
   - `name` (string) — `"PLACEHOLDER — replace before use"`
   - `isDraft` (boolean) — `true`
3. For each entry in `packages.json`, create a document in the `packages`
   collection (auto-ID is fine) with fields `label` (string), `amountCents`
   (number), and `order` (number), copied exactly from the JSON.
4. Do not flip `isDraft` to `false` on the placeholder for any reason other
   than a deliberate, time-boxed test against your own email address — and
   set it back to `true` immediately afterward, before ending the session.

## How to swap in the real contract later

When Khiara has a real, purchased (or attorney-drafted) contract:

1. Create a **new** document in `contractTemplates` — do not overwrite or
   delete `contractTemplates/placeholder`. Give the new document its own ID
   (e.g. `contractTemplates/v1` or similar).
2. Set its fields: `html` = the real contract's HTML (with the same eight
   merge fields, styled however the real template requires), `version: 1`,
   `name` = whatever Khiara calls it, `isDraft: false`.
3. Point whatever the dashboard/sender uses to select "the active template"
   at this new document's ID.
4. **Leave `contractTemplates/placeholder` in place**, still `isDraft: true`.
   It stays as a permanent, inert fallback — never delete it. If anything
   ever points at it by mistake, the `isDraft` guard in `sendContract`
   (Task 9) stops the send instead of silently emailing a client a document
   with no legal effect.

## Packages extracted

Only **one** package is seeded, and it's the one the plan explicitly told
this task is confirmed:

| label | amountCents | order | source markup |
|---|---|---|---|
| The Grand — 8 Hours | 120000 | 1 | `weddings.pkg3.name` = "The Grand", `weddings.pkg3.price` = "8 Hours — Starting from $1,200" (index.html ~line 881-882) |

$1,200 → 120000 cents (dollars × 100, no decimal drift).

### Why nothing else was seeded — read this before adding more packages

While extracting the other dollar amounts named in the brief ($175, $200,
$225, $300, $750, $1,000), I found something the plan did not mention: the
site's own markup **explicitly labels this pricing as not-yet-real**, in two
places:

- Line 110, inside the global `<style>` comment block: `NOTE: photos are
  temporary placeholders. Pricing is placeholder.`
- Line 693, immediately above the Portraits section: `<!-- PLACEHOLDER
  PRICING — replace every figure below before launch. -->`

That second comment sits directly above `<section class="page" id="portraits">`,
and the Portraits, Elopements, and Weddings sections are the only pricing
content in the file — the comment reads as covering all of it, not just
Portraits. Per the standing instruction not to guess a price because a wrong
one becomes a wrong number on a legal contract, I did not seed any of these
as confirmed packages, including "The Grand," except that the brief for this
task specifically told me "The Grand, 8 hours, from $1,200" is the one
package confirmed while the plan was written — that is a direct instruction
from Laakea/the plan, not something I inferred from the page, so I kept it.
Everything else below needs a human decision.

**Every name/price pairing below is unambiguous as markup** (each price sits
directly under one clearly-named package, no guessing needed to match them
up) — the open question is only whether the number itself is real or a
placeholder Khiara hasn't replaced yet.

## CONFIRM WITH KHIARA BEFORE SEEDING

The site's own comments (index.html line 110 and line 693) say pricing on
this site is still placeholder text pending replacement "before launch."
Before seeding any of the following as real packages, confirm each price
with Khiara — including double-checking "The Grand" above, since the same
blanket comment technically covers it too, even though the task brief names
it as confirmed.

**Weddings** (index.html ~lines 862-888):
- The Intimate — 4 hours, "Starting from $750" (`weddings.pkg1`)
- The Classic — 6 hours, "Starting from $1,000" (`weddings.pkg2`)

**Portraits** (index.html ~lines 703-793, all sit under the "PLACEHOLDER
PRICING" comment):
- Couples — 60 min. session, $175 (`portraits.pkg1`)
- Engagement — 60 min. session, $225 (`portraits.pkg2`)
- Family — 60 min. session, $200 (`portraits.pkg3`)
- Maternity — 60 min. session, $200 (`portraits.pkg4`)
- Senior — 30–45 min. session, $175 (`portraits.pkg5`); its own list
  includes an add-on line, "Add a friend: +$25, +15 min" — if this package
  is confirmed, also confirm whether that add-on needs its own line item or
  price entry, since it isn't a package on its own.

**Elopements** (index.html ~lines 820-833, no placeholder comment directly
above it, but same site-wide "Pricing is placeholder" note in line 110
applies):
- Elopements — up to 2 hours, $300 (`elopements.pkg1`)

### Excluded as not packages at all

These dollar-adjacent mentions elsewhere in the file are not package prices
and were not considered as candidates:

- The Senior portrait package's own add-on, "Add a friend: +$25, +15 min" —
  a line item inside a package's feature list, not a standalone package.
- The retainer/payment FAQ copy (index.html ~line 964: "A signed agreement
  and a 30% retainer lock it in. The balance can be split monthly.") — this
  is a percentage/policy description, not a package price.
- The travel FAQ (index.html ~lines 978-979: "Travel within Oʻahu is
  included. Neighbor islands and mainland trips are quoted per trip...") —
  no dollar figure at all, and this copy is still Hawaii-worded (Khiara has
  since relocated to Oregon and shoots Oregon work; this copy is being fixed
  separately). Nothing from this FAQ was copied into the contract template.

## Oregon tax note

Khiara has relocated from Hawaii to Oregon and now shoots local Oregon work.
Oregon has no sales tax and no general excise tax, so there is intentionally
**no tax line** anywhere in the placeholder template, and none should be
added to any future real contract or invoice for Oregon bookings.
