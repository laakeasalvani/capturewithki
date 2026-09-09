// Node runtime is pinned in TWO places and they must agree:
//   firebase.json     -> functions[0].runtime  ("nodejs24")
//   functions/package.json -> engines.node     ("24")
// firebase.json wins. Changing only package.json looks like it worked — the
// deploy succeeds and says nothing — but the function stays on the old runtime.
//
// A second trap: the CLI skips redeploying a function whose SOURCE is
// unchanged, so a runtime-only change deploys as "Skipped (No changes
// detected)" and silently does nothing. Verify with `firebase functions:list`
// after any runtime change rather than trusting the deploy output.
import { randomUUID } from 'node:crypto';
// archiver 8 is ESM-native and dropped the old `archiver('zip', opts)`
// factory for named classes. Verified against a real archive before use:
// `new ZipArchive({ store: true })` writes entries as Stored at 0%.
import { ZipArchive } from 'archiver';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

import { validateInquiry } from './lib/validate.js';
import { isBotSubmission, hashIp, checkRateLimit } from './lib/spam.js';
import { ownerEmail, clientEmail, ownerEmailHtml, clientEmailHtml, sendEmail } from './lib/email.js';
import { verifyPassword, galleryOpenable, isValidGalleryId, generatePassword, hashPassword } from './lib/gallery-auth.js';
import { dueGalleries } from './lib/gallery-expiry.js';
import { planZipParts, zipEntryName, zipFileName, sourceFingerprint,
         isClaimStale, partDocId, zipStoragePath } from './lib/gallery-zip.js';
import { dueEscalations, escalationEmail, BACKLOG_MS } from './lib/escalate.js';
import { validateKeaInquiry, keaOwnerEmail, keaClientEmail,
         keaOwnerEmailHtml, keaClientEmailHtml, sendKeaEmail,
         KEA_OWNER_EMAIL } from './lib/kea.js';
import {
  isValidContractId, MAX_PHONE, MAX_EVENT_DATE, renderTemplate, canTransition,
  computeFeeBlock, validateClientDetails, missingRequiredFields, resolvePackagePrice
} from './lib/contracts.js';
import { validatePackage, requiredSpecsFor } from './lib/packages.js';
import { generateToken, hashToken, hashDocument, isValidTokenShape, verifyToken } from './lib/contract-crypto.js';
import {
  readyToSignEmail, signedCopyEmail, formatCents,
  signReminderEmail, neverOpenedAlertEmail, unsignedEscalationEmail
} from './lib/contract-email.js';
import { dueActions } from './lib/chase.js';
import { fakePayAllowed, markContractPaid, getProvider, providerName, paymentsEnabled } from './lib/payments.js';
import { completeFakeSession, retrieveSession as retrieveFakeSession } from './lib/fake-payments.js';
import { getStripe } from './lib/stripe.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const OWNER_EMAIL = 'capturewithki@gmail.com';

// Hard-coded, and never taken from request.data. The sign link emailed below
// is built ONLY from this origin plus the freshly minted token — nothing a
// caller supplies can reach it, which is what makes it safe to drop into an
// href after nothing more than escaping.
const SITE_ORIGIN = 'https://capturewithki.com';

// She is the party offering the contract's terms, and her countersignature is
// stamped into every sent contract by sendContract below — see the comment
// there for why that happens BEFORE hashDocument runs.
const PHOTOGRAPHER_NAME = 'Khiara Salvani';

// e.g. "September 8, 2026" — used only for her countersignature date, which
// is a merge field in the document text, not a stored Firestore Timestamp.
// Every date printed on a contract is in HER timezone, never the server's and
// never the reader's.
//
// Without this the Cloud Function formatted her countersignature in UTC while
// the browser formatted the client's signature in whatever zone the client was
// sitting in. A contract signed at 23:00 Pacific therefore showed the client
// signing on the 8th and the photographer on the 9th — the client appearing to
// sign a day BEFORE the document was offered to them. A client abroad would
// have seen a third answer again.
const BUSINESS_TZ = 'America/Los_Angeles';   // Portland, Oregon

function formatLongDate(d) {
  return d.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: BUSINESS_TZ
  });
}

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
          'That is a lot of inquiries in a short time. Please try again later, or email capturewithki@gmail.com directly.'
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
        'Something went wrong saving your inquiry. Please email capturewithki@gmail.com directly.'
      );
    }

    const key = RESEND_API_KEY.value();
    const errors = [];
    let ownerSent = false;
    let clientSent = false;

    try {
      const m = ownerEmail(inquiry);
      await sendEmail({ apiKey: key, to: OWNER_EMAIL, replyTo: inquiry.email,
                        subject: m.subject, text: m.text, html: ownerEmailHtml(inquiry) });
      ownerSent = true;
      console.log('[submitInquiry] owner email accepted by Resend');
    } catch (err) {
      errors.push('owner: ' + describeError(err));
      console.warn('[submitInquiry] owner email FAILED:', describeError(err));
    }

    // The owner can reword the thank-you from the dashboard. A missing or
    // unreadable document is not an error: clientEmail falls back to the
    // hardcoded wording, so a couple always gets a sensible reply.
    let template = null;
    try {
      const tSnap = await db.collection('settings').doc('email').get();
      if (tSnap.exists) template = tSnap.data();
    } catch (err) {
      console.warn('[submitInquiry] could not read the auto-reply template:', describeError(err));
    }

    try {
      const m = clientEmail(inquiry, template);
      // The banner photo lives on the same settings document as the wording.
      // clientEmailHtml drops the banner if it is missing or fails its check.
      const banner = template && template.clientImage;
      await sendEmail({ apiKey: key, to: inquiry.email, subject: m.subject, text: m.text,
                        html: clientEmailHtml(inquiry, template, banner) });
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

// ---------------------------------------------------------------------------
// Kea Web Creations contact form
//
// A different website belonging to the same owner: a static single-file site
// on GitHub Pages with nowhere safe to keep a Resend key. It lives here only
// because this project already has Blaze billing and the RESEND_API_KEY
// secret; see lib/kea.js for what is and is not shared.
//
// onRequest, not onCall: submitInquiry is called from a page that already
// loads the Firebase JS SDK, but the Kea site is one hand-written HTML file
// with no build step and no SDK. A plain HTTP endpoint lets it use fetch().
// That also means CORS is enforced by an explicit origin list rather than by
// the SDK, and that this handler must do its own method and JSON checks.
// ---------------------------------------------------------------------------

const KEA_ORIGINS = [
  // The live site. Both spellings are listed because an origin is matched
  // exactly: keawebcreations.com and www.keawebcreations.com are different
  // origins to a browser even when one redirects to the other, and a visitor
  // who lands on the www form would otherwise be refused.
  'https://keawebcreations.com',
  'https://www.keawebcreations.com',
  // Kept: github.io still serves the site and redirects here, so a stale link
  // or a cached page can still be the origin of a real submission.
  'https://laakeasalvani.github.io',
  // Any FURTHER domain must be added here too. An origin missing from this
  // list fails in the browser with a CORS error and never reaches the code
  // below, so it cannot be diagnosed from the function logs — it looks like
  // the form silently doing nothing.
  'http://localhost:4321',
  'http://127.0.0.1:4321',
  'http://localhost:8000',
  'http://127.0.0.1:8000'
];

export const keaInquiry = onRequest(
  { region: 'us-west1', secrets: [RESEND_API_KEY], cors: KEA_ORIGINS },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed.' });
      return;
    }

    // express parses a JSON body for us, but a request with the wrong
    // content-type arrives as a Buffer or a string and would sail past a
    // plain truthiness check straight into the validator.
    const data = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? req.body : {};
    const now = Date.now();

    // Bots get a cheerful success and nothing else. An error would just teach
    // them to retry without the tell.
    if (isBotSubmission({ honeypot: data.honeypot, renderedAt: data.renderedAt, now: now })) {
      res.json({ ok: true });
      return;
    }

    const check = validateKeaInquiry(data);
    if (!check.valid) {
      res.status(400).json({ ok: false, error: check.error });
      return;
    }
    const inquiry = check.value;

    // Only validated, guaranteed-scalar data ever reaches the templates or
    // Firestore below — never req.body or any raw field.
    const ip = req.ip;
    if (ip) {
      // Prefixed so Kea and CaptureWithKi never share a bucket: without it,
      // one visitor filling in both forms would spend a single allowance.
      const limit = await checkRateLimit(db, hashIp('kea:' + ip), now);
      if (!limit.allowed) {
        res.status(429).json({
          ok: false,
          error: 'That is a lot of messages in a short time. Please try again later, or email ' +
                 KEA_OWNER_EMAIL + ' directly.'
        });
        return;
      }
    } else {
      // Pooling IP-less callers into one bucket would block real visitors once
      // five of them submitted in an hour. The honeypot, timing check and
      // validation still apply.
      console.warn('[keaInquiry] no caller IP; skipping rate limit');
    }

    // Record FIRST. A failed email is recoverable; a lost enquiry is not.
    // Separate collection from `inquiries`, which is CaptureWithKi's and is
    // read by that site's admin dashboard.
    let ref;
    try {
      ref = await db.collection('keaInquiries').add(Object.assign({}, inquiry, {
        createdAt: FieldValue.serverTimestamp(),
        status: 'new',
        emailToOwnerSent: false,
        emailToClientSent: false
      }));
    } catch (err) {
      console.error('[keaInquiry] could not save enquiry:', describeError(err));
      res.status(500).json({
        ok: false,
        error: 'Something went wrong saving your message. Please email ' +
               KEA_OWNER_EMAIL + ' directly.'
      });
      return;
    }

    const key = RESEND_API_KEY.value();
    const errors = [];
    let ownerSent = false;
    let clientSent = false;

    try {
      const m = keaOwnerEmail(inquiry);
      await sendKeaEmail({ apiKey: key, to: KEA_OWNER_EMAIL, replyTo: inquiry.email,
                           subject: m.subject, text: m.text, html: keaOwnerEmailHtml(inquiry) });
      ownerSent = true;
      console.log('[keaInquiry] owner email accepted by Resend');
    } catch (err) {
      errors.push('owner: ' + describeError(err));
      console.warn('[keaInquiry] owner email FAILED:', describeError(err));
    }

    try {
      const m = keaClientEmail(inquiry);
      await sendKeaEmail({ apiKey: key, to: inquiry.email,
                           subject: m.subject, text: m.text, html: keaClientEmailHtml(inquiry) });
      clientSent = true;
      console.log('[keaInquiry] auto-reply accepted by Resend');
    } catch (err) {
      errors.push('client: ' + describeError(err));
      console.warn('[keaInquiry] auto-reply FAILED:', describeError(err));
    }

    // One bookkeeping write, recording what actually happened. It must never
    // fail the request: the enquiry is already safely in Firestore, and
    // telling the visitor it failed would have them submit all over again.
    try {
      const patch = { emailToOwnerSent: ownerSent, emailToClientSent: clientSent };
      if (errors.length) patch.emailError = errors.join('; ');
      await ref.update(patch);
    } catch (err) {
      console.warn('[keaInquiry] could not record email status:', describeError(err));
    }

    // The enquiry is safely recorded either way, so the visitor sees success.
    res.json({ ok: true });
  }
);

