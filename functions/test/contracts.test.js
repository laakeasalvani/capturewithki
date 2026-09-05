import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_RETAINER_PERCENT, sumLineItems,
  computeRetainerCents, computeBalanceCents,
  isValidContractId, validateContractInput, MAX_TOTAL_CENTS,
  renderTemplate
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

function goodInput(extra) {
  return Object.assign({
    clientName: 'Jordan Rivera',
    clientEmail: 'jordan@example.com',
    eventDate: '2027-06-12',
    eventLocation: 'Cannon Beach, OR',
    lineItems: [{ label: 'The Grand — 8 hours', amountCents: 120000 }]
  }, extra || {});
}

test('a normal booking validates', () => {
  assert.equal(validateContractInput(goodInput()).ok, true);
});

test('a contract id is constrained, because it becomes a Firestore path', () => {
  assert.equal(isValidContractId('abcdefghij0123456789'), true);
  assert.equal(isValidContractId('../../admins/xyz'), false);
  assert.equal(isValidContractId('short'), false);
  assert.equal(isValidContractId(''), false);
  assert.equal(isValidContractId(null), false);
});

// Hostile input. This project has already shipped validation that crashed on
// it once, from a plan rather than an implementation.
test('hostile names are rejected or survived, never crashed on', () => {
  assert.equal(validateContractInput(goodInput({ clientName: '' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: '   ' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: 'x'.repeat(10000) })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: null })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientName: { a: 1 } })).ok, false);
  // These are legitimate and must pass — escaping is rendering's job, not validation's.
  assert.equal(validateContractInput(goodInput({ clientName: "Siobhán O'Brien-Núñez" })).ok, true);
  assert.equal(validateContractInput(goodInput({ clientName: '<script>alert(1)</script>' })).ok, true);
});

test('an unusable email is rejected', () => {
  assert.equal(validateContractInput(goodInput({ clientEmail: 'nope' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: '' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: 'a@b' })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientEmail: 'a@b.co' })).ok, true);
});

test('line items must be present, sane, and finite in number', () => {
  assert.equal(validateContractInput(goodInput({ lineItems: [] })).ok, false);
  assert.equal(validateContractInput(goodInput({ lineItems: null })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Travel', amountCents: -100 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Travel', amountCents: 12.5 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: '', amountCents: 100 }]
  })).ok, false);
  const many = [];
  for (let i = 0; i < 50; i++) many.push({ label: 'Item', amountCents: 100 });
  assert.equal(validateContractInput(goodInput({ lineItems: many })).ok, false);
});

// A zero-total contract is almost certainly a mistake, and an implausible
// total is almost certainly a units error — someone passing dollars as cents.
test('the total must be plausible', () => {
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Free', amountCents: 0 }]
  })).ok, false);
  assert.equal(validateContractInput(goodInput({
    lineItems: [{ label: 'Oops', amountCents: MAX_TOTAL_CENTS + 1 }]
  })).ok, false);
});

test('errors are reported as a list, not a single message', () => {
  const result = validateContractInput({ clientName: '', clientEmail: 'nope', lineItems: [] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test('a placeholder is replaced with its value', () => {
  assert.equal(
    renderTemplate('<p>For {{client_name}}</p>', { client_name: 'Jordan' }),
    '<p>For Jordan</p>'
  );
});

test('whitespace inside the braces is tolerated', () => {
  assert.equal(renderTemplate('{{ client_name }}', { client_name: 'Jordan' }), 'Jordan');
});

// The client's own name goes into the contract HTML. email.js already
// documents why this matters: text cannot be markup, but HTML can.
test('values are escaped', () => {
  assert.equal(
    renderTemplate('{{client_name}}', { client_name: '<script>alert(1)</script>' }),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});

// A client named "{{total}}" must not be able to read another field. One
// substitution pass, never recursive.
test('a value containing a placeholder is not expanded again', () => {
  assert.equal(
    renderTemplate('{{client_name}}', { client_name: '{{total}}', total: '$1,200' }),
    '{{total}}'
  );
});

// Blanking an unknown placeholder would ship a contract with a silent hole
// where a clause used to be. Leaving it visible makes the mistake loud.
test('an unknown placeholder is left visible, not blanked', () => {
  assert.equal(renderTemplate('<p>{{mystery}}</p>', {}), '<p>{{mystery}}</p>');
});

test('rendering survives nonsense input', () => {
  assert.equal(renderTemplate(null, {}), '');
  assert.equal(renderTemplate('<p>hi</p>', null), '<p>hi</p>');
  assert.equal(renderTemplate('{{client_name}}', { client_name: null }), '');
});
