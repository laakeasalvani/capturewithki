import { createHash } from 'node:crypto';

const MIN_FILL_MS = 3000;
const WINDOW_MS = 3600000;
const MAX_PER_WINDOW = 5;

export function isBotSubmission(opts) {
  const o = opts || {};
  if (o.honeypot) return true;
  if (typeof o.renderedAt !== 'number' || !o.renderedAt) return false;
  return (o.now - o.renderedAt) < MIN_FILL_MS;
}

export function hashIp(ip) {
  return createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

export async function checkRateLimit(db, ipHash, now) {
  const ref = db.collection('rateLimits').doc(ipHash);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() : undefined;

  if (!prev || (now - prev.windowStart) >= WINDOW_MS) {
    await ref.set({ count: 1, windowStart: now });
    return { allowed: true };
  }
  if (prev.count >= MAX_PER_WINDOW) {
    return { allowed: false };
  }
  await ref.set({ count: prev.count + 1, windowStart: prev.windowStart });
  return { allowed: true };
}
