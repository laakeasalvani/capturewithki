# Client galleries — design

*2026-08-15*

## What Khiara asked for

Send a couple a link to their photos. The link needs a temporary login that
works **only** for that gallery, and the gallery expires after 30 days. She
needs to see and control all of it from the dashboard.

## Decisions taken with the owner

| Question | Decision |
|---|---|
| Can couples download? | **Yes.** The site-wide "no downloads" rule applies to the public portfolio, not to paying clients collecting their own photos. |
| How do they get in? | **Secret link + one shared password** per gallery. No accounts. |
| What happens at expiry? | **Link dies and the photo files are deleted.** The gallery record survives as history. |
| Gallery size | Both — a portrait session and an 800-photo wedding. Built for the large case. |
| When does the clock start? | **When she presses Send**, not when she creates it. Her editing time never eats the couple's window. |
| Extending | **She chooses the date.** Not a fixed +30. This also applies to the initial expiry, which defaults to 30 days and is editable. |
| Download-all-as-zip | **Deliberately out of the first version.** See "Out of scope". |

## Constraints

- **The site is static.** GitHub Pages, no `hosting` block in `firebase.json`.
  A folder resolves (`/int/` already works this way); a dynamic path
  (`/galleries/sarah-ronan`) does not. Hence the query string.
- **Gallery photos must not live under `uploads/**`**, which
  `storage.rules` makes world-readable. A password in front of publicly
  addressable files is theatre.
- No build step. Plain ES modules, Firebase SDK pinned to 10.13.0.

## The link

```
capturewithki.com/galleries/?g=<galleryId>
```

`galleryId` is a Firestore auto-id — 20 random characters, unguessable. The
password is separate and shared out of band.

## Data model

### `galleries/{galleryId}`

| Field | Type | Notes |
|---|---|---|
| `title` | string | Her label, e.g. "Sarah & Ronan" |
| `passwordHash` | string | scrypt hash. The password itself is never stored. |
| `passwordSalt` | string | random per gallery |
| `status` | string | `draft` \| `live` \| `expired` |
| `createdAt` | timestamp | |
| `sentAt` | timestamp \| null | set when she presses Send; starts the clock |
| `expiresAt` | timestamp \| null | set on Send, editable by her at any time |
| `photoCount` | number | maintained on upload and delete |
| `coverThumb` | string \| null | storage path of the first photo, for her list |

### `galleries/{galleryId}/photos/{photoId}`

| Field | Type |
|---|---|
| `full` | storage path of the original |
| `thumb` | storage path of the preview |
| `name` | original filename |
| `order` | number, from `orderForNewItem` in `collection-store.js` |

`order` reuses the existing helper deliberately: the `items.length` bug that
corrupted all four CMS collections is exactly the mistake to avoid repeating.

### Storage

```
galleries/{galleryId}/full/{photoId}.jpg
galleries/{galleryId}/thumb/{photoId}.jpg
```

Separate from `uploads/**` so it gets its own, closed rules.

## Access control

This is the load-bearing part.

1. The couple submits the password to a **Cloud Function**, `openGallery`. The
   page never sees whether it was right, and never holds a hash.
2. The function loads the gallery, verifies `scrypt(password, salt) ===
   passwordHash` using a **timing-safe comparison**, and checks
   `status === 'live'` and `expiresAt > now`.
3. On success it mints a **Firebase custom token** carrying the claim
   `gal: <galleryId>`, and returns it with the gallery title.
4. The page calls `signInWithCustomToken`. That session is the "temporary
   login": anonymous, and scoped to one gallery by its claim.

### Rules

Storage:

```
match /galleries/{galleryId}/{allPaths=**} {
  allow read: if request.auth != null && request.auth.token.gal == galleryId;
  allow write: if isAdmin();
}
```

Firestore:

```
match /galleries/{galleryId} {
  allow read: if isAdmin() ||
    (request.auth.token.gal == galleryId &&
     resource.data.status == 'live' &&
     resource.data.expiresAt > request.time);
  allow write: if isAdmin();

  match /photos/{photoId} {
    allow read: if isAdmin() || request.auth.token.gal == galleryId;
    allow write: if isAdmin();
  }
}
```

