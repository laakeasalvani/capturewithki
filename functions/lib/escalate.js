// The unseen-inquiry alarm.
//
// Why this exists: an inquiry was once accepted by Resend, reported as sent,
// and then filed into the owner's Gmail spam folder. Nothing in the system
// could tell — "accepted by Resend" only means the API queued it, and Gmail
// reports a spam-filed message as delivered. The only signal that survives
// every delivery failure is whether she actually LOOKED at the inquiry, so
// that is what this alarm watches.
//
// It deliberately does not watch `status`. That flips to 'replied' only when
// she presses the button, so an inquiry read at 11pm and answered at 9am would
// raise a false alarm every single time — and an alarm she learns to ignore is
// worse than no alarm.
//
// No node imports here, matching gallery-expiry.js: keeping this file
// browser-safe means the dashboard can share it later without a crash.
import { toMillis } from './gallery-expiry.js';

const HOUR_MS = 3600000;

// Six hours, chosen by the owner. Long enough that a normal evening does not
// trip it, short enough that a wedding lead is not left cold overnight.
export const UNSEEN_MS = 6 * HOUR_MS;

// An inquiry older than this is history, not a live lead.
//
// This ceiling is load-bearing on the very first run: every inquiry that
// existed before `seenAt` shipped has no such field, and without the ceiling
// the alarm would mistake the entire back catalogue for unseen mail and fire
// once for each. It also stops a long outage turning into a flood.
export const BACKLOG_MS = 7 * 24 * HOUR_MS;

export function needsEscalation(inquiry, now) {
  if (!inquiry || typeof inquiry !== 'object') return false;

  // One alarm per inquiry, ever. This is a fault report, not a nag.
  if (inquiry.escalatedAt) return false;

  // She has had it on screen in the dashboard. That is the whole point.
  if (inquiry.seenAt) return false;

  // Handled by some other route — archived, or answered from her phone —
  // so the notification plainly did reach her.
  if (inquiry.archived === true) return false;
  if (inquiry.status === 'replied') return false;

  // A record whose date cannot be read is left alone. Escalating on a
  // malformed timestamp would fire on every run for the rest of time.
  const created = toMillis(inquiry.createdAt);
  if (created === null) return false;

  const age = now - created;
  // A negative age means a clock disagreement, not a stale inquiry.
  if (age < 0) return false;
  return age >= UNSEEN_MS && age <= BACKLOG_MS;
}

export function dueEscalations(inquiries, now) {
  if (!Array.isArray(inquiries)) return [];
  return inquiries.filter(function (i) { return needsEscalation(i, now); });
}

function hoursOld(inquiry, now) {
  const created = toMillis(inquiry.createdAt);
  if (created === null) return null;
  return Math.floor((now - created) / HOUR_MS);
}

// The alarm carries the couple's NAME and a link, and deliberately not their
// email, phone or message. It goes to maintainer inboxes rather than the
// business one, and there is no reason to copy a stranger's contact details
// into a second and third mailbox to say "go and look at the dashboard".
export function escalationEmail(inquiry, now) {
  const who = inquiry && inquiry.name ? String(inquiry.name) : 'someone';
  const hrs = hoursOld(inquiry, now);
  const age = hrs === null ? 'some time' : hrs + ' hours';

  const text = [
    'An inquiry has been sitting in the dashboard for ' + age + ' without',
    'being opened.',
    '',
    'From: ' + who,
    'Dashboard: https://capturewithki.com/int/',
    '',
    'This alarm means the email notification probably did not reach',
    'capturewithki@gmail.com — check the spam folder there first, then',
    'Resend at https://resend.com/emails to see what actually happened.',
    '',
    'The inquiry itself is safe. Nothing is ever lost: it is recorded in',
    'Firestore before any email is attempted.',
    '',
    'You are getting this because the inquiry was never displayed in the',
    'dashboard, which is the only signal that survives a delivery failure.'
  ].join('\n');

  return { subject: 'Unopened inquiry from ' + who + ' (' + age + ')', text: text };
}
