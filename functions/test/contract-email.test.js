import { test } from 'node:test';
import assert from 'node:assert';
import { formatCents, readyToSignEmail, signedCopyEmail } from '../lib/contract-email.js';

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
