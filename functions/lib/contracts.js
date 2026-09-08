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
export const MAX_PHONE = 40;
export const MAX_EVENT_DATE = 40;

// A contract id arrives from a query string, becomes a Firestore path, and is
// embedded in an email link. Its shape is not negotiable. Same reasoning, and
// same regex, as isValidGalleryId.
export function isValidContractId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]{16,40}$/.test(id);
}

function trimmedString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Client-only checks, split out so createContract can run them even though it
// no longer calls validateContractInput (that now runs against the PACKAGE via
// validatePackage). Kept byte-for-byte identical to what validateContractInput
// used to do inline — see the callers below for why each check exists.
export function validateClientDetails(input) {
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

  // Optional, but if it is given it must be usable. Without this, a typo of 150
  // (meaning "$150") is stored as retainerPercent:150 while computeRetainerCents's
  // own out-of-range guard quietly returns 0 — a real, sendable contract with no
  // retainer collected and nothing anywhere reporting a problem.
  const pct = d.retainerPercent;
  if (pct !== undefined && pct !== null) {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      errors.push('The retainer percentage must be a number between 0 and 100.');
    }
  }

  // Both are sliced to these same caps in createContract. Validating against the
  // identical numbers is what makes the slice a no-op rather than silent data
  // loss on a field that gets rendered into a legal document.
  if (trimmedString(d.clientPhone).length > MAX_PHONE) {
    errors.push('That phone number is too long.');
  }
  if (trimmedString(d.eventDate).length > MAX_EVENT_DATE) {
    errors.push('That event date is too long.');
  }

  return { ok: errors.length === 0, errors: errors };
}

export function validateContractInput(input) {
  const clientCheck = validateClientDetails(input);
  const errors = clientCheck.errors.slice();
  const d = input && typeof input === 'object' ? input : {};

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

// The unfilled-placeholder guard only catches a literal {{token}} left in the
// output. It cannot catch a field that WAS substituted — with nothing. An empty
// value leaves a blank line in a signed legal document and looks like a design
// choice rather than a fault. These fields must never be blank.
export const REQUIRED_FIELDS = [
  'client_1_name', 'event_date', 'balance_due_date',
  'package_name', 'package_price', 'retainer', 'remaining_balance'
];

export function missingRequiredFields(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  return REQUIRED_FIELDS.filter(function (k) {
    const v = f[k];
    return v === undefined || v === null || String(v).trim() === '';
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

// The retainer is 30% of the PACKAGE PRICE, never of the total. Her contracts list
// "Package Price" and "Travel Fees" as separate lines and label the retainer "(30%)",
// and the owner's decision is that travel is billed but does not inflate the deposit.
// Computing it from the total would print a number in a signed legal document that
// does not match the label above it.
export function computeFeeBlock(input) {
  const d = input && typeof input === 'object' ? input : {};
  const pkg = d.packagePriceCents;
  const travel = d.travelFeesCents === undefined || d.travelFeesCents === null ? 0 : d.travelFeesCents;
  const pct = Number.isFinite(d.retainerPercent) ? d.retainerPercent : DEFAULT_RETAINER_PERCENT;

  const bad = !Number.isInteger(pkg) || pkg < 0
    || !Number.isInteger(travel) || travel < 0
    || pct < 0 || pct > 100;
  if (bad) {
    return { packagePriceCents: 0, travelFeesCents: 0, retainerCents: 0, totalCents: 0, balanceCents: 0 };
  }

  const retainerCents = Math.round(pkg * pct / 100);
  const totalCents = pkg + travel;
  return {
    packagePriceCents: pkg,
    travelFeesCents: travel,
    retainerCents: retainerCents,
    totalCents: totalCents,
    // By subtraction, always. Computing this independently means the two halves
    // fail to sum on any amount where the percentage lands on a half-cent.
    balanceCents: computeBalanceCents(totalCents, retainerCents)
  };
}
