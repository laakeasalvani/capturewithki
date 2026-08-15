import { test } from 'node:test';
import assert from 'node:assert';
import {
  generatePassword, hashPassword, verifyPassword,
  galleryOpenable, toMillis, isValidGalleryId
} from '../lib/gallery-auth.js';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

// --- passwords ------------------------------------------------------------

test('a generated password is 8 characters from the unambiguous alphabet', () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.equal(p.length, 8);
    assert.match(p, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  }
});

test('generated passwords leave out the characters people misread', () => {
  let all = '';
  for (let i = 0; i < 200; i++) all += generatePassword();
  for (const c of ['O', '0', 'I', '1', 'L']) {
    assert.ok(!all.includes(c), 'ambiguous character ' + c + ' appeared');
  }
});

test('two generated passwords are not the same', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(generatePassword());
  assert.ok(seen.size > 190, 'suspiciously few distinct passwords: ' + seen.size);
});

test('the right password verifies', async () => {
  const { hash, salt } = await hashPassword('SUNSET24');
  assert.equal(await verifyPassword('SUNSET24', salt, hash), true);
});

test('the wrong password does not verify', async () => {
  const { hash, salt } = await hashPassword('SUNSET24');
  for (const wrong of ['sunset24', 'SUNSET25', 'SUNSET2', 'SUNSET244', '', ' SUNSET24']) {
    assert.equal(await verifyPassword(wrong, salt, hash), false, 'accepted ' + JSON.stringify(wrong));
  }
});

test('the same password under a different salt does not verify', async () => {
  const a = await hashPassword('SUNSET24');
  const b = await hashPassword('SUNSET24');
  assert.notEqual(a.salt, b.salt, 'salts must differ per gallery');
  assert.notEqual(a.hash, b.hash, 'same password must not produce the same hash');
  assert.equal(await verifyPassword('SUNSET24', a.salt, b.hash), false);
});

test('the password itself is never recoverable from what is stored', async () => {
  const { hash, salt } = await hashPassword('SUNSET24');
  assert.ok(!hash.includes('SUNSET24'));
  assert.ok(!salt.includes('SUNSET24'));
  assert.match(hash, /^[0-9a-f]+$/);
});

test('malformed input is refused rather than throwing', async () => {
  const { hash, salt } = await hashPassword('SUNSET24');
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(await verifyPassword(bad, salt, hash), false, 'password ' + String(bad));
    assert.equal(await verifyPassword('SUNSET24', bad, hash), false, 'salt ' + String(bad));
    assert.equal(await verifyPassword('SUNSET24', salt, bad), false, 'hash ' + String(bad));
  }
});

test('a hash of the wrong length is refused, not compared', async () => {
  const { salt } = await hashPassword('SUNSET24');
  assert.equal(await verifyPassword('SUNSET24', salt, 'abcd'), false);
  assert.equal(await verifyPassword('SUNSET24', salt, ''), false);
});

// --- whether a gallery may be opened --------------------------------------

const live = { status: 'live', expiresAt: NOW + 24 * HOUR };

test('a live, unexpired gallery opens', () => {
  assert.deepEqual(galleryOpenable(live, NOW), { ok: true, reason: 'ok' });
});

test('a draft gallery does not open', () => {
  const draft = { status: 'draft', expiresAt: NOW + 24 * HOUR };
  assert.equal(galleryOpenable(draft, NOW).ok, false);
});

test('an expired gallery does not open', () => {
  const expired = { status: 'live', expiresAt: NOW - 1 };
  assert.equal(galleryOpenable(expired, NOW).ok, false);
});

test('expiry is exclusive at the exact millisecond', () => {
  assert.equal(galleryOpenable({ status: 'live', expiresAt: NOW }, NOW).ok, false);
  assert.equal(galleryOpenable({ status: 'live', expiresAt: NOW + 1 }, NOW).ok, true);
});

test('a gallery with no expiry does not open', () => {
  assert.equal(galleryOpenable({ status: 'live' }, NOW).ok, false);
  assert.equal(galleryOpenable({ status: 'live', expiresAt: null }, NOW).ok, false);
});

test('a missing or malformed gallery does not open', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.equal(galleryOpenable(bad, NOW).ok, false, String(bad));
  }
});

test('a garbage expiry fails closed rather than becoming 1970 or NaN', () => {
  for (const bad of ['soon', {}, NaN, Infinity]) {
    assert.equal(galleryOpenable({ status: 'live', expiresAt: bad }, NOW).ok, false, String(bad));
  }
});

// --- timestamp shapes -----------------------------------------------------

test('toMillis accepts the shapes Firestore and tests actually produce', () => {
  assert.equal(toMillis(NOW), NOW);
  assert.equal(toMillis(new Date(NOW)), NOW);
  assert.equal(toMillis({ toMillis: () => NOW }), NOW);
  assert.equal(toMillis({ toDate: () => new Date(NOW) }), NOW);
});

test('toMillis returns null for anything it cannot trust', () => {
  for (const bad of [null, undefined, 'soon', {}, [], NaN, Infinity, new Date('nope')]) {
    assert.equal(toMillis(bad), null, String(bad));
  }
});

// --- gallery ids ----------------------------------------------------------

test('a Firestore-shaped id is accepted', () => {
  assert.equal(isValidGalleryId('k3f9x2p8QzRt7WmL4bNv'), true);
});

test('ids that could escape a path or a claim are refused', () => {
  for (const bad of [
    '../../admins/someone', 'abc/def', 'abc def', 'short', '',
    'a'.repeat(41), null, undefined, 42, {}, 'abc-def_ghi012345678',
    '<script>alertalert</script>'
  ]) {
    assert.equal(isValidGalleryId(bad), false, 'accepted ' + JSON.stringify(bad));
  }
});

test('generation is not biased toward the earlier letters', () => {
  // Rejection sampling, not modulo. With 200k characters a modulo bias over a
  // 31-letter alphabet shows up well outside this tolerance.
  const counts = new Map();
  let total = 0;
  for (let i = 0; i < 25000; i++) {
    for (const c of generatePassword()) {
      counts.set(c, (counts.get(c) || 0) + 1);
      total++;
    }
  }
  const expected = total / counts.size;
  for (const [c, n] of counts) {
    const drift = Math.abs(n - expected) / expected;
    assert.ok(drift < 0.06, 'letter ' + c + ' drifted ' + (drift * 100).toFixed(1) + '% from even');
  }
  assert.equal(counts.size, 31, 'expected all 31 letters to appear');
});
