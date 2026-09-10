import { test } from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_RETAINER_PERCENT, sumLineItems,
  computeRetainerCents, computeBalanceCents,
  isValidContractId, validateContractInput, validateClientDetails, MAX_TOTAL_CENTS,
  renderTemplate, STATUSES, canTransition, missingRequiredFields, resolvePackagePrice,
  isValidEventDateISO, formatEventDate, isEventPast, closingStatusFor,
  dollarsToCents, centsToInput
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

test('client details are validated on their own, not only as part of a full contract', () => {
  const good = {
    clientName: 'Jordan Rivera', clientEmail: 'jordan@example.com', eventDate: '2027-06-12'
  };
  assert.equal(validateClientDetails(good).ok, true);
});

// A contract created without an event date is not merely incomplete, it is a
// dead draft: sendContract refuses it forever (event_date is in REQUIRED_FIELDS)
// and there is no edit control. voidContract can now at least file one away, and
// firestore.rules still forbids delete, so it is refused here — before
// createContract writes anything — rather than left for her to tidy up after.
test('a blank event date is refused, because the draft it would create can never be sent or deleted', () => {
  const base = { clientName: 'Jordan Rivera', clientEmail: 'jordan@example.com' };
  assert.equal(validateClientDetails({ ...base, eventDate: '' }).ok, false);
  assert.equal(validateClientDetails({ ...base, eventDate: '   ' }).ok, false);
  assert.equal(validateClientDetails(base).ok, false);
  assert.equal(validateClientDetails({ ...base, eventDate: null }).ok, false);
  // And a real one passes — the point is to refuse the blank, not the field.
  assert.equal(validateClientDetails({ ...base, eventDate: 'June 14, 2027' }).ok, true);
  assert.equal(validateClientDetails({ ...base, eventDate: '2027-06-12' }).ok, true);
});

// The whole reason a blank is refused rather than length-capped: the message
// has to name what is wrong, in her words, not just fail.
test('the refusal names the event date', () => {
  const result = validateClientDetails({ clientName: 'J', clientEmail: 'a@b.co' });
  assert.ok(result.errors.some((e) => /event date/i.test(e)));
});

// An empty name is the dangerous one: renderTemplate substitutes a present-but-empty
// value as an empty string, NOT as an unfilled {{placeholder}}, so the send-time guard
// never catches it and a blank name reaches a signed legal document.
test('an empty client name is refused, because a blank one would render invisibly', () => {
  assert.equal(validateClientDetails({ clientName: '', clientEmail: 'a@b.co' }).ok, false);
  assert.equal(validateClientDetails({ clientName: '   ', clientEmail: 'a@b.co' }).ok, false);
  assert.equal(validateClientDetails({ clientEmail: 'a@b.co' }).ok, false);
});

test('an unusable client email is refused, because a sent contract cannot be resent', () => {
  const d = '2027-06-12';
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: 'nope', eventDate: d }).ok, false);
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: '', eventDate: d }).ok, false);
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: 'a@b', eventDate: d }).ok, false);
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: 'a@b.co', eventDate: d }).ok, true);
});

test('over-long fields are refused, not silently truncated into the signed document', () => {
  const base = { clientName: 'J', clientEmail: 'a@b.co', eventDate: '2027-06-12' };
  assert.equal(validateClientDetails({ ...base, clientName: 'x'.repeat(10000) }).ok, false);
  assert.equal(validateClientDetails({ ...base, eventLocation: 'x'.repeat(10000) }).ok, false);
  assert.equal(validateClientDetails({ ...base, eventDate: 'x'.repeat(10000) }).ok, false);
});

test('hostile and malformed input is survived, not crashed on', () => {
  assert.equal(validateClientDetails(null).ok, false);
  assert.equal(validateClientDetails(undefined).ok, false);
  assert.equal(validateClientDetails('nope').ok, false);
  assert.equal(validateClientDetails(42).ok, false);
  assert.equal(validateClientDetails({ clientName: { a: 1 }, clientEmail: 'a@b.co' }).ok, false);
  const d = '2027-06-12';
  // Legitimate and must PASS — escaping is rendering's job, not validation's.
  assert.equal(validateClientDetails({ clientName: "Siobhán O'Brien-Núñez", clientEmail: 'a@b.co', eventDate: d }).ok, true);
  assert.equal(validateClientDetails({ clientName: '<script>alert(1)</script>', clientEmail: 'a@b.co', eventDate: d }).ok, true);
  // A non-string event date is not a date. trimmedString gives '' for it, and
  // '' is refused — the same way a non-string name is.
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: 'a@b.co', eventDate: { a: 1 } }).ok, false);
  assert.equal(validateClientDetails({ clientName: 'J', clientEmail: 'a@b.co', eventDate: 20270612 }).ok, false);
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

