import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatCents, readyToSignEmail, signedCopyEmail,
  signReminderEmail, neverOpenedAlertEmail, unsignedEscalationEmail,
  ownerSignedNoticeEmail
} from '../lib/contract-email.js';

// A stand-in for a Firestore Timestamp: chaseContracts hands these builders
// raw contract documents straight off Firestore, where sentAt/signedAt are
// Timestamp instances (a .toDate() method), never a plain Date or string.
const fakeTimestamp = (date) => ({ toDate: () => date });

test('cents render as dollars with a thousands separator', () => {
  assert.equal(formatCents(120000), '$1,200.00');
  assert.equal(formatCents(5250), '$52.50');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('a nonsense amount never renders as NaN in a client email', () => {
  assert.equal(formatCents(null), '$0.00');
  assert.equal(formatCents('1200'), '$0.00');
  assert.equal(formatCents(12.5), '$0.00');
});

const ready = () => readyToSignEmail({
  clientName: 'Jordan Rivera',
  signUrl: 'https://capturewithki.com/sign/?t=abc',
  eventDate: '2027-06-12',
  totalCents: 120000,
  retainerCents: 36000
});

test('the ready-to-sign email carries both a text and an HTML body', () => {
  const mail = ready();
  assert.ok(mail.subject.length > 0);
  assert.ok(mail.text.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.html.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.text.includes('$360.00'));
  assert.ok(mail.html.includes('$360.00'));
});

// Same lesson email.js already learned: text cannot be markup, but HTML can.
test('a hostile client name cannot inject markup into the email', () => {
  const mail = readyToSignEmail({
    clientName: '<img src=x onerror=alert(1)>',
    signUrl: 'https://capturewithki.com/sign/?t=abc',
    eventDate: '2027-06-12',
    totalCents: 120000,
    retainerCents: 36000
  });
  assert.equal(mail.html.includes('<img src=x'), false);
  assert.ok(mail.html.includes('&lt;img'));
});

// A newline in a single-line field must not be able to forge a Subject line.
test('a newline in the name cannot break the subject', () => {
  const mail = readyToSignEmail({
    clientName: 'Jordan\nBcc: someone@example.com',
    signUrl: 'https://capturewithki.com/sign/?t=abc',
    eventDate: '2027-06-12', totalCents: 120000, retainerCents: 36000
  });
  assert.equal(mail.subject.includes('\n'), false);
  assert.equal(mail.subject.includes('\r'), false);
});

test('the signed-copy email links back to the permanent record', () => {
  const mail = signedCopyEmail({
    clientName: 'Jordan Rivera',
    contractUrl: 'https://capturewithki.com/sign/?t=abc',
    signedAt: new Date(Date.UTC(2026, 8, 4, 19, 30))
  });
  assert.ok(mail.text.includes('https://capturewithki.com/sign/?t=abc'));
  assert.ok(mail.html.includes('https://capturewithki.com/sign/?t=abc'));
});

// Nothing anywhere told the client HOW to pay. There is no payment page today,
// so the only true answer is that Khiara makes the next move — and it has to
// survive in the plain-text body, which is what a text-only mail client shows.
test('the signed copy says who will be in touch about paying the retainer', () => {
  const mail = signedCopyEmail({
    clientName: 'Jordan Rivera',
    contractUrl: 'https://capturewithki.com/sign/?t=abc',
    signedAt: new Date(Date.UTC(2026, 8, 4, 19, 30))
  });
  assert.ok(/payment details/i.test(mail.text));
  assert.ok(/payment details/i.test(mail.html));
});

// ---------------------------------------------------------------------------
// The chase ladder (Task 6, narrowed by Task 4 to the signature alone)
// ---------------------------------------------------------------------------

test('the sign reminder names the client, the date, and says the date is not held — with no fabricated sign link', () => {
  const mail = signReminderEmail({ clientName: 'Jordan Rivera', eventDate: '2027-06-12' });
  assert.ok(mail.subject.length > 0);
  assert.ok(mail.text.includes('Jordan Rivera'));
  assert.ok(mail.html.includes('Jordan Rivera'));
  assert.ok(mail.text.includes('2027-06-12'));
  assert.ok(mail.html.includes('2027-06-12'));
  assert.ok(/not held/i.test(mail.text));
  assert.ok(/not held/i.test(mail.html));
  // No raw token exists to build a fresh sign link with — see the comment
  // in contract-email.js. Nothing here should look like a fabricated one.
  assert.equal(mail.text.includes('/sign/?t='), false);
  assert.equal(mail.html.includes('/sign/?t='), false);
});

test('the never-opened alert names the client, gives contact details and when it was sent, and tells Khiara to consider texting', () => {
  const sentAt = fakeTimestamp(new Date(Date.UTC(2026, 8, 1, 12, 0)));
  const mail = neverOpenedAlertEmail({
    clientName: 'Jordan Rivera',
    clientEmail: 'jordan@example.com',
    clientPhone: '808-555-0100',
    sentAt: sentAt
  });
  assert.ok(mail.subject.includes('Jordan Rivera'));
  assert.ok(mail.subject.toLowerCase().includes('has not opened'));
  assert.ok(mail.text.includes('jordan@example.com'));
  assert.ok(mail.html.includes('jordan@example.com'));
  assert.ok(mail.text.includes('808-555-0100'));
  assert.ok(mail.html.includes('808-555-0100'));
  assert.ok(mail.text.includes('2026-09-01'));
  assert.ok(mail.html.includes('2026-09-01'));
  assert.ok(/spam/i.test(mail.text) && /text/i.test(mail.text));
  assert.ok(/spam/i.test(mail.html) && /text/i.test(mail.html));
  assert.ok(mail.text.includes('https://capturewithki.com/int/'));
  assert.ok(mail.html.includes('https://capturewithki.com/int/'));
});

test('a missing phone renders plainly in the never-opened alert rather than blank', () => {
  const mail = neverOpenedAlertEmail({
    clientName: 'Jordan Rivera', clientEmail: 'jordan@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 8, 1, 12, 0)))
  });
  assert.ok(mail.text.includes('not given'));
  assert.ok(mail.html.includes('not given'));
});

test('the unsigned escalation names the client, when it was sent, contact details, the reminder count, and says the date is not held', () => {
  const mail = unsignedEscalationEmail({
    clientName: 'Jordan Rivera',
    clientEmail: 'jordan@example.com',
    clientPhone: '808-555-0100',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 7, 28, 9, 0))),
    signReminderCount: 2
  });
  assert.ok(mail.subject.startsWith('ACTION NEEDED'));
  assert.ok(mail.subject.includes('Jordan Rivera'));
  assert.ok(/has not signed/i.test(mail.subject));
  assert.ok(mail.text.includes('jordan@example.com'));
  assert.ok(mail.html.includes('jordan@example.com'));
  assert.ok(mail.text.includes('808-555-0100'));
  assert.ok(mail.text.includes('2026-08-28'));
  assert.ok(mail.html.includes('2026-08-28'));
  assert.ok(mail.text.includes('2'));
  assert.ok(mail.html.includes('2'));
  assert.ok(/not held/i.test(mail.text));
  assert.ok(/not held/i.test(mail.html));
  assert.ok(mail.text.includes('https://capturewithki.com/int/'));
  assert.ok(mail.html.includes('https://capturewithki.com/int/'));
});

