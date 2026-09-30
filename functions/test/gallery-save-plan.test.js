import { test } from 'node:test';
import assert from 'node:assert';
import {
  deviceKind, planSaveBatches, imageTypeFor, totalBytes
} from '../../galleries/save-plan.js';

const MB = 1024 * 1024;

function photo(n, bytes) {
  return { id: 'p' + n, name: 'photo-' + n + '.jpg', order: n, bytes: bytes };
}
function many(count, bytes) {
  const out = [];
  for (let i = 1; i <= count; i++) out.push(photo(i, bytes));
  return out;
}

// --- which phone is this ----------------------------------------------------

test('an iPhone is ios', () => {
  assert.equal(deviceKind({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15',
    platform: 'iPhone', maxTouchPoints: 5
  }), 'ios');
});

test('an iPad pretending to be a Mac is still ios', () => {
  // iPadOS Safari sends a desktop Mac user agent. The touch screen gives it away.
  assert.equal(deviceKind({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 5
  }), 'ios');
});

test('a real Mac is desktop', () => {
  assert.equal(deviceKind({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel', maxTouchPoints: 0
  }), 'desktop');
});

test('an Android phone is android', () => {
  assert.equal(deviceKind({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile',
    platform: 'Linux armv8l', maxTouchPoints: 5
  }), 'android');
});

test('nothing to go on is desktop', () => {
  assert.equal(deviceKind({}), 'desktop');
  assert.equal(deviceKind(null), 'desktop');
});

// --- splitting into batches -------------------------------------------------

test('no photos, no batches', () => {
  assert.deepEqual(planSaveBatches([], { maxCount: 50, maxBytes: 300 * MB }), []);
  assert.deepEqual(planSaveBatches(null, { maxCount: 50, maxBytes: 300 * MB }), []);
});

test('a small session is one batch', () => {
  const b = planSaveBatches(many(40, 4 * MB), { maxCount: 50, maxBytes: 300 * MB });
  assert.equal(b.length, 1);
  assert.equal(b[0].photos.length, 40);
  assert.equal(b[0].first, 1);
  assert.equal(b[0].last, 40);
});

test('the count cap splits evenly, not 50 + a scrap', () => {
  const b = planSaveBatches(many(60, 1 * MB), { maxCount: 50, maxBytes: Infinity });
  assert.deepEqual(b.map(function (x) { return x.photos.length; }), [30, 30]);
  assert.equal(b[1].first, 31);
  assert.equal(b[1].last, 60);
});

test('the byte cap splits too', () => {
  const b = planSaveBatches(many(100, 5 * MB), { maxCount: 1000, maxBytes: 200 * MB });
  assert.ok(b.length >= 3);
  for (const x of b) assert.ok(totalBytes(x.photos) <= 200 * MB, 'batch too big: ' + totalBytes(x.photos));
});

test('uneven sizes still respect the byte cap', () => {
  const photos = many(10, 1 * MB).concat(many(10, 9 * MB)).map(function (p, i) {
    return Object.assign({}, p, { id: 'q' + i });
  });
  const b = planSaveBatches(photos, { maxCount: 1000, maxBytes: 30 * MB });
  for (const x of b) assert.ok(totalBytes(x.photos) <= 30 * MB, 'batch too big: ' + totalBytes(x.photos));
});

test('every photo lands in exactly one batch, in order', () => {
  const photos = many(237, 3 * MB);
  const b = planSaveBatches(photos, { maxCount: 50, maxBytes: 300 * MB });
  const ids = [];
  b.forEach(function (x) { x.photos.forEach(function (p) { ids.push(p.id); }); });
  assert.deepEqual(ids, photos.map(function (p) { return p.id; }));
});

test('a photo bigger than the whole cap gets a batch of its own, never dropped', () => {
  const photos = [photo(1, 2 * MB), photo(2, 500 * MB), photo(3, 2 * MB)];
  const b = planSaveBatches(photos, { maxCount: 50, maxBytes: 100 * MB });
  const ids = [];
  b.forEach(function (x) { x.photos.forEach(function (p) { ids.push(p.id); }); });
  assert.deepEqual(ids, ['p1', 'p2', 'p3']);
  for (const x of b) assert.ok(x.photos.length > 0);
});

