import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_RETAINER_PERCENT, sumLineItems,
  computeRetainerCents, computeBalanceCents
} from '../lib/contracts.js';

test('the retainer is 30 percent, as the site promises', () => {
  assert.equal(DEFAULT_RETAINER_PERCENT, 30);
});

test('line items add up', () => {
  assert.equal(sumLineItems([{ amountCents: 120000 }, { amountCents: 25000 }]), 145000);
  assert.equal(sumLineItems([]), 0);
});

// A malformed item must not poison the total with NaN. A NaN total silently
// becomes a $0 contract, which is worse than a loud failure.
test('a malformed line item is skipped, not propagated', () => {
  assert.equal(sumLineItems([{ amountCents: 1000 }, { amountCents: '500' }]), 1000);
  assert.equal(sumLineItems([{ amountCents: 1000 }, { amountCents: 1.5 }]), 1000);
  assert.equal(sumLineItems([{ amountCents: 1000 }, null]), 1000);
  assert.equal(sumLineItems(null), 0);
});

test('the retainer on her top package is $360', () => {
  assert.equal(computeRetainerCents(120000, 30), 36000);
});

test('the retainer on her smallest session is $52.50', () => {
  assert.equal(computeRetainerCents(17500, 30), 5250);
});

// Hand-computed, so the test disagrees with the code when the formula changes
// instead of agreeing with itself. The three half-cent cases are the point.
test('the retainer rounds half up, on values worked out by hand', () => {
  assert.equal(computeRetainerCents(120000, 30), 36000); // $1,200.00 -> $360.00, exact
  assert.equal(computeRetainerCents(17500, 30), 5250);   // $175.00 -> $52.50, exact
  assert.equal(computeRetainerCents(75000, 30), 22500);  // $750.00 -> $225.00, exact
  assert.equal(computeRetainerCents(35, 30), 11);        // 10.5 -> 11, half rounds UP
  assert.equal(computeRetainerCents(15, 30), 5);         // 4.5 -> 5, half rounds UP
  assert.equal(computeRetainerCents(12345, 30), 3704);   // 3703.5 -> 3704, half rounds UP
});

// The sum property, checked against an INDEPENDENT oracle. The previous version
// of this test compared the function against itself: because balance is defined
// as (total - retainer), the sum identity held by algebra and the test would
// have passed even if computeRetainerCents always returned zero.
//
// The oracle below is integer-only — floor plus an explicit half-up on the
// remainder — so it shares no floating-point division path with the
// implementation and cannot agree with it by coincidence.
test('the retainer matches an independent oracle, and the two halves sum to the total', () => {
  for (let total = 0; total <= 200000; total += 7) {
    const scaled = total * 30;
    const expected = Math.floor(scaled / 100) + ((scaled % 100) >= 50 ? 1 : 0);
    const retainer = computeRetainerCents(total, 30);
    assert.equal(retainer, expected, 'wrong retainer at total=' + total);
    assert.equal(
      retainer + computeBalanceCents(total, retainer), total,
      'halves do not sum at total=' + total
    );
  }
});

test('computeBalanceCents refuses nonsense rather than returning a wrong balance', () => {
  assert.equal(computeBalanceCents(1.5, 30), 0);
  assert.equal(computeBalanceCents(100, 'x'), 0);
  assert.equal(computeBalanceCents(null, 30), 0);
  assert.equal(computeBalanceCents(100, null), 0);
});

test('a nonsense percentage yields nothing rather than a wrong number', () => {
  assert.equal(computeRetainerCents(120000, -5), 0);
  assert.equal(computeRetainerCents(120000, 150), 0);
  assert.equal(computeRetainerCents(-1, 30), 0);
  assert.equal(computeRetainerCents(1.5, 30), 0);
});
