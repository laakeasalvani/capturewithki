# One file, not five hundred — zipped gallery downloads

**Date:** 2026-09-05
**Status:** approved, ready to implement

## The problem

"Download all" fires one hidden `<a download>` per photo, 700ms apart
(`galleries/gallery.js`). On a phone that is 240 separate saves landing one by
one in Downloads, each one a notification, each one losing its place if the
page is backgrounded. The couple wanted one file they could tap open.

The current comment defends the choice: a 500-photo wedding is well over a
gigabyte and building that zip in a phone's memory is the most likely thing to
fail. That reasoning still holds. It rules out zipping *in the browser* — not
zipping altogether.

## Measurements this design is built on

Numbers from the owner, 2026-09-05:

- Galleries run **40 to 500 photos** depending on the shoot.
- The largest single file so far is **4–5 MB**; most are smaller.
- So the worst case is roughly **2.5 GB**, and a normal gallery about
  **600 MB**.

2.5 GB is too much for one download on hotel wifi, which is what decides the
shape below.

## Decision

Build the zip **on the server, into Storage**, and hand the phone an ordinary
Storage link.

Rejected alternatives:

- **Stream the zip straight down the wire.** Simpler and needs no storage. But
  a generated stream has no resume: a connection that drops at 90% starts from
  zero, and iOS Safari stalls long streaming downloads when the screen locks.
  Every visitor also re-pays the full packing cost.
- **Zip in the browser (JSZip).** No server code, but the phone must hold the
  whole gallery in memory. This is the failure the existing comment was written
  to avoid.

A Storage link resumes a broken download, comes off Google's edge rather than
out of a function, and is built once for everyone who shares the link.

## What the couple sees

First visitor to tap:

1. Button reads **"Download all 240 photos"**.
2. Tap. It disables, and a line appears: *"Getting your photos ready. This
   takes a couple of minutes — you can leave this page open, or close it and
   come back later."*
3. When ready the button becomes **"Save all 240 photos (712 MB)"**.
4. Tap. One file downloads. A hint line says where it lands on an iPhone
   (Files › Downloads) and that tapping it once opens it into a folder.

Everyone after: the page finds the finished zip on load and shows the Save
button immediately. No wait at all.

Galleries over the part cap show a numbered list instead, each row savable as
soon as *that* part is ready:

```
Part 1 of 3 — 980 MB · Save
Part 2 of 3 — 980 MB · Save
Part 3 of 3 — 540 MB · Save
```

On failure: *"Something went wrong making your file. Tap to try again — or use
the ↓ arrow on any photo to save it on its own."* plus a Try again button.

Unchanged: the ↓ arrow on each tile, and the download button in the photo
viewer. Only the one-at-a-time loop is replaced.

## Server

### `prepareGalleryZip` — new callable, `us-west1`

`{ memory: '512MiB', timeoutSeconds: 900, cors: true }`.

Takes `{ galleryId, part }`. Steps:

1. **Gate.** `request.auth.token.gal === galleryId`, then re-read the gallery
   doc and confirm `status === 'live'` and not expired — the same check
   `firestore.rules` makes, done here because the Admin SDK bypasses rules.
2. **Plan.** Read the photo docs (already carry `bytes`, `fullPath`, `order`)
   and pack them in `order` into parts of at most **1 GiB**.
3. **Claim.** In a Firestore transaction on `galleries/{id}/zips/part-{n}`,
   refuse if that part is already `building` with a fresh heartbeat, or already
   `ready` at the current fingerprint. Otherwise write `building`.
4. **Build.** For each photo, `bucket.file(fullPath).createReadStream()` fed
   into `archiver` at **store level (no compression)** — JPEGs do not compress,
   and skipping it keeps CPU low and the finished size exactly predictable.
   Piped straight into `bucket.file(zipPath).createWriteStream()`. Nothing is
   buffered whole; bytes flow through.
5. **Record.** Mark the part doc `ready` with its size, photo count, file name,
   download URL and fingerprint.

Return value is informational only — see "why the page listens" below.

### Paths and links

- Zip file: `galleries/{galleryId}/zips/part-{n}.zip`
- Zip record: `galleries/{galleryId}/zips/part-{n}` (Firestore)
- Download URL: the standard Firebase Storage form, with a random
  `firebaseStorageDownloadTokens` value written into the object's metadata at
  upload:
  `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?alt=media&token={uuid}`

