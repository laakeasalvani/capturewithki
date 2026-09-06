import { test } from 'node:test';
import assert from 'node:assert';
import {
  PART_CAP_BYTES, ASSUMED_PHOTO_BYTES, CLAIM_STALE_MS,
  photoBytes, planZipParts, zipEntryName, zipFileName,
  sourceFingerprint, isClaimStale, zipStoragePath, partDocId
} from '../lib/gallery-zip.js';

const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

function photo(n, bytes) {
  return { id: 'p' + n, name: 'photo-' + n + '.jpg', order: n, bytes: bytes, fullPath: 'galleries/g/full/p' + n };
}

// --- how big is one photo -------------------------------------------------

test('a photo reports its own size', () => {
  assert.equal(photoBytes({ bytes: 3 * MB }), 3 * MB);
});

test('a photo with no usable size is assumed rather than treated as free', () => {
  // Treating it as 0 would let a part grow without bound and blow the timeout.
  for (const bad of [0, -1, NaN, Infinity, null, undefined, '4000000', {}]) {
    assert.equal(photoBytes({ bytes: bad }), ASSUMED_PHOTO_BYTES, String(bad));
  }
  assert.equal(photoBytes(null), ASSUMED_PHOTO_BYTES);
});

// --- splitting into parts -------------------------------------------------

test('an empty gallery plans no parts at all', () => {
  assert.deepEqual(planZipParts([]), []);
  assert.deepEqual(planZipParts(null), []);
});

test('a small gallery is a single part', () => {
  const parts = planZipParts([photo(1, 3 * MB), photo(2, 3 * MB)]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].index, 1);
  assert.equal(parts[0].total, 1);
  assert.equal(parts[0].bytes, 6 * MB);
  assert.deepEqual(parts[0].photos.map((p) => p.id), ['p1', 'p2']);
});

test('a gallery larger than the cap splits, and every part stamps the same total', () => {
  const photos = [];
  for (let i = 1; i <= 6; i++) photos.push(photo(i, 400 * MB));
  const parts = planZipParts(photos, 1024 * MB);
  assert.equal(parts.length, 3); // 2 photos per part at 400MB against a 1GB cap
  for (const p of parts) assert.equal(p.total, 3);
  assert.deepEqual(parts.map((p) => p.index), [1, 2, 3]);
  assert.deepEqual(parts.map((p) => p.photos.length), [2, 2, 2]);
});

test('a part is filled right up to the cap but never over it', () => {
  const parts = planZipParts([photo(1, 600 * MB), photo(2, 424 * MB)], 1024 * MB);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].bytes, 1024 * MB);
});

test('one byte over the cap starts a new part', () => {
  const parts = planZipParts([photo(1, 600 * MB), photo(2, 424 * MB + 1)], 1024 * MB);
  assert.equal(parts.length, 2);
});

test('a single photo bigger than the cap gets a part of its own rather than being dropped', () => {
  const parts = planZipParts([photo(1, 2048 * MB), photo(2, 3 * MB)], 1024 * MB);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].photos.map((p) => p.id), ['p1']);
  assert.deepEqual(parts[1].photos.map((p) => p.id), ['p2']);
});

test('every photo lands in exactly one part', () => {
  const photos = [];
  for (let i = 1; i <= 500; i++) photos.push(photo(i, 5 * MB));
  const parts = planZipParts(photos);
  const packed = parts.flatMap((p) => p.photos.map((x) => x.id));
  assert.equal(packed.length, 500);
  assert.equal(new Set(packed).size, 500);
});

test('the cap defaults to 1 GiB', () => {
  assert.equal(PART_CAP_BYTES, 1024 * 1024 * 1024);
  const photos = [];
  for (let i = 1; i <= 300; i++) photos.push(photo(i, 5 * MB)); // 1500MB
  assert.equal(planZipParts(photos).length, 2);
});

// --- names inside the zip -------------------------------------------------

test('entries are numbered so the opened folder keeps her ordering', () => {
  assert.equal(zipEntryName({ name: 'beach.jpg' }, 0), '001-beach.jpg');
  assert.equal(zipEntryName({ name: 'beach.jpg' }, 41), '042-beach.jpg');
  assert.equal(zipEntryName({ name: 'beach.jpg' }, 998), '999-beach.jpg');
});

test('numbering past 999 still sorts correctly', () => {
  // Fixed 3-wide padding gives '999-' then '1000-', and '9' sorts after '1',
  // so the folder would jump back to the start. The width follows the count.
  const a = zipEntryName({ name: 'a.jpg' }, 998, 1000);
  const b = zipEntryName({ name: 'a.jpg' }, 999, 1000);
  assert.equal(a, '0999-a.jpg');
  assert.equal(b, '1000-a.jpg');
  assert.ok(a < b);
});

