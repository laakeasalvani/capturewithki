import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_DAYS, defaultExpiry, isDue, dueGalleries, daysLeft, validateExpiry
} from '../lib/gallery-expiry.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

test('the default window is 30 days from when she presses Send', () => {
  assert.equal(DEFAULT_DAYS, 30);
  assert.equal(defaultExpiry(NOW), NOW + 30 * DAY);
});

test('she can choose a different number of days', () => {
  assert.equal(defaultExpiry(NOW, 14), NOW + 14 * DAY);
  assert.equal(defaultExpiry(NOW, 90), NOW + 90 * DAY);
});

test('a nonsense day count falls back to 30 rather than to zero', () => {
  for (const bad of [0, -5, NaN, Infinity, null, undefined, 'ten', {}]) {
    assert.equal(defaultExpiry(NOW, bad), NOW + 30 * DAY, String(bad));
  }
});

// --- what gets cleaned up -------------------------------------------------

test('a live gallery past its date is due', () => {
  assert.equal(isDue({ status: 'live', expiresAt: NOW - 1 }, NOW), true);
  assert.equal(isDue({ status: 'live', expiresAt: NOW }, NOW), true);
});

test('a live gallery still inside its window is not due', () => {
  assert.equal(isDue({ status: 'live', expiresAt: NOW + 1 }, NOW), false);
});

test('a draft is never due, however old', () => {
  assert.equal(isDue({ status: 'draft', expiresAt: NOW - 999 * DAY }, NOW), false);
});

test('an already-expired gallery is not re-processed', () => {
  assert.equal(isDue({ status: 'expired', expiresAt: NOW - DAY }, NOW), false);
});

test('an unreadable or missing date is left alone, never deleted', () => {
  for (const bad of [null, undefined, 'soon', {}, NaN, Infinity, []]) {
    assert.equal(isDue({ status: 'live', expiresAt: bad }, NOW), false, String(bad));
  }
  assert.equal(isDue({ status: 'live' }, NOW), false);
});

test('a malformed gallery is left alone', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(isDue(bad, NOW), false, String(bad));
  }
});

test('dueGalleries picks out only the ones that are due', () => {
  const list = [
    { id: 'a', status: 'live', expiresAt: NOW - DAY },
    { id: 'b', status: 'live', expiresAt: NOW + DAY },
    { id: 'c', status: 'draft', expiresAt: NOW - DAY },
    { id: 'd', status: 'expired', expiresAt: NOW - DAY },
    { id: 'e', status: 'live', expiresAt: null }
  ];
  assert.deepEqual(dueGalleries(list, NOW).map(g => g.id), ['a']);
  assert.deepEqual(dueGalleries(null, NOW), []);
});

// --- what the couple is told ---------------------------------------------

test('days remaining rounds up so a part-day still counts', () => {
  assert.equal(daysLeft(NOW + 30 * DAY, NOW), 30);
  assert.equal(daysLeft(NOW + DAY + 1, NOW), 2);
  assert.equal(daysLeft(NOW + 1, NOW), 1);
});

test('an elapsed gallery reports zero, never a negative', () => {
  assert.equal(daysLeft(NOW, NOW), 0);
  assert.equal(daysLeft(NOW - 99 * DAY, NOW), 0);
});

test('an unreadable date reports nothing rather than a wrong number', () => {
  for (const bad of [null, undefined, 'soon', {}, NaN]) {
    assert.equal(daysLeft(bad, NOW), null, String(bad));
  }
});

// --- the date she types --------------------------------------------------

test('a future date is accepted', () => {
  const r = validateExpiry(NOW + 10 * DAY, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.value, NOW + 10 * DAY);
});

test('a past date is refused — it would delete the photos on the next run', () => {
  assert.equal(validateExpiry(NOW - DAY, NOW).valid, false);
  assert.equal(validateExpiry(NOW, NOW).valid, false);
});

test('a date years away is refused as a mistyped year', () => {
  assert.equal(validateExpiry(NOW + 3651 * DAY, NOW).valid, false);
  assert.equal(validateExpiry(NOW + 3649 * DAY, NOW).valid, true);
});

test('an unreadable date is refused with a message, not a crash', () => {
  for (const bad of [null, undefined, 'whenever', {}, NaN, []]) {
    const r = validateExpiry(bad, NOW);
    assert.equal(r.valid, false, String(bad));
    assert.ok(r.error && r.error.length > 0);
  }
});

test('a Date object and a Firestore timestamp are both understood', () => {
  assert.equal(validateExpiry(new Date(NOW + DAY), NOW).valid, true);
  assert.equal(validateExpiry({ toMillis: () => NOW + DAY }, NOW).valid, true);
});
