# Pasted text keeps its source styling — design

*2026-08-14*

## Problem

Khiara writes in Notes, Google Docs and Word, then pastes into the inline CMS.
Clipboard HTML carries the source app's styling with it, so the pasted words
arrive black, or 16px, or in Arial, instead of taking the site's own type.

This is not a display glitch that a reload fixes. `edit-text.js` stores
`el.innerHTML`, so the foreign styling is written to Firestore and served to
every visitor from then on.

Observed on the live site, 9 of 90 `data-cms-type="text"` fields carried stored
markup. Four were genuinely wrong:

| Field | Stored styling | Effect |
|---|---|---|
| `home.paragraph1` | `color: rgb(0,0,0)`, `font-size: medium` | black, 16px instead of `rgb(107,101,96)`, 15px |
| `home.paragraph2` | same | same |
| `about.paragraph1` | `color: rgb(0,0,0)` | black instead of `rgb(107,101,96)` |
| `testimonials.process.step1.body` | `color: rgb(255,255,255)` | white on cream — invisible |

The other five were legitimate: `<li>` bullets in the three wedding package
lists, and `<span class="ll-heart">♡</span>` in the Testimonials title.

## Constraint

Any cleaner must strip styling without touching structure. A blanket
"strip all formatting" rule would delete the package bullet lists and the
heart.

## Design

One module, `cms/sanitize.js`, used at the three moments styling can arrive.

### 1. On paste — `initPasteGuard()`

A capture-phase `paste` listener on `document`. When the target is inside a
`[contenteditable="true"]`, it cancels the native paste, reads only
`text/plain` from the clipboard, collapses whitespace runs (including `\n` and
` `) to single spaces, and inserts that.

Whitespace collapse is the chosen behaviour: pasting three paragraphs into a
one-line heading must not blow the layout apart. The result is not trimmed, so
a leading or trailing space copied on purpose survives.

Insertion uses `document.execCommand('insertText', …)`. Deprecated, but it is
the only reliable way to insert into a contenteditable while preserving the
browser's native undo stack, it works on iOS Safari, and `edit-text.js`
already depends on it for the spacebar fix. A Range-based fallback covers a
throw or a `false` return.

### 2. On save — `sanitizeHtml()` in the `focusout` handler

A safety net for styling that arrives some other way: dragged-in text, an
unusual phone keyboard, a browser not anticipated here. The cleaned value is
written back to the element as well as saved, so the correction is visible
immediately rather than on next load.

### 3. On render — `sanitizeHtml()` in `applyContent()`

This is what repairs the fields already stored dirty. Cleaning on the way out
of the store means the junk in Firestore stops mattering, with no writes to a
live business's content and no Firebase console steps.

### What `sanitizeHtml` does

Parses into a detached document via `document.implementation.createHTMLDocument`
— inert, nothing loads or executes — then:

- removes `script, style, meta, link, base, title` elements entirely
- removes every `style` attribute
- removes every `on*` attribute
- unwraps `<font>`, keeping its children

Nothing else. Classes, `<li>`, `<br>`, `<span>`, `<p>` and all text survive.

A regex pre-check short-circuits the common case, since this runs across ~90
fields on every page load.

`on*` removal goes marginally beyond "strip styling". `innerHTML` will not run
a `<script>`, but it will wire up an `onerror`, so removing them is what makes
the paste path genuinely safe rather than nearly safe.

## Out of scope

- The `int/` dashboard: its fields are `<textarea>`, already plain text.
- `data-cms-type="attr"` and `"options"`: edited through `prompt()`, already
  plain text.
- `data-cms-type="item-text"` (testimonials): already saves `textContent`. The
  paste guard still improves what she sees while typing.
- Rewriting the stored Firestore values. Render-time cleaning makes it
  unnecessary, and automatic writes to live content carry more risk than the
  dead markup they would remove. Each field is genuinely rewritten the next
  time she edits it.

## Verification

In a browser, against the real stored values:

1. `sanitizeHtml(raw)` over each dirty field → no `style=` remains, text
   identical.
2. `sanitizeHtml(raw)` over the package lists and the ♡ title → output
   identical to input.
3. Rendered `color` of the repaired fields → `rgb(107,101,96)`.
4. Simulated paste carrying `color:#fff; font-family:Arial; font-size:16px` →
   plain text inserted, no `style=`.
5. Simulated multi-paragraph paste → collapsed to one line.
6. Simulated `<img onerror>` / `<script>` paste → inserted as plain text, no
   execution.
7. Paste outside an editable → not intercepted.
8. `data-cms-id` count still 114; Firebase SDK still pinned to 10.13.0.

## Note recorded during verification

`testimonials.process.step1.body` was read twice, minutes apart. The first read
returned the white-styled sentence above; the second returned `"<br>"`, an
empty field, on both the live site and locally. The value changed between
reads — most likely edited in the CMS during the session, or a stale
first read. Either way that field currently holds no text and renders blank;
that is a content problem, not a styling one, and no code change can restore
words that are not stored. It needs retyping in the CMS.
