import { createHash } from 'node:crypto';

const MIN_FILL_MS = 3000;
const WINDOW_MS = 3600000;
const MAX_PER_WINDOW = 5;

export function isBotSubmission(opts) {
  const o = opts || {};
  if (o.honeypot) return true;
  if (typeof o.renderedAt !== 'number' || !o.renderedAt) return false;
  const elapsed = o.now - o.renderedAt;
  // A negative gap means the visitor's clock runs ahead of ours. We cannot
  // judge fill time from a clock we do not trust, and wrongly flagging a real
  // couple silently bins their inquiry — so give them the benefit of the doubt.
  if (elapsed < 0) return false;
  return elapsed < MIN_FILL_MS;
}

export function hashIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

export async function checkRateLimit(db, ipHash, now) {
  const ref = db.collection('rateLimits').doc(ipHash);
  // Must be a transaction: a plain get-then-set lets a concurrent burst all
  // read the same count and every request in the burst gets allowed.
  return db.runTransaction(async function (tx) {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data() : undefined;

    if (!prev || (now - prev.windowStart) >= WINDOW_MS) {
      tx.set(ref, { count: 1, windowStart: now });
      return { allowed: true };
    }
    if (prev.count >= MAX_PER_WINDOW) {
      return { allowed: false };
    }
    tx.set(ref, { count: prev.count + 1, windowStart: prev.windowStart });
    return { allowed: true };
  });
}
