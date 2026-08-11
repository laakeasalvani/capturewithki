import { test } from 'node:test';
import assert from 'node:assert';
import { validateInquiry } from '../lib/validate.js';

test('accepts a complete valid submission', () => {
  const r = validateInquiry({
    name: ' Sarah ', partnerName: 'Michael', email: 'sarah@example.com',
    phone: '8085550123', eventDate: '2026-09-12',
    sessionType: 'Engagement — $175', message: 'Hello!'
  });
  assert.equal(r.valid, true);
  assert.equal(r.value.name, 'Sarah');
  assert.equal(r.value.email, 'sarah@example.com');
});

test('accepts when optional fields are missing', () => {
  const r = validateInquiry({
    name: 'Sarah', email: 'sarah@example.com', phone: '8085550123',
    sessionType: 'Not sure yet'
  });
  assert.equal(r.valid, true);
  assert.equal(r.value.partnerName, '');
  assert.equal(r.value.eventDate, '');
  assert.equal(r.value.message, '');
});

test('rejects a missing name', () => {
  const r = validateInquiry({ email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /name/i);
});

test('rejects a malformed email', () => {
  const r = validateInquiry({ name: 'S', email: 'not-an-email', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /email/i);
});

test('rejects a missing phone', () => {
  const r = validateInquiry({ name: 'S', email: 'a@b.com', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /phone/i);
});

test('rejects absurdly long input', () => {
  const r = validateInquiry({
    name: 'S', email: 'a@b.com', phone: '1', sessionType: 'x',
    message: 'x'.repeat(5001)
  });
  assert.equal(r.valid, false);
  assert.match(r.error, /too long/i);
});

test('coerces non-string input rather than throwing', () => {
  const r = validateInquiry({ name: 123, email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, true);
  assert.equal(r.value.name, '123');
});

test('a deeply nested array does not crash the validator', () => {
  let root = [], cur = root;
  for (let i = 0; i < 150000; i++) { const n = []; cur.push(n); cur = n; }
  const r = validateInquiry({ name: root, email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.match(r.error, /did not look right/i);
});

test('an object value is refused rather than stringified', () => {
  const r = validateInquiry({ name: { a: 1 }, email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
  assert.ok(!JSON.stringify(r).includes('[object Object]'));
});

test('an array value is refused', () => {
  const r = validateInquiry({ name: ['a'], email: 'a@b.com', phone: '1', sessionType: 'x' });
  assert.equal(r.valid, false);
});

test('a non-object payload is refused cleanly', () => {
  for (const bad of ['hello', 42, true, null, undefined, ['a']]) {
    const r = validateInquiry(bad);
    assert.equal(r.valid, false, 'should refuse ' + JSON.stringify(bad));
    assert.ok(typeof r.error === 'string' && r.error.length > 0);
  }
});

test('over-length errors name the field in human words', () => {
  const r = validateInquiry({
    name: 'S', email: 'a@b.com', phone: '1', sessionType: 'x',
    partnerName: 'x'.repeat(201)
  });
  assert.equal(r.valid, false);
  assert.ok(r.error.includes("partner's name"), 'got: ' + r.error);
  assert.ok(!r.error.includes('partnerName'), 'leaked the raw field name');
});

test('a boolean or number is still accepted and coerced', () => {
  const r = validateInquiry({ name: 123, email: 'a@b.com', phone: 5550123, sessionType: 'x' });
  assert.equal(r.valid, true);
  assert.equal(r.value.name, '123');
  assert.equal(r.value.phone, '5550123');
});
