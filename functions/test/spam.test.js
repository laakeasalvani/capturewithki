import { test } from 'node:test';
import assert from 'node:assert';
import { isBotSubmission, hashIp, checkRateLimit } from '../lib/spam.js';

test('honeypot with any value is a bot', () => {
  assert.equal(isBotSubmission({ honeypot: 'x', renderedAt: 0, now: 999999 }), true);
});

test('submitting faster than 3 seconds is a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: 1000, now: 2500 }), true);
});

test('empty honeypot and a human pause is not a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: 1000, now: 20000 }), false);
});

test('a missing renderedAt is not treated as a bot', () => {
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: undefined, now: 20000 }), false);
});

test('hashIp is stable and does not contain the raw ip', () => {
  const h = hashIp('203.0.113.7');
  assert.equal(h, hashIp('203.0.113.7'));
  assert.ok(!h.includes('203'));
  assert.equal(h.length, 64);
});

// Minimal fake Firestore: only what checkRateLimit uses.
function fakeDb(existing) {
  let stored = existing;
  return {
    saved: () => stored,
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: stored !== undefined, data: () => stored };
            },
            async set(v) { stored = v; }
          };
        }
      };
    }
  };
}

test('first submission is allowed and starts a window', async () => {
  const db = fakeDb(undefined);
  const r = await checkRateLimit(db, 'abc', 1000);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 1);
});

test('fifth submission inside the window is allowed', async () => {
  const db = fakeDb({ count: 4, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 2000);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 5);
});

test('sixth submission inside the window is blocked', async () => {
  const db = fakeDb({ count: 5, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 2000);
  assert.equal(r.allowed, false);
});

test('a new window resets the count', async () => {
  const db = fakeDb({ count: 5, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 1000 + 3600001);
  assert.equal(r.allowed, true);
  assert.equal(db.saved().count, 1);
});
