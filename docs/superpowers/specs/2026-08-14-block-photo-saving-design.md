# Block casual photo saving — design

*2026-08-14*

## Problem

On a phone, a visitor can press and hold any photo on capturewithki.com and get
the browser's "Save Image" menu. On a computer, right-click gives "Save image
as…", and a photo can be dragged off the page onto the desktop. Khiara does not
want her work saved that easily.

## Scope of what is achievable

This removes the one-gesture save. It does **not** make the photos
unobtainable, and nothing can:

- Screenshots are outside the page's control.
- Every photo is served from a public URL — `images/` on GitHub Pages, or a
  Firebase Storage download URL — because that is how a browser displays an
  image at all. Anyone who opens that URL directly gets the file.

Accepted tradeoff: block the gesture 99% of people would use, and do not
pretend to more than that.

## Design

Two edits, both in `index.html`. No new files, no new dependencies, no build
step, nothing touching Firebase.

### 1. CSS on images

Added beside the existing base `img{}` rule:

```css
img{
  -webkit-touch-callout:none;   /* iOS long-press "Save Image" menu */
  -webkit-user-drag:none;       /* drag a photo off the page to save it */
  user-select:none;             /* Android long-press selection handles */
  -webkit-user-select:none;
}
```

`-webkit-touch-callout` is the property that actually suppresses the iOS
long-press sheet; the other two close the desktop-drag and Android-selection
routes to the same result.

### 2. A `contextmenu` listener

Added to the existing inline `<script>` at the top of `<head>`:

```js
document.addEventListener('contextmenu', function (e) {
  if (e.target && e.target.tagName === 'IMG') e.preventDefault();
});
```

Scoped to `IMG` targets on purpose. A blanket block would also stop a visitor
long-pressing the phone number or email address to copy it, which is a real
thing people do on a photographer's contact page.

**Why the head script rather than a module in `cms/`:** that script is plain
inline code with no dependency on `gstatic.com`. When the CMS modules fail to
load — CDN blocked, offline, script error, the case the 12-second hero timer
exists for — the photo protection still runs.

### 3. Exception for CMS reorder tiles

```css
.cms-collection-tile img{-webkit-user-drag:auto;}
```

In edit mode Khiara drags photo tiles to reorder them. `-webkit-user-drag:none`
on a child can block a drag that starts on that child, which would break
reordering. `cms/collection-ui.js` already sets `draggable="false"` on those
images for its own reasons, so restoring `user-drag:auto` returns them to
exactly today's behaviour and no further.

The "Change photo" control is a `<button>`, not an `<img>`, so none of this
reaches it.

## Verification

Run the site locally in a browser and confirm, with observed output:

1. A `contextmenu` event dispatched on a photo reports `defaultPrevented: true`.
2. The same event on a paragraph reports `defaultPrevented: false`.
3. Computed style on a photo shows `-webkit-touch-callout: none`,
   `-webkit-user-drag: none`, `user-select: none`.
4. An element carrying `.cms-collection-tile` shows `-webkit-user-drag: auto`
   on its image.
5. `grep -o 'data-cms-id' index.html | wc -l` still returns **114**, and all
   nine contact-form ids (`n1 n2 em ph dt cl ms send sent`) are still present.

Points 3 and 4 are computed-style checks rather than manual gestures because
the iOS long-press sheet cannot be triggered from an automated desktop browser.
Point 4 covers the reorder-regression risk without a Firebase login.

## Out of scope

- Watermarking.
- Serving photos through a token-gated proxy.
- Any change to Firebase Storage rules or the CMS upload path.
