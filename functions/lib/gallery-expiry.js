// No node imports in this file, deliberately: int/galleries.js imports it in
// the browser, and a node:crypto import anywhere in the chain would crash it.

// Firestore hands back a Timestamp; tests and older records may hold a Date or
// a number. Anything else is treated as absent rather than coerced, so a
// malformed value fails closed instead of becoming NaN or 1970.
export function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.toMillis === 'function') {
    const t = value.toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  return null;
}

export const DEFAULT_DAYS = 30;
const DAY_MS = 86400000;

// The clock starts when she presses Send, not when she creates the gallery, so
// her editing time never eats into the couple's window.
export function defaultExpiry(now, days) {
  const d = typeof days === 'number' && isFinite(days) && days > 0 ? Math.floor(days) : DEFAULT_DAYS;
  return now + d * DAY_MS;
}

// A gallery is due for cleanup once it is live and its moment has passed.
// Anything already expired, still a draft, or carrying an unreadable date is
// left alone — deleting a couple's photos because a field was malformed is not
// a mistake worth risking.
export function isDue(gallery, now) {
  if (!gallery || typeof gallery !== 'object') return false;
  if (gallery.status !== 'live') return false;
  const expires = toMillis(gallery.expiresAt);
  if (expires === null) return false;
  return expires <= now;
}

export function dueGalleries(galleries, now) {
  if (!Array.isArray(galleries)) return [];
  return galleries.filter(function (g) { return isDue(g, now); });
}

// Whole days remaining, rounded up, so "1 day left" covers any part of the
// final day rather than flicking to 0 with hours still to go.
export function daysLeft(expiresAt, now) {
  const expires = toMillis(expiresAt);
  if (expires === null) return null;
  const ms = expires - now;
  if (ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

// A date she typed into the dashboard. Refused unless it is a real date in the
// future — an accidental past date would delete the photos on the next run.
export function validateExpiry(value, now) {
  const ms = toMillis(value);
  if (ms === null) return { valid: false, error: 'That date could not be read.' };
  if (ms <= now) return { valid: false, error: 'Pick a date in the future.' };
  // Ten years is not a real gallery; it is a typo in the year.
  if (ms > now + 3650 * DAY_MS) return { valid: false, error: 'That date is too far away.' };
  return { valid: true, value: ms };
}
