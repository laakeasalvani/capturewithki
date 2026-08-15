# Branded automated emails — design

*2026-08-15*

## Problem

Both automated emails were plain text only — no HTML, no colour, no image.
The thank-you a couple receives is the only piece of the brand that reaches
them by mail, and it looked like a terminal printout.

## Decisions (owner's)

- **Client thank-you:** full design, with a wide photo banner across the top.
- **Owner notification:** same palette and a header strip, **no photo**, so the
  inquiry details stay scannable on a phone.
- **The photo is hers to change**, from the same `/int/` page where she edits
  the wording.

## Constraints that shaped the markup

These are not stylistic choices:

- **Custom fonts do not survive email.** Gmail, Outlook and Apple Mail strip
  them. The stacks used are the site's *own* fallbacks from `index.html`'s
  `:root` — Georgia/Times for the display serif, Helvetica/Arial for the sans.
  This is what a visitor already sees when the webfonts fail to load.
- **No `<style>` block, no classes.** Gmail strips the head. Everything is
  inline and laid out with tables, because Outlook renders with Word.
- **Images are blocked by default** in many clients, so nothing structural may
  depend on the banner, and it carries alt text.
- **Plain text is kept alongside the HTML.** HTML-only mail is penalised by
  spam filters and unreadable to anyone reading in plain text.

## Implementation

### `functions/lib/email.js`

New exports beside the existing text builders, which are untouched:

- `escapeHtml` — the text emails could pass a stranger's name and message
  through untouched because text cannot be markup. In HTML it can.
- `safeImageUrl` — only a Storage URL on this project is embeddable. Only an
  admin can write the value, but an `<img src>` pointing elsewhere would leak
  the reader's IP to a third party the owner never chose. Also rejects quotes
  and angle brackets, which would break out of the attribute even after the
  host check passes.
- `textToParagraphs` — preserves her paragraph breaks by escaping first, then
  rebuilding the breaks.
- `clientEmailHtml(inquiry, template, imageUrl)` — banner (omitted entirely if
  absent or unsafe), wordmark, hairline, her message, footer.
- `ownerEmailHtml(inquiry)` — khaki header strip, a labelled two-column table
  of the fields, the message, the reply note.

`sendEmail` gains an optional `html`, sent *alongside* `text`, never instead.

Palette copied from `index.html` `:root`: `#F2ECE0`, `#FAF6EE`, `#171614`,
`#6B6560`, `#DCD0BC`, `#6E7C5C`.

### `int/settings.js` + `int/dashboard.css`

A "Photo at the top of the email" block under the wording fields: current photo
preview, "Change photo", "Remove photo", and a status line. The URL is stored as
`clientImage` on the existing `settings/email` document, and the existing Save
uses `merge: true`, so wording and photo do not overwrite each other.

Upload reuses `cms/edit-image.js`'s `uploadImage`, so a photo chosen here takes
exactly the path her site photos take — full quality, same 50MB ceiling. The
file input is a real element in the page opened by a direct tap, the same shape
the testimonial form needed and for the same iOS reason.

## Two bugs caught by rendering it rather than trusting it

**Mojibake.** The first render showed `â€"` where an em dash should be: the
HTML had no charset declaration. Every curly apostrophe and dash in her wording
would have arrived broken. Fixed with `<meta charset="utf-8">`, and covered by
a test.

**Sideways scroll on a phone.** The card was `width:600px;max-width:100%`. The
hard 600 pushes the layout viewport past a 375px screen, so `max-width` never
gets a chance and the reader has to pinch and scroll — confirmed at 375px,
where the document measured 624px wide. Swapped to
`width:100%;max-width:600px`, keeping `width="600"` for Outlook, which ignores
CSS. Re-measured: 375px viewport, 375px document, no overflow.

Neither would have been visible from reading the code.

## Verification

`npm test` in `functions/`: **60 tests, 60 passing** (was 38). New coverage:

- palette and font fallbacks present in both emails
- first-name greeting and saved-template substitution in HTML
- markup injection through a name or message — asserts no raw `<script>` or
  `<img>` and no event-handler *attribute*, while allowing the characters to
  appear as escaped visible text, which is correct: the owner should see what
  was actually typed
- banner embedded only for a Storage URL on this project; eight hostile or
  malformed values rejected, including one carrying a quote
- no photo set leaves no `<img>` at all
- her paragraph breaks survive
- owner email carries no photo, by design
- plain text still produced for both
- `<meta charset="utf-8">` present; curly punctuation survives
- responsive width asserted in both directions, so the fixed-width form cannot
  come back
- banner alt text present

Rendered and viewed in a browser at 760px and 375px: client email with photo,
without photo, owner email, and a simulated images-blocked version. All four
read correctly; no horizontal overflow at 375px.

Dashboard: the photo controls build correctly — real file input in the page,
"Remove photo" disabled and preview hidden when there is none. Login gate
unaffected, no console errors, 114 `data-cms-id`, SDK still 10.13.0.

## Not verified here

Real inbox rendering in Gmail, Outlook and Apple Mail. Nothing in this
environment can send or receive a real message, and the owner's Resend account
is hers. Recommended before relying on it: send one real test inquiry and look
at both emails on a phone and a computer.
