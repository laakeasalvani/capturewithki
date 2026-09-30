// The arithmetic behind "save everything to my phone", kept apart from the page
// so it can be tested in node. No DOM, no Firebase — same rule as
// functions/lib/gallery-zip.js, which this borrows its photo sizing from.
import { photoBytes } from '../functions/lib/gallery-zip.js';

// Which way "Download all" should go on this device.
//
//   ios      — the share sheet, whose "Save N Images" puts them in Photos. A
//              website cannot write to the photo library any other way.
//   android  — plain downloads. They show up in Gallery / Google Photos on
//              their own, so there is nothing to gain from the share sheet.
//   desktop  — the zip, which is what a computer handles best.
//
// iPadOS Safari sends a Mac user agent; the touch screen is what gives it away.
export function deviceKind(nav) {
  if (!nav) return 'desktop';
  const ua = String(nav.userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'desktop';
}

export function totalBytes(photos) {
  return (photos || []).reduce(function (n, p) { return n + photoBytes(p); }, 0);
}

// Split the gallery into batches small enough for a phone to hold at once.
//
// Every photo in a batch sits in the page's memory until the share sheet takes
// it, so the cap is about memory, not convenience. Split EVENLY across however
// many batches are needed — the zip design found that filling each one to the
// brim leaves a scrap at the end (50 + 10), which is a worse thing to tap
// through than 30 + 30.
//
// Returns [{ photos, first, last }] where first/last are 1-based positions in
// the gallery, for "Save photos 1–30".
export function planSaveBatches(photos, caps) {
  const list = Array.isArray(photos) ? photos : [];
  if (!list.length) return [];
  const maxCount = caps && caps.maxCount > 0 ? caps.maxCount : Infinity;
  const maxBytes = caps && caps.maxBytes > 0 ? caps.maxBytes : Infinity;

  let n = Math.max(
    1,
    isFinite(maxCount) ? Math.ceil(list.length / maxCount) : 1,
    isFinite(maxBytes) ? Math.ceil(totalBytes(list) / maxBytes) : 1
  );

  // An even split by count can still put several big photos together and go
  // over the byte cap, so add batches until none does — or until every photo
  // is on its own, which is as far as splitting can go.
  let batches = splitEvenly(list, n);
  while (n < list.length && batches.some(function (b) {
    return b.length > 1 && totalBytes(b) > maxBytes;
  })) {
    n++;
    batches = splitEvenly(list, n);
  }

  let pos = 0;
  return batches.map(function (b) {
    const first = pos + 1;
    pos += b.length;
    return { photos: b, first: first, last: pos };
  });
}

function splitEvenly(list, n) {
  const out = [];
  const base = Math.floor(list.length / n);
  let extra = list.length % n;
  let i = 0;
  for (let k = 0; k < n; k++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    if (size > 0) out.push(list.slice(i, i + size));
    i += size;
  }
  return out;
}

// iPhones only offer "Save N Images" when every file says it is an image. A
// blank or generic type turns the menu into "Save to Files", which is the
// exact thing this feature exists to avoid.
const TYPES_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
  gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff'
};

export function imageTypeFor(serverType, name) {
  if (typeof serverType === 'string' && /^image\//i.test(serverType)) return serverType;
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return (m && TYPES_BY_EXT[m[1].toLowerCase()]) || 'image/jpeg';
}

// --- getting back up after the phone runs out of memory ---------------------
//
// When an iPhone runs out of memory mid-save, Safari kills the page and
// reloads it. Nothing on the page gets a chance to react, so the only way to
// know it happened is a note written BEFORE the risky part and erased after.
// If the note is still there when the gallery next opens, the save died.

// Long enough to cover re-typing the password; short enough that a note left
// by closing Safari mid-save does not greet them days later.
export const ATTEMPT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// { at, mode: 'all'|'selected', ids?, from, count, listLength }
//   from       — position in the list where the round that died began
//   count      — how many photos that round held
//   listLength — how many photos the whole save covered
export function parseAttempt(raw, now) {
  if (!raw) return null;
  let a;
  try { a = JSON.parse(raw); } catch (err) { return null; }
  if (!a || typeof a !== 'object') return null;
  if (typeof a.at !== 'number' || a.at > now + 60000 || now - a.at > ATTEMPT_MAX_AGE_MS) return null;
  if (a.mode !== 'all' && a.mode !== 'selected') return null;
  if (!Number.isInteger(a.count) || a.count < 1) return null;
  if (!Number.isInteger(a.from) || a.from < 0) return null;
  if (!Number.isInteger(a.listLength) || a.listLength < a.count) return null;
  if (a.mode === 'selected' && (!Array.isArray(a.ids) || !a.ids.length)) return null;
  return a;
}

// Pick up where it broke, with rounds half the size of the one that died.
// Halving again on every further crash is what gets an old phone through.
export function recoveryFrom(a) {
  return { from: a.from, maxCount: Math.max(1, Math.floor(a.count / 2)) };
}

// The number has to be the real one. "All" only when the round that died
// really was everything; a second crash is on a half-size round.
export function crashMessage(a) {
  if (a.count === 1) return 'Your phone couldn’t hold that photo.';
  return 'Your phone couldn’t hold ' + (a.count === a.listLength && a.from === 0 ? 'all ' : '') +
    a.count + ' photos at once.';
}
