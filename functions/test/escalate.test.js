import { test } from 'node:test';
import assert from 'node:assert';
import {
  UNSEEN_MS, BACKLOG_MS, needsEscalation, dueEscalations, escalationEmail
} from '../lib/escalate.js';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

// An inquiry that SHOULD raise the alarm: seven hours old, never displayed.
function unseen(extra) {
  return Object.assign({
    name: 'Ana',
    status: 'new',
    createdAt: new Date(NOW - 7 * HOUR)
  }, extra || {});
}

test('the window is six hours', () => {
  assert.equal(UNSEEN_MS, 6 * HOUR);
});

test('an inquiry nobody has opened raises the alarm once it is old enough', () => {
  assert.equal(needsEscalation(unseen(), NOW), true);
});

test('a fresh inquiry is left alone until the window has passed', () => {
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW - 1 * HOUR) }), NOW), false);
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW - 5 * HOUR) }), NOW), false);
  // Exactly on the boundary counts as due.
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW - 6 * HOUR) }), NOW), true);
});

test('once she has had it on screen, it never alarms', () => {
  assert.equal(needsEscalation(unseen({ seenAt: new Date(NOW - 6 * HOUR) }), NOW), false);
});

// The whole reason this alarm does not watch `status`: reading an inquiry at
// night and replying in the morning must not be reported as a fault.
test('being unreplied is not a fault — only being unseen is', () => {
  const readButNotAnswered = unseen({ seenAt: new Date(NOW - 6 * HOUR), status: 'new' });
  assert.equal(needsEscalation(readButNotAnswered, NOW), false);
});

test('an inquiry already replied to or archived never alarms', () => {
  assert.equal(needsEscalation(unseen({ status: 'replied' }), NOW), false);
  assert.equal(needsEscalation(unseen({ archived: true }), NOW), false);
});

test('the alarm fires once and then stays quiet', () => {
  assert.equal(needsEscalation(unseen({ escalatedAt: new Date(NOW - HOUR) }), NOW), false);
});

// The first run after this ships meets a back catalogue with no seenAt on any
// record. Without the ceiling every one of them would alarm at once.
test('the existing back catalogue does not set off a flood on first run', () => {
  const old = unseen({ createdAt: new Date(NOW - 30 * 24 * HOUR) });
  assert.equal(needsEscalation(old, NOW), false);
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW - BACKLOG_MS - HOUR) }), NOW), false);
  // Just inside the ceiling still counts.
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW - BACKLOG_MS + HOUR) }), NOW), true);
});

test('an unreadable or missing date is left alone rather than alarming forever', () => {
  for (const bad of [null, undefined, NaN, 'yesterday', {}, []]) {
    assert.equal(needsEscalation(unseen({ createdAt: bad }), NOW), false, String(bad));
  }
});

test('a clock disagreement does not look like a stale inquiry', () => {
  assert.equal(needsEscalation(unseen({ createdAt: new Date(NOW + 2 * HOUR) }), NOW), false);
});

test('junk in place of an inquiry is ignored, not crashed on', () => {
  for (const bad of [null, undefined, 'inquiry', 42, []]) {
    assert.equal(needsEscalation(bad, NOW), false, String(bad));
  }
  assert.deepEqual(dueEscalations(null, NOW), []);
  assert.deepEqual(dueEscalations('nope', NOW), []);
});

test('dueEscalations picks out only the ones that qualify', () => {
  const list = [
    unseen({ name: 'Ana' }),
    unseen({ name: 'Bo', seenAt: new Date(NOW) }),
    unseen({ name: 'Cy', createdAt: new Date(NOW - HOUR) }),
    unseen({ name: 'Di' })
  ];
  assert.deepEqual(dueEscalations(list, NOW).map(function (i) { return i.name; }), ['Ana', 'Di']);
});

// Firestore hands back Timestamps, not Dates.
test('a Firestore Timestamp is understood', () => {
  const ts = { toMillis: function () { return NOW - 7 * HOUR; } };
  assert.equal(needsEscalation(unseen({ createdAt: ts }), NOW), true);
});

test('the alarm says who it is about and where to look', () => {
  const m = escalationEmail(unseen(), NOW);
  assert.match(m.subject, /Ana/);
  assert.match(m.subject, /7 hours/);
  assert.match(m.text, /capturewithki\.com\/int\//);
  assert.match(m.text, /spam/);
});

// It goes to maintainer inboxes, not the business one. A stranger's contact
// details have no business being copied there to say "go and look".
test('the alarm does not leak the couple\'s contact details', () => {
  const i = unseen({ email: 'ana@example.com', phone: '808-555-0101', message: 'private words' });
  const m = escalationEmail(i, NOW);
  assert.doesNotMatch(m.text, /ana@example\.com/);
  assert.doesNotMatch(m.text, /555-0101/);
  assert.doesNotMatch(m.text, /private words/);
});

test('a nameless inquiry still produces a sensible alarm', () => {
  const m = escalationEmail({ createdAt: new Date(NOW - 7 * HOUR) }, NOW);
  assert.match(m.subject, /someone/);
  assert.ok(m.text.length > 0);
});
