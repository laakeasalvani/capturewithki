# Adding a testimonial takes several tries — design

*2026-08-14*

## Report

Khiara added one testimonial and it took roughly three attempts before it
stuck.

## Root cause investigation

Two independent defects, both confirmed against live data.

### 1. Duplicate `order` values

`addCollectionItem` was called with `items.length` as the new item's `order`.
That is only correct while the numbers run `0..n-1` with no gaps — and
`deleteCollectionItem` never renumbered. One deletion broke it permanently:
with orders `{0, 2}`, `items.length` is 2, and the next item collides with the
existing 2.

Live data, read from the public collections:

| Collection | orders | state |
|---|---|---|
| `heroSlides` | `2,2,2,3` | three-way tie |
| `testimonials` | `1,2,2` | tie |
| `portfolioShots` | `0..29,31,32,33` | gap; **next add would have collided at 33** |
| `filmstripShots` | `0,1,3,4,5,6,8` | gaps |

Firestore breaks an `orderBy('order')` tie by document id. Verified: the three
tied hero slides come back in exact ascending document-id order. So a colliding
item lands in a position nobody chose.

`handleAdd` then finished with:

```js
index = items.length - 1;   // assumes the new item sorted last
```

When the tie sorted the other way, she was shown a *different* testimonial than
the one she had just created — indistinguishable from "it didn't save".

All four collections shared this defect. It is not specific to testimonials.

### 2. The add flow could not report anything

`handleAdd` ran `prompt()` twice, then created a detached
`<input type="file">` and called `.click()` on it. Six silent dead ends:
cancelling either prompt, leaving either blank, dismissing the picker, or the
picker never opening — plus a long silent upload — and no confirmation on
success.

The picker is the important one. iOS Safari will not reliably open a
programmatic file picker once dialogs have interrupted the tap. **Hero,
Portfolio and Filmstrip open their picker immediately from the button press
with no dialogs first, and Khiara reports those work on her phone.**
Testimonials is the only add flow with prompts in front of the picker, and the
only one she reports as broken. That asymmetry is the corroboration.

Today's full-quality upload change lengthens the silent window further, since
the files are now several times larger.

## Fix

### Ordering, in `collection-store.js` — applies to all four collections

- `orderForNewItem(items)` returns `max(order) + 1`, exported for testing.
- `addCollectionItem(name, data)` computes the order itself rather than
  trusting the caller. All four callers made the same mistake, so the rule
  lives in one place.
- `normalizeOrder(name)` renumbers to a clean `0..n-1`, and
  `deleteCollectionItem` calls it. Closing the gaps is what stops the
  corruption recurring, and it repairs a collection that is already tangled.

Concurrent adds could still read the same maximum. Single-operator CMS, and
delete-time normalisation cleans up after it; not worth a transaction here.

### The add flow, in `testimonials.js` + `index.html` + `cms.css`

- The two `prompt()` calls and the detached input are replaced by a real form
  in the page. The file input is an actual element she taps directly, which is
  what removes the iOS failure entirely.
- The new item is located by the document id returned from
  `addCollectionItem`, not by assuming it sorted last.
- Every step reports: field-level validation messages, "Uploading the photo…"
  while it runs, "Testimonial added" on success, and the real error text on
  failure. Save/Cancel disable while in flight; "+ Add testimonial" disables
  while the form is open.
- On failure the form stays open with her words intact. Retyping a long quote
  because an upload failed would be its own bug.
- Tap targets are 44px.

`showToast` is extracted from `edit-text.js` into `cms/toast.js` so both
modules share one feedback channel; it gains an optional duration so an upload
message can be held rather than vanishing after 1.5s.

## Verification

`orderForNewItem` against her real live orders and the corruption scenario:

| Case | Old result | New result |
|---|---|---|
| `1,2,2` (testimonials) | 3 | 3 |
| `2,2,2,3` (heroSlides) | 4 | 4 |
| `0..29,31,32,33` (portfolio) | **33 — collides** | 34 |
| `0,1,3,4,5,6,8` (filmstrip) | 7 | 9 |
| `0,2` (delete then add) | **2 — collides** | 3 |
| empty | 0 | 0 |
| missing/garbage `order` | 3 | 1 |

All pass. The old code collides on the portfolio case, meaning the next photo
she added there would have broken too.

Form, in-browser: all elements present; file input confirmed to be in the page
rather than script-created; no `prompt()` left in the add path; validation
messages correct for each missing field; her typed text survives validation;
Cancel clears and re-enables; at 375×812 every control measures ≥44px and the
page does not scroll sideways.

Site: 114 `data-cms-id` intact, all 9 contact-form ids, no duplicate
`showToast` definition, testimonials render, no request failures.

## Noted during verification, not part of this fix

`about.bioImage` failed to render on localhost. Isolated by stashing this
change and reloading: **it fails identically without it**, and does not
reproduce on the live site, where all 74 images load. Attributed to Firebase
Storage throttling the local IP after a burst of parallel test fetches. Not
caused by this work, and no action taken.

## Left alone

- `handleChangePhoto` and the hero/portfolio/filmstrip add flows still use a
  script-created file input, but they call it directly from the button press
  with no dialogs in between, which is the case iOS handles. Gained upload
  progress toasts only where testimonials were concerned.
- Existing duplicate orders in `heroSlides` and `testimonials` are not
  rewritten here. They self-heal on the next delete or reorder. Repairing live
  content is the owner's call, as with the pasted-styling cleanup.
