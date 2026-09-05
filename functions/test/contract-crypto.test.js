import { test } from 'node:test';
import assert from 'node:assert';
import {
  TOKEN_BYTES, generateToken, isValidTokenShape,
  hashToken, verifyToken, hashDocument
} from '../lib/contract-crypto.js';

test('a token is 32 random bytes', () => {
  assert.equal(TOKEN_BYTES, 32);
});

// 32 bytes in base64url is 43 characters with no padding.
test('a token is 43 url-safe characters', () => {
  const t = generateToken();
  assert.equal(t.length, 43);
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.includes('='), false);
});

test('tokens do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateToken());
  assert.equal(seen.size, 1000);
});

test('token shape is checked before anything touches Firestore', () => {
  assert.equal(isValidTokenShape(generateToken()), true);
  assert.equal(isValidTokenShape('too-short'), false);
  assert.equal(isValidTokenShape('a'.repeat(44)), false);
  assert.equal(isValidTokenShape('../../etc/passwd'), false);
  assert.equal(isValidTokenShape(''), false);
  assert.equal(isValidTokenShape(null), false);
});

test('hashing a token is stable and 64 hex characters', () => {
  const t = generateToken();
  assert.equal(hashToken(t), hashToken(t));
  assert.match(hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(t), hashToken(generateToken()));
});

test('hashing nonsense yields null rather than a usable hash', () => {
  assert.equal(hashToken(''), null);
  assert.equal(hashToken(null), null);
  assert.equal(hashToken(42), null);
});

test('a token verifies against its own hash and nothing else', () => {
  const t = generateToken();
  assert.equal(verifyToken(t, hashToken(t)), true);
  assert.equal(verifyToken(generateToken(), hashToken(t)), false);
});

// Buffer.from(str, 'hex') silently truncates at the first non-hex character,
// so a stored hash of "zz" would become a zero-length buffer and could
// compare equal to another zero-length buffer. The length check comes first.
test('a malformed stored hash never verifies', () => {
  const t = generateToken();
  assert.equal(verifyToken(t, ''), false);
  assert.equal(verifyToken(t, 'z'.repeat(64)), false);
  assert.equal(verifyToken(t, 'ab'), false);
  assert.equal(verifyToken(t, null), false);
  assert.equal(verifyToken('', ''), false);
});

test('a document hash changes when a single character changes', () => {
  const a = hashDocument('<p>Total: $1,200</p>');
  const b = hashDocument('<p>Total: $1,300</p>');
  assert.notEqual(a, b);
  assert.equal(a, hashDocument('<p>Total: $1,200</p>'));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});
