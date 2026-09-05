//
// Node only. Kept apart from contracts.js because the browser imports that
// file and must never pull node:crypto in through it.
//
// Note the divergence from gallery-auth.js, which scrypts its passwords at
// cost 2^14. That is right THERE: gallery passwords are 8 human-typed
// characters shared aloud between a couple, exactly the shape an offline
// guessing attack eats. A contract token is 32 random bytes — 256 bits — so
// guessing is not a threat and scrypt would buy latency and nothing else.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_BYTES = 32;

export function generateToken() {
  // base64url, so it survives a query string without escaping. No modulo and
  // therefore no rejection sampling needed — unlike generatePassword, which
  // maps bytes onto a 31-letter alphabet and does need it.
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isValidTokenShape(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function hashToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyToken(token, expectedHash) {
  // Length is checked BEFORE Buffer.from, because Buffer.from(s, 'hex')
  // truncates silently at the first non-hex character — a stored hash of
  // 'zz' would otherwise become an empty buffer that compares equal to
  // another empty buffer.
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = hashToken(token);
  if (!actual) return false;
  // timingSafeEqual rather than ===, so the time taken cannot be used to
  // learn the hash a character at a time. Same reasoning as verifyPassword.
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// The binding between a signature and the exact words that were signed. If
// the template is edited later, this no longer matches the new text, which is
// what proves the signed version was not swapped.
export function hashDocument(html) {
  return 'sha256:' + createHash('sha256').update(String(html), 'utf8').digest('hex');
}