// ---------------------------------------------------------------------------
// Client galleries
//
// The couple sends a gallery id and a password. Everything that decides
// whether they get in happens HERE, on the server — the page never sees the
// hash, never learns whether an id is real, and never decides anything itself.
//
// On success this mints a Firebase custom token carrying the claim
// `gal: <galleryId>`. That token IS the "temporary login": Firestore and
// Storage rules refuse the gallery's photos to anyone without it, and a token
// for one gallery grants nothing in any other.
// ---------------------------------------------------------------------------

// Every failure returns this same message. Saying "expired" or "no such
// gallery" instead of "wrong password" would confirm to someone probing ids
// that a gallery is real, which is exactly what probing is trying to learn.
const GALLERY_DENIED = 'That link or password is not right. Check with Khiara.';

export const openGallery = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    const data = request.data || {};
    const galleryId = typeof data.galleryId === 'string' ? data.galleryId.trim() : '';
    // Normalised here as well as in the page: generated passwords use only the
    // uppercase alphabet, so folding case costs nothing and means a client that
    // forgets to do it still works.
    const password = typeof data.password === 'string' ? data.password.trim().toUpperCase() : '';

    // Checked before touching Firestore: the id becomes a document path and a
    // token claim, so its shape is not negotiable.
    if (!isValidGalleryId(galleryId) || !password) {
      throw new HttpsError('permission-denied', GALLERY_DENIED);
    }

    // No rate limit here, by the owner's decision after it locked her out of
    // her own gallery: five tries an hour counted EVERY attempt, so once the
    // count was spent even the correct password was refused, and the lockout
    // hid the real fault underneath it.
    //
    // The trade is real and was stated: nothing now slows an automated attempt
    // to guess a gallery password. What still stands in the way is the password
    // itself — 8 characters from a 31-letter alphabet is about 8.5e11
    // combinations — and the gallery id, which is 20 random characters and must
    // also be known. Restoring a limit is a few lines here if abuse ever shows
    // up in the logs; counting only FAILED attempts would keep a correct
    // password working while still slowing a guesser.
    const now = Date.now();

    let snap;
    try {
      snap = await db.collection('galleries').doc(galleryId).get();
    } catch (err) {
      console.warn('[openGallery] could not read gallery:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    const gallery = snap.exists ? snap.data() : null;

    // The password is verified even when the gallery is missing or closed, so
    // the time taken does not reveal which galleries exist.
    const salt = (gallery && gallery.passwordSalt) || 'absent-gallery-salt';
    const hash = (gallery && gallery.passwordHash) || 'f'.repeat(64);
    const passwordOk = await verifyPassword(password, salt, hash);
    const openable = galleryOpenable(gallery, now);

    if (!passwordOk || !openable.ok) {
      console.log('[openGallery] refused:', galleryId, 'password:', passwordOk, 'state:', openable.reason);
      throw new HttpsError('permission-denied', GALLERY_DENIED);
    }

    // One Auth identity per gallery rather than one per visitor. Both partners
    // share the same password, so they are the same principal — and a fresh
    // uid per visit would fill her Firebase Auth user list with thousands of
    // one-off accounts. An `admins/{uid}` document never exists for these, so
    // they can never be mistaken for her.
    let token;
    try {
      token = await getAuth().createCustomToken('gallery_' + galleryId, { gal: galleryId });
    } catch (err) {
      console.warn('[openGallery] could not mint token:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    console.log('[openGallery] opened:', galleryId);
    return {
      token: token,
      title: typeof gallery.title === 'string' ? gallery.title : '',
      expiresAt: gallery.expiresAt && gallery.expiresAt.toMillis
        ? gallery.expiresAt.toMillis()
        : null
    };
  }
);

// Creating a gallery has to happen here, not in the browser: the password is
// hashed with scrypt, which the browser cannot do compatibly, and the plaintext
// must never be written to Firestore. It is returned exactly once, to her.
async function requireAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('permission-denied', 'Sign in first.');
  let snap;
  try {
    snap = await db.collection('admins').doc(uid).get();
  } catch (err) {
    console.warn('[admin] could not check admin status:', describeError(err));
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
  if (!snap.exists) throw new HttpsError('permission-denied', 'Not allowed.');
  return uid;
}

export const createGallery = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);

    const raw = request.data && request.data.title;
    const title = (typeof raw === 'string' ? raw : '').trim().slice(0, 120);
    if (!title) throw new HttpsError('invalid-argument', 'Give the gallery a name.');

    const password = generatePassword();
    const { hash, salt } = await hashPassword(password);

    const ref = await db.collection('galleries').add({
      title: title,
      passwordHash: hash,
      passwordSalt: salt,
      status: 'draft',
      createdAt: FieldValue.serverTimestamp(),
      sentAt: null,
      expiresAt: null,
      photoCount: 0,
      coverThumb: null
    });

    // The only time the plaintext exists outside her screen.
    return { galleryId: ref.id, password: password };
  }
);

export const regenerateGalleryPassword = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);

    const galleryId = typeof (request.data && request.data.galleryId) === 'string'
      ? request.data.galleryId.trim() : '';
    if (!isValidGalleryId(galleryId)) {
      throw new HttpsError('invalid-argument', 'Unknown gallery.');
    }

    const ref = db.collection('galleries').doc(galleryId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Unknown gallery.');

    const password = generatePassword();
    const { hash, salt } = await hashPassword(password);
    await ref.update({ passwordHash: hash, passwordSalt: salt });

    // Anyone already inside keeps their session until it lapses. Say so rather
    // than implying the old password is instantly dead everywhere.
    return { password: password };
  }
);

// ---------------------------------------------------------------------------
// Contracts
//
// createContract drafts a contract from an inquiry (or from scratch) for
// Khiara's own dashboard.
// ---------------------------------------------------------------------------

export const createContract = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);

    const d = request.data || {};

    // The package decides which of the three contracts this client signs and
    // what its blanks say. Loaded and validated BEFORE anything else: a
    // package missing a spec would otherwise produce a contract with a
    // visible blank in it, and refusing here lets her fix the package
    // instead of discovering the hole at send time.
    const pkgSnap = await db.collection('packages').doc(String(d.packageId || '')).get();
    if (!pkgSnap.exists) throw new HttpsError('not-found', 'No such package.');
    const pkg = pkgSnap.data();
    const check = validatePackage(pkg);
    if (!check.ok) {
      throw new HttpsError('failed-precondition',
        'That package is not ready to send: ' + check.errors.join(' '));
    }

    // validatePackage checks the PACKAGE, not the client. Without this, an empty
    // clientName renders as an empty STRING rather than an unfilled placeholder,
    // so the send-time guard never fires and a blank name ships inside a signed
    // legal document. A malformed clientEmail is worse: Resend accepts it, the
    // contract is marked sent, and it silently never arrives.
    const clientCheck = validateClientDetails(d);
    if (!clientCheck.ok) {
      throw new HttpsError('invalid-argument', clientCheck.errors.join(' '));
    }

    // The package price is a default she can override on this booking. Her
    // weddings are advertised "starting from", so the catalogue figure is a
    // floor, not the price. resolvePackagePrice does the checking, in lib/
    // where it can be tested — this number ends up in a signed document.
    const price = resolvePackagePrice(pkg.priceCents, d.packagePriceCents);
    if (!price.ok) throw new HttpsError('invalid-argument', price.error);

    // Retainer is 30% of the PACKAGE PRICE only, never the total — travel is
    // billed but does not inflate the deposit. See computeFeeBlock's own
    // comment in lib/contracts.js.
    const fees = computeFeeBlock({
      packagePriceCents: price.cents,
      travelFeesCents: Number.isInteger(d.travelFeesCents) ? d.travelFeesCents : 0
    });
    if (fees.totalCents <= 0) throw new HttpsError('invalid-argument', 'That total is not valid.');

    const doc = {
      status: 'draft',
      inquiryId: typeof d.inquiryId === 'string' && d.inquiryId ? d.inquiryId : null,
      packageId: String(d.packageId),
      templateKey: pkg.templateKey,
      packageLabel: pkg.label,
      specs: pkg.specs,
      packagePriceCents: fees.packagePriceCents,
      travelFeesCents: fees.travelFeesCents,
      retainerCents: fees.retainerCents,
      totalCents: fees.totalCents,
      balanceCents: fees.balanceCents,
      // clientName already means Client 1 and is read in 21 places across
      // openContract, sign.js, the email builders and the dashboard — kept
      // exactly as it is rather than renamed. client2Name is new and optional;
      // sendContract renders it as "Not applicable" when empty.
      clientName: typeof d.clientName === 'string' ? d.clientName.trim().slice(0, 200) : '',
      client2Name: typeof d.client2Name === 'string' ? d.client2Name.trim().slice(0, 200) : '',
      clientEmail: typeof d.clientEmail === 'string' ? d.clientEmail.trim().slice(0, 254) : '',
      clientPhone: typeof d.clientPhone === 'string' ? d.clientPhone.trim().slice(0, MAX_PHONE) : '',
      eventDate: typeof d.eventDate === 'string' ? d.eventDate.trim().slice(0, MAX_EVENT_DATE) : '',
      eventLocation: typeof d.eventLocation === 'string' ? d.eventLocation.trim().slice(0, 300) : '',
      startTime: typeof d.startTime === 'string' ? d.startTime.trim().slice(0, MAX_EVENT_DATE) : '',
      endTime: typeof d.endTime === 'string' ? d.endTime.trim().slice(0, MAX_EVENT_DATE) : '',
      balanceDueDate: typeof d.balanceDueDate === 'string' ? d.balanceDueDate.trim().slice(0, MAX_EVENT_DATE) : '',
      openCount: 0,
      signReminderCount: 0,
      payReminderCount: 0,
      createdAt: FieldValue.serverTimestamp()
    };

    let ref;
    try {
      ref = await db.collection('contracts').add(doc);
    } catch (err) {
      console.warn('[createContract] could not write:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    try {
      await ref.collection('audit').add({
        event: 'created', at: FieldValue.serverTimestamp(), by: request.auth.uid
      });
    } catch (err) {
      // Logged, not thrown. The contract IS created by this point. Throwing would
      // tell her it failed, and her retry would create a SECOND draft for the same
      // booking. A missing audit row on CREATION is recoverable — the document's own
      // timestamps survive. A duplicate contract is a conversation with a client.
      //
      // This leniency is specific to creation. Do NOT copy it to signing, where the
      // audit row is the legal evidence.
      console.warn('[createContract] contract created but audit row failed:', describeError(err));
    }

    console.log('[createContract] drafted:', ref.id);
    return { contractId: ref.id };
  }
);

