// Runs the real submitReviewFeedback handler with an in-memory database and a
// stubbed fetch, so nothing here can touch Firestore or send an email.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { registerHooks } from 'node:module';

const docs = [];
const limits = new Map();
const fakeDb = {
  collection(name) {
    if (name === 'inquiries') {
      return {
        add: async (data) => {
          const stored = Object.assign({}, data);
          docs.push(stored);
          return { update: async (patch) => { Object.assign(stored, patch); } };
        }
      };
    }
    if (name === 'rateLimits') {
      return { doc: (id) => ({ id }) };
    }
    throw new Error('unexpected collection ' + name);
  },
  runTransaction: (fn) => fn({
    get: async (ref) => ({ exists: limits.has(ref.id), data: () => limits.get(ref.id) }),
    set: (ref, value) => { limits.set(ref.id, value); }
  })
};
globalThis.__fakeDb = fakeDb;

registerHooks({
  load(url, context, next) {
    if (url.includes('firebase-admin') && url.includes('firestore')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const getFirestore = () => globalThis.__fakeDb;' +
          'export const FieldValue = { serverTimestamp: () => "SERVER_TIME" };' +
          'export const Timestamp = {};'
      };
    }
    return next(url, context);
  }
});

const realFetch = globalThis.fetch;
const sent = [];
let resendFails = false;
globalThis.fetch = async (url, opts) => {
  if (!String(url).includes('api.resend.com')) return realFetch(url, opts);
  sent.push(JSON.parse(opts.body));
  if (resendFails) return { ok: false, status: 500, json: async () => ({}), text: async () => 'down' };
  return { ok: true, status: 200, json: async () => ({ id: 'stub' }), text: async () => '{}' };
};
process.env.RESEND_API_KEY = 'stub-key';
process.env.GCLOUD_PROJECT = 'demo-capturewithki';

const fns = await import('../index.js');

// A small stand-in for what Cloud Functions hands the handler.
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    req.body = raw ? JSON.parse(raw) : undefined;
    req.ip = '203.0.113.' + (req.headers['x-test-ip'] || '1');
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    fns.submitReviewFeedback(req, res);
  });
});
await new Promise((r) => server.listen(0, r));
const base = 'http://127.0.0.1:' + server.address().port;

async function post(body, ip, origin) {
  const res = await realFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': origin || 'https://capturewithki.com', 'x-test-ip': String(ip) },
    body: JSON.stringify(body)
  });
  return { status: res.status, cors: res.headers.get('access-control-allow-origin'), body: await res.json() };
}

const VALID = { rating: 2, name: 'Dana Reyes', email: 'dana@example.com', message: 'Photos came late.' };

test.after(() => { server.close(); });

test('saves as an inquiry, emails Khiara, and replies go to the client', async () => {
  const r = await post(VALID, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.cors, 'https://capturewithki.com');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].kind, 'review-feedback');
  assert.equal(docs[0].rating, 2);
  assert.equal(docs[0].status, 'new');
  assert.equal(docs[0].createdAt, 'SERVER_TIME');
  assert.equal(docs[0].emailToOwnerSent, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['capturewithki@gmail.com']);
  assert.deepEqual(sent[0].reply_to, ['dana@example.com']);
});

test('tells a bot it succeeded and saves nothing', async () => {
  const before = docs.length;
  const r = await post(Object.assign({}, VALID, { honeypot: 'filled' }), 2);
  assert.equal(r.body.ok, true);
  assert.equal(docs.length, before);
});

test('refuses an invalid submission with a readable error', async () => {
  const before = docs.length;
  const r = await post(Object.assign({}, VALID, { rating: 9 }), 2);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Please choose a star rating.');
  assert.equal(docs.length, before);
});

test('keeps the feedback and flags it when the email fails', async () => {
  resendFails = true;
  const r = await post(VALID, 3);
  resendFails = false;
  assert.equal(r.status, 200);
  const last = docs[docs.length - 1];
  assert.equal(last.emailToOwnerSent, false);
  assert.ok(last.emailError);
});

test('rate limits after five in an hour', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await post(VALID, 4)).status, 200);
  assert.equal((await post(VALID, 4)).status, 429);
});

test('does not grant CORS to another website', async () => {
  const r = await post(VALID, 5, 'https://evil.example.com');
  assert.equal(r.cors, null);
});