test('a gallery of ordinary size stays three wide', () => {
  assert.equal(zipEntryName({ name: 'a.jpg' }, 0, 240), '001-a.jpg');
  assert.equal(zipEntryName({ name: 'a.jpg' }, 239, 240), '240-a.jpg');
});

test('a name that could escape the archive is defused', () => {
  assert.equal(zipEntryName({ name: '../../etc/passwd' }, 0), '001-.._.._etc_passwd');
  assert.equal(zipEntryName({ name: 'a/b\\c.jpg' }, 0), '001-a_b_c.jpg');
});

test('an unusable name still produces something savable', () => {
  for (const bad of [null, undefined, '', '   ', 123, {}]) {
    assert.equal(zipEntryName({ name: bad }, 0), '001-photo.jpg', String(bad));
  }
  assert.equal(zipEntryName(null, 0), '001-photo.jpg');
});

test('a very long name is trimmed but keeps its ending', () => {
  const long = 'x'.repeat(300) + '.jpg';
  const out = zipEntryName({ name: long }, 0);
  assert.ok(out.length <= 108, out.length);
  assert.ok(out.endsWith('.jpg'));
});

// --- the name of the zip itself -------------------------------------------

test('a single-part gallery is just the title', () => {
  assert.equal(zipFileName('Sarah and Tom Wedding', 1, 1), 'Sarah and Tom Wedding.zip');
});

test('a split gallery says which part it is', () => {
  assert.equal(zipFileName('Sarah and Tom Wedding', 2, 3), 'Sarah and Tom Wedding - Part 2 of 3.zip');
});

test('a title that would break a filename or a header is cleaned', () => {
  assert.equal(zipFileName('Sarah/Tom: "the big day"', 1, 1), 'Sarah_Tom_ the big day.zip');
});

test('a missing title falls back rather than producing ".zip"', () => {
  for (const bad of [null, undefined, '', '   ', '///', 42]) {
    assert.equal(zipFileName(bad, 1, 1), 'Gallery.zip', String(bad));
  }
});

// --- knowing when a zip has gone stale ------------------------------------

test('the fingerprint is stable for the same photos in any order', () => {
  const a = [photo(1, 3 * MB), photo(2, 5 * MB)];
  const b = [photo(2, 5 * MB), photo(1, 3 * MB)];
  assert.equal(sourceFingerprint(a), sourceFingerprint(b));
});

test('adding a photo changes the fingerprint', () => {
  const before = sourceFingerprint([photo(1, 3 * MB)]);
  assert.notEqual(before, sourceFingerprint([photo(1, 3 * MB), photo(2, 3 * MB)]));
});

test('removing a photo changes the fingerprint', () => {
  const before = sourceFingerprint([photo(1, 3 * MB), photo(2, 3 * MB)]);
  assert.notEqual(before, sourceFingerprint([photo(1, 3 * MB)]));
});

test('swapping a photo for one of a different size changes the fingerprint', () => {
  assert.notEqual(sourceFingerprint([photo(1, 3 * MB)]), sourceFingerprint([photo(9, 4 * MB)]));
});

test('an empty gallery has a fingerprint rather than blowing up', () => {
  assert.equal(typeof sourceFingerprint([]), 'string');
  assert.equal(sourceFingerprint([]), sourceFingerprint(null));
});

// --- not letting a dead build wedge a gallery -----------------------------

test('a build claimed moments ago is respected', () => {
  assert.equal(isClaimStale({ status: 'building', updatedAt: NOW - 1000 }, NOW), false);
});

test('a build claimed longer ago than the window may be taken over', () => {
  assert.equal(isClaimStale({ status: 'building', updatedAt: NOW - CLAIM_STALE_MS - 1 }, NOW), true);
});

test('an unreadable heartbeat is treated as dead, so a gallery cannot wedge forever', () => {
  for (const bad of [null, undefined, 'soon', {}, NaN]) {
    assert.equal(isClaimStale({ status: 'building', updatedAt: bad }, NOW), true, String(bad));
  }
});

test('anything not currently building is not a live claim', () => {
  assert.equal(isClaimStale({ status: 'ready', updatedAt: NOW }, NOW), false);
  assert.equal(isClaimStale({ status: 'failed', updatedAt: NOW }, NOW), false);
  assert.equal(isClaimStale(null, NOW), false);
});

// --- where things live ----------------------------------------------------

test('paths and ids are derived the same way on both sides', () => {
  assert.equal(partDocId(1), 'part-1');
  assert.equal(partDocId(12), 'part-12');
  assert.equal(zipStoragePath('abc123', 1), 'galleries/abc123/zips/part-1.zip');
});
