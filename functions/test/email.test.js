import { test } from 'node:test';
import assert from 'node:assert';
import { ownerEmail, clientEmail } from '../lib/email.js';

const full = {
  name: 'Sarah', partnerName: 'Michael', email: 'sarah@example.com',
  phone: '8085550123', eventDate: '2026-09-12',
  sessionType: 'Engagement — $175', message: 'We met hiking.'
};

test('owner subject names both people when a partner is given', () => {
  assert.equal(ownerEmail(full).subject, 'New inquiry — Sarah & Michael');
});

test('owner subject names one person when no partner', () => {
  const one = Object.assign({}, full, { partnerName: '' });
  assert.equal(ownerEmail(one).subject, 'New inquiry — Sarah');
});

test('owner body contains every submitted field', () => {
  const t = ownerEmail(full).text;
  for (const v of ['Sarah', 'Michael', 'sarah@example.com', '8085550123',
                   '2026-09-12', 'Engagement — $175', 'We met hiking.']) {
    assert.ok(t.includes(v), 'missing ' + v);
  }
});

test('owner body marks empty optional fields rather than leaving a blank', () => {
  const sparse = { name: 'Sarah', partnerName: '', email: 'a@b.com',
                   phone: '1', eventDate: '', sessionType: 'Not sure yet', message: '' };
  const t = ownerEmail(sparse).text;
  assert.ok(t.includes('Not given'));
});

test('client email greets by first name and promises 48 hours', () => {
  const e = clientEmail(full);
  assert.ok(e.text.includes('Sarah'));
  assert.match(e.text, /48 hours/);
  assert.ok(e.text.includes('Khiara'));
});

test('client subject is the fixed thank-you line', () => {
  assert.equal(clientEmail(full).subject, 'Thank you for reaching out — CaptureWithKi');
});

test('a newline in the name cannot forge extra fields in the owner email', () => {
  const evil = { name: 'Sarah\nPhone:      555-000-9999', email: 'a@b.com',
                 phone: '8085550123', sessionType: 'x', partnerName: '', eventDate: '', message: '' };
  const t = ownerEmail(evil).text;
  const phoneLines = t.split('\n').filter(l => l.startsWith('Phone:'));
  assert.equal(phoneLines.length, 1, 'exactly one Phone line, got:\n' + t);
  assert.ok(phoneLines[0].includes('8085550123'));
});

test('a newline in the name cannot reach the subject', () => {
  const s = ownerEmail({ name: 'Sarah\nBcc: someone@evil.com', partnerName: '' }).subject;
  assert.ok(!s.includes('\n'), 'subject contains a newline: ' + JSON.stringify(s));
});

test("the couple's message keeps its line breaks", () => {
  const t = ownerEmail({ name: 'S', partnerName: '', email: 'a@b.com', phone: '1',
                         eventDate: '', sessionType: 'x',
                         message: 'Line one.\nLine two.' }).text;
  assert.ok(t.includes('Line one.\nLine two.'), 'message line breaks were stripped');
});

test('a leading space in the name still greets them properly', () => {
  assert.ok(clientEmail({ name: ' Sarah Connor' }).text.includes('Hi Sarah,'));
});

test('an empty or whitespace-only name falls back to a friendly greeting', () => {
  assert.ok(clientEmail({ name: '' }).text.includes('Hi there,'));
  assert.ok(clientEmail({ name: '   ' }).text.includes('Hi there,'));
});
