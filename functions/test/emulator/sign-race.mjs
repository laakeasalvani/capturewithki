// Two partners signing on two devices at the same instant — the case that
// left Hanani Andrade's contract stuck at 'opened' with both signatures on it
// (2026-10-30). Needs the Firestore emulator, so it is not part of npm test:
//
//   firebase emulators:exec --only firestore --project demo-capturewithki \
//     "node test/emulator/sign-race.mjs"
//
// No email can leave: fetch is stubbed before index.js loads.
import assert from 'node:assert/strict';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Run this under firebase emulators:exec — refusing to touch a real database.');
  process.exit(1);
}
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'stubbed' });

const { signContract } = await import('../../index.js');
const { generateToken, hashToken } = await import('../../lib/contract-crypto.js');
const { getFirestore } = await import('firebase-admin/firestore');
const db = getFirestore();

async function seed() {
  const token = generateToken();
  const ref = db.collection('contracts').doc();
  await ref.set({
    status: 'opened', clientName: 'Pat One', client2Name: 'Sam Two',
    clientEmail: 'one@example.com', client2Email: 'two@example.com',
    tokenHash: hashToken(token), documentHash: 'sha256:test', sentAt: new Date()
  });
  return { ref, token };
}

function sign(token, slot, name) {
  return signContract.run({
    data: { token, typedName: name, consent: true, slot },
    rawRequest: { headers: { 'user-agent': 'race-test' }, ip: '127.0.0.1' }
  });
}

let failures = 0;
for (let round = 1; round <= 10; round++) {
  const { ref, token } = await seed();
  const results = await Promise.all([sign(token, 'client1', 'Pat One'), sign(token, 'client2', 'Sam Two')]);
  const c = (await ref.get()).data();
  const audit = await ref.collection('audit').get();
  try {
    assert.ok(c.signedAt && c.signed2At, 'both signatures recorded');
    assert.equal(c.status, 'signed', 'status after both signed at once');
    assert.equal(results.filter((r) => r.complete).length, 1, 'exactly one request completes the agreement');
    assert.equal(audit.size, 2, 'one audit row per signature');
  } catch (err) {
    failures++;
    console.log('round', round, 'FAILED:', err.message, '— status:', c.status);
  }
}
console.log(failures ? failures + ' of 10 rounds failed' : 'all 10 rounds passed');
process.exit(failures ? 1 : 0);
