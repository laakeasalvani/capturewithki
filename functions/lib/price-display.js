// How a package's price reads on the public site and in the inquiry form.
//
// The `packages` collection is the ONE place a package's price lives. Contracts
// read `priceCents` from it (functions/index.js, createContract), and the public
// page renders every price and every inquiry option from it through this file
// (cms/prices.js). Changing a price in edit mode writes `packages/{id}` and all
// three follow — there is no second copy to forget.
//
// Pure — no Firebase, no DOM — so it is tested in functions/test and imported
// as-is by the browser, the same way int/contracts.js imports lib/contracts.js.

import { formatCents } from './contract-email.js';
import { dollarsToCents, MAX_TOTAL_CENTS } from './contracts.js';

// "$1,200", or "$175.50" when there are cents. The site never shows ".00".
export function displayPrice(cents) {
  if (!Number.isInteger(cents) || cents <= 0) return '';
  const full = formatCents(cents);
  return full.endsWith('.00') ? full.slice(0, -3) : full;
}

// Weddings are advertised as a floor ("Starting from $950") because she quotes
// bigger days higher. A package can say so explicitly with `startingFrom`; one
// that never set it keeps the behaviour it has always had: weddings yes, the
// rest no.
export function isStartingFrom(pkg) {
  if (pkg && typeof pkg.startingFrom === 'boolean') return pkg.startingFrom;
  return !!(pkg && pkg.templateKey === 'wedding');
}

function hoursOf(pkg) {
  const h = pkg && pkg.specs && pkg.specs.hours;
  const s = h === undefined || h === null ? '' : String(h).trim();
  return s;
}

// "The Intimate — 4 Hours" -> "The Intimate"
export function shortName(pkg) {
  const label = pkg && typeof pkg.label === 'string' ? pkg.label : '';
  return label.split(' — ')[0].trim();
}

export function isUsable(pkg) {
  return !!pkg && pkg.active !== false &&
    Number.isInteger(pkg.priceCents) && pkg.priceCents > 0 &&
    typeof pkg.label === 'string' && pkg.label.trim() !== '';
}

// Active packages with a real price, in display order. A package with no
// `order` sinks to the bottom rather than vanishing.
export function usablePackages(list) {
  return (Array.isArray(list) ? list : [])
    .filter(isUsable)
    .slice()
    .sort(function (a, b) {
      const ao = Number.isFinite(a.order) ? a.order : Infinity;
      const bo = Number.isFinite(b.order) ? b.order : Infinity;
      return ao - bo;
    });
}

// The line under a package's name on the page.
//   portrait / elopement:  "$175"
//   wedding:               "4 Hours — Starting from $950"
export function sitePriceText(pkg) {
  if (!isUsable(pkg)) return '';
  const price = displayPrice(pkg.priceCents);
  const priced = isStartingFrom(pkg) ? 'Starting from ' + price : price;
  const hours = hoursOf(pkg);
  if (pkg.templateKey === 'wedding' && hours) return hours + ' Hours — ' + priced;
  return priced;
}

// The option a visitor picks in the contact form. The chosen text is what
// arrives in her inbox, so it names the package and the price they saw.
//   "Couples — $175"
//   "Wedding, The Intimate — 4 hrs, from $950"
export function inquiryOptionText(pkg) {
  if (!isUsable(pkg)) return '';
  const price = displayPrice(pkg.priceCents);
  const priced = isStartingFrom(pkg) ? 'from ' + price : price;
  const hours = hoursOf(pkg);
  if (pkg.templateKey === 'wedding') {
    return 'Wedding, ' + shortName(pkg) + ' — ' + (hours ? hours + ' hrs, ' : '') + priced;
  }
  return pkg.label.trim() + ' — ' + priced;
}

// What she types in the price editor -> cents, or a reason it was refused.
// Same rules as the contract composer, so a price that saves here is always a
// price a contract can carry.
export function parsePriceInput(raw) {
  const cents = dollarsToCents(raw);
  if (cents === null) return { error: 'Enter an amount like 950 or 175.50.' };
  if (cents <= 0) return { error: 'The price has to be more than $0.' };
  if (cents > MAX_TOTAL_CENTS) return { error: 'That price is too high — check for an extra zero.' };
  return { cents: cents };
}