The gallery doc is **not** publicly readable, so `passwordHash` is never
exposed and the id space cannot be probed for valid galleries.

### A limit, stated honestly

A Firebase session refreshes itself, so a couple already signed in could in
principle hold a token past `expiresAt`. The Firestore rule on the gallery doc
re-checks expiry cheaply (one document), but the Storage rule deliberately does
**not** call `firestore.get` per file — at 800 photos that is 800 extra reads
per page view.

This is acceptable because **the files are deleted at expiry**. Deletion, not
the token, is the real enforcement. A stale token ends up authorised to read
nothing.

## Thumbnails

Generated **in the browser at upload time**, reusing the canvas approach
already proven in `cms/edit-image.js`. Each photo uploads twice: the untouched
original to `full/`, and a long-edge-1600 preview to `thumb/`.

Chosen over the Firebase Resize Images extension because it adds no new
dependency, no server cost, and no post-upload delay — and because the code it
reuses is already working in production.

Browsing shows thumbnails only. The original is fetched only when the couple
downloads. Without this an 800-photo gallery would attempt roughly 2GB on open
and never finish on a phone.

## Her side — a Galleries tab in `/int/`

- Create a gallery (title)
- Bulk upload: select many files, sequential queue, visible progress, count of
  done/remaining, and a warning not to close the tab
- Password: generated, shown once with a copy button, regenerable
- Send: sets `sentAt`, sets `status: 'live'`, sets `expiresAt` (default 30 days,
  editable before confirming)
- List: title, photo count, created, sent, expires, status, copyable link
- Extend: date picker writing a new `expiresAt`
- Delete now: removes files and the record

## Their side — `/galleries/`

- No `?g=` → a plain "ask Khiara for your link" message
- With `?g=` → password prompt. It does **not** confirm whether the gallery
  exists, so the id space cannot be probed.
- On success → thumbnail grid, gallery title
- Click a photo → larger view, with a download button for the original
- Wrong password, expired, or not yet sent → one neutral message. Distinguishing
  them would leak information about galleries the visitor cannot open.

The site-wide long-press/right-click block is **not** applied here. These are
paying clients collecting their own photos; blocking the gesture would fight
the entire purpose of the page.

## Expiry and cleanup

A scheduled function runs daily:

1. Find galleries with `expiresAt < now` and `status == 'live'`
2. Delete every file under `galleries/{id}/`
3. Delete the `photos` subcollection
4. Set `status: 'expired'`, `photoCount: 0`

The gallery record survives so her list keeps a history. Cloud Scheduler is
required, which the Blaze plan already covers.

## Cost

A 500-photo wedding at full quality is roughly 1.5GB. Storage is about
$0.026/GB/month — **4 cents** for a month. A complete download is about
$0.12/GB — **18 cents**. Thumbnails are negligible. Cost is not a design
constraint here, which is why originals are kept at full quality.

## Out of scope for the first version

- **Download all as a zip.** 1.5GB of originals strains both a Cloud Function's
  memory and a phone's. It is the most likely thing to break and the least
  understood requirement. Ship single downloads, watch real use, then decide.
- Favourites, comments, or client proofing.
- Per-photo access control.
- Email notification when a gallery is sent — she sends the link herself.

## Build order

Each stage is independently testable and leaves the site working.

| Stage | Contents | Why here |
|---|---|---|
| **1** | Data model, Firestore + Storage rules, `openGallery` function, password hashing, unit tests | Nothing else is safe to build before access control is proven |
| **2** | Galleries tab in `/int/`: create, bulk upload with thumbnails, list | She can load real photos before the couple's page exists |
| **3** | `/galleries/` page: password, grid, single download | The visible half, tested against real content from stage 2 |
| **4** | Send, editable expiry, extend, scheduled cleanup | Time logic last, tested against real galleries |

## Testing

- `functions/lib/gallery-auth.js` gets unit tests in the existing
  `node --test` suite: hashing round-trip, wrong password, timing-safe compare,
  expired gallery, draft gallery, missing gallery, malformed input.
- Rules are verified by attempting reads without a token, with a token for a
  *different* gallery, and with the correct token.
- Upload and download paths are checked in a browser against a real gallery.

`functions/index.js` still has no automated tests; `openGallery` goes in its own
module so it is testable without deploying.
