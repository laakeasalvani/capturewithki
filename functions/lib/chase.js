//
// Pure. Takes contracts and a clock, returns what to send. No Firebase and no
// Stripe, so every boundary below is testable — which is the only reason
// escalate.js's timing was ever trustworthy.
//
// Reuses toMillis from gallery-expiry.js rather than reimplementing Firestore
// timestamp coercion for a third time.
import { toMillis } from './gallery-expiry.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

export const NEVER_OPENED_MS = 48 * HOUR;
export const SIGN_REMINDERS_MS = [24 * HOUR, 72 * HOUR];
export const PAY_REMINDERS_MS = [1 * HOUR, 24 * HOUR, 72 * HOUR];
export const UNPAID_ESCALATION_MS = 7 * DAY;

// Nothing older than this is ever acted on. Without it, the first run after
// deploy mails every client she has ever had. escalate.js needed the same
// guard for the same reason.
export const BACKLOG_MS = 30 * DAY;

// Reminder N is due once `elapsed` passes the Nth threshold. Indexing by the
// count already sent is what stops an hourly job re-sending the same nudge:
// after reminder 0 goes out the count is 1, and threshold[1] is still hours
// away. No lastReminderAt bookkeeping required.
function reminderDue(thresholds, countSoFar, elapsed) {
  if (!Number.isInteger(countSoFar) || countSoFar < 0) return false;
  if (countSoFar >= thresholds.length) return false;
  return elapsed >= thresholds[countSoFar];
}

export function dueActions(contracts, now) {
  if (!Array.isArray(contracts)) return [];
  const out = [];

  for (const c of contracts) {
    if (!c || typeof c !== 'object') continue;
    if (['paid', 'void', 'cancelled', 'draft'].indexOf(c.status) !== -1) continue;

    const sentAt = toMillis(c.sentAt);
    if (sentAt === null) continue;
    if (now - sentAt > BACKLOG_MS) continue;

    // Sent but never opened. This alerts HER, because no signal the sending
    // side produces can tell a spam-filed message from a delivered one.
    if (!c.openCount && c.status === 'sent') {
      if (now - sentAt >= NEVER_OPENED_MS && !c.neverOpenedAlertAt) {
        out.push({ contractId: c.id, kind: 'never-opened-alert', to: 'owner' });
      }
      continue;
    }

    if (c.status === 'opened') {
      if (reminderDue(SIGN_REMINDERS_MS, c.signReminderCount || 0, now - sentAt)) {
        out.push({ contractId: c.id, kind: 'sign-reminder', to: 'client' });
      }
      continue;
    }

    if (c.status === 'signed') {
      const signedAt = toMillis(c.signedAt);
      if (signedAt === null) continue;

      // Escalation first: once it is a week old she needs to know, whether or
      // not another client nudge is also due this hour.
      if (now - signedAt >= UNPAID_ESCALATION_MS && !c.escalatedAt) {
        out.push({ contractId: c.id, kind: 'unpaid-escalation', to: 'owner' });
        continue;
      }
      if (reminderDue(PAY_REMINDERS_MS, c.payReminderCount || 0, now - signedAt)) {
        out.push({ contractId: c.id, kind: 'pay-reminder', to: 'client' });
      }
    }
  }

  return out;
}
