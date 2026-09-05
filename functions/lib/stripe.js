import Stripe from 'stripe';

let client = null;

// Constructed lazily. Building it at module load would need the secret at
// deploy time, and every function importing this file would then require the
// STRIPE_SECRET_KEY binding whether or not it charges anything.
export function getStripe() {
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  }
  return client;
}

export function checkoutLineItems(contract) {
  const c = contract && typeof contract === 'object' ? contract : null;
  if (!c) throw new Error('checkoutLineItems: no contract');

  const cents = c.retainerCents;
  // Checked here rather than trusted, because this number becomes a real
  // charge on a real card.
  if (!Number.isInteger(cents) || cents <= 0) {
    throw new Error('checkoutLineItems: retainerCents must be a positive whole number of cents');
  }
  // Required, not optional. Gating this comparison on Number.isInteger(totalCents)
  // meant a missing or malformed total silently removed the ceiling entirely, and
  // any retainer at all would pass. The total is how we know the retainer is sane,
  // so its absence is itself a refusal.
  if (!Number.isInteger(c.totalCents) || c.totalCents <= 0) {
    throw new Error('checkoutLineItems: totalCents must be a positive whole number of cents');
  }
  if (cents > c.totalCents) {
    throw new Error('checkoutLineItems: retainer exceeds the total');
  }

  return [{
    quantity: 1,
    price_data: {
      currency: 'usd',
      // unit_amount is CENTS. c.retainerCents is already cents. No conversion.
      unit_amount: cents,
      product_data: {
        name: 'Booking retainer — CaptureWithKi',
        description: c.eventDate ? ('Photography on ' + c.eventDate) : 'Photography booking'
      }
    }
  }];
}

// successUrl and cancelUrl are passed in fully formed. The token belongs to
// the caller: building it into a URL inside this file would mean a library
// that handles secrets, and it would need string substitution nobody can test.
export async function createRetainerSession(contract, contractId, successUrl, cancelUrl) {
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    line_items: checkoutLineItems(contract),
    customer_email: contract.clientEmail,
    // Ties the payment back to the contract in the webhook, and again in the
    // Stripe dashboard where she will look when something is confusing.
    client_reference_id: contractId,
    metadata: { contractId: contractId },
    payment_intent_data: { metadata: { contractId: contractId } },
    // Cards only. Apple Pay, Google Pay and Link ride along with 'card' at no
    // extra cost and no extra configuration — do NOT list them separately.
    payment_method_types: ['card'],
    success_url: successUrl,
    cancel_url: cancelUrl
  }, {
    // Stripe deduplicates on this key, so a retried call cannot create a
    // second session and charge the client twice.
    idempotencyKey: 'retainer_' + contractId
  });
  return { id: session.id, url: session.url };
}
