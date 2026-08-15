# Full-site audit fixes — design

*2026-08-15*

Findings from a sweep of every page at 375, 768, 1280 and 1920, plus the
dashboard. Empty CMS text fields are deliberately excluded — those are Khiara's
to write, and at least two were cleared on purpose (see below).

## 1. The menu could not be closed

`.nav` is `z-index:60`; the menu overlay `#mobile` is `z-index:70`. Opening the
menu buried the Menu button underneath it — invisible, and clicks landed on the
overlay. There was **no Escape handler at all**, so the only way out was to pick
a page.

Confirmed with real mouse clicks and screenshots at 375 and 1280: with the menu
open, clicking the button's position did not close it.

Fix: `.nav.menu-open{z-index:80}` toggled with the overlay, so the bar rises
above it only while open. The button now relabels to **Close**, carries
`aria-expanded`, and Escape is handled explicitly. One `setMenu()` owns all of
it, and `go()` routes through it so choosing a page resets the label.

`.nav.menu-open .wordmark` is forced to khaki — in hero mode the wordmark is
white, which would be invisible against the cream overlay.

## 2. No link preview, favicon or description

Sharing capturewithki.com on Instagram, iMessage or Facebook produced a bare URL
with no image and no title. For a photographer that is the worst possible place
to look unfinished.

Added Open Graph and Twitter card tags, `og:image` pointing at
`images/home-banner.jpg` (2400×1600, already in the repo, stable — unlike a
Storage URL whose token can change), a meta description, and a canonical link.
Absolute URLs throughout: scrapers do not resolve relative paths.

The favicon is an inline SVG data URI — a khaki rounded square with an italic
serif "K" in the site cream. No binary in the repo, and it cannot 404. Easily
swapped for real artwork.

## 3. The contact form was not a form

The fields sat in a plain `<div>`, so pressing Enter did nothing, and the submit
button's `type="submit"` was inert. There were also no `autocomplete`
attributes, so phones would not offer a saved name, email or phone — while the
admin login page had them set correctly.

Fix: wrapped in `<form id="inqForm" novalidate>`. The handler moved from the
button's `click` to the form's `submit`, which covers both the button and the
Enter key through **one** path — attaching to both would have double-sent.
Added `autocomplete` on name/email/phone and `inputmode` on email/phone.

## 4. Success and failure looked identical

`#sent` is a shared status line and every message rendered in the same ink.
"Your inquiry is on its way" and "that email address does not look right" were
indistinguishable at a glance.

Added `.sent-err` (red) and `.sent-ok` (khaki), applied through a small `say()`
helper so no message can be emitted without a state. Validation failures now
also focus the offending field.

## 5. Home had no `h1`

Every other page had one. `home.heading` was an `<h2>`; it is now an `<h1>`,
keeping its class and its `data-cms-id` so nothing else changes.

## 6. Touch targets

At 375px, 18 of 28 controls were under the 44px Apple and WCAG both ask for.
Worst was the hero's prev/next arrows at **29×2px** — thin rules by design, and
essentially unhittable with a thumb. The CMS gear was 11px, which is the first
thing Khiara must hit before she can do anything on her phone.

Fixes, all inside `@media (max-width:768px)` so desktop is untouched:

- Menu button, contact inputs/select/textarea/submit, testimonial arrows:
  `min-height:44px`.
- Footer nav links and the social icon: padding to a 44px box, type unchanged;
  the surrounding margin is reduced so the footer does not grow.
- CMS gear: 44×44 box via flex centring with a negative margin, icon still 11px
  and just as quiet to a visitor.
- Hero arrows, frame thumbnails and the "Learn more" link: an invisible
  `::after` overlay sized `max(100%,44px)`. Verified none of these had an
  existing `::after`, so nothing visual was displaced, and because the overlay
  is absolutely positioned nothing in the layout moves.

Measured after the change, with each control scrolled into view (`elementFromPoint`
returns null outside the viewport — an earlier measurement pass was invalid for
exactly that reason):

| Control | Looks like | Tappable |
|---|---|---|
| Hero ← / → | 2px | 44px |
| "Learn more" | 28px | 44px |
| Footer link | 44px | 45px |
| CMS gear | 11px icon | 41px |
| Frame thumbnail | 34px | 34px — unchanged, accepted |

The frame thumbnails resisted the overlay (something in `#frames` wins the
stacking contest). At 52×34 they remain usable and are secondary to the arrows,
which now work, so this was left rather than risk the hero layout.

## Verified unchanged

Desktop at 1280 after the change: burger 31px, gear 7×11, footer link 19px, no
44px pseudo-element — i.e. the mobile rules are correctly scoped.

All 8 pages at 375 and 1280: no horizontal overflow, no broken images, exactly
one `h1` each. Today's earlier work still intact: photo-save blocking active, 0
text fields carrying foreign styling, testimonial form present, CMS controls
invisible to a logged-out visitor, 114 `data-cms-id`, all 9 contact-form ids,
SDK still pinned to 10.13.0.

## Not changed, deliberately

The six empty CMS text fields. Their original wording still sits in `index.html`
as a fallback, but restoring it would republish stale content: the Home location
fallback reads "Based in Honolulu, Hawaiʻi" while Khiara has already migrated
the site to Portland, Oregon — she rewrote `home.heading` and the contact label
and *cleared* the two spots that still said Honolulu. Those blanks are edits,
not accidents. Owner's decision: she writes them herself.

## Audit findings that turned out not to be bugs

Recorded so they are not re-investigated: the empty contact form appearing to
show a success message (`#sent` is a shared status line, behaving correctly);
page scrolling appearing broken (`scroll-behavior:smooth` racing the
measurement); Portfolio photos appearing to fail (`loading="lazy"` working as
intended); the filmstrip appearing to show only placeholders (4 of its 7 items
are her uploads, 3 are unreplaced seeds); `about.bioImage` failing on localhost
(reproduced without any of this work, absent on live, Storage throttling the
local IP); and CORS errors in the console (produced by the audit's own `fetch`
probes — the site loads photos via `<img>`, which does not use CORS).
