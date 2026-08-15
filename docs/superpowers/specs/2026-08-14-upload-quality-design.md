# Stop degrading uploaded photos — design

*2026-08-14*

## Problem

Khiara can see a quality drop in photos she adds through the CMS. She is right,
and two separate things were causing it:

1. **Downscaling.** `MAX_EDGE = 2560` capped the long edge. Her camera produces
   ~5239px files, so every photo was scaled to roughly a quarter of its pixels.
2. **Re-encoding.** `JPEG_QUALITY = 0.85` re-compressed an already-compressed
   camera JPEG. That is generation loss, and it shows first in exactly what a
   portrait photographer cares about: skin, hair, fabric.

Measured on a 5239×3493 test file: the old path uploaded 2560×1707 at 498KB
from a 3.77MB original — **24% of the pixels kept**.

## Decision

Owner's call, made with the tradeoff stated: quality wins over page weight.

| Setting | Before | After |
|---|---|---|
| Re-encode every upload | quality 0.85 | **removed** |
| Downscale above | 2560px | **6000px** |
| Quality if it *is* over the ceiling | 0.85 | **0.95** |
| Max upload size | 25MB | **50MB** |

The ceiling sits at 6000px specifically because her camera is 5239px. A
threshold below that — 4500px was proposed first — would have re-encoded every
photo she owns and quietly preserved the bug.

Net effect: a normal photo never reaches the canvas. It uploads byte-for-byte
as she exported it. The resize path now only catches something genuinely
enormous, a stitched panorama or a scan.

The 50MB cap is not a quality decision; it exists so a mistaken file (a video)
is rejected. It is set high enough that it can never push her toward exporting
at lower quality to fit under it.

## Measured page-weight consequence

Her real full-size photos are **1.2–3.1MB**, not the 6–8MB estimated during
brainstorming — they are already well-compressed camera exports. The 36-image
Portfolio grid therefore lands around 40–80MB at full size, not the ~250MB
first quoted. The earlier figure overstated the cost of this decision by
roughly 3×.

Context that further softens it: **23 of the 30 CMS photos on the live site are
already over 2560px**, uploaded before the shrink feature existed. Full-size
photos are already the norm; this change stops new ones being degraded rather
than introducing a new burden.

The 36-image Portfolio grid remains the weak point, and the real fix for it is
the Firebase **Resize Images** extension — originals kept pristine, display
copies served to visitors. That remains outstanding work, and this change
raises its value.

## Implementation

`cms/edit-image.js` only. `shrink()` is renamed `capIfEnormous()`, which
describes what it now does, and is exported so the behaviour can be tested
without performing a real upload.

The early-return moves to the top of `onload`: at or under 6000px, resolve with
the original `File` object untouched — no canvas, no decode, no re-encode. The
old `scale === 1 && file.size <= 900 * 1024` condition is gone; it was what let
an under-ceiling file still get re-encoded merely for being large.

Preserved unchanged: HEIC and undecodable formats pass through, a decode error
passes through, and a re-encode that would not shrink the file is discarded in
favour of the original.

## Verification

Built real JPEGs at each size in a browser and ran `capIfEnormous` on them:

| Input | Expected | Result |
|---|---|---|
| 5239×3493 (her camera) | untouched | same `File` object, byte-identical, 5239×3493 |
| 6000×4000 (at ceiling) | untouched | untouched |
| 9000×3000 (panorama) | capped | 6000×2000 |
| 1200×800 (small) | untouched | untouched |
| `image/heic` | passthrough | passthrough |
| 51MB file | rejected | "That image is larger than 50MB." |
| 40MB file | passes size guard | passed, failed later at Storage auth as expected |

Site checked after the change: no console or network errors, 38 remote requests
all successful, hero paints, `data-cms-id` still 114.
