import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

import { validateInquiry } from './lib/validate.js';
import { isBotSubmission, hashIp, checkRateLimit } from './lib/spam.js';
import { ownerEmail, clientEmail, sendEmail } from './lib/email.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const OWNER_EMAIL = 'netherlyk23@gmail.com';

initializeApp();
const db = getFirestore();

// Describes a caught error for storage/logging without ever risking
// `undefined` in the output. Keeps every part that carries information:
// a timed-out fetch() rejects with a DOMException named 'TimeoutError'
// whose message is unhelpful, while sendEmail() throws a plain Error whose
// message ("Resend responded 401: ...") is the only useful part. An earlier
// version returned `err.code || err.name || err.message`, which always
// stopped at `name` ("Error") for the latter and discarded the reason.
function describeError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.code) parts.push(String(err.code));
  if (err.name && err.name !== 'Error') parts.push(String(err.name));
  if (err.message) parts.push(String(err.message));
  return parts.length ? parts.join(' ') : String(err);
}

export const submitInquiry = onCall(
  { region: 'us-west1', secrets: [RESEND_API_KEY], cors: true },
  async (request) => {
    const data = request.data || {};
    const now = Date.now();

    // Bots get a cheerful success and nothing else. An error would just
    // teach them to retry without the tell.
    if (isBotSubmission({ honeypot: data.honeypot, renderedAt: data.renderedAt, now: now })) {
      return { ok: true };
    }

    const check = validateInquiry(data);
    if (!check.valid) {
      throw new HttpsError('invalid-argument', check.error);
    }
    const inquiry = check.value;

    // Only validated, guaranteed-scalar data ever reaches the email
    // templates or Firestore below — never request.data or any raw field.
    // email.js's oneLine() calls String(v) unguarded, so an unvalidated
    // deeply-nested array would reproduce the RangeError that validate.js
    // was fixed to prevent.
    const ip = request.rawRequest && request.rawRequest.ip;
    if (ip) {
      const limit = await checkRateLimit(db, hashIp(ip), now);
      if (!limit.allowed) {
        throw new HttpsError(
          'resource-exhausted',
          'That is a lot of inquiries in a short time. Please try again later, or email netherlyk23@gmail.com directly.'
        );
      }
    } else {
      // Pooling IP-less callers into one bucket would block real clients once
      // five of them submitted in an hour. The honeypot, timing check and
      // validation still apply.
      console.warn('[submitInquiry] no caller IP; skipping rate limit');
    }

    // Record FIRST. A failed email is recoverable; a lost inquiry is not.
    let ref;
    try {
      ref = await db.collection('inquiries').add(Object.assign({}, inquiry, {
        createdAt: FieldValue.serverTimestamp(),
        status: 'new',
        emailToOwnerSent: false,
        emailToClientSent: false
      }));
    } catch (err) {
      throw new HttpsError(
        'internal',
        'Something went wrong saving your inquiry. Please email netherlyk23@gmail.com directly.'
      );
    }

    const key = RESEND_API_KEY.value();
    const errors = [];
    let ownerSent = false;
    let clientSent = false;

    try {
      const m = ownerEmail(inquiry);
      await sendEmail({ apiKey: key, to: OWNER_EMAIL, replyTo: inquiry.email, subject: m.subject, text: m.text });
      ownerSent = true;
      console.log('[submitInquiry] owner email accepted by Resend');
    } catch (err) {
      errors.push('owner: ' + describeError(err));
      console.warn('[submitInquiry] owner email FAILED:', describeError(err));
    }

    try {
      const m = clientEmail(inquiry);
      await sendEmail({ apiKey: key, to: inquiry.email, subject: m.subject, text: m.text });
      clientSent = true;
      console.log('[submitInquiry] client email accepted by Resend');
    } catch (err) {
      errors.push('client: ' + describeError(err));
      console.warn('[submitInquiry] client email FAILED:', describeError(err));
    }

    // One bookkeeping write, recording what actually happened. It must never
    // fail the request: the inquiry is already safely in Firestore, and telling
    // the visitor it failed would have them submit all over again.
    try {
      const patch = { emailToOwnerSent: ownerSent, emailToClientSent: clientSent };
      if (errors.length) patch.emailError = errors.join('; ');
      await ref.update(patch);
    } catch (err) {
      console.warn('[submitInquiry] could not record email status:', describeError(err));
    }

    // The inquiry is safely recorded either way, so the visitor sees success.
    return { ok: true };
  }
);
