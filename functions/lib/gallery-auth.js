import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

// scrypt over a fast hash because these passwords are short, human-shareable
// and reused across a couple — exactly the shape an offline guessing attack
// eats. The cost below is deliberate: a wrong guess should be slow.
const KEY_LEN = 32;
const SCRYPT_COST = 16384; // 2^14

// Ambiguous characters are left out. She reads these to a couple over the
// phone or types them into a message, and an O/0 mix-up becomes a support
// conversation. I, L, O, 0 and 1 are all gone — L belongs in that list as much
// as I does, which a test caught after the first draft kept it.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 characters
const PASSWORD_LENGTH = 8;

export function generatePassword() {
  // Rejection sampling, not `% ALPHABET.length`. 256 is not a multiple of 31,
  // so the modulo would make the first 8 letters slightly likelier than the
  // rest. The bias is small but free to avoid.
  const limit = 256 - (256 % ALPHABET.length); // 248
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    for (const byte of randomBytes(PASSWORD_LENGTH)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === PASSWORD_LENGTH) break;
    }
  }
  return out;
}

export async function hashPassword(password, salt) {
  const useSalt = salt || randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), useSalt, KEY_LEN, { N: SCRYPT_COST });
  return { hash: derived.toString('hex'), salt: useSalt };
}

// Compared with timingSafeEqual rather than ===, so the time taken cannot be
// used to learn the hash a character at a time. Length is checked first
// because timingSafeEqual throws on a mismatch.
export async function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== 'string' || typeof salt !== 'string' || typeof expectedHash !== 'string') {
    return false;
  }
  if (!password || !salt || !expectedHash) return false;

  let derived;
  try {
    const result = await hashPassword(password, salt);
    derived = Buffer.from(result.hash, 'hex');
  } catch (err) {
    return false;
  }

  let expected;
  try {
    expected = Buffer.from(expectedHash, 'hex');
  } catch (err) {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// Whether a gallery may be opened right now, and if not, why — for logging
// only. The caller must NOT pass the reason back to the visitor: telling
// someone "expired" rather than "wrong password" confirms that a gallery id is
// real, which is exactly what an id-probing attempt is looking for.
export function galleryOpenable(gallery, now) {
  if (!gallery || typeof gallery !== 'object') return { ok: false, reason: 'missing' };
  if (gallery.status !== 'live') return { ok: false, reason: 'not-live' };

  const expires = toMillis(gallery.expiresAt);
  if (expires === null) return { ok: false, reason: 'no-expiry' };
  if (expires <= now) return { ok: false, reason: 'expired' };

  return { ok: true, reason: 'ok' };
}

// Firestore hands back a Timestamp; tests and older records may hold a Date or
// a number. Anything else is treated as absent rather than coerced, so a
// malformed value fails closed instead of becoming NaN or 1970.
export function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.toMillis === 'function') {
    const t = value.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  return null;
}

// A gallery id arrives from a query string, so it is attacker-controlled. It
// is used to build a Firestore path and is embedded in a token claim, so it is
// constrained to what a Firestore auto-id can contain.
export function isValidGalleryId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{16,40}$/.test(id);
}