test('a missing phone renders plainly in the unsigned escalation rather than blank', () => {
  const mail = unsignedEscalationEmail({
    clientName: 'Jordan Rivera', clientEmail: 'jordan@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 7, 28, 9, 0)))
  });
  assert.ok(mail.text.includes('not given'));
  assert.ok(mail.html.includes('not given'));
});

test('a hostile client name cannot inject markup into the owner-facing alerts', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const alert1 = neverOpenedAlertEmail({
    clientName: hostile, clientEmail: 'a@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 8, 1)))
  });
  assert.equal(alert1.html.includes('<img src=x'), false);
  assert.ok(alert1.html.includes('&lt;img'));

  const alert2 = unsignedEscalationEmail({
    clientName: hostile, clientEmail: 'a@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 8, 1)))
  });
  assert.equal(alert2.html.includes('<img src=x'), false);
  assert.ok(alert2.html.includes('&lt;img'));
});

test('a newline in the client name cannot forge either owner-alert subject', () => {
  const hostile = 'Jordan\nBcc: someone@example.com';
  const alert1 = neverOpenedAlertEmail({
    clientName: hostile, clientEmail: 'a@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 8, 1)))
  });
  assert.equal(alert1.subject.includes('\n'), false);

  const alert2 = unsignedEscalationEmail({
    clientName: hostile, clientEmail: 'a@example.com',
    sentAt: fakeTimestamp(new Date(Date.UTC(2026, 8, 1)))
  });
  assert.equal(alert2.subject.includes('\n'), false);
});

