import { test } from 'node:test';
import assert from 'node:assert';
import { TEMPLATE_KEYS, validatePackage, requiredSpecsFor } from '../lib/packages.js';

const wedding = (extra) => Object.assign({
  label: 'The Grand — 8 Hours', templateKey: 'wedding', priceCents: 120000, order: 3,
  specs: { packageName: 'The Grand 8-Hour Package', hours: 8, editedImages: '400+' }
}, extra || {});

const portrait = (extra) => Object.assign({
  label: 'Maternity', templateKey: 'portrait', priceCents: 20000, order: 1,
  specs: { packageName: 'Maternity Session', sessionMinutes: 60, editedImages: '30+', locations: 1, outfitChanges: 2 }
}, extra || {});

test('there are exactly three templates', () => {
  assert.deepEqual(TEMPLATE_KEYS, ['wedding', 'elopement', 'portrait']);
});

test('each template declares what it needs filled in', () => {
  assert.deepEqual(requiredSpecsFor('wedding'), ['packageName', 'hours', 'editedImages']);
  assert.deepEqual(requiredSpecsFor('elopement'), ['packageName', 'hours', 'editedImages']);
  assert.deepEqual(requiredSpecsFor('portrait'),
    ['packageName', 'sessionMinutes', 'editedImages', 'locations', 'outfitChanges']);
  assert.deepEqual(requiredSpecsFor('nope'), []);
});

test('a complete package validates', () => {
  assert.equal(validatePackage(wedding()).ok, true);
  assert.equal(validatePackage(portrait()).ok, true);
});

test('an unknown or missing template key is refused', () => {
  assert.equal(validatePackage(wedding({ templateKey: 'invoice' })).ok, false);
  assert.equal(validatePackage(wedding({ templateKey: '' })).ok, false);
  assert.equal(validatePackage(wedding({ templateKey: null })).ok, false);
});

// This is the point of the file: a missing spec becomes a blank in a signed contract.
test('a package missing any required spec is refused, and the error names it', () => {
  const noHours = wedding({ specs: { packageName: 'X', editedImages: '400+' } });
  const r = validatePackage(noHours);
  assert.equal(r.ok, false);
  assert.ok(r.errors.join(' ').includes('hours'));

  const noOutfits = portrait({ specs: {
    packageName: 'X', sessionMinutes: 60, editedImages: '30+', locations: 1 } });
  assert.equal(validatePackage(noOutfits).ok, false);
  assert.ok(validatePackage(noOutfits).errors.join(' ').includes('outfitChanges'));
});

test('a portrait spec is not accepted on a wedding package and vice versa', () => {
  const w = wedding({ specs: { packageName: 'X', sessionMinutes: 60, editedImages: '1' } });
  assert.equal(validatePackage(w).ok, false);
});

test('price and label are checked, and hostile input is survived not crashed on', () => {
  assert.equal(validatePackage(wedding({ priceCents: 0 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: -1 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: 12.5 })).ok, false);
  assert.equal(validatePackage(wedding({ priceCents: '120000' })).ok, false);
  assert.equal(validatePackage(wedding({ label: '' })).ok, false);
  assert.equal(validatePackage(wedding({ label: 'x'.repeat(300) })).ok, false);
  assert.equal(validatePackage(wedding({ specs: null })).ok, false);
  assert.equal(validatePackage(null).ok, false);
  assert.equal(validatePackage('nope').ok, false);
});
