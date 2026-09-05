import { test } from 'node:test';
import assert from 'node:assert';
import {
  NEVER_OPENED_MS, SIGN_REMINDERS_MS, PAY_REMINDERS_MS,
  UNPAID_ESCALATION_MS, BACKLOG_MS, dueActions
} from '../lib/chase.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

function contract(extra) {
  return Object.assign({
    id: 'abcdefghij0123456789',
    status: 'sent',
    sentAt: new Date(NOW - 1 * HOUR),
    openCount: 0,
    signReminderCount: 0,
    payReminderCount: 0
  }, extra || {});
}

const kinds = (list) => list.map((a) => a.kind);

test('the thresholds are what the spec says', () => {
  assert.equal(NEVER_OPENED_MS, 48 * HOUR);
  assert.deepEqual(SIGN_REMINDERS_MS, [24 * HOUR, 72 * HOUR]);
  assert.deepEqual(PAY_REMINDERS_MS, [1 * HOUR, 24 * HOUR, 72 * HOUR]);
  assert.equal(UNPAID_ESCALATION_MS, 7 * DAY);
  assert.equal(BACKLOG_MS, 30 * DAY);
});

test('a freshly sent contract is left alone', () => {
  assert.deepEqual(dueActions([contract()], NOW), []);
});

// The inquiry bug, wearing a different hat. Resend returning 200 means
// queued, not delivered, and Gmail reports a spam-filed message as delivered.
// Never-opened is the only signal that survives that failure.
test('a contract nobody has opened alerts HER, not the client', () => {
  const c = contract({ sentAt: new Date(NOW - 49 * HOUR) });
  const actions = dueActions([c], NOW);
  assert.deepEqual(kinds(actions), ['never-opened-alert']);
  assert.equal(actions[0].to, 'owner');
});

test('the never-opened alert fires exactly once', () => {
  const c = contract({
    sentAt: new Date(NOW - 49 * HOUR),
    neverOpenedAlertAt: new Date(NOW - 1 * HOUR)
  });
  assert.deepEqual(dueActions([c], NOW), []);
});

test('an opened but unsigned contract nudges the client twice and then stops', () => {
  const base = { status: 'opened', sentAt: new Date(NOW - 25 * HOUR) };
  const first = dueActions([contract(Object.assign({}, base, { signReminderCount: 0 }))], NOW);
  assert.deepEqual(kinds(first), ['sign-reminder']);
  assert.equal(first[0].to, 'client');

  // 25 hours in, the second reminder is not due until 72.
  assert.deepEqual(dueActions([contract(Object.assign({}, base, { signReminderCount: 1 }))], NOW), []);

  const late = Object.assign({}, base, { sentAt: new Date(NOW - 73 * HOUR), signReminderCount: 1 });
  assert.deepEqual(kinds(dueActions([contract(late)], NOW)), ['sign-reminder']);

  const done = Object.assign({}, late, { signReminderCount: 2 });
  assert.deepEqual(dueActions([contract(done)], NOW), []);
});

test('a signed but unpaid contract is chased three times', () => {
  const signed = (hoursAgo, count) => contract({
    status: 'signed',
    sentAt: new Date(NOW - (hoursAgo + 2) * HOUR),
    signedAt: new Date(NOW - hoursAgo * HOUR),
    payReminderCount: count
  });
  assert.deepEqual(kinds(dueActions([signed(2, 0)], NOW)), ['pay-reminder']);
  assert.deepEqual(dueActions([signed(2, 1)], NOW), []);
  assert.deepEqual(kinds(dueActions([signed(25, 1)], NOW)), ['pay-reminder']);
  assert.deepEqual(kinds(dueActions([signed(73, 2)], NOW)), ['pay-reminder']);
  assert.deepEqual(dueActions([signed(73, 3)], NOW), []);
});

// The dangerous state: she has a signed agreement and no money, and the date
// is not actually held.
test('a week-old unpaid signature escalates to her', () => {
  const c = contract({
    status: 'signed',
    sentAt: new Date(NOW - 8 * DAY),
    signedAt: new Date(NOW - 8 * DAY),
    payReminderCount: 3
  });
  const actions = dueActions([c], NOW);
  assert.deepEqual(kinds(actions), ['unpaid-escalation']);
  assert.equal(actions[0].to, 'owner');
});

test('the escalation fires once, not every hour for the rest of time', () => {
  const c = contract({
    status: 'signed',
    sentAt: new Date(NOW - 8 * DAY),
    signedAt: new Date(NOW - 8 * DAY),
    payReminderCount: 3,
    escalatedAt: new Date(NOW - 1 * HOUR)
  });
  assert.deepEqual(dueActions([c], NOW), []);
});

// escalate.js needed exactly this guard, for exactly this reason.
test('the back catalogue cannot flood the first run', () => {
  const ancient = contract({ status: 'signed', sentAt: new Date(NOW - 200 * DAY), signedAt: new Date(NOW - 200 * DAY) });
  assert.deepEqual(dueActions([ancient], NOW), []);
});

test('finished and abandoned contracts are never chased', () => {
  for (const status of ['paid', 'void', 'cancelled', 'draft']) {
    const c = contract({ status: status, sentAt: new Date(NOW - 10 * DAY), signedAt: new Date(NOW - 10 * DAY) });
    assert.deepEqual(dueActions([c], NOW), [], 'chased a ' + status + ' contract');
  }
});

test('a contract missing its timestamps is skipped, not crashed on', () => {
  assert.deepEqual(dueActions([contract({ sentAt: null })], NOW), []);
  assert.deepEqual(dueActions([contract({ status: 'signed', signedAt: undefined })], NOW), []);
  assert.deepEqual(dueActions([null, undefined, {}], NOW), []);
  assert.deepEqual(dueActions(null, NOW), []);
});

// Exact boundaries, because off-by-one here means a reminder that never fires.
test('the boundary counts as due', () => {
  const c = contract({ sentAt: new Date(NOW - NEVER_OPENED_MS) });
  assert.deepEqual(kinds(dueActions([c], NOW)), ['never-opened-alert']);
  const justUnder = contract({ sentAt: new Date(NOW - NEVER_OPENED_MS + 1) });
  assert.deepEqual(dueActions([justUnder], NOW), []);
});