// ---------------------------------------------------------------------------
// Telling Khiara a contract has been signed.
// ---------------------------------------------------------------------------

const signed = {
  clientName: 'Jordan Rivera',
  clientEmail: 'jordan@example.com',
  clientPhone: '555 0101',
  eventDate: 'June 12, 2027',
  totalCents: 120000,
  retainerCents: 36000
};

test('she is told who signed, and both partners are named', () => {
  const one = ownerSignedNoticeEmail(signed);
  assert.match(one.subject, /Jordan Rivera signed their contract/);

  const two = ownerSignedNoticeEmail({ ...signed, client2Name: 'Sam Rivera' });
  assert.match(two.subject, /Jordan Rivera and Sam Rivera signed their contract/);
  assert.match(two.html, /Jordan Rivera and Sam Rivera/);
});

// The whole point of this email. A signed contract with no retainer does NOT
// hold the date, and she is the only one who can record that it arrived.
test('an unpaid retainer says the date is NOT held', () => {
  const m = ownerSignedNoticeEmail(signed);
  assert.match(m.text, /has NOT been recorded/);
  assert.match(m.text, /date is not held/);
  assert.doesNotMatch(m.text, /The date is held\./);
});

test('a recorded retainer says the date IS held', () => {
  const m = ownerSignedNoticeEmail({ ...signed, retainerReceivedAt: new Date() });
  assert.match(m.text, /The date is held\./);
  assert.doesNotMatch(m.text, /NOT been recorded/);
});

test('the money and the date are in the email, not just a link', () => {
  const m = ownerSignedNoticeEmail(signed);
  assert.match(m.text, /June 12, 2027/);
  assert.match(m.text, /\$1,200\.00/);
  assert.match(m.text, /\$360\.00/);
  assert.match(m.text, /jordan@example\.com/);
});

test('a hostile client name cannot inject markup into her inbox', () => {
  const m = ownerSignedNoticeEmail({ ...signed, clientName: '<script>alert(1)</script>' });
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /&lt;script&gt;/);
});

test('missing details degrade to words rather than blanks or undefined', () => {
  const m = ownerSignedNoticeEmail({ clientName: 'Jordan Rivera' });
  assert.doesNotMatch(m.text, /undefined/);
  assert.doesNotMatch(m.subject, /undefined/);
  assert.match(m.text, /not given/);
  assert.match(m.text, /not set/);
});

// A subject carrying a newline would let a crafted name forge headers.
test('the subject is a single line whatever the name contains', () => {
  const m = ownerSignedNoticeEmail({ ...signed, clientName: 'Jordan\nBcc: someone@evil.com' });
  assert.doesNotMatch(m.subject, /\n/);
});