// sendContract freezes the contract's exact wording, hashes it, mints a
// signing token, and emails the client a link. From the moment this returns,
// the live template is irrelevant to this contract: editing a clause later
// cannot change what this client agreed to, and documentHash is what proves
// the signed version was not swapped.
export const sendContract = onCall(
  { region: 'us-west1', cors: true, secrets: [RESEND_API_KEY] },
  async (request) => {
    await requireAdmin(request);

    const d = request.data || {};
    const contractId = typeof d.contractId === 'string' ? d.contractId.trim() : '';
    if (!isValidContractId(contractId)) {
      throw new HttpsError('invalid-argument', 'That contract id is not valid.');
    }

    const ref = db.collection('contracts').doc(contractId);
    let snap;
    try {
      snap = await ref.get();
    } catch (err) {
      console.warn('[sendContract] could not read contract:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!snap.exists) throw new HttpsError('not-found', 'No such contract.');
    const contract = snap.data();

    if (!canTransition(contract.status, 'sent')) {
      throw new HttpsError('failed-precondition', 'That contract cannot be sent from its current state.');
    }

    // The PACKAGE decides which contract this client signs, not a
    // caller-supplied id — templateKey was fixed by createContract and
    // validated then against pkg.specs, so there is nothing left for a
    // caller to choose here.
    const templateKey = typeof contract.templateKey === 'string' ? contract.templateKey : '';
    let tplSnap;
    try {
      tplSnap = await db.collection('contractTemplates').doc(templateKey).get();
    } catch (err) {
      console.warn('[sendContract] could not read template:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!tplSnap.exists) throw new HttpsError('not-found', 'No such contract template.');
    const tpl = tplSnap.data();

    // A placeholder contract reaching a real client would be worse than no system at
    // all — she would believe she had an agreement and have nothing. The templates are
    // hand-loaded with isDraft:true and flipped to false only once Khiara has read the
    // exact text (see docs/superpowers/2026-09-08-contracts-handover.md), and this is
    // what keeps a still-unread one unsendable.
    if (tpl.isDraft === true) {
      throw new HttpsError('failed-precondition',
        'That contract template is still marked a draft. Replace it with the real agreement first.');
    }

    // validatePackage runs at CREATE time. templateKey and specs are stored
    // separately and this feature is hand-loaded into Firestore, so re-check the
    // pairing here. String(undefined) is "undefined" — not blank, not an unfilled
    // placeholder — so neither existing guard would catch it, and the client would
    // sign "...includes: undefined hours of coverage." Checked before the fields
    // object below is built, so a specs object that is missing entirely cannot
    // throw on contract.specs.packageName either.
    for (const specName of requiredSpecsFor(contract.templateKey)) {
      const v = contract.specs ? contract.specs[specName] : undefined;
      if (v === undefined || v === null || String(v).trim() === '') {
        throw new HttpsError('failed-precondition',
          'This contract is missing a package detail: ' + specName + '. Check the package.');
      }
    }

    // Stamped in BEFORE the snapshot is hashed, so her countersignature is covered
    // by the same tamper-evidence as the client's. She is the party offering these
    // terms; the client accepts them, so the document goes out already countersigned.
    const sentDate = new Date();
    const fields = {
      client_1_name: contract.clientName,
      client_2_name: contract.client2Name || 'Not applicable',
      client_email: contract.clientEmail,
      client_phone: contract.clientPhone || 'Not given',
      event_date: contract.eventDate,
      event_location: contract.eventLocation || 'Not given',
      start_time: contract.startTime || 'To be confirmed',
      end_time: contract.endTime || 'To be confirmed',
      package_name: contract.specs.packageName,
      package_price: formatCents(contract.packagePriceCents),
      retainer: formatCents(contract.retainerCents),
      travel_fees: formatCents(contract.travelFeesCents),
      remaining_balance: formatCents(contract.balanceCents),
      balance_due_date: contract.balanceDueDate,
      photographer_name: PHOTOGRAPHER_NAME,
      photographer_signed_date: formatLongDate(sentDate)
    };
    // Template-specific specs. Portrait has no hours; wedding and elopement
    // have no portrait specs — passing an unused field is harmless
    // (renderTemplate only substitutes what the template asks for), but a
    // MISSING one would leave that template's own placeholder unfilled.
    if (contract.templateKey === 'portrait') {
      fields.session_minutes = String(contract.specs.sessionMinutes);
      fields.locations = String(contract.specs.locations);
      fields.outfit_changes = String(contract.specs.outfitChanges);
      fields.edited_images = String(contract.specs.editedImages);
    } else {
      fields.hours = String(contract.specs.hours);
      fields.edited_images = String(contract.specs.editedImages);
    }

    // Checked before rendering, because after rendering an empty value is
    // indistinguishable from text that was meant to be short.
    const blank = missingRequiredFields(fields);
    if (blank.length) {
      throw new HttpsError('failed-precondition',
        'This contract is missing: ' + blank.join(', ') + '. Fill those in before sending.');
    }

    // Rendered ONCE, here, and stored. From this moment the live template is
    // irrelevant to this contract: editing a clause later cannot change what
    // this client agreed to, and the hash is what proves it.
    const documentSnapshot = renderTemplate(tpl.html, fields);

    // A placeholder the template asked for and the data could not fill would
    // ship a contract with a visible hole in it. Refuse instead. This also
    // catches a template/spec mismatch — e.g. a portrait package pointed at
    // the wedding template would leave {{hours}} unfilled.
    const unfilled = documentSnapshot.match(/\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/gi);
    if (unfilled) {
      throw new HttpsError('failed-precondition',
        'The template has placeholders nothing filled in: ' + unfilled.join(', '));
    }

    const token = generateToken();
    // Built ONLY from the hard-coded origin above and the token just minted —
    // never from request.data or anything else caller-supplied.
    const signUrl = SITE_ORIGIN + '/sign/?t=' + token;

    try {
      await ref.update({
        status: 'sent',
        templateVersion: tpl.version || 1,
        documentSnapshot: documentSnapshot,
        documentHash: hashDocument(documentSnapshot),
        // Only the hash. The token itself exists in exactly one place after
        // this line returns: the client's email.
        tokenHash: hashToken(token),
        sentAt: FieldValue.serverTimestamp()
      });
    } catch (err) {
      console.warn('[sendContract] could not update:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    const mail = readyToSignEmail({
      clientName: contract.clientName,
      signUrl: signUrl,
      eventDate: contract.eventDate,
      totalCents: contract.totalCents,
      retainerCents: contract.retainerCents
    });
    const key = RESEND_API_KEY.value();
    // Recorded first, then sent — the ordering submitInquiry uses, because a lost
    // record is worse than a failed email.
    //
    // But a contract is not an inquiry. A contract marked 'sent' whose email never
    // left is not merely un-actioned, it is UNREACHABLE: canTransition allows only
    // sent -> opened|void, so 'sent' -> 'sent' is refused and there is no path back
    // through the dashboard. So a failed send undoes the update rather than leaving
    // her with a contract nobody can send and nobody can fix.
    try {
      await sendEmail({
        apiKey: key,
        to: contract.clientEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html
      });
    } catch (err) {
      console.warn('[sendContract] email failed, rolling back to draft:', describeError(err));
      // Whether the rollback itself worked decides which message she gets. The
      // throw below used to sit outside this catch and always said "It is still
      // a draft — please try sending again", which was emitted precisely when
      // the rollback had FAILED and it was NOT a draft: the one case where
      // trying again is refused (canTransition has no sent -> sent) and where
      // the advice sent her round a loop instead of telling her the truth.
      let stranded = false;
      try {
        await ref.update({
          status: 'draft',
          tokenHash: FieldValue.delete(),
          sentAt: FieldValue.delete(),
          documentSnapshot: FieldValue.delete(),
          documentHash: FieldValue.delete(),
          templateVersion: FieldValue.delete()
        });
      } catch (rollbackErr) {
        // Deliberately console.error and deliberately greppable. If this line ever
        // appears, a contract IS stranded in 'sent' with no email behind it, and a
        // human has to free it by hand. It is the only remaining route to that state.
        stranded = true;
        console.error('[sendContract] STRANDED: send failed AND rollback failed for',
          contractId, describeError(rollbackErr));
      }
      if (stranded) {
        // Names the id because a human has to go find this exact document in the
        // Firebase console and set its status back to 'draft' by hand. Safe to
        // interpolate: contractId passed isValidContractId above, and only an
        // authenticated admin ever reads this message.
        throw new HttpsError('internal',
          'The contract could not be emailed, AND it could not be put back to a draft. ' +
          'Contract ' + contractId + ' is stuck as "sent" with no email behind it — ' +
          'sending it again will be refused. It has to be fixed by hand before it can go out.');
      }
      throw new HttpsError('unavailable',
        'The contract could not be emailed. It is still a draft — please try sending again.');
    }

    try {
      await ref.collection('audit').add({
        event: 'sent', at: FieldValue.serverTimestamp(), by: request.auth.uid
      });
    } catch (err) {
      // Logged, not thrown. The contract IS sent by this point — the email is
      // away and status already updated. Throwing here would tell her the send
      // failed when it did not, and a retry would mint and mail a SECOND token
      // for the same contract.
      console.warn('[sendContract] contract sent but audit row failed:', describeError(err));
    }

    console.log('[sendContract] sent:', contractId);
    // Returned so she can copy the link and text it to them as well. Resend
    // returning 200 means queued, not delivered — this project already learned
    // that the hard way.
    return { ok: true, signUrl: signUrl };
  }
);

// openContract is the first client-facing (unauthenticated) function in this
// feature. It is what runs when the client clicks the link in the email
// sendContract sent them. Modelled directly on openGallery above — same
// uniform-denial message, same deliberate absence of a rate limit — read
// openGallery's comments first if either choice looks wrong here.

// One message for every refusal. Saying "expired" rather than "not found"
// confirms a token is real, which is exactly what a probing attempt is
// looking for. Same reasoning as GALLERY_DENIED.
const CONTRACT_DENIED = 'That link is not valid. Please check the email again.';

export const openContract = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    const d = request.data || {};
    const token = typeof d.token === 'string' ? d.token.trim() : '';

    // Checked before touching Firestore.
    if (!isValidTokenShape(token)) throw new HttpsError('permission-denied', CONTRACT_DENIED);

    // No rate limit here, deliberately, and for a different reason than the
    // galleries. A gallery password is 8 characters from a 31-letter alphabet;
    // this token is 256 bits. Guessing is not a threat, and the limiter that
    // was removed from openGallery had already refused a correct password once.
    const hash = hashToken(token);
    let found = null;
    try {
      const q = await db.collection('contracts').where('tokenHash', '==', hash).limit(1).get();
      if (!q.empty) found = q.docs[0];
    } catch (err) {
      console.warn('[openContract] lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    if (!found) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    const contract = found.data();

    // Verified again in constant time even though the query already matched,
    // so this path does not depend on Firestore's comparison semantics.
    if (!verifyToken(token, contract.tokenHash)) {
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }
    if (['void', 'cancelled'].indexOf(contract.status) !== -1) {
      console.log('[openContract] refused, state:', contract.status);
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }

    // Stamped before returning. This is the ONLY signal that survives a
    // spam-filed email — escalateUnreadInquiries exists because no signal the
    // sending side produces can detect that failure.
    const update = { openCount: (contract.openCount || 0) + 1 };
    if (!contract.firstOpenedAt) update.firstOpenedAt = FieldValue.serverTimestamp();
    if (contract.status === 'sent') update.status = 'opened';
    try {
      await found.ref.update(update);
      await found.ref.collection('audit').add({
        event: 'opened', at: FieldValue.serverTimestamp()
      });
    } catch (err) {
      // Logged, not thrown. Failing to record the open must never stop a
      // client reading the agreement they were sent.
      console.warn('[openContract] could not stamp open:', describeError(err));
    }

    console.log('[openContract] opened:', found.id);
    return {
      contractId: found.id,
      clientName: contract.clientName,
      documentSnapshot: contract.documentSnapshot,
      totalCents: contract.totalCents,
      retainerCents: contract.retainerCents,
      eventDate: contract.eventDate,
      status: contract.status,
      signedAt: contract.signedAt ? contract.signedAt.toMillis() : null,
      // Millis, exactly like signedAt above. markRetainerReceived sets this
      // field and deliberately leaves status at 'signed', so without it her
      // dashboard said "Booked — date held" while this client's page went on
      // saying the date would be held once the retainer reached Khiara —
      // forever, including after it had.
      retainerReceivedAt: contract.retainerReceivedAt
        ? contract.retainerReceivedAt.toMillis() : null,
      // Who actually typed their name. The signed page IS the client's
      // permanent record (signedCopyEmail calls it that), and a record that
      // does not say who signed it is not much of one. Read off the signature
      // block signContract wrote; null until then.
      typedName: contract.signature ? contract.signature.typedName : null,
      // Needed so the page can hide the Client 2 signature block entirely when
      // there is no second client. Leaving it visible on a signed agreement
      // shows an empty signature line under a named heading, which reads as a
      // party who failed to sign rather than one who was never required to.
      client2Name: contract.client2Name || '',
      // Her half of the signature record. It used to live inside the document
      // as merge fields; the signature block is now a separate panel below the
      // form, so the page needs these directly. She countersigns at send time,
      // which is why sentAt is the date shown against her name.
      photographerName: PHOTOGRAPHER_NAME,
      photographerSignedAt: contract.sentAt ? contract.sentAt.toMillis() : null,
      // Client 2's half. Both partners sign on this one link in turn, so the
      // page has to know which of them it is still waiting for.
      signed2At: contract.signed2At ? contract.signed2At.toMillis() : null,
      typedName2: contract.signature2 ? contract.signature2.typedName : null,
      // null once nobody else has to sign. Note this is about SIGNATURES, not
      // status: a two-signer contract sits at 'opened' with one signature on
      // it, because one of two is not a signed contract.
      awaitingSigner: !contract.signedAt
        ? 'client1'
        : ((contract.client2Name && String(contract.client2Name).trim() && !contract.signed2At)
            ? 'client2' : null),
      // Signed, and no payment recorded. This is what puts a pay button on the
      // page after an abandoned checkout — the client's only remaining route
      // back to Stripe, since no reminder email can carry a signing link.
      //
      // Read from the document, never from the ?paid=1 hint on the URL. No
      // session is created here: openContract runs on every page load, and the
      // session is minted by startRetainerPayment on an actual click.
      //
      // Forced false while payments are off, on top of the status check:
      // with no provider configured, no session can ever be minted for any
      // contract, so this must never invite a client to click a pay button
      // that leads nowhere.
      needsPayment: paymentsEnabled() && contract.status === 'signed' && !contract.paidAt,
      // The page cannot read PAYMENT_PROVIDER itself — that is a server env
      // var — so this is how it learns whether to mention payment at all.
      paymentsEnabled: paymentsEnabled()
    };
  }
);

// signContract records the client's electronic signature: the typed name and
// consent that show intent to sign, plus the server-observed IP and user
// agent that attribute the signature to whoever held the link. Modelled
// directly on openContract above — same token-authentication shape, same
// uniform-denial rule — read that function's comments first if either choice
// here looks wrong.
// STRIPE_SECRET_KEY is bound even though the fake provider never needs it:
// getProvider() resolves at call time, and a function that does not DECLARE a
// secret never receives it. Without this, switching PAYMENT_PROVIDER to stripe
// would make every real client sign successfully and silently never reach a
// payment page, because the resulting throw is swallowed below by design.
export const signContract = onCall(
  { region: 'us-west1', cors: true, secrets: [RESEND_API_KEY, STRIPE_SECRET_KEY] },
  async (request) => {
    const d = request.data || {};
    const token = typeof d.token === 'string' ? d.token.trim() : '';
    const typedName = typeof d.typedName === 'string' ? d.typedName.trim().slice(0, 200) : '';
    const consent = d.consent === true;

    // Checked before touching Firestore, same as openContract.
    if (!isValidTokenShape(token)) throw new HttpsError('permission-denied', CONTRACT_DENIED);

    // These get their own specific messages rather than CONTRACT_DENIED,
    // because this point is reachable only by someone who already holds a
    // token of the right shape — unlike the lookup below, refusing here
    // does not confirm or deny that any particular token is real.
    if (!typedName) throw new HttpsError('invalid-argument', 'Please type your full legal name.');
    if (!consent) {
      throw new HttpsError('invalid-argument', 'Please agree to sign electronically first.');
    }

    const hash = hashToken(token);
    let found = null;
    try {
      const q = await db.collection('contracts').where('tokenHash', '==', hash).limit(1).get();
      if (!q.empty) found = q.docs[0];
    } catch (err) {
      console.warn('[signContract] lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    if (!found) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    const ref = found.ref;
    const contract = found.data();

    // Verified again in constant time even though the query already matched,
    // same reasoning as openContract.
    if (!verifyToken(token, contract.tokenHash)) {
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }

    // Idempotent. A replayed token, a double-tap, or a client who hits back
    // and signs again must never produce a second signature record. No new
    // checkout session is created here either — the fake provider has no
    // idempotency key, so calling it again on a replay would mint a second,
    // orphaned session. checkoutUrl is null; a client who lands back on this
    // path after already being redirected once has no need of a second one.
    // Two signers, one link. Both partners sign on the same page in turn,
    // which is how a couple actually does this — sitting together on one
    // phone. The trade is weaker attribution than two separate links would
    // give: on one link, nothing proves the second name was typed by the
    // second person. Each signature therefore captures its OWN ip, user agent
    // and server timestamp, so two signings made at different moments or on
    // different devices are at least distinguishable in the record.
    const needsTwo = !!(contract.client2Name && String(contract.client2Name).trim());
    const c1Done = !!contract.signedAt;
    const c2Done = !!contract.signed2At;

    // Fully signed already. Idempotent for the same reasons as before: a
    // replayed token, a double-tap, or a client who hits back must never
    // produce a second signature or a second checkout session.
    if (c1Done && (!needsTwo || c2Done)) {
      return {
        ok: true, signedAt: contract.signedAt.toMillis(),
        checkoutUrl: null, complete: true, awaitingSigner: null
      };
    }

    // Whose turn. Order is enforced rather than chosen by the caller: the
    // page only offers Client 2's form once Client 1 has signed, so a request
    // arriving in the other order came from something other than the page.
    const slot = c1Done ? 'client2' : 'client1';
    const willComplete = slot === 'client2' || !needsTwo;

    // Only checked when this signature actually completes the agreement.
    // Client 1 signing a two-signer contract leaves the status alone, because
    // one of two signatures is not a signed contract.
    if (willComplete && !canTransition(contract.status, 'signed')) {
      throw new HttpsError('failed-precondition', CONTRACT_DENIED);
    }

    // The IP comes from the request, never from the browser. Everything a
    // client can set is evidence about them, not evidence they supply.
    const raw = request.rawRequest || {};
    const forwardedHeader = (raw.headers && raw.headers['x-forwarded-for']) || '';
    const ip = String(forwardedHeader).split(',')[0].trim() || raw.ip || 'unknown';
    const userAgent = String((raw.headers && raw.headers['user-agent']) || '').slice(0, 500);

    // Signature and audit row commit together or not at all — the OPPOSITE
    // of createContract's choice to swallow an audit failure. There, a
    // missing audit row on creation is recoverable because the document's
    // own timestamps survive; a retry only risks a duplicate draft. Here the
    // idempotency check above makes a lost audit row unrecoverable: once
    // signedAt is set, every future attempt sees it and returns early
    // without ever writing the audit row again. A single batch removes the
    // possibility of the two writes splitting.
    const auditRef = ref.collection('audit').doc();
    const batch = db.batch();
    // Every timestamp here is a serverTimestamp and ONLY EVER a
    // serverTimestamp — never a JS Date or a number. This project has already
    // been bitten once by trusting a client clock, in the spam check that
    // would have binned real clients whose phone ran fast; the stakes here are
    // a contested contract date. openContract calls .toMillis() on these
    // fields with no guard that they really are Timestamps — this function is
    // what creates them, so that assumption must always hold.
    const signatureRecord = {
      typedName: typedName,
      ip: ip,
      userAgent: userAgent,
      // Copied, not referenced, so the signature record stands alone even
      // if every other field on the contract were altered later.
      documentHash: contract.documentHash,
      consentGiven: true,
      consentTextVersion: 'esign-disclosure-v1'
    };

    const contractUpdate = slot === 'client2'
      ? { signed2At: FieldValue.serverTimestamp(), signature2: signatureRecord, status: 'signed' }
      : Object.assign(
          { signedAt: FieldValue.serverTimestamp(), signature: signatureRecord },
          // Status moves to 'signed' only when nobody else still has to sign.
          needsTwo ? {} : { status: 'signed' }
        );

    batch.update(ref, contractUpdate);
    batch.set(auditRef, {
      event: slot === 'client2' ? 'signed-client2' : 'signed',
      at: FieldValue.serverTimestamp(),
      typedName: typedName,
      ip: ip,
      documentHash: contract.documentHash
    });

    try {
      await batch.commit();
    } catch (err) {
      console.warn('[signContract] could not record signature:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    // AFTER the signature is safely recorded, never before. If the payment
    // provider is unreachable, the client has still signed and that fact
    // must survive — a failure here costs a redirect, not an agreement.
    const back = SITE_ORIGIN + '/sign/?t=' + token;
    let checkoutUrl = null;
    // Payments off is the normal state today — Khiara has no processor
    // configured — not a failure that happens to look like one. No session
    // is created and checkoutUrl stays null; nothing here is logged as a
    // warning, because nothing has gone wrong.
    // willComplete as well as paymentsEnabled: there is nothing to pay for
    // while one of two signatures is still outstanding, and minting a session
    // now would hand Client 1 a payment page for an agreement that is not yet
    // an agreement.
    if (willComplete && paymentsEnabled()) {
      try {
        // Dispatched through the seam, so this line is identical whether the
        // fake payer or Stripe is configured. Switching between them is
        // PAYMENT_PROVIDER and nothing else.
        const session = await getProvider().createRetainerSession(
          contract, ref.id, back + '&paid=1', back
        );
        checkoutUrl = session.url;
        // Provider-agnostic name, deliberately: this document may end up paid
        // by either provider, and a field named for one of them would be a lie
        // about the other's rows — the same reason fakeCheckoutComplete and
        // stripeWebhook both write to the shared `paymentIntent` field.
        await ref.update({ paymentSessionId: session.id });
      } catch (err) {
        console.warn('[signContract] could not create checkout session:', describeError(err));
        // Deliberately swallowed, not thrown. The signature above is already
        // committed; the client sees a calm true message instead, and a signed-
        // unpaid contract is exactly what needsPayment on the dashboard/sign
        // page exists to catch — there is no reminder ladder for it anymore,
        // since a contract this far along has nothing left to be chased for
        // signing.
      }
    }

    // Only when the agreement is complete. Sending "your signed agreement"
    // after the first of two signatures would tell the couple it was done
    // while it was still waiting on one of them.
    if (willComplete) {
    const mail = signedCopyEmail({
      clientName: contract.clientName,
      contractUrl: SITE_ORIGIN + '/sign/?t=' + token,
      signedAt: new Date()
    });
    const key = RESEND_API_KEY.value();
    try {
      await sendEmail({
        apiKey: key,
        to: contract.clientEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html
      });
    } catch (err) {
      // Logged, not thrown. The signature is already recorded and valid; a
      // failed confirmation email must not make the client think their
      // signing did not work. The opposite of sendContract's rollback — the
      // difference is that here the important thing already succeeded.
      console.warn('[signContract] confirmation email failed:', describeError(err));
    }
    }

    console.log('[signContract] signed:', slot, ref.id, willComplete ? '(complete)' : '(awaiting client 2)');
    return {
      ok: true,
      signedAt: Date.now(),
      checkoutUrl: checkoutUrl,
      // The page needs to know whether to thank them or to turn round and ask
      // the second partner to sign.
      complete: willComplete,
      awaitingSigner: willComplete ? null : 'client2',
      signedSlot: slot
    };
  }
);

// startRetainerPayment — the way BACK to checkout after an abandoned one.
//
// Without this, an abandoned checkout was a dead end. signContract redirects
// to the payment page with cancel_url pointing at /sign/?t=<token>, so a
// client who closes the tab, has a card declined, or simply hits back lands
// on this page again — signed, unpaid, and with nothing to click. The pay
// reminders that follow cannot carry a link either (no raw token is ever
// stored), so the only remaining route to paying was emailing Khiara.
//
// Modelled directly on openContract above: same token authentication, same
// uniform CONTRACT_DENIED refusal, same region/cors. The one thing it does
// differently is mint a checkout session — which is exactly why it is a
// separate callable and not part of openContract. openContract runs on every
// page load; creating a Stripe session there would mint one per refresh.
//
// STRIPE_SECRET_KEY is declared for the same reason signContract and
// chaseContracts declare it: a function that does not DECLARE a secret never
// receives it, and this one reaches getStripe() through getProvider(). That
// exact omission has already been found twice on this branch.
export const startRetainerPayment = onCall(
  { region: 'us-west1', cors: true, secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const d = request.data || {};
    const token = typeof d.token === 'string' ? d.token.trim() : '';

    // Checked before touching Firestore, same as openContract.
    if (!isValidTokenShape(token)) throw new HttpsError('permission-denied', CONTRACT_DENIED);

    // Payments are off today — Khiara has no processor configured. There is
    // no session this function could ever mint, for any contract, so this is
    // checked before Firestore is touched at all, and refused plainly rather
    // than treated as the token-based CONTRACT_DENIED (a real, held client
    // reaching this path has done nothing wrong).
    if (!paymentsEnabled()) {
      throw new HttpsError('failed-precondition', 'Online payment is not set up yet.');
    }

    const hash = hashToken(token);
    let found = null;
    try {
      const q = await db.collection('contracts').where('tokenHash', '==', hash).limit(1).get();
      if (!q.empty) found = q.docs[0];
    } catch (err) {
      console.warn('[startRetainerPayment] lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    if (!found) throw new HttpsError('permission-denied', CONTRACT_DENIED);
    const contract = found.data();

    // Verified again in constant time even though the query already matched,
    // same reasoning as openContract.
    if (!verifyToken(token, contract.tokenHash)) {
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }
    if (['void', 'cancelled'].indexOf(contract.status) !== -1) {
      console.log('[startRetainerPayment] refused, state:', contract.status);
      throw new HttpsError('permission-denied', CONTRACT_DENIED);
    }

    // Already paid. Said plainly rather than refused, so the page can stop
    // offering a button that would take a second payment — and checked BEFORE
    // the signed check, because 'paid' is not 'signed'.
    if (contract.status === 'paid') return { alreadyPaid: true };

    // Nothing to pay for yet. A contract that is only 'sent' or 'opened' has
    // no signature behind it, and the retainer is due ON signing.
    if (contract.status !== 'signed') {
      console.log('[startRetainerPayment] refused, nothing to pay for yet:', contract.status);
      throw new HttpsError('failed-precondition', CONTRACT_DENIED);
    }

    // Identical to the pair signContract passes, so a session minted here and
    // a session minted at signing land the client back in the same two places.
    const back = SITE_ORIGIN + '/sign/?t=' + token;
    let session;
    try {
      // Through the seam, never Stripe directly — the fake payer serves this
      // path today exactly as it serves signContract's.
      session = await getProvider().createRetainerSession(
        contract, found.id, back + '&paid=1', back
      );
    } catch (err) {
      console.warn('[startRetainerPayment] could not create checkout session:', describeError(err));
      // Generic on purpose: the page shows one calm sentence and the provider's
      // own error code never reaches a client.
      throw new HttpsError('unavailable',
        'We could not open the payment page just now. Please try again in a moment.');
    }

    try {
      // Same provider-agnostic field signContract writes. Overwriting the
      // previous id is correct: this newer session is the one the client is
      // about to use, and it is the one chaseContracts should reconcile.
      await found.ref.update({ paymentSessionId: session.id });
    } catch (err) {
      // Logged, not thrown. The session exists and the client can pay through
      // it; losing our record of the id costs reconciliation, not the payment,
      // and refusing here would strand them for a bookkeeping failure.
      console.warn('[startRetainerPayment] could not record session id:', describeError(err));
    }

    console.log('[startRetainerPayment] checkout opened:', found.id);
    return { checkoutUrl: session.url };
  }
);

// markRetainerReceived is how a retainer paid outside this system — Venmo, a
// cheque, cash — gets recorded. Nothing here can detect those; a person has
// to say so. Her contracts say the date is not reserved until the signed
// Agreement AND the required retainer have been received, so this is the
// field that lets the dashboard tell the truth about whether a date is held.
//
// Deliberately provider-agnostic, same reasoning as paymentSessionId and
// paymentIntent elsewhere in this file: when Stripe is switched on, the
// webhook sets this SAME field, and the dashboard needs no change. Do not
// name or shape this around manual entry.
export const markRetainerReceived = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    await requireAdmin(request);
    const d = request.data || {};
    const contractId = typeof d.contractId === 'string' ? d.contractId.trim() : '';
    if (!isValidContractId(contractId)) {
      throw new HttpsError('invalid-argument', 'That contract id is not valid.');
    }
    // Defaults true; pass false to undo a mis-tap.
    // Strict, because `d.received !== false` treated the STRING "false" as true —
    // the precise thing a caller that serialises booleans would send.
    const received = d.received !== false && d.received !== 'false';

    const ref = db.collection('contracts').doc(contractId);
    let snap;
    try {
      snap = await ref.get();
    } catch (err) {
      console.warn('[markRetainerReceived] could not read contract:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!snap.exists) throw new HttpsError('not-found', 'No such contract.');
    const contract = snap.data();

    // signedAt alone is not enough. It is written once and never cleared, and
    // canTransition permits signed -> cancelled and paid -> cancelled, so a
    // called-off booking still carries it. Requiring a live status too means a
    // cancelled contract cannot have a retainer recorded against it — which
    // matters the moment a cancel control exists.
    if (!contract.signedAt || (contract.status !== 'signed' && contract.status !== 'paid')) {
      throw new HttpsError('failed-precondition', 'That contract is not a signed, active booking.');
    }

    // Idempotent. If the flag is already set the way this call asks for,
    // return success without rewriting it — re-stamping would move the date
    // she actually recorded, and un-marking an already-unmarked contract has
    // nothing left to undo.
    const alreadyReceived = !!contract.retainerReceivedAt;
    if (received === alreadyReceived) {
      return { ok: true };
    }

    // Update and audit row commit together or not at all, same reasoning as
    // signContract: once the check above passes, this is the only chance to
    // write both, and a lost audit row here is unrecoverable.
    const auditRef = ref.collection('audit').doc();
    const batch = db.batch();
    batch.update(ref, {
      retainerReceivedAt: received ? FieldValue.serverTimestamp() : FieldValue.delete(),
      retainerReceivedBy: received ? request.auth.uid : FieldValue.delete()
    });
    batch.set(auditRef, {
      event: received ? 'retainer-received' : 'retainer-unmarked',
      at: FieldValue.serverTimestamp(),
      by: request.auth.uid
    });
    try {
      await batch.commit();
    } catch (err) {
      console.warn('[markRetainerReceived] could not update:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    console.log('[markRetainerReceived]', received ? 'marked:' : 'unmarked:', contractId);
    return { ok: true };
  }
);

// ---------------------------------------------------------------------------
// The fake checkout completion.
//
// There is no staging Firebase project — capturewithki-69dd3 IS production —
// so this endpoint lives next to the real payment path forever, not just
// until Khiara has a Stripe account. The only thing standing between a real
// client's contract and a button that "pays" for nothing is fakePayAllowed's
// allowlist, checked below BEFORE anything is written. If that check is ever
// weakened to a substring match or an environment flag, a real wedding could
// be marked paid without a cent moving. Do not relax it.
// ---------------------------------------------------------------------------
export const fakeCheckoutComplete = onCall(
  { region: 'us-west1', cors: true },
  async (request) => {
    const d = request.data || {};
    const sessionId = typeof d.sessionId === 'string' ? d.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 200) {
      throw new HttpsError('invalid-argument', 'That test payment link is not valid.');
    }

    let sessionSnap;
    try {
      sessionSnap = await db.collection('fakeSessions').doc(sessionId).get();
    } catch (err) {
      console.warn('[fakeCheckoutComplete] session lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!sessionSnap.exists) {
      throw new HttpsError('not-found', 'That test payment link is not valid.');
    }
    const session = sessionSnap.data();
    const contractId = session.contractId;
    if (!isValidContractId(contractId)) {
      throw new HttpsError('failed-precondition', 'That test payment link is not valid.');
    }

    let contractSnap;
    try {
      contractSnap = await db.collection('contracts').doc(contractId).get();
    } catch (err) {
      console.warn('[fakeCheckoutComplete] contract lookup failed:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!contractSnap.exists) {
      throw new HttpsError('not-found', 'That test payment link is not valid.');
    }
    const contract = contractSnap.data();

    // THE GUARD. Exact, case- and whitespace-insensitive match against a
    // hard-coded allowlist of two addresses — never a substring check, never
    // an environment check. A real client's contract fails this even if
    // PAYMENT_PROVIDER is left set to 'fake' in production.
    if (!fakePayAllowed(contract)) {
      console.warn('[fakeCheckoutComplete] refused, not allowlisted:', contractId);
      throw new HttpsError('permission-denied', 'Test payment is not available for this contract.');
    }

    // Marks the session paid — the fake stand-in for a card being charged —
    // then reads it back through the same shape the real webhook and Task
    // 6's reconciliation will use, so that path runs today rather than
    // first running the day real money is involved.
    try {
      await completeFakeSession(sessionId);
    } catch (err) {
      console.warn('[fakeCheckoutComplete] could not complete session:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    let result;
    try {
      result = await retrieveFakeSession(sessionId);
    } catch (err) {
      console.warn('[fakeCheckoutComplete] could not read session back:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (result.payment_status !== 'paid') {
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    // Compared against the amount recorded on the SESSION at creation, not
    // the contract's current retainerCents — the same defence-in-depth
    // markContractPaid applies to a real Stripe payment.
    const decision = await markContractPaid(db, contractId, {
      amountCents: session.amountCents,
      paymentIntent: result.payment_intent
    });

    if (!decision.ok) {
      console.warn('[fakeCheckoutComplete] not recorded:', decision.reason);
      throw new HttpsError('failed-precondition', decision.reason);
    }

    // Contract update and audit row commit together, same reasoning as
    // signContract above: once markContractPaid has said this event is
    // good, a lost audit row can never be rewritten, because a retry of
    // this same session would just see status: 'paid' and refuse as
    // already-paid. A single batch removes the possibility of the two
    // writes splitting.
    const auditRef = decision.ref.collection('audit').doc();
    const batch = db.batch();
    batch.update(decision.ref, {
      status: 'paid',
      paidAt: FieldValue.serverTimestamp(),
      paymentIntent: result.payment_intent,
      // Written on every fake payment without exception, so test data can
      // be found and deleted later — this project already has one pile of
      // undeleted test data from backend development; this must not
      // become a second.
      isTestPayment: true
    });
    batch.set(auditRef, {
      event: 'paid',
      at: FieldValue.serverTimestamp(),
      amountCents: session.amountCents,
      paymentIntent: result.payment_intent,
      provider: 'fake',
      isTestPayment: true
    });
    try {
      await batch.commit();
    } catch (err) {
      console.warn('[fakeCheckoutComplete] could not record payment:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    console.log('[fakeCheckoutComplete] test payment recorded:', contractId);
    return { ok: true };
  }
);

// ---------------------------------------------------------------------------
// stripeWebhook — the only thing in this whole system permitted to mark a
// contract paid.
//
// onRequest, not onCall: Stripe posts a raw signed body and knows nothing
// about the callable protocol. Everything that decides whether an event
// counts as a payment lives in markContractPaid (lib/payments.js) — the
// idempotency check, the amount check, and the out-of-order guard. This
// handler's only job is to verify the signature, pull the contract id out
// of a verified event, and call that one shared function. fakeCheckoutComplete
// above calls the very same function, so there is one implementation of
// "is this really paid" and one set of tests for it.
// ---------------------------------------------------------------------------
export const stripeWebhook = onRequest(
  { region: 'us-west1', secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      res.status(400).send('missing signature');
      return;
    }

    let event;
    try {
      // req.rawBody, NOT req.body. Firebase parses JSON before this handler
      // runs, and re-serialising it produces different bytes — the signature
      // then fails to verify for reasons that look like a Stripe bug.
      event = getStripe().webhooks.constructEvent(
        req.rawBody, signature, STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      // Never log the body of a failed verification — an unverified payload
      // is attacker-controlled. Log only that verification failed.
      console.warn('[stripeWebhook] signature verification failed');
      res.status(400).send('bad signature');
      return;
    }

    if (event.type !== 'checkout.session.completed' && event.type !== 'charge.refunded') {
      // 200, deliberately. Anything else makes Stripe retry an event we will
      // never care about, forever.
      res.status(200).send('ignored');
      return;
    }

    const object = event.data.object;
    const contractId = (object.metadata && object.metadata.contractId)
      || object.client_reference_id
      || '';
    if (!isValidContractId(contractId)) {
      console.warn('[stripeWebhook] event carried no usable contract id:', event.id);
      res.status(200).send('no contract');
      return;
    }

    const ref = db.collection('contracts').doc(contractId);

    if (event.type === 'charge.refunded') {
      // Audit-only. Refunding never changes status — that stays a manual,
      // human decision, not something a webhook infers from a Stripe event.
      let snap;
      try {
        snap = await ref.get();
      } catch (err) {
        // Transient — a Firestore hiccup, not a refusal. A real error status
        // so Stripe retries; nothing has been decided yet either way.
        console.error('[stripeWebhook] refund lookup failed:', contractId, describeError(err));
        res.status(500).send('lookup failed');
        return;
      }
      if (!snap.exists) {
        console.warn('[stripeWebhook] refund for unknown contract:', contractId);
        res.status(200).send('unknown contract');
        return;
      }
      try {
        await ref.collection('audit').add({
          event: 'refunded',
          at: FieldValue.serverTimestamp(),
          stripeEventId: event.id,
          amountCents: object.amount_refunded
        });
      } catch (err) {
        console.error('[stripeWebhook] could not record refund audit row:', contractId, describeError(err));
        res.status(500).send('audit write failed');
        return;
      }
      console.log('[stripeWebhook] refund recorded:', contractId);
      res.status(200).send('ok');
      return;
    }

    // checkout.session.completed does NOT mean money moved. It means the
    // session finished. Today lib/stripe.js sets payment_method_types:['card'],
    // where completion does imply payment — but the day an asynchronous method
    // (ACH, Klarna, bank debit) is switched on in the Stripe dashboard, this
    // event fires with payment_status 'unpaid' while the funds are still days
    // away, and the contract would read "Booked — retainer paid" with nothing
    // taken. That is a dashboard toggle away, not a code change, so the guard
    // lives here rather than in a comment.
    //
    // 200 and stop: this is not an error and Stripe must not retry it. The
    // later checkout.session.async_payment_succeeded (or chaseContracts'
    // reconciliation, which re-reads payment_status) is what records it.
    if (object.payment_status !== 'paid') {
      console.warn('[stripeWebhook] session completed but not paid:', contractId, object.payment_status);
      res.status(200).send('not paid'); return;
    }

    // amount_total is what the client actually paid, compared inside
    // markContractPaid against the contract's own retainerCents — not
    // trusted on its own.
    const decision = await markContractPaid(db, contractId, {
      amountCents: object.amount_total
    });

    if (!decision.ok) {
      // 200, always. Retrying would never change the outcome: the contract
      // is already paid, the amount is wrong, or it isn't payable yet and
      // the reconciliation sweep will pick it up. An amount mismatch is
      // logged loudly — it means something is badly wrong — everything
      // else is a routine, expected refusal.
      if (decision.reason === 'amount-mismatch') {
        console.error('[stripeWebhook] amount mismatch, refusing to record payment:', contractId, event.id);
        // A console.error in Cloud Logging is a signal nobody will ever see.
        // This is the one refusal where MONEY HAS ALREADY MOVED and the system
        // is declining to record it — and the chase ladder will go on dunning
        // a client who has paid. So it is stamped onto the contract itself,
        // where int/contracts.js renders it as a loud alert on the card.
        //
        // Wrapped, and deliberately not allowed to change anything: status is
        // untouched, a failure here is logged rather than thrown, and Stripe
        // still gets its 200 below. Turning a bookkeeping flag into a 500
        // would buy retries that cannot change the outcome.
        try {
          const anomalySnap = await ref.get();
          const expected = anomalySnap.exists ? anomalySnap.data().retainerCents : null;
          await ref.update({
            paymentAnomalyAt: FieldValue.serverTimestamp(),
            paymentAnomaly: 'expected ' + formatCents(expected) +
              ' vs received ' + formatCents(object.amount_total)
          });
        } catch (err) {
          console.error('[stripeWebhook] could not flag amount mismatch on the contract:',
            contractId, describeError(err));
        }
      } else {
        console.warn('[stripeWebhook] not recorded:', decision.reason, contractId);
      }
      res.status(200).send(decision.reason);
      return;
    }

    // Contract update and audit row commit together, same reasoning as
    // signContract above: if the update landed but the audit add then threw,
    // a retry of this same event would see status: 'paid' and refuse as
    // already-paid, and the audit row could never be recreated. A single
    // batch makes the two writes atomic, so a retry after a failed commit
    // can genuinely redo the whole thing.
    // Derived from the event, never hard-coded. Stripe test mode has its own
    // endpoint and its own signing secret, so a test-mode event verifies just
    // as cleanly as a live one and arrives here indistinguishable from a real
    // booking — permanently, since nothing downstream ever revisits the flag.
    // livemode !== true rather than === false, so a missing field is treated
    // as "not proven live" instead of silently recorded as real money.
    const isTestPayment = event.livemode !== true;

    const auditRef = decision.ref.collection('audit').doc();
    const batch = db.batch();
    batch.update(decision.ref, {
      status: 'paid',
      paidAt: FieldValue.serverTimestamp(),
      paymentIntent: object.payment_intent || null,
      isTestPayment: isTestPayment
    });
    batch.set(auditRef, {
      event: 'paid',
      at: FieldValue.serverTimestamp(),
      amountCents: object.amount_total,
      paymentIntent: object.payment_intent || null,
      provider: 'stripe',
      isTestPayment: isTestPayment,
      stripeEventId: event.id
    });
    try {
      await batch.commit();
    } catch (err) {
      // The commit itself failed after markContractPaid said this event is
      // good — a transient Firestore error, not a refusal. Unlike the 200s
      // above, this outcome CAN change on retry, and markContractPaid's own
      // idempotency check makes a retry safe: since the batch is atomic,
      // either nothing landed (and the retry redoes both writes) or nothing
      // failed. So: a real error status, on purpose, so Stripe retries.
      console.error('[stripeWebhook] could not record payment:', contractId, describeError(err));
      res.status(500).send('write failed');
      return;
    }

    console.log('[stripeWebhook] paid:', contractId);
    res.status(200).send('ok');
  }
);

// "Download all", as one file
//
// The couple used to get one save per photo, 700ms apart — 240 separate files
// arriving one by one on a phone. This packs a gallery into zips instead.
//
// The zip is built HERE and written to Storage, rather than streamed straight
// down to the phone, for one reason: a Storage download can be RESUMED. A
// wedding gallery runs to ~2.5GB, the couple are on hotel wifi, and a stream
// that dies at 90% has to start again from nothing. It is also built once and
// then shared — the bride waits, her mum and her bridesmaids do not.
//
// Nothing is ever held whole in memory. Each photo is a read stream from
// Storage, fed through the archiver and out to a write stream. Peak memory is
// a few megabytes whatever the gallery weighs, which is exactly what the old
// "do not zip on the phone" comment in galleries/gallery.js was protecting.
// ---------------------------------------------------------------------------

// Uploads in bounded chunks. Left unbounded, the Storage client keeps the
// whole upload buffered so it can retry it, which would put the gallery back
// in memory and undo the streaming above. 8MiB is a multiple of the 256KiB
// the API requires.
const ZIP_UPLOAD_CHUNK = 8 * 1024 * 1024;

async function buildZipPart(galleryId, plan, allPhotos, fileName) {
  const bucket = getStorage().bucket();
  const path = zipStoragePath(galleryId, plan.index);

  // A download token in the object's metadata, not a signed URL. A v4 signed
  // URL needs `iam.serviceAccountTokenCreator` on the functions service
  // account — a setup step that fails at RUN time, long after a deploy said
  // it was fine. This form needs no IAM change, is unguessable, and Storage
  // honours Range requests on it, which is the resume this design exists for.
  const token = randomUUID();
  const out = bucket.file(path);
  const write = out.createWriteStream({
    resumable: true,
    chunkSize: ZIP_UPLOAD_CHUNK,
    metadata: {
      contentType: 'application/zip',
      contentDisposition: 'attachment; filename="' + fileName.replace(/"/g, '') + '"',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });

  // No compression. JPEGs are already compressed, so deflate spends real CPU
  // to save almost nothing — and storing them keeps the finished size
  // predictable.
  const archive = new ZipArchive({ store: true });

  const finished = new Promise(function (resolve, reject) {
    archive.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
  });

  archive.pipe(write);

  // Numbering is by position in the WHOLE gallery, not within the part, so
  // part 2 continues from where part 1 stopped instead of restarting at 001.
  const positions = new Map();
  allPhotos.forEach(function (p, i) { positions.set(p.id, i); });

  let missing = 0;
  for (const p of plan.photos) {
    if (typeof p.fullPath !== 'string' || !p.fullPath) {
      // A record with no file path cannot be fetched. Skipping it and saying
      // so beats failing the whole gallery: the other 239 photos still arrive,
      // and the page tells them to use the arrow on the ones that did not.
      missing++;
      console.warn('[zip] photo has no fullPath, skipped:', galleryId, p.id);
      continue;
    }
    archive.append(bucket.file(p.fullPath).createReadStream(), {
      name: zipEntryName(p, positions.get(p.id) || 0, allPhotos.length)
    });
  }

  await archive.finalize();
  await finished;

  const [meta] = await out.getMetadata();
  return {
    bytes: Number(meta && meta.size) || 0,
    missing: missing,
    url: 'https://firebasestorage.googleapis.com/v0/b/' + bucket.name +
         '/o/' + encodeURIComponent(path) + '?alt=media&token=' + token
  };
}

export const prepareGalleryZip = onCall(
  // 15 minutes and half a gigabyte. The work is almost entirely waiting on
  // network inside Google's own data centre, so the memory is headroom rather
  // than need. The timeout is deliberately shorter than the 20-minute window
  // in isClaimStale(): the instance is always dead before its claim expires,
  // so a claim can never be stolen from a build that is still running.
  { region: 'us-west1', cors: true, memory: '512MiB', timeoutSeconds: 900 },
  async (request) => {
    const data = request.data || {};
    const galleryId = typeof data.galleryId === 'string' ? data.galleryId.trim() : '';
    const part = Number(data.part);

    // The same claim the Firestore and Storage rules gate on. openGallery only
    // mints it after checking the password, so holding it IS the permission.
    const claim = request.auth && request.auth.token && request.auth.token.gal;
    if (!isValidGalleryId(galleryId) || claim !== galleryId) {
      throw new HttpsError('permission-denied', GALLERY_DENIED);
    }
    if (!Number.isInteger(part) || part < 1) {
      throw new HttpsError('invalid-argument', 'Which part?');
    }

    // Re-read the gallery even though the caller holds a token: the Admin SDK
    // bypasses rules, so the expiry check the rules would have made has to
    // happen here instead. A token outlives the gallery it was minted for.
    let snap;
    try {
      snap = await db.collection('galleries').doc(galleryId).get();
    } catch (err) {
      console.warn('[zip] could not read gallery:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    const gallery = snap.exists ? snap.data() : null;
    if (!galleryOpenable(gallery, Date.now()).ok) {
      throw new HttpsError('permission-denied', GALLERY_DENIED);
    }

    let photosSnap;
    try {
      photosSnap = await db.collection('galleries').doc(galleryId)
        .collection('photos').orderBy('order').get();
    } catch (err) {
      console.warn('[zip] could not list photos:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    const photos = [];
    photosSnap.forEach(function (d) { photos.push(Object.assign({ id: d.id }, d.data())); });
    if (!photos.length) {
      throw new HttpsError('failed-precondition', 'There are no photos in this gallery yet.');
    }

    const parts = planZipParts(photos);
    if (part > parts.length) {
      throw new HttpsError('invalid-argument', 'That part does not exist.');
    }
    const plan = parts[part - 1];
    const fingerprint = sourceFingerprint(photos);
    const fileName = zipFileName(gallery.title, part, parts.length);
    const ref = db.collection('galleries').doc(galleryId).collection('zips').doc(partDocId(part));

    // Claiming in a transaction is what stops two people tapping at once from
    // both packing the same gigabyte.
    const now = Date.now();
    let outcome;
    try {
      outcome = await db.runTransaction(async function (tx) {
        const cur = await tx.get(ref);
        const d = cur.exists ? cur.data() : null;
        // Already built FROM THESE PHOTOS. A zip whose fingerprint no longer
        // matches is stale — she has added or removed something since — and
        // gets rebuilt over the top.
        if (d && d.status === 'ready' && d.fingerprint === fingerprint) return 'ready';
        if (d && d.status === 'building' && !isClaimStale(d, now)) return 'building';
        tx.set(ref, {
          status: 'building',
          index: part,
          total: parts.length,
          photoCount: plan.photos.length,
          fingerprint: fingerprint,
          name: fileName,
          bytes: 0,
          missing: 0,
          url: null,
          error: null,
          startedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        return 'claimed';
      });
    } catch (err) {
      console.warn('[zip] could not claim part:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }

    if (outcome !== 'claimed') {
      console.log('[zip] part', part, 'of', galleryId, 'already', outcome);
      return { status: outcome, total: parts.length };
    }

    console.log('[zip] building part', part, 'of', parts.length, 'for', galleryId,
      '—', plan.photos.length, 'photos,', Math.round(plan.bytes / 1048576), 'MB');

    try {
      const built = await buildZipPart(galleryId, plan, photos, fileName);
      await ref.update({
        status: 'ready',
        bytes: built.bytes,
        missing: built.missing,
        url: built.url,
        error: null,
        updatedAt: FieldValue.serverTimestamp()
      });
      console.log('[zip] part', part, 'of', galleryId, 'ready —', built.bytes, 'bytes');
      return { status: 'ready', total: parts.length };
    } catch (err) {
      const reason = describeError(err);
      console.error('[zip] part', part, 'of', galleryId, 'failed:', reason);
      // Recorded rather than left as a dangling "building", so the page can
      // offer Try again immediately instead of waiting out the claim window.
      try {
        await ref.update({
          status: 'failed',
          error: reason.slice(0, 300),
          updatedAt: FieldValue.serverTimestamp()
        });
      } catch (inner) {
        console.error('[zip] could not record the failure:', describeError(inner));
      }
      throw new HttpsError('internal', 'Could not build that download. Please try again.');
    }
  }
);

// ---------------------------------------------------------------------------
// Expiry cleanup
//
// Runs daily. Finds galleries whose moment has passed, deletes their photo
// files and photo records, and marks the gallery expired. The gallery record
// itself survives so her list keeps a history of what she sent and when.
//
// This function DELETES A CLIENT'S PHOTOS. Everything below is written to fail
// closed: anything it cannot read confidently is skipped rather than guessed
// at, and one gallery going wrong must not stop the others.
// ---------------------------------------------------------------------------
export const cleanupExpiredGalleries = onSchedule(
  { region: 'us-west1', schedule: 'every day 03:00', timeZone: 'Pacific/Honolulu' },
  async () => {
    const now = Date.now();

    let snap;
    try {
      // Only live ones are candidates. Filtering here rather than in code keeps
      // the read small as her history grows.
      snap = await db.collection('galleries').where('status', '==', 'live').get();
    } catch (err) {
      console.error('[cleanup] could not list galleries:', describeError(err));
      return;
    }

    const all = [];
    snap.forEach(function (d) { all.push(Object.assign({ id: d.id }, d.data())); });
    const due = dueGalleries(all, now);

    console.log('[cleanup] live galleries:', all.length, 'due:', due.length);
    if (!due.length) return;

    const bucket = getStorage().bucket();

    for (const g of due) {
      try {
        // The files first. If this fails we do NOT mark the gallery expired,
        // so the next run tries again rather than leaving orphaned files
        // nobody will ever find or pay attention to.
        await bucket.deleteFiles({ prefix: 'galleries/' + g.id + '/', force: true });

        // Then the photo records, in batches — a wedding gallery can hold
        // hundreds and a single batch is capped at 500 writes.
        const photos = await db.collection('galleries').doc(g.id).collection('photos').get();
        let batch = db.batch();
        let n = 0;
        for (const doc of photos.docs) {
          batch.delete(doc.ref);
          n++;
          if (n % 400 === 0) { await batch.commit(); batch = db.batch(); }
        }
        if (n % 400 !== 0) await batch.commit();

        // Then the zip records. The zip FILES are already gone — deleteFiles
        // above sweeps the whole `galleries/{id}/` prefix and the zips live
        // under it — but these records would survive it, each one pointing at
        // a file that no longer exists.
        const zips = await db.collection('galleries').doc(g.id).collection('zips').get();
        let zipBatch = db.batch();
        let z = 0;
        for (const doc of zips.docs) {
          zipBatch.delete(doc.ref);
          z++;
          if (z % 400 === 0) { await zipBatch.commit(); zipBatch = db.batch(); }
        }
        if (z % 400 !== 0) await zipBatch.commit();

        await db.collection('galleries').doc(g.id).update({
          status: 'expired',
          photoCount: 0,
          coverThumb: null,
          expiredAt: FieldValue.serverTimestamp()
        });

        console.log('[cleanup] expired gallery', g.id, '—', n, 'photos and', z, 'zips removed');
      } catch (err) {
        // One bad gallery must not stop the rest.
        console.error('[cleanup] failed for gallery', g.id, describeError(err));
      }
    }
  }
);

// ---------------------------------------------------------------------------
// The unseen-inquiry alarm
//
// Background: an inquiry was accepted by Resend, logged as sent, and filed
// into the owner's Gmail spam folder. Nothing in this system could tell.
// "Accepted by Resend" only means the API queued the message, and a
// spam-filed message is reported by Gmail as delivered — so every signal the
// send path produces was green while she saw nothing.
//
// The one signal that survives ANY delivery failure is whether the inquiry
// was ever displayed in the dashboard. That is what this watches, and it is
// why the dashboard stamps `seenAt` (int/inquiries.js).
//
// It mails maintainer inboxes, NOT capturewithki@gmail.com. An alarm about a
// broken inbox that is delivered to the broken inbox is not an alarm.
// ---------------------------------------------------------------------------
const ALARM_EMAILS = ['laakeasalvani@gmail.com', 'netherlyk23@gmail.com'];

// A bound on how many alarms one run may send. A systemic fault should ring
// the bell, not empty the Resend quota into two mailboxes.
const MAX_ALARMS_PER_RUN = 10;

export const escalateUnreadInquiries = onSchedule(
  {
    region: 'us-west1',
    schedule: 'every 60 minutes',
    timeZone: 'Pacific/Honolulu',
    secrets: [RESEND_API_KEY]
  },
  async () => {
    const now = Date.now();

    let snap;
    try {
      // Ranged on createdAt alone. Adding `status == 'new'` here would make it
      // a composite query needing an index, and the week's worth of documents
      // this returns is small enough to finish filtering in code.
      snap = await db.collection('inquiries')
        .where('createdAt', '>=', new Date(now - BACKLOG_MS))
        .get();
    } catch (err) {
      console.error('[alarm] could not list recent inquiries:', describeError(err));
      return;
    }

    const recent = [];
    snap.forEach(function (d) { recent.push(Object.assign({ id: d.id }, d.data())); });
    const due = dueEscalations(recent, now);

    console.log('[alarm] recent inquiries:', recent.length, 'unseen past the window:', due.length);
    if (!due.length) return;

    const key = RESEND_API_KEY.value();

    for (const inquiry of due.slice(0, MAX_ALARMS_PER_RUN)) {
      try {
        const m = escalationEmail(inquiry, now);
        await sendEmail({ apiKey: key, to: ALARM_EMAILS, subject: m.subject, text: m.text });

        // Stamped only once the alarm is genuinely away. If the send throws we
        // leave the mark off so the next run tries again — a duplicate alarm
        // is a nuisance, a silently swallowed one is the original bug.
        await db.collection('inquiries').doc(inquiry.id)
          .update({ escalatedAt: FieldValue.serverTimestamp() });

        console.log('[alarm] raised for inquiry', inquiry.id);
      } catch (err) {
        // One failure must not stop the rest.
        console.error('[alarm] could not raise for inquiry', inquiry.id, describeError(err));
      }
    }
  }
);

// ---------------------------------------------------------------------------
// The signature chase — reminders and escalation — plus reconciliation.
//
// dueActions never chases a 'signed' contract for anything (Task 4: there is
// no payment left to ask for, so a signature is the end of the ladder), so
// reconciliation below is no longer about protecting the chase from a stale
// status. It still matters for the dashboard and the sign page: openContract
// reports needsPayment from `status === 'signed' && !paidAt`, and a missed
// checkout.session.completed webhook (Stripe drops them occasionally, and
// the fake payer has no webhook at all — completing a fake session only ever
// updates fakeSessions, never the contract, unless fakeCheckoutComplete
// itself ran) would otherwise leave that flag wrongly true even though the
// client already paid. Reconciliation runs FIRST, inside the same
// invocation, and patches the in-memory contract to 'paid' immediately, so a
// contract this run just repaired is never even considered stale by
// anything reading `contracts` afterward.
// ---------------------------------------------------------------------------
export const chaseContracts = onSchedule(
  {
    region: 'us-west1',
    schedule: 'every 1 hours',
    // STRIPE_SECRET_KEY is required here even though this function never
    // touches Stripe directly: Functions v2 only injects a declared secret
    // into the runtime environment for functions that list it, so when
    // PAYMENT_PROVIDER=stripe the reconciliation loop below calls
    // getProvider().retrieveSession() -> getStripe() -> new
    // Stripe(process.env.STRIPE_SECRET_KEY, ...) with that key undefined.
    // Without this line that throw is swallowed by the per-contract
    // try/catch below as a console.warn, so reconciliation would silently
    // fail for every contract, every hour, forever.
    secrets: [RESEND_API_KEY, STRIPE_SECRET_KEY]
  },
  async () => {
    const now = Date.now();

    let snap;
    try {
      // Only live states. 'paid', 'void', 'cancelled' and 'draft' are never
      // chased, and fetching them would grow this query without bound as
      // the years pass.
      snap = await db.collection('contracts')
        .where('status', 'in', ['sent', 'opened', 'signed'])
        .get();
    } catch (err) {
      console.error('[chaseContracts] could not list contracts:', describeError(err));
      return;
    }

    const contracts = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));

    // Reconciliation. Only 'signed' contracts with a checkout session on file
    // are candidates, and only once the session has had a little time to
    // resolve — checkContract's own webhook can legitimately still be in
    // flight seconds after signing, and this must not race it.
    //
    // Skipped entirely while payments are off: there is no provider to ask
    // and no checkout session was ever minted (signContract and
    // startRetainerPayment both skip that step too), so every contract's
    // paymentSessionId is already absent and this loop would be a no-op
    // anyway. Checking paymentsEnabled() up front avoids calling
    // getProvider() at all, which would otherwise throw once per contract.
    for (const c of (paymentsEnabled() ? contracts : [])) {
      if (c.status !== 'signed' || !c.paymentSessionId) continue;
      const signedAt = c.signedAt && typeof c.signedAt.toMillis === 'function'
        ? c.signedAt.toMillis() : null;
      if (signedAt === null || now - signedAt < 15 * 60000) continue;

      try {
        // Through the seam — never Stripe directly. The fake provider's
        // retrieveSession reads the fakeSessions collection it already
        // wrote at checkout, so this path is exercised for real today
        // rather than first running the day real money is involved.
        const session = await getProvider().retrieveSession(c.paymentSessionId);
        if (session.payment_status !== 'paid') continue;

        console.warn('[chaseContracts] webhook was missed, repairing:', c.id);

        // Routed through the SAME shared decision stripeWebhook and
        // fakeCheckoutComplete use — not a hand-rolled update. This is what
        // gets reconciliation the amount check (session.amount_total is
        // compared against retainerCents inside markContractPaid) and a
        // fresh ref.get() at decision time, which closes the race where this
        // loop's stale in-memory `contracts` array could otherwise stomp a
        // paidAt the webhook had already written moments earlier.
        const decision = await markContractPaid(db, c.id, { amountCents: session.amount_total });
        if (!decision.ok) {
          console.warn('[chaseContracts] not reconciled:', decision.reason, c.id);
          continue;
        }

        // provider/isTestPayment are derived, never hard-coded — reconciliation
        // runs under whichever provider is currently configured, and a
        // hard-coded 'fake'/false here would mislabel a real Stripe repair.
        const provider = providerName();
        const isTestPayment = provider === 'fake';

        // Same shared shape stripeWebhook writes, field for field, so a
        // reconciled payment is indistinguishable from one the webhook
        // recorded directly except for the audit event name.
        const auditRef = decision.ref.collection('audit').doc();
        const batch = db.batch();
        batch.update(decision.ref, {
          status: 'paid',
          paidAt: FieldValue.serverTimestamp(),
          paymentIntent: session.payment_intent || null,
          isTestPayment: isTestPayment
        });
        batch.set(auditRef, {
          event: 'paid-reconciled',
          at: FieldValue.serverTimestamp(),
          amountCents: session.amount_total,
          paymentIntent: session.payment_intent || null,
          provider: provider,
          isTestPayment: isTestPayment
        });
        await batch.commit();

        // Patched in memory too, so dueActions below — which only ever
        // sees this array, never Firestore again — skips it this run.
        c.status = 'paid';
      } catch (err) {
        console.warn('[chaseContracts] could not reconcile', c.id, describeError(err));
      }
    }

    const actions = dueActions(contracts, now);
    console.log('[chaseContracts] scanned', contracts.length, 'due', actions.length);
    if (!actions.length) return;

    const key = RESEND_API_KEY.value();

    for (const action of actions) {
      const c = contracts.find((x) => x.id === action.contractId);
      if (!c) continue;
      const ref = db.collection('contracts').doc(c.id);

      // Each action's send-and-record is its own try/catch. One bad address
      // or one Resend hiccup must not stop every other contract's reminder
      // from going out this hour.
      try {
        if (action.kind === 'sign-reminder') {
          const m = signReminderEmail(c);
          await sendEmail({ apiKey: key, to: c.clientEmail, subject: m.subject, text: m.text, html: m.html });
          await ref.update({
            signReminderCount: (c.signReminderCount || 0) + 1,
            lastReminderAt: FieldValue.serverTimestamp()
          });
        } else if (action.kind === 'never-opened-alert') {
          const m = neverOpenedAlertEmail(c);
          await sendEmail({ apiKey: key, to: OWNER_EMAIL, subject: m.subject, text: m.text, html: m.html });
          await ref.update({ neverOpenedAlertAt: FieldValue.serverTimestamp() });
        } else if (action.kind === 'unsigned-escalation') {
          const m = unsignedEscalationEmail(c);
          await sendEmail({ apiKey: key, to: OWNER_EMAIL, subject: m.subject, text: m.text, html: m.html });
          await ref.update({ escalatedAt: FieldValue.serverTimestamp() });
        } else {
          continue;
        }

        await ref.collection('audit').add({
          event: action.kind,
          at: FieldValue.serverTimestamp()
        });
      } catch (err) {
        console.warn('[chaseContracts] action failed', action.kind, c.id, describeError(err));
      }
    }
  }
);
