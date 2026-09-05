//
// Pure and BROWSER-SAFE. `int/contracts.js` imports this file to preview the
// retainer as she types, so it must never import node:crypto or anything else
// node-only. Crypto lives in contract-crypto.js for exactly this reason —
// the same split gallery-expiry.js already needed.
//
// All money is integer cents. Dollars-as-floats put 0.1 + 0.2 into an invoice.

import { escapeHtml } from './html.js';

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

export const MAX_NAME = 200;
export const MAX_LOCATION = 300;
export const MAX_LINE_LABEL = 120;
export const MAX_LINE_ITEMS = 20;
export const MAX_TOTAL_CENTS = 10000000; // $100,000 — far above her top package

// A contract id arrives from a query string, becomes a Firestore path, and is
// embedded in an email link. Its shape is not negotiable. Same reasoning, and
// same regex, as isValidGalleryId.
export function isValidContractId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{16,40}$/.test(id);
}

function trimmedString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateContractInput(input) {
  const errors = [];
  const d = input && typeof input === 'object' ? input : {};

  const name = trimmedString(d.clientName);
  if (!name) errors.push('A client name is required.');
  else if (name.length > MAX_NAME) errors.push('That client name is too long.');

  // Deliberately loose. A strict RFC-5322 regex rejects real addresses, and
  // the only check that actually matters is whether the emailed link arrives.
  const email = trimmedString(d.clientEmail);
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.push('That email address will not work.');
  }

  if (trimmedString(d.eventLocation).length > MAX_LOCATION) {
    errors.push('That location is too long.');
  }

  const items = Array.isArray(d.lineItems) ? d.lineItems : null;
  if (!items || items.length === 0) {
    errors.push('A contract needs at least one line item.');
  } else if (items.length > MAX_LINE_ITEMS) {
    errors.push('That is too many line items.');
  } else {
    for (const item of items) {
      const label = trimmedString(item ? item.label : null);
      if (!label) { errors.push('Every line item needs a label.'); break; }
      if (label.length > MAX_LINE_LABEL) { errors.push('A line item label is too long.'); break; }
      if (!Number.isInteger(item.amountCents) || item.amountCents < 0) {
        errors.push('Every line item needs a whole-cent amount of zero or more.');
        break;
      }
    }
  }

  const total = sumLineItems(items);
  if (total <= 0) errors.push('The total must be more than zero.');
  if (total > MAX_TOTAL_CENTS) errors.push('That total looks wrong — is it in cents?');

  return { ok: errors.length === 0, errors: errors };
}

const FIELD = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export function renderTemplate(templateHtml, fields) {
  if (typeof templateHtml !== 'string') return '';
  const f = fields && typeof fields === 'object' ? fields : {};
  // String.replace with a function makes exactly one pass, which is the whole
  // defence against a client named "{{total}}" reading a field they should
  // not see. Do not reach for a while-loop that re-renders until stable.
  return templateHtml.replace(FIELD, function (whole, name) {
    const key = String(name).toLowerCase();
    // hasOwnProperty, not `key in f` — otherwise {{constructor}} resolves
    // through the prototype chain and renders something absurd.
    if (!Object.prototype.hasOwnProperty.call(f, key)) return whole;
    return escapeHtml(f[key]);
  });
}

export const STATUSES = ['draft', 'sent', 'opened', 'signed', 'paid', 'void', 'cancelled'];

// `void` means never signed and killed off. `cancelled` means signed and then
// called off — a different event with different consequences, which is why
// signed can never reach `void`.
const TRANSITIONS = {
  draft:     ['sent', 'void'],
  sent:      ['opened', 'void'],
  opened:    ['signed', 'void'],
  signed:    ['paid', 'cancelled'],
  paid:      ['cancelled'],
  void:      [],
  cancelled: []
};

export function canTransition(from, to) {
  // hasOwnProperty, so 'constructor' and 'toString' are not statuses.
  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, from)) return false;
  return TRANSITIONS[from].indexOf(to) !== -1;
}
