// markContractSigned against the Firestore emulator, plus the signing paths it
// interacts with. Not part of npm test — run it with:
//
//   firebase emulators:exec --only firestore --project demo-capturewithki \
//     "node test/emulator/mark-signed.mjs"
//
// No email can leave: fetch is stubbed before index.js loads, and every
// attempted send is captured instead.
import assert from 'node:assert/strict';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Run this under firebase emulators:exec — refusing to touch a real database.');
  process.exit(1);
}
const sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({ id: 'stub' }), text: async () => '{}' };
};
process.env.RESEND_API_KEY = 'stub-key';

const fns = await import('../../index.js');
const { generateToken, hashToken } = await import('../../lib/contract-crypto.js');
const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
const db = getFirestore();
await db.doc('admins/khiara').set({ ok: true });

const asAdmin = { auth: { uid: 'khiara' } };
const mark = (id, extra, who) => fns.markContractSigned.run(Object.assign(
  { data: Object.assign({ contractId: id }, extra) }, who === undefined ? asAdmin : who));
const sign = (token, slot, name) => fns.signContract.run({
  data: { token, typedName: name, consent: true, slot },
  rawRequest: { headers: { 'user-agent': 'test' }, ip: '127.0.0.1' }
});
const retainer = (id, received) => fns.markRetainerReceived.run(
  Object.assign({ data: { contractId: id, received } }, asAdmin));

async function seed(over) {
  const token = generateToken();
  const ref = db.collection('contracts').doc();
  await ref.set(Object.assign({
    status: 'opened', clientName: 'Pat One', client2Name: 'Sam Two',
    clientEmail: 'one@example.com', client2Email: 'two@example.com',
    tokenHash: hashToken(token), documentHash: 'sha256:test', sentAt: Timestamp.now()
  }, over));
  return { ref, token, id: ref.id };
}
const read = async (ref) => (await ref.get()).data();
const events = async (ref) => (await ref.collection('audit').orderBy('at').get()).docs.map((d) => d.data().event);
async function rejects(p, re) {
  await assert.rejects(p, (err) => { assert.match(err.message, re); return true; });
}

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('signing one after the other still completes and emails once', async () => {
  const { ref, token } = await seed();
  sent.length = 0;
  assert.equal((await sign(token, 'client1', 'Pat One')).complete, false);
  assert.equal((await read(ref)).status, 'opened');
  assert.equal((await sign(token, 'client2', 'Sam Two')).complete, true);
  assert.equal((await read(ref)).status, 'signed');
  assert.equal(sent.length, 2, 'couple confirmation + her notice');
});

check('a double-tap does not overwrite a signature', async () => {
  const { ref, token } = await seed({ client2Name: '' });
  await sign(token, 'client1', 'Pat One');
  const first = (await read(ref)).signedAt.toMillis();
  await sign(token, 'client1', 'Someone Else');
  const c = await read(ref);
  assert.equal(c.signedAt.toMillis(), first);
  assert.equal(c.signature.typedName, 'Pat One');
});

check("Hanani's state: mark signed, couple emailed, retainer then works, undo refused", async () => {
  const { ref, id } = await seed({
    signedAt: Timestamp.fromDate(new Date('2026-10-30T06:16:07Z')),
    signed2At: Timestamp.fromDate(new Date('2026-10-30T06:16:07Z')),
    signature: { typedName: 'Pat One' }, signature2: { typedName: 'Sam Two' }
  });
  await rejects(retainer(id, true), /not a signed, active booking/);
  sent.length = 0;
  const r = await mark(id, { emailClient: true });
  assert.deepEqual([r.status, r.emailed], ['signed', true]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['one@example.com', 'two@example.com']);
  assert.match(sent[0].text, /October 29, 2026/);
  const c = await read(ref);
  assert.equal(c.status, 'signed');
  assert.equal(c.manuallySignedFrom, 'opened');
  assert.equal(c.signature.typedName, 'Pat One', 'e-signatures untouched');
  await retainer(id, true);
  assert.ok((await read(ref)).retainerReceivedAt);
  await rejects(mark(id, { signed: false }), /Undo the retainer first|really is signed/);
  await retainer(id, false);
  await rejects(mark(id, { signed: false }), /really is signed/);
  assert.deepEqual(await events(ref), ['marked-signed', 'retainer-received', 'retainer-unmarked']);
});

check('marking twice changes nothing and sends no second email', async () => {
  const { ref, id } = await seed();
  sent.length = 0;
  await mark(id, { emailClient: true });
  const again = await mark(id, { emailClient: true });
  assert.equal(again.already, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(await events(ref), ['marked-signed']);
});

check('no email unless the box is ticked', async () => {
  const { id } = await seed({ status: 'sent' });
  sent.length = 0;
  const r = await mark(id, { emailClient: false });
  assert.equal(r.emailed, null);
  assert.equal(sent.length, 0);
});

check('a paper-signed contract: mark, undo back to where it was', async () => {
  const { ref, id } = await seed({ status: 'sent' });
  await mark(id, {});
  assert.equal((await read(ref)).status, 'signed');
  const r = await mark(id, { signed: false });
  assert.equal(r.status, 'sent');
  const c = await read(ref);
  assert.equal(c.status, 'sent');
  assert.equal(c.manuallySignedAt, undefined);
  assert.deepEqual(await events(ref), ['marked-signed', 'signed-unmarked']);
});

check('a client e-signing after a hand mark is recorded, without a status flip or emails', async () => {
  const { ref, id, token } = await seed({ client2Name: '' });
  await mark(id, {});
  sent.length = 0;
  const r = await sign(token, 'client1', 'Pat One');
  assert.equal(r.complete, true);
  const c = await read(ref);
  assert.equal(c.status, 'signed');
  assert.equal(c.signature.typedName, 'Pat One');
  assert.equal(sent.length, 0);
});

check('the retainer can be recorded against a paper-signed contract', async () => {
  const { ref, id } = await seed({ client2Name: '' });
  await mark(id, {});
  await retainer(id, true);
  assert.ok((await read(ref)).retainerReceivedAt);
});

check('drafts, voided and cancelled contracts cannot be marked', async () => {
  for (const status of ['draft', 'void', 'cancelled']) {
    const { id } = await seed({ status });
    await rejects(mark(id, {}), /Only a contract that has been sent/);
  }
});

check('an e-signed contract cannot be unmarked', async () => {
  const { id, token } = await seed({ client2Name: '' });
  await sign(token, 'client1', 'Pat One');
  await rejects(mark(id, { signed: false }), /signed this one themselves/);
});

check('only an admin can mark', async () => {
  const { ref, id } = await seed();
  await rejects(mark(id, {}, {}), /Sign in first/);
  await rejects(mark(id, {}, { auth: { uid: 'stranger' } }), /Not allowed/);
  assert.equal((await read(ref)).status, 'opened');
});

check('a missing or malformed id is refused', async () => {
  await rejects(mark('nope-not-real-0000000', {}), /No such contract|not valid/);
  await rejects(mark('../admins/khiara', {}), /not valid/);
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log('PASS', name); }
  catch (err) { failed++; console.log('FAIL', name, '\n   ', err.message); }
}
console.log(failed ? failed + ' failed' : 'all ' + checks.length + ' passed');
process.exit(failed ? 1 : 0);
