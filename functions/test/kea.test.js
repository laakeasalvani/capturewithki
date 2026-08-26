import { test } from 'node:test';
import assert from 'node:assert';
import {
  validateKeaInquiry, keaOwnerEmail, keaClientEmail,
  keaOwnerEmailHtml, keaClientEmailHtml, KEA_FROM, KEA_OWNER_EMAIL
} from '../lib/kea.js';

const VALID = {
  name: 'Dana Reyes', email: 'dana@example.com', phone: '5035550142',
  website: 'oldsite.example.com', interest: 'Tier 1 — website only',
  message: 'Need a new site before the holidays.'
};

test('accepts a complete valid submission and trims it', () => {
  const r = validateKeaInquiry(Object.assign({}, VALID, { name: '  Dana Reyes  ' }));
  assert.equal(r.valid, true);
  assert.equal(r.value.name, 'Dana Reyes');
  assert.equal(r.value.email, 'dana@example.com');
});

test('accepts when every optional field is missing', () => {
  // Only name and email are marked required on the form, so the backend must
  // not demand more than the form does.
  const r = validateKeaInquiry({ name: 'Dana', email: 'dana@example.com' });
  assert.equal(r.valid, true);
  assert.equal(r.value.phone, '');
  assert.equal(r.value.website, '');
  assert.equal(r.value.interest, '');
  assert.equal(r.value.message, '');
});

test('rejects a missing name or email', () => {
  assert.equal(validateKeaInquiry({ email: 'd@example.com' }).valid, false);
  assert.equal(validateKeaInquiry({ name: 'Dana' }).valid, false);
});

test('rejects an email that is not an address', () => {
  for (const email of ['dana', 'dana@example', 'da na@example.com', '@example.com']) {
    assert.equal(validateKeaInquiry({ name: 'Dana', email: email }).valid, false, email);
  }
});

test('rejects an over-long field', () => {
  const r = validateKeaInquiry({ name: 'D'.repeat(201), email: 'd@example.com' });
  assert.equal(r.valid, false);
  assert.match(r.error, /too long/);
});

test('rejects non-scalar values without calling String() on them', () => {
  // A deeply nested array would overflow the stack inside String().
  let deep = [];
  for (let i = 0; i < 60000; i++) deep = [deep];
  const r = validateKeaInquiry({ name: 'Dana', email: 'd@example.com', message: deep });
  assert.equal(r.valid, false);
});

test('rejects a payload that is not an object', () => {
  for (const bad of [null, 'hello', 42, []]) {
    assert.equal(validateKeaInquiry(bad).valid, false);
  }
});

test('owner email carries every field and a reply hint', () => {
  const m = keaOwnerEmail(VALID);
  assert.match(m.subject, /Dana Reyes/);
  assert.match(m.text, /dana@example\.com/);
  assert.match(m.text, /Tier 1/);
  assert.match(m.text, /holidays/);
  assert.match(m.text, /reply/i);
});

test('owner email labels blank optional fields rather than leaving gaps', () => {
  const m = keaOwnerEmail({ name: 'Dana', email: 'd@example.com', phone: '', website: '', interest: '', message: '' });
  assert.match(m.text, /Phone:\s+Not given/);
  assert.match(m.text, /Not given/);
});

test('a newline in a single-line field cannot forge another labelled line', () => {
  const m = keaOwnerEmail(Object.assign({}, VALID, { name: 'Dana\nEmail: attacker@evil.com' }));
  assert.equal(m.subject.includes('\n'), false);
  assert.equal(/^Email:/m.test(m.text.split('Message:')[0].replace(/^Email: {5}dana.*$/m, '')), false);
});

test('auto-reply greets by first name and falls back when there is none', () => {
  assert.match(keaClientEmail(VALID).text, /Hi Dana,/);
  assert.match(keaClientEmail({ name: '', email: 'd@example.com' }).text, /Hi there,/);
});

test('HTML emails escape anything a stranger typed', () => {
  const nasty = Object.assign({}, VALID, {
    name: '<script>alert(1)</script>',
    message: 'before <img src=x onerror=alert(1)> after'
  });
  const owner = keaOwnerEmailHtml(nasty);
  assert.equal(owner.includes('<script>'), false);
  assert.equal(owner.includes('<img src=x'), false);
  assert.match(owner, /&lt;script&gt;/);
  assert.equal(keaClientEmailHtml(nasty).includes('<script>'), false);
});

test('HTML emails ship no <style> block and no class attributes', () => {
  // Gmail strips the head, so anything not inlined is lost.
  for (const html of [keaOwnerEmailHtml(VALID), keaClientEmailHtml(VALID)]) {
    assert.equal(/<style/i.test(html), false);
    assert.equal(/ class=/i.test(html), false);
  }
});

test('the Kea sender and inbox are not the CaptureWithKi ones', () => {
  assert.match(KEA_FROM, /^Kea Web Creations </);
  assert.equal(KEA_OWNER_EMAIL, 'keawebcreations@gmail.com');
  assert.equal(KEA_OWNER_EMAIL.includes('capturewithki'), false);
});