test('a retainer percentage outside 0-100 is refused, not silently zeroed', () => {
  assert.equal(validateContractInput(goodInput({ retainerPercent: 150 })).ok, false);
  assert.equal(validateContractInput(goodInput({ retainerPercent: -5 })).ok, false);
  assert.equal(validateContractInput(goodInput({ retainerPercent: NaN })).ok, false);
  assert.equal(validateContractInput(goodInput({ retainerPercent: Infinity })).ok, false);
  assert.equal(validateContractInput(goodInput({ retainerPercent: '30' })).ok, false);
});

test('a sensible retainer percentage is accepted, and omitting it is fine', () => {
  assert.equal(validateContractInput(goodInput({ retainerPercent: 30 })).ok, true);
  assert.equal(validateContractInput(goodInput({ retainerPercent: 0 })).ok, true);
  assert.equal(validateContractInput(goodInput({ retainerPercent: 100 })).ok, true);
  assert.equal(validateContractInput(goodInput()).ok, true);
});

test('an over-long phone or event date is refused rather than truncated', () => {
  assert.equal(validateContractInput(goodInput({ clientPhone: '5'.repeat(41) })).ok, false);
  assert.equal(validateContractInput(goodInput({ eventDate: 'x'.repeat(41) })).ok, false);
  assert.equal(validateContractInput(goodInput({ clientPhone: '5'.repeat(40) })).ok, true);
  assert.equal(validateContractInput(goodInput({ eventDate: 'x'.repeat(40) })).ok, true);
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

test('every status is accounted for', () => {
  assert.deepEqual(
    STATUSES,
    ['draft', 'sent', 'opened', 'signed', 'paid', 'void', 'cancelled']
  );
});

test('a contract moves forward through the normal path', () => {
  assert.equal(canTransition('draft', 'sent'), true);
  assert.equal(canTransition('sent', 'opened'), true);
  // openContract stamps sent -> opened best-effort and swallows a failed
  // write, so a client can legitimately hold a valid token on a contract
  // still marked 'sent'. Their signature must not be refused for that.
  assert.equal(canTransition('sent', 'signed'), true);
  assert.equal(canTransition('opened', 'signed'), true);
  assert.equal(canTransition('signed', 'paid'), true);
});

test('a contract never moves backwards', () => {
  assert.equal(canTransition('signed', 'opened'), false);
  assert.equal(canTransition('paid', 'signed'), false);
  assert.equal(canTransition('opened', 'draft'), false);
});

// The spec is explicit: auto-voiding something a client actually signed is
// legally awkward and would burn a slow-but-real client. A signed agreement
// can only be CANCELLED, which is a decision she makes and a record that keeps.
test('a signed contract can never be voided, only cancelled', () => {
  assert.equal(canTransition('signed', 'void'), false);
  assert.equal(canTransition('paid', 'void'), false);
  assert.equal(canTransition('signed', 'cancelled'), true);
  assert.equal(canTransition('paid', 'cancelled'), true);
});

test('an unsigned contract can be voided', () => {
  assert.equal(canTransition('draft', 'void'), true);
  assert.equal(canTransition('sent', 'void'), true);
  assert.equal(canTransition('opened', 'void'), true);
});

test('terminal states are terminal', () => {
  assert.equal(canTransition('void', 'sent'), false);
  assert.equal(canTransition('cancelled', 'paid'), false);
});

test('an unknown status transitions nowhere', () => {
  assert.equal(canTransition('nonsense', 'sent'), false);
  assert.equal(canTransition(null, 'sent'), false);
  assert.equal(canTransition('draft', 'nonsense'), false);
  assert.equal(canTransition('constructor', 'sent'), false);
});

// Append to functions/test/contracts.test.js
import { computeFeeBlock } from '../lib/contracts.js';

// Reversed by the owner on 2026-09-09. It used to be 30% of the package alone,
// which printed a retainer labelled "(30%)" directly beneath a total it was not
// 30% of — $360 under a $1,500 total is 24%.
test('the retainer is 30 percent of the total, travel included', () => {
  const f = computeFeeBlock({ packagePriceCents: 120000, travelFeesCents: 5000 });
  assert.equal(f.packagePriceCents, 120000);
  assert.equal(f.travelFeesCents, 5000);
  assert.equal(f.totalCents, 125000);
  assert.equal(f.retainerCents, 37500);   // 30% of 125000, travel included
  assert.equal(f.balanceCents, 87500);    // 125000 - 37500
});

// The label on the document has to be true of the number beside it.
test('the retainer really is the stated percentage of the printed total', () => {
  for (const [pkg, travel] of [[120000, 5000], [75000, 0], [17500, 3333], [100000, 100000]]) {
    const f = computeFeeBlock({ packagePriceCents: pkg, travelFeesCents: travel });
    assert.equal(f.retainerCents, Math.round(f.totalCents * 30 / 100),
      'retainer is not 30% of the total at pkg=' + pkg + ' travel=' + travel);
  }
});

// The property that matters, checked against an independent integer oracle so it
// cannot agree with the implementation by construction.
test('retainer plus balance always equals package plus travel', () => {
  for (let pkg = 0; pkg <= 200000; pkg += 1301) {
    for (const travel of [0, 1, 4999, 25000]) {
      const f = computeFeeBlock({ packagePriceCents: pkg, travelFeesCents: travel });
      // Oracle over the TOTAL, travel included — the rule the document states.
      const scaled = (pkg + travel) * 30;
      const expected = Math.floor(scaled / 100) + ((scaled % 100) >= 50 ? 1 : 0);
      assert.equal(f.retainerCents, expected,
        'wrong retainer at pkg=' + pkg + ' travel=' + travel);
      assert.equal(f.retainerCents + f.balanceCents, pkg + travel,
        'does not sum at pkg=' + pkg + ' travel=' + travel);
    }
  }
});

test('travel of zero behaves, and a missing travel fee counts as zero', () => {
  assert.equal(computeFeeBlock({ packagePriceCents: 17500, travelFeesCents: 0 }).balanceCents, 12250);
  assert.equal(computeFeeBlock({ packagePriceCents: 17500 }).totalCents, 17500);
});

test('nonsense input yields zeroes rather than a wrong number', () => {
  const bad = computeFeeBlock({ packagePriceCents: -1, travelFeesCents: 0 });
  assert.equal(bad.retainerCents, 0);
  assert.equal(bad.totalCents, 0);
  assert.equal(computeFeeBlock(null).totalCents, 0);
  assert.equal(computeFeeBlock({ packagePriceCents: 12.5 }).totalCents, 0);
  assert.equal(computeFeeBlock({ packagePriceCents: 10000, travelFeesCents: -5 }).totalCents, 0);
});

test('a required merge field that is present but EMPTY is caught', () => {
  const full = {
    client_1_name: 'Jordan Rivera', event_date: 'June 12, 2027',
    balance_due_date: 'May 29, 2027', package_name: 'The Grand 8-Hour Package',
    package_price: '$1,200.00', retainer: '$360.00', remaining_balance: '$840.00'
  };
  assert.deepEqual(missingRequiredFields(full), []);
  assert.deepEqual(missingRequiredFields({ ...full, balance_due_date: '' }), ['balance_due_date']);
  assert.deepEqual(missingRequiredFields({ ...full, balance_due_date: '   ' }), ['balance_due_date']);
  assert.deepEqual(missingRequiredFields({ ...full, client_1_name: null }), ['client_1_name']);
});

test('several blanks are all reported, so she fixes them in one pass', () => {
  const r = missingRequiredFields({ client_1_name: 'J' });
  assert.ok(r.length >= 5);
  assert.ok(r.includes('balance_due_date'));
  assert.equal(r.includes('client_1_name'), false);
});

test('missingRequiredFields survives nonsense', () => {
  assert.deepEqual(missingRequiredFields(null).length > 0, true);
  assert.deepEqual(missingRequiredFields(undefined).length > 0, true);
  assert.deepEqual(missingRequiredFields('nope').length > 0, true);
});

// Optional fields are deliberately NOT on the list — a blank phone or venue is
// normal, and those fall back to readable text rather than rendering empty.
test('optional fields are not required', () => {
  const full = {
    client_1_name: 'J', event_date: 'D', balance_due_date: 'B',
    package_name: 'P', package_price: '$1', retainer: '$1', remaining_balance: '$1'
  };
  assert.deepEqual(missingRequiredFields({ ...full, client_phone: '', client_2_name: '' }), []);
});

// ---------------------------------------------------------------------------
// resolvePackagePrice — the package figure is a default she can override,
// because her weddings are advertised "starting from".
// ---------------------------------------------------------------------------

test('with no override, the package price is used', () => {
  const r = resolvePackagePrice(120000, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.cents, 120000);
  assert.equal(r.overridden, false);
});

test('an empty override is not zero — it means "use the package price"', () => {
  // A blank input field arrives as '' or null. Treating either as the NUMBER
  // zero would quietly produce a free contract.
  for (const blank of [undefined, null, '']) {
    const r = resolvePackagePrice(120000, blank);
    assert.equal(r.ok, true, 'failed for ' + JSON.stringify(blank));
    assert.equal(r.cents, 120000);
  }
});

test('a real override wins and is reported as overridden', () => {
  const r = resolvePackagePrice(120000, 160000);
  assert.equal(r.ok, true);
  assert.equal(r.cents, 160000);
  assert.equal(r.overridden, true);
});

test('an override equal to the package price is not an override', () => {
  assert.equal(resolvePackagePrice(120000, 120000).overridden, false);
});

test('a nonsense override is refused, never coerced', () => {
  // Every one of these would otherwise become a wrong figure on a signed contract.
  for (const bad of [0, -1, 12.5, '120000', 'abc', NaN, Infinity, {}]) {
    assert.equal(resolvePackagePrice(120000, bad).ok, false, 'accepted ' + String(bad));
  }
});

test('an implausible override is refused, in case dollars were typed as cents', () => {
  assert.equal(resolvePackagePrice(120000, MAX_TOTAL_CENTS + 1).ok, false);
  assert.equal(resolvePackagePrice(120000, MAX_TOTAL_CENTS).ok, true);
});

test('a package with no usable price is refused when nothing overrides it', () => {
  for (const bad of [undefined, null, 0, -5, 12.5, '120000']) {
    assert.equal(resolvePackagePrice(bad, undefined).ok, false, 'accepted ' + String(bad));
  }
  // ...but an override rescues it, which is how a quote-only package would work.
  assert.equal(resolvePackagePrice(undefined, 160000).ok, true);
});

test('the retainer follows the overridden price, not the catalogue one', () => {
  // The whole point: a Grand quoted at $1,600 must take 30% of $1,600.
  const price = resolvePackagePrice(120000, 160000);
  const fees = computeFeeBlock({ packagePriceCents: price.cents, travelFeesCents: 0 });
  assert.equal(fees.retainerCents, 48000);
  assert.equal(fees.retainerCents + fees.balanceCents, fees.totalCents);
});

// ---------------------------------------------------------------------------
// Event dates. The free text these replace parsed "Summer 2027" as 1 January,
// which would have filed an upcoming wedding under past events and hidden it.
// ---------------------------------------------------------------------------

test('an ISO day formats without shifting a day', () => {
  // new Date('2027-06-12') is midnight UTC — the 11th in Oregon. The whole
  // point of splitting the string is that this cannot happen.
  assert.equal(formatEventDate('2027-06-12'), 'June 12, 2027');
  assert.equal(formatEventDate('2027-01-01'), 'January 1, 2027');
  assert.equal(formatEventDate('2027-12-31'), 'December 31, 2027');
});

test('a nonsense date is refused, never guessed at', () => {
  for (const bad of ['Summer 2027', 'next summer', 'TBD', '6/12/27', '2027-13-01',
                     '2027-02-31', '2027-6-1', '', null, undefined, 42, {}]) {
    assert.equal(isValidEventDateISO(bad), false, 'accepted ' + JSON.stringify(bad));
    assert.equal(formatEventDate(bad), '', 'formatted ' + JSON.stringify(bad));
  }
  assert.equal(isValidEventDateISO('2028-02-29'), true);   // 2028 is a leap year
  assert.equal(isValidEventDateISO('2027-02-29'), false);  // 2027 is not
});

test('past is decided by comparing calendar days, not instants', () => {
  assert.equal(isEventPast('2026-09-08', '2026-09-09'), true);
  assert.equal(isEventPast('2026-09-09', '2026-09-09'), false);   // today is not past
  assert.equal(isEventPast('2026-09-10', '2026-09-09'), false);
  assert.equal(isEventPast('2027-06-12', '2026-09-09'), false);
});

test('an unusable date is never treated as past', () => {
  // The dangerous direction: anything we cannot read must stay VISIBLE, never
  // get filed away into a section that is hidden by default.
  for (const bad of ['Summer 2027', '', null, 'TBD']) {
    assert.equal(isEventPast(bad, '2026-09-09'), false, 'hid ' + JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Closing a contract out of her way.
// ---------------------------------------------------------------------------

test('an offer nobody agreed to is voided, not cancelled', () => {
  assert.equal(closingStatusFor('draft'), 'void');
  assert.equal(closingStatusFor('sent'), 'void');
  assert.equal(closingStatusFor('opened'), 'void');
});

test('an agreement a client actually signed is cancelled, not voided', () => {
  // Describing a signed wedding as "void" would misdescribe an executed legal
  // document in her permanent record.
  assert.equal(closingStatusFor('signed'), 'cancelled');
  assert.equal(closingStatusFor('paid'), 'cancelled');
});

test('an already-closed contract yields no further transition', () => {
  assert.equal(closingStatusFor('void'), null);
  assert.equal(closingStatusFor('cancelled'), null);
});

test('an unrecognised status is refused rather than guessed at', () => {
  assert.equal(closingStatusFor('nonsense'), null);
  assert.equal(closingStatusFor(''), null);
  assert.equal(closingStatusFor(undefined), null);
  // Prototype keys must not be mistaken for statuses.
  assert.equal(closingStatusFor('constructor'), null);
  assert.equal(closingStatusFor('toString'), null);
});

test('every status closingStatusFor offers is one canTransition actually permits', () => {
  // These two must never drift apart: closingStatusFor decides the target and
  // canTransition is the gate, so a status allowed by one and refused by the
  // other would make the button dead for that contract.
  for (const from of STATUSES) {
    const to = closingStatusFor(from);
    if (to !== null) {
      assert.equal(canTransition(from, to), true,
        from + ' -> ' + to + ' is offered but not permitted');
    }
  }
});

// ---------------------------------------------------------------------------
// Money typed by hand. She could only enter whole dollars before.
// ---------------------------------------------------------------------------

test('cents are accepted, which is the whole point', () => {
  assert.equal(dollarsToCents('175.50'), 17550);
  assert.equal(dollarsToCents('0.99'), 99);
  assert.equal(dollarsToCents('1200.05'), 120005);
});

// '.5' is fifty cents. Read as five, every such contract would be 45 cents short.
test('one decimal place means tenths of a dollar, not cents', () => {
  assert.equal(dollarsToCents('175.5'), 17550);
  assert.equal(dollarsToCents('1.1'), 110);
  assert.equal(dollarsToCents('0.5'), 50);
});

test('whole dollars still work exactly as before', () => {
  assert.equal(dollarsToCents('175'), 17500);
  assert.equal(dollarsToCents('1200'), 120000);
  assert.equal(dollarsToCents('0'), 0);
});

test('blank is zero, so a missing travel fee is not an error', () => {
  assert.equal(dollarsToCents(''), 0);
  assert.equal(dollarsToCents('   '), 0);
  assert.equal(dollarsToCents(null), 0);
  assert.equal(dollarsToCents(undefined), 0);
});

test('a dollar sign and thousands separators are tolerated', () => {
  assert.equal(dollarsToCents('$1,200.50'), 120050);
  assert.equal(dollarsToCents('1,200'), 120000);
});

// Refused, never rounded. A figure she did not type must not reach a document
// that somebody signs.
test('more than two decimal places is refused rather than rounded', () => {
  assert.equal(dollarsToCents('175.555'), null);
  assert.equal(dollarsToCents('1.005'), null);
});

test('nonsense is refused rather than coerced to a number', () => {
  assert.equal(dollarsToCents('abc'), null);
  assert.equal(dollarsToCents('12abc'), null);
  assert.equal(dollarsToCents('-5'), null);
  assert.equal(dollarsToCents('1.2.3'), null);
  assert.equal(dollarsToCents('.50'), null);
  assert.equal(dollarsToCents('1e3'), null);
  assert.equal(dollarsToCents('+5'), null);
  assert.equal(dollarsToCents('Infinity'), null);
});

test('an absurd amount is refused rather than losing precision', () => {
  assert.equal(dollarsToCents('999999999999999999'), null);
});

test('the box is pre-filled without inventing decimals', () => {
  assert.equal(centsToInput(17500), '175');
  assert.equal(centsToInput(17550), '175.50');
  assert.equal(centsToInput(99), '0.99');
  assert.equal(centsToInput(5), '0.05');
  assert.equal(centsToInput(0), '0');
  assert.equal(centsToInput(null), '');
  assert.equal(centsToInput(-1), '');
});

// The two must agree, or a figure changes just by being displayed and re-saved.
test('every amount survives a round trip through the box', () => {
  for (const cents of [0, 5, 99, 100, 5250, 17500, 17550, 120000, 120005, 999999]) {
    assert.equal(dollarsToCents(centsToInput(cents)), cents, 'round trip failed at ' + cents);
  }
});
