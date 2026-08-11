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

// Fake Firestore: records the call shape (collection/doc names, transaction
// use) and supports runTransaction, so wiring bugs (wrong collection name,
// one hardcoded doc for every visitor, a non-transactional implementation)
// fail the tests instead of slipping through.
function fakeDb(existing) {
  let stored = existing;
  const seen = { collection: null, doc: null, transactions: 0 };
  const ref = { __isRef: true };
  return {
    saved: () => stored,
    seen: () => seen,
    collection(name) {
      seen.collection = name;
      return { doc(id) { seen.doc = id; return ref; } };
    },
    async runTransaction(fn) {
      seen.transactions++;
      return fn({
        async get(r) {
          if (r !== ref) throw new Error('transaction read an unexpected ref');
          return { exists: stored !== undefined, data: () => stored };
        },
        set(r, v) {
          if (r !== ref) throw new Error('transaction wrote an unexpected ref');
          stored = v;
        }
      });
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

test('a visitor whose clock runs ahead is not treated as a bot', () => {
  const now = 1000000;
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: now + 20000, now: now }), false);
});

test('an instant submission is still treated as a bot', () => {
  const now = 1000000;
  assert.equal(isBotSubmission({ honeypot: '', renderedAt: now, now: now }), true);
});

test('rate limiting reads and writes the right document', async () => {
  const db = fakeDb(undefined);
  await checkRateLimit(db, 'abc123', 1000);
  assert.equal(db.seen().collection, 'rateLimits');
  assert.equal(db.seen().doc, 'abc123');
});

test('rate limiting runs inside a transaction', async () => {
  const db = fakeDb(undefined);
  await checkRateLimit(db, 'abc123', 1000);
  assert.equal(db.seen().transactions, 1, 'must use runTransaction, not a bare get/set');
});

test('a blocked caller does not get their window extended', async () => {
  const db = fakeDb({ count: 5, windowStart: 1000 });
  const r = await checkRateLimit(db, 'abc', 2000);
  assert.equal(r.allowed, false);
  assert.deepEqual(db.saved(), { count: 5, windowStart: 1000 }, 'blocked path must not write');
});