A v4 **signed** URL was rejected: it needs `iam.serviceAccountTokenCreator` on
the functions service account, which is a real setup step that fails at runtime
rather than at deploy. The download-token form needs no IAM change, is
unguessable, and Storage honours Range requests on it — which is the resume
this whole design exists for.

### Why the page listens instead of waiting

The page subscribes to the `zips` collection with `onSnapshot` rather than
awaiting the callable's reply. If her phone loses signal mid-build the function
finishes anyway, and reopening the page simply shows the finished file. Walking
out of range costs nothing.

The client drives sequencing: ask for the first part that is not ready, and on
seeing it go ready, ask for the next. Part 1 is savable while part 2 builds, and
a page closed after part 2 leaves parts 1 and 2 done for the next person.

### Staleness

If Khiara adds or removes photos, an existing zip is wrong. Each part records a
**fingerprint** of the source: `photoCount + ':' + totalBytes`, computed
server-side from the photo docs the function itself read. The page computes the
same value from the photos it loaded and ignores any part whose fingerprint
differs, offering a rebuild instead. A rebuild overwrites in place.

This can theoretically collide — swap one photo for another of identical byte
count and the fingerprint holds. The consequence is a slightly stale zip, not a
leak, and the couple can still save any photo individually. Hashing every id
would close it and is not worth the browser-side cost.

### Names inside the zip

`001-original-name.jpg`, numbered by `order`. The prefix makes the opened
folder sort the way she arranged the gallery, and removes any chance of two
photos with the same name colliding inside the archive.

### Failure and locks

A part that throws is marked `failed` with a short reason; the page shows Try
again. A `building` claim older than **20 minutes** is treated as dead and may
be reclaimed, so a killed instance cannot wedge a gallery permanently.

## Rules

`firestore.rules` gains a sibling to the existing `photos` block:

```
match /zips/{zipId} {
  allow read: if isAdmin() ||
    (request.auth != null && request.auth.token.gal == galleryId);
  allow write: if false;
}
```

Written only by the function through the Admin SDK, which bypasses rules.

`storage.rules` needs nothing: `galleries/{galleryId}/{allPaths=**}` already
covers `zips/`.

## Cleanup

`cleanupExpiredGalleries` already runs
`bucket.deleteFiles({ prefix: 'galleries/' + g.id + '/' })`, which sweeps the
zip files with the photos. It deletes the `photos` records by name and would
walk past the `zips` records, so **it gains a matching delete for the `zips`
subcollection**, in the same batched loop and with the same fail-closed
behaviour.

## Cost

- Function time: ~2 minutes at 512 MiB per gallery, against 400,000 GB-seconds
  free per month. Free in practice.
- Reads from Storage into the function are same-region and not charged as
  egress.
- The only real cost is a **second copy of the bytes at rest** while the gallery
  is live: about 2 cents/month for a normal gallery, 6 cents for a 2.5 GB one,
  and $0 while total storage stays under the 5 GB free line.
- Download egress is unchanged — the same bytes reach the couple either way.

## Testing

`functions/lib/gallery-zip.js` holds the pure logic and is unit-tested in
`functions/test/gallery-zip.test.js`:

- `planZipParts` — empty gallery, one photo, exactly at the cap, one photo
  larger than the cap, missing or zero `bytes`, ordering.
- `zipEntryName` — numbering, unsafe characters, very long names.
- `zipFileName` — gallery titles with quotes, slashes, emoji; single-part vs
  multi-part naming.
- `sourceFingerprint` — stable, and changes when a photo is added or removed.
- `isClaimStale` — the 20-minute lock window.

Streaming cannot be unit-tested meaningfully; it is verified by building a real
gallery in the live project and downloading it on an actual iPhone.

## Deploy

1. `npm install archiver` in `functions/`
2. `firebase deploy --only functions:prepareGalleryZip,functions:cleanupExpiredGalleries --project capturewithki-69dd3`
3. `firebase deploy --only firestore:rules --project capturewithki-69dd3`
4. Push `galleries/` to `main` for GitHub Pages.

Never a bare `firebase deploy` — see CLAUDE.md.