test('no cap at all is one batch', () => {
  const b = planSaveBatches(many(500, 5 * MB), { maxCount: Infinity, maxBytes: Infinity });
  assert.equal(b.length, 1);
  assert.equal(b[0].photos.length, 500);
});

// --- what kind of file is this ---------------------------------------------

test('a proper image type from the server is kept', () => {
  assert.equal(imageTypeFor('image/png', 'x.jpg'), 'image/png');
});

test('a missing or generic type is worked out from the name', () => {
  // iPhones only offer "Save Images" when every file says it is an image.
  assert.equal(imageTypeFor('', 'IMG_1.JPG'), 'image/jpeg');
  assert.equal(imageTypeFor('application/octet-stream', 'a.jpeg'), 'image/jpeg');
  assert.equal(imageTypeFor(undefined, 'a.png'), 'image/png');
  assert.equal(imageTypeFor(null, 'a.heic'), 'image/heic');
  assert.equal(imageTypeFor('', 'a.webp'), 'image/webp');
  assert.equal(imageTypeFor('', 'noextension'), 'image/jpeg');
});

// --- getting back up after the phone runs out of memory ---------------------

import { parseAttempt, recoveryFrom, crashMessage, ATTEMPT_MAX_AGE_MS } from '../../galleries/save-plan.js';

const NOW = Date.UTC(2026, 8, 29, 20, 0, 0);
function attempt(over) {
  return Object.assign({ at: NOW - 60000, mode: 'all', from: 0, count: 500, listLength: 500 }, over);
}

test('a fresh attempt record is read back', () => {
  const a = parseAttempt(JSON.stringify(attempt()), NOW);
  assert.equal(a.count, 500);
  assert.equal(a.mode, 'all');
});

test('an old, broken or missing record is ignored', () => {
  assert.equal(parseAttempt(null, NOW), null);
  assert.equal(parseAttempt('', NOW), null);
  assert.equal(parseAttempt('{not json', NOW), null);
  assert.equal(parseAttempt(JSON.stringify(attempt({ at: NOW - ATTEMPT_MAX_AGE_MS - 1 })), NOW), null);
  assert.equal(parseAttempt(JSON.stringify(attempt({ count: 0 })), NOW), null);
  assert.equal(parseAttempt(JSON.stringify(attempt({ count: 'x' })), NOW), null);
  assert.equal(parseAttempt(JSON.stringify(attempt({ from: -1 })), NOW), null);
  assert.equal(parseAttempt(JSON.stringify(attempt({ mode: 'weird' })), NOW), null);
  // A record from the future means a wrong clock, not a crash worth acting on.
  assert.equal(parseAttempt(JSON.stringify(attempt({ at: NOW + 3600000 })), NOW), null);
});

test('a selection record must carry the photos that were picked', () => {
  assert.equal(parseAttempt(JSON.stringify(attempt({ mode: 'selected' })), NOW), null);
  const a = parseAttempt(JSON.stringify(attempt({ mode: 'selected', ids: ['a', 'b'], count: 2, listLength: 2 })), NOW);
  assert.deepEqual(a.ids, ['a', 'b']);
});

test('after a crash the next try is half the size, starting where it broke', () => {
  assert.deepEqual(recoveryFrom(attempt()), { from: 0, maxCount: 250 });
  assert.deepEqual(recoveryFrom(attempt({ from: 250, count: 250 })), { from: 250, maxCount: 125 });
  assert.deepEqual(recoveryFrom(attempt({ count: 7 })), { from: 0, maxCount: 3 });
});

test('halving never reaches zero', () => {
  assert.deepEqual(recoveryFrom(attempt({ count: 1 })), { from: 0, maxCount: 1 });
});

test('the message names the real number', () => {
  assert.equal(crashMessage(attempt()), 'Your phone couldn’t hold all 500 photos at once.');
  assert.equal(crashMessage(attempt({ count: 56, listLength: 56 })), 'Your phone couldn’t hold all 56 photos at once.');
  // A second crash is on a half-size round, which is not "all" of anything.
  assert.equal(crashMessage(attempt({ from: 0, count: 250 })), 'Your phone couldn’t hold 250 photos at once.');
  assert.equal(crashMessage(attempt({ count: 1, listLength: 3 })), 'Your phone couldn’t hold that photo.');
});
