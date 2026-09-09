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
  // Required, not merely length-capped. Without this a contract can be created
  // with no event date at all, and then sendContract refuses it forever —
  // missingRequiredFields lists event_date, there is no edit control, no void,
  // and firestore.rules forbids delete. That draft is permanent and dead.
  // Refusing here means createContract never writes it in the first place.
  const eventDate = trimmedString(d.eventDate);
  if (!eventDate) errors.push('An event date is required.');
  else if (eventDate.length > MAX_EVENT_DATE) errors.push('That event date is too long.');

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
  // 'signed' as well as 'opened'. openContract stamps sent -> opened
  // best-effort and swallows a failed write, so a client can legitimately be
  // sitting on a contract still marked 'sent'. Without this, that swallowed
  // failure turns into a refusal of their valid signature — and a client
  // holding a valid token is entitled to sign whether or not the open was
  // ever recorded.
  sent:      ['opened', 'signed', 'void'],
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

// Closing a contract out of her way means two different things, and the
// difference is not cosmetic.
//
// An offer that was never agreed to is VOID — withdrawn, as though it had not
// been made. An agreement a client actually signed is CANCELLED — it existed,
// it was executed, and it was called off. Recording a signed wedding as "void"
// would misdescribe a legal document in her own permanent record.
//
// Returns null for anything already closed, or any status this does not
// recognise, so the caller refuses rather than inventing a transition. Lives
// here rather than in the callable because it decides how an executed
// agreement is described forever, and index.js is not unit-tested by this
// project's convention.
export function closingStatusFor(from) {
  if (from === 'signed' || from === 'paid') return 'cancelled';
  if (from === 'draft' || from === 'sent' || from === 'opened') return 'void';
  return null;
}

// The package price is a DEFAULT, not a fixed price.
//
// Her weddings are advertised "starting from $750 / $1,000 / $1,200", and a
// wedding genuinely varies — more hours, a second location, add-ons. A system
// that could only print the catalogue figure would either make that wording a
// lie or force a new package for every quote.
//
// So the price that reaches the contract is the one she confirms on THIS
// booking, pre-filled from the package. This lives here rather than in the
// callable because it decides a number in a signed legal document, and
// index.js is not unit-tested by this project's convention.
export function resolvePackagePrice(packagePriceCents, overrideCents) {
  const blank = overrideCents === undefined || overrideCents === null || overrideCents === '';
  if (blank) {
    if (!Number.isInteger(packagePriceCents) || packagePriceCents <= 0) {
      return { ok: false, error: 'That package has no usable price.' };
    }
    return { ok: true, cents: packagePriceCents, overridden: false };
  }

  // Checked, never coerced. Number('') is 0 and Number('x') is NaN, and either
  // one silently becomes a wrong figure on a contract somebody signs.
  if (!Number.isInteger(overrideCents) || overrideCents <= 0) {
    return { ok: false, error: 'That price must be a whole number of cents above zero.' };
  }
  if (overrideCents > MAX_TOTAL_CENTS) {
    return { ok: false, error: 'That price looks wrong — is it in cents?' };
  }
  return { ok: true, cents: overrideCents, overridden: overrideCents !== packagePriceCents };
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

// ---------------------------------------------------------------------------
// Event dates.
//
// Stored as a plain ISO day, 'YYYY-MM-DD', and NEVER parsed with `new Date()`.
// `new Date('2027-06-12')` is midnight UTC, which is the 11th in Oregon — so
// a naive parse shifts every event date back a day for her. And the free text
// this replaces was worse still: "Summer 2027" parsed as 1 January, which
// would have filed an upcoming wedding under past events and hidden it.
//
// Splitting the string is timezone-proof because no timezone is involved: an
// ISO day is a calendar date, not an instant. Comparison is lexical for the
// same reason — 'YYYY-MM-DD' sorts correctly as text.
// ---------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

export function isValidEventDateISO(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Rejects 31 February and friends: rebuild the date in UTC and check the
  // parts survived. UTC is safe here because both sides are UTC.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// The text that goes ON the contract. Derived from the ISO day so the printed
// date and the sorted date can never disagree.
export function formatEventDate(iso) {
  if (!isValidEventDateISO(iso)) return '';
  return MONTHS[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)) + ', ' + iso.slice(0, 4);
}

// todayISO is the current day in HER timezone, supplied by the caller — the
// server runs in UTC and the browser in whatever zone the reader is in, and
// neither should decide whether her Saturday wedding is over.
export function isEventPast(iso, todayISO) {
  if (!isValidEventDateISO(iso) || !isValidEventDateISO(todayISO)) return false;
  return iso < todayISO;
}
