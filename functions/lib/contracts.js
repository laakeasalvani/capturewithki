//
// Pure and BROWSER-SAFE. `int/contracts.js` imports this file to preview the
// retainer as she types, so it must never import node:crypto or anything else
// node-only. Crypto lives in contract-crypto.js for exactly this reason —
// the same split gallery-expiry.js already needed.
//
// All money is integer cents. Dollars-as-floats put 0.1 + 0.2 into an invoice.

export const DEFAULT_RETAINER_PERCENT = 30;

export function sumLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return 0;
  let total = 0;
  for (const item of lineItems) {
    const cents = item ? item.amountCents : null;
    // Skipped rather than coerced. Number('') is 0 and Number('x') is NaN,
    // and a NaN total renders as a $0 contract nobody notices.
    if (!Number.isInteger(cents)) continue;
    total += cents;
  }
  return total;
}

export function computeRetainerCents(totalCents, percent) {
  if (!Number.isInteger(totalCents) || totalCents < 0) return 0;
  const pct = Number.isFinite(percent) ? percent : DEFAULT_RETAINER_PERCENT;
  if (pct < 0 || pct > 100) return 0;
  return Math.round(totalCents * pct / 100);
}

// By subtraction, deliberately. Computing this as 70% independently means the
// two halves fail to sum to the total on any amount where 30% lands on a
// half-cent — she would be quietly short a penny on a fraction of bookings.
export function computeBalanceCents(totalCents, retainerCents) {
  if (!Number.isInteger(totalCents) || !Number.isInteger(retainerCents)) return 0;
  return totalCents - retainerCents;
}
