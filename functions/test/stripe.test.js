import { test } from 'node:test';
import assert from 'node:assert';
import { checkoutLineItems } from '../lib/stripe.js';

const contract = (extra) => Object.assign({
  clientName: 'Jordan Rivera',
  retainerCents: 36000,
  totalCents: 120000,
  eventDate: '2027-06-12'
}, extra || {});

test('the client is charged the retainer, not the total', () => {
  const items = checkoutLineItems(contract());
  assert.equal(items.length, 1);
  assert.equal(items[0].price_data.unit_amount, 36000);
  assert.equal(items[0].quantity, 1);
});

// Stripe's unit_amount is already cents. Converting to dollars anywhere in
// this path would charge a hundredth of the retainer and nobody would notice
// until reconciliation.
test('the amount is passed in cents, untouched', () => {
  assert.equal(checkoutLineItems(contract({ retainerCents: 5250 }))[0].price_data.unit_amount, 5250);
});

test('the charge is in US dollars', () => {
  assert.equal(checkoutLineItems(contract())[0].price_data.currency, 'usd');
});

test('the client can tell what they are paying for on their statement', () => {
  const name = checkoutLineItems(contract())[0].price_data.product_data.name;
  assert.ok(name.toLowerCase().includes('retainer'));
});

// A zero or nonsense retainer must never reach Stripe as a live charge.
test('a nonsense retainer throws rather than creating a $0 session', () => {
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 0 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: -100 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 12.5 })));
  assert.throws(() => checkoutLineItems(contract({ retainerCents: null })));
  assert.throws(() => checkoutLineItems(null));
});

test('the retainer can never exceed the total', () => {
  assert.throws(() => checkoutLineItems(contract({ retainerCents: 200000, totalCents: 120000 })));
});
