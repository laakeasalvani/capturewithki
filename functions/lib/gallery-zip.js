// Planning and naming for zipped gallery downloads.
//
// No node imports in this file, deliberately: galleries/gallery.js imports it
// in the browser to work out whether a finished zip still matches the gallery,
// and a node:crypto import anywhere in the chain would crash the page. The
// same rule that governs gallery-expiry.js governs this one. All the streaming
// lives in functions/index.js, where node is fine.
import { toMillis } from './gallery-expiry.js';

// Three gigabytes per part, which for this photographer means ONE part.
//
// Her worst realistic gallery is 500 photos at 5MB, about 2.44GB, so this cap
// is set above it deliberately: the couple get one file and one tap, every
// time. Splitting still exists below and is still correct, but it is a safety
// valve for a gallery beyond anything she has ever sent, not a normal outcome.
//
// The number was 1GiB first, chosen to keep any single download small. That
// was the wrong thing to optimise. A couple who has to understand "Part 2 of
// 3" pays that cost on every gallery; the risk of a big download is paid
// rarely and, because Storage downloads resume, is recoverable when it is.
//
// What it costs: a 2.4GB file needs 2.4GB free on the phone at once and can
// take 10-40 minutes on bad wifi. Lower this constant if a client ever
// struggles — everything else adapts on its own, including invalidating any
// zip that was built under the old value.
export const PART_CAP_BYTES = 3 * 1024 * 1024 * 1024;

// What an unmeasured photo is assumed to weigh. Treating it as free would let
// a part grow without bound, which is the one planning mistake that turns into
// a timeout rather than a slightly uneven split.
export const ASSUMED_PHOTO_BYTES = 4 * 1024 * 1024;

// How long a "building" claim is believed. An instance killed mid-build leaves
// its claim behind; without an expiry that gallery could never be zipped again.
export const CLAIM_STALE_MS = 20 * 60 * 1000;

export function photoBytes(photo) {
  const raw = photo && photo.bytes;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return ASSUMED_PHOTO_BYTES;
  return raw;
}

function byOrder(a, b) {
  const ao = typeof a.order === 'number' && Number.isFinite(a.order) ? a.order : 0;
  const bo = typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : 0;
  if (ao !== bo) return ao - bo;
  // A tie must not depend on which order Firestore handed them back, or the
  // same gallery could be numbered differently on two runs.
  return String(a.id || '') < String(b.id || '') ? -1 : 1;
}

// Pack the photos, in her order, into parts no larger than `capBytes`.
//
// Two passes, not one. The first works out how many parts are NEEDED; the
// second spreads the photos evenly across exactly that many.
//
// Filling each part to the brim and letting the remainder fall into the next
// one is simpler and produces lopsided splits: 400 photos at 4MB came out as
// 1536MB + 64MB, so the couple downloaded an enormous file and then tapped
// again for a scrap. Same number of parts, far worse to use. Evenly split,
// that gallery is 800MB + 800MB.
//
// A photo larger than the cap on its own still gets a part to itself rather
// than being skipped: an oversized file is still the couple's photo, and a plan
// that silently drops one is worse than a part that runs over.
export function planZipParts(photos, capBytes) {
  if (!Array.isArray(photos) || !photos.length) return [];
  const cap = typeof capBytes === 'number' && Number.isFinite(capBytes) && capBytes > 0
    ? capBytes
    : PART_CAP_BYTES;

  const ordered = photos.slice().sort(byOrder);
  let total = 0;
  for (const p of ordered) total += photoBytes(p);

  const wanted = Math.max(1, Math.ceil(total / cap));
  const target = total / wanted;

  const parts = [];
  let current = { index: 1, total: 0, photos: [], bytes: 0 };

  for (const p of ordered) {
    const size = photoBytes(p);
    // Move on once this part has taken its share — but never open more parts
    // than were planned, and never leave one empty. Those two guards are what
    // keep an oversized photo, or a long tail of tiny ones, from turning the
    // even split back into a ragged one.
    if (current.photos.length && current.bytes + size > target && parts.length < wanted - 1) {
      parts.push(current);
      current = { index: parts.length + 1, total: 0, photos: [], bytes: 0 };
    }
    current.photos.push(p);
    current.bytes += size;
  }
  parts.push(current);

  // Stamped afterwards, because "of 3" is not known until the packing is done.
  for (const part of parts) part.total = parts.length;
  return parts;
}

// Anything outside this set becomes an underscore. Quotes are dropped rather
// than replaced because they are what would break the Content-Disposition
// header the browser reads the filename out of.
function clean(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/["']/g, '').replace(/[^A-Za-z0-9 ._-]/g, '_');
}

// `001-beach.jpg`. The number is what makes the opened folder sort the way she
// arranged the gallery — a zip has no ordering of its own, and an alphabetical
// folder of camera filenames is not the sequence she chose. It also means two
// photos sharing a name cannot collide inside the archive.
//
// The width comes from the gallery's size, and a test is why. Padding to a
// fixed 3 gives '999-' and '1000-', and '9' sorts after '1', so the folder
// would jump back to the start after photo 999. Every number must be the same
// width for text ordering to match counting order.
export function zipEntryName(photo, indexInGallery, totalPhotos) {
  const cleaned = clean(photo && photo.name).trim().slice(-100);
  const name = cleaned || 'photo.jpg';
  const count = typeof totalPhotos === 'number' && Number.isFinite(totalPhotos) ? totalPhotos : 0;
  const width = Math.max(3, String(Math.max(count, 0)).length);
  return String(indexInGallery + 1).padStart(width, '0') + '-' + name;
}

export function zipFileName(title, index, total) {
  const cleaned = clean(title)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
    .trim();
  const base = cleaned || 'Gallery';
  return total > 1 ? base + ' - Part ' + index + ' of ' + total + '.zip' : base + '.zip';
}

// What the zip was built FROM, so a stale one can be spotted.
//
// Count plus total bytes, which both sides can compute from the photo records
// they already hold — the page needs no extra read to check. Two different sets
// of photos summing to the same bytes would collide; the cost of that is one
// slightly out-of-date zip, with every photo still savable on its own, and
// hashing every id instead would put real work in the browser to close it.
//
// The part count is in there for a sharper reason. Without it, changing
// PART_CAP_BYTES leaves every existing zip looking valid while the plan around
// it has changed shape: a gallery built as 3 parts, now planned as 1, would
// hand the couple part 1 of the OLD plan and call the download complete —
// silently short by two thirds of their wedding. Including it means any zip
// built under a different cap is seen as stale and rebuilt.
export function sourceFingerprint(photos) {
  if (!Array.isArray(photos) || !photos.length) return '0:0:0';
  let total = 0;
  for (const p of photos) total += photoBytes(p);
  return photos.length + ':' + total + ':' + planZipParts(photos).length;
}

export function isClaimStale(part, now) {
  if (!part || part.status !== 'building') return false;
  const at = toMillis(part.updatedAt);
  // A heartbeat that cannot be read is treated as dead. Failing the other way
  // would let one unreadable field wedge a gallery until it expired.
  if (at === null) return true;
  return now - at > CLAIM_STALE_MS;
}

export function partDocId(index) {
  return 'part-' + index;
}

export function zipStoragePath(galleryId, index) {
  return 'galleries/' + galleryId + '/zips/' + partDocId(index) + '.zip';
}
