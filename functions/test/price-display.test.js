import { test } from 'node:test';
import assert from 'node:assert';
import {
  displayPrice, isStartingFrom, shortName, usablePackages,
  sitePriceText, inquiryOptionText, parsePriceInput
} from '../lib/price-display.js';

// Shaped exactly like her live `packages` documents.
const intimate = { label: 'The Intimate — 4 Hours', templateKey: 'wedding', priceCents: 95000, order: 7, active: true,
  specs: { packageName: 'The Intimate 4-Hour Package', hours: '4', editedImages: '200+' } };
const classic = { label: 'The Classic — 6 Hours', templateKey: 'wedding', priceCents: 120000, order: 8, active: true,
  specs: { packageName: 'The Classic 6-Hour Package', hours: '6', editedImages: '300+' } };
const elopement = { label: 'Elopement', templateKey: 'elopement', priceCents: 35000, order: 6, active: true,
  specs: { packageName: 'The Elopement Package', hours: '2', editedImages: '150+' } };
const couples = { label: 'Couples', templateKey: 'portrait', priceCents: 17500, order: 1, active: true,
  specs: { packageName: 'Couples Session', sessionMinutes: '60', editedImages: '30–50', locations: '1', outfitChanges: '1' } };

test('prices read the way the site always showed them', () => {
  assert.equal(displayPrice(17500), '$175');
  assert.equal(displayPrice(120000), '$1,200');
  assert.equal(displayPrice(17550), '$175.50');
  assert.equal(displayPrice(0), '');
  assert.equal(displayPrice(null), '');
});

test('page text matches what is live today, word for word', () => {
  assert.equal(sitePriceText(couples), '$175');
  assert.equal(sitePriceText(elopement), '$350');
  assert.equal(sitePriceText(intimate), '4 Hours — Starting from $950');
  assert.equal(sitePriceText(classic), '6 Hours — Starting from $1,200');
});

test('inquiry options match what is live today, word for word', () => {
  assert.equal(inquiryOptionText(couples), 'Couples — $175');
  assert.equal(inquiryOptionText(elopement), 'Elopement — $350');
  assert.equal(inquiryOptionText(intimate), 'Wedding, The Intimate — 4 hrs, from $950');
  assert.equal(inquiryOptionText(classic), 'Wedding, The Classic — 6 hrs, from $1,200');
});

test('one price change reaches both the page and the form', () => {
  const raised = Object.assign({}, intimate, { priceCents: 100000 });
  assert.equal(sitePriceText(raised), '4 Hours — Starting from $1,000');
  assert.equal(inquiryOptionText(raised), 'Wedding, The Intimate — 4 hrs, from $1,000');
});

test('"Starting from" defaults to weddings only, and can be switched either way', () => {
  assert.equal(isStartingFrom(intimate), true);
  assert.equal(isStartingFrom(couples), false);
  assert.equal(sitePriceText(Object.assign({}, intimate, { startingFrom: false })), '4 Hours — $950');
  assert.equal(sitePriceText(Object.assign({}, elopement, { startingFrom: true })), 'Starting from $350');
  assert.equal(inquiryOptionText(Object.assign({}, couples, { startingFrom: true })), 'Couples — from $175');
});

test('a wedding missing its hours still reads sensibly', () => {
  const noHours = Object.assign({}, intimate, { specs: { packageName: 'x', editedImages: '1' } });
  assert.equal(sitePriceText(noHours), 'Starting from $950');
  assert.equal(inquiryOptionText(noHours), 'Wedding, The Intimate — from $950');
});

test('short name drops the hours from the label', () => {
  assert.equal(shortName(intimate), 'The Intimate');
  assert.equal(shortName(couples), 'Couples');
});

test('only active, priced packages are listed, in her order', () => {
  const hidden = Object.assign({}, couples, { label: 'Hidden', active: false });
  const unpriced = Object.assign({}, couples, { label: 'Unpriced', priceCents: 0 });
  const unordered = Object.assign({}, couples, { label: 'Unordered', order: undefined });
  const out = usablePackages([classic, unordered, hidden, intimate, unpriced, couples]);
  assert.deepEqual(out.map((p) => p.label), ['Couples', 'The Intimate — 4 Hours', 'The Classic — 6 Hours', 'Unordered']);
  assert.deepEqual(usablePackages(null), []);
});

test('an unusable package produces no text, so the built-in wording stays', () => {
  assert.equal(sitePriceText(Object.assign({}, couples, { active: false })), '');
  assert.equal(inquiryOptionText(Object.assign({}, couples, { priceCents: 'abc' })), '');
  assert.equal(sitePriceText(null), '');
});

test('the price editor accepts the amounts she would type', () => {
  assert.deepEqual(parsePriceInput('950'), { cents: 95000 });
  assert.deepEqual(parsePriceInput('$1,200'), { cents: 120000 });
  assert.deepEqual(parsePriceInput(' 175.50 '), { cents: 17550 });
});

test('the price editor refuses anything a contract could not carry', () => {
  for (const bad of ['', '0', 'abc', '12.345', '-5', '1e3', '9999999']) {
    assert.ok(parsePriceInput(bad).error, 'should refuse ' + JSON.stringify(bad));
  }
});
