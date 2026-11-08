import { test } from 'node:test';
import assert from 'node:assert';
import {
  validateReviewFeedback, reviewFeedbackEmail, reviewFeedbackEmailHtml
} from '../lib/review-feedback.js';

const VALID = { rating: 2, name: 'Dana Reyes', email: 'dana@example.com', message: 'Photos came late.' };

function withField(patch) {
  return Object.assign({}, VALID, patch);
}

test('accepts a complete submission and trims it', () => {
  const r = validateReviewFeedback(withField({ name: '  Dana Reyes ' }));
  assert.equal(r.valid, true);
  assert.deepEqual(r.value, VALID);
});

test('drops fields the form does not send', () => {
  const r = validateReviewFeedback(withField({ status: 'replied', seenAt: 'yesterday' }));
  assert.equal(r.valid, true);
  assert.deepEqual(Object.keys(r.value).sort(), ['email', 'message', 'name', 'rating']);
});

test('refuses a missing or impossible rating', () => {
  for (const rating of [undefined, null, 0, 6, 2.5, '2', [2]]) {
    assert.equal(validateReviewFeedback(withField({ rating })).valid, false, String(rating));
  }
});

test('requires a name, a usable email and the feedback itself', () => {
  assert.equal(validateReviewFeedback(withField({ name: ' ' })).valid, false);
  assert.equal(validateReviewFeedback(withField({ email: '' })).valid, false);
  assert.equal(validateReviewFeedback(withField({ email: 'not-an-email' })).valid, false);
  assert.equal(validateReviewFeedback(withField({ message: '' })).valid, false);
});

test('refuses oversized fields', () => {
  assert.equal(validateReviewFeedback(withField({ message: 'x'.repeat(5001) })).valid, false);
});

test('survives hostile payloads without throwing', () => {
  let deep = [];
  for (let i = 0; i < 100000; i++) deep = [deep];
  assert.equal(validateReviewFeedback(withField({ name: deep })).valid, false);
  assert.equal(validateReviewFeedback(null).valid, false);
  assert.equal(validateReviewFeedback([]).valid, false);
});

test('a line break in the name cannot reach the subject or forge a text line', () => {
  const m = reviewFeedbackEmail(withField({ name: 'Dana\r\nBcc: x@example.com' }));
  assert.equal(m.subject, '2 stars feedback — Dana Bcc: x@example.com');
  assert.ok(!m.text.includes('\nBcc:'));
});

test('uses the singular for one star', () => {
  assert.ok(reviewFeedbackEmail(withField({ rating: 1 })).subject.startsWith('1 star feedback'));
});

test('escapes everything a client typed in the HTML email', () => {
  const html = reviewFeedbackEmailHtml(withField({ name: '<b>x</b>', message: '<script>y</script>' }));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>x</b>'));
});
