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
import { dueEscalations, escalationEmail, BACKLOG_MS } from './lib/escalate.js';
import { validateKeaInquiry, keaOwnerEmail, keaClientEmail,
         keaOwnerEmailHtml, keaClientEmailHtml, sendKeaEmail,
         KEA_OWNER_EMAIL } from './lib/kea.js';
import {
  validateContractInput, sumLineItems, computeRetainerCents,
  computeBalanceCents, DEFAULT_RETAINER_PERCENT, isValidContractId,
  MAX_PHONE, MAX_EVENT_DATE, renderTemplate, canTransition
} from './lib/contracts.js';
import { generateToken, hashToken, hashDocument } from './lib/contract-crypto.js';
import { readyToSignEmail, formatCents } from './lib/contract-email.js';

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const OWNER_EMAIL = 'capturewithki@gmail.com';

// Hard-coded, and never taken from request.data. The sign link emailed below
// is built ONLY from this origin plus the freshly minted token — nothing a
// caller supplies can reach it, which is what makes it safe to drop into an
// href after nothing more than escaping.
const SITE_ORIGIN = 'https://capturewithki.com';

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
    const check = validateContractInput(d);
    if (!check.ok) {
      // She is the only caller, so unlike the client-facing paths this one
      // says exactly what is wrong. There is no id to probe for here.
      throw new HttpsError('invalid-argument', check.errors.join(' '));
    }

    const lineItems = d.lineItems.map(function (item) {
      return { label: String(item.label).trim().slice(0, 120), amountCents: item.amountCents };
    });
    const totalCents = sumLineItems(lineItems);
    const percent = Number.isFinite(d.retainerPercent) ? d.retainerPercent : DEFAULT_RETAINER_PERCENT;
    const retainerCents = computeRetainerCents(totalCents, percent);

    const doc = {
      status: 'draft',
      inquiryId: typeof d.inquiryId === 'string' && d.inquiryId ? d.inquiryId : null,
      clientName: String(d.clientName).trim().slice(0, 200),
      clientEmail: String(d.clientEmail).trim().slice(0, 254),
      clientPhone: typeof d.clientPhone === 'string' ? d.clientPhone.trim().slice(0, MAX_PHONE) : '',
      eventDate: typeof d.eventDate === 'string' ? d.eventDate.trim().slice(0, MAX_EVENT_DATE) : '',
      eventLocation: typeof d.eventLocation === 'string' ? d.eventLocation.trim().slice(0, 300) : '',
      lineItems: lineItems,
      totalCents: totalCents,
      retainerCents: retainerCents,
      // By subtraction. Never recomputed as a second percentage.
      balanceCents: computeBalanceCents(totalCents, retainerCents),
      retainerPercent: percent,
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

    const templateId = typeof d.templateId === 'string' ? d.templateId.trim() : '';
    let tplSnap;
    try {
      tplSnap = await db.collection('contractTemplates').doc(templateId).get();
    } catch (err) {
      console.warn('[sendContract] could not read template:', describeError(err));
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
    if (!tplSnap.exists) throw new HttpsError('not-found', 'No such contract template.');
    const tpl = tplSnap.data();

    // A placeholder contract reaching a real client would be worse than no system at
    // all — she would believe she had an agreement and have nothing. functions/seed/
    // ships a placeholder template marked isDraft, and this is what keeps it unsendable.
    if (tpl.isDraft === true) {
      throw new HttpsError('failed-precondition',
        'That contract template is still marked a draft. Replace it with the real agreement first.');
    }

    // Rendered ONCE, here, and stored. From this moment the live template is
    // irrelevant to this contract: editing a clause later cannot change what
    // this client agreed to, and the hash is what proves it.
    const documentSnapshot = renderTemplate(tpl.html, {
      client_name: contract.clientName,
      client_email: contract.clientEmail,
      event_date: contract.eventDate,
      event_location: contract.eventLocation,
      total: formatCents(contract.totalCents),
      retainer: formatCents(contract.retainerCents),
      balance: formatCents(contract.balanceCents),
      line_items: contract.lineItems
        .map(function (i) { return i.label + ' — ' + formatCents(i.amountCents); })
        .join('; ')
    });

    // A placeholder the template asked for and the data could not fill would
    // ship a contract with a visible hole in it. Refuse instead.
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
        templateId: templateId,
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
      try {
        await ref.update({
          status: 'draft',
          tokenHash: FieldValue.delete(),
          sentAt: FieldValue.delete(),
          documentSnapshot: FieldValue.delete(),
          documentHash: FieldValue.delete(),
          templateId: FieldValue.delete(),
          templateVersion: FieldValue.delete()
        });
      } catch (rollbackErr) {
        // Deliberately console.error and deliberately greppable. If this line ever
        // appears, a contract IS stranded in 'sent' with no email behind it, and a
        // human has to free it by hand. It is the only remaining route to that state.
        console.error('[sendContract] STRANDED: send failed AND rollback failed for',
          contractId, describeError(rollbackErr));
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

        await db.collection('galleries').doc(g.id).update({
          status: 'expired',
          photoCount: 0,
          coverThumb: null,
          expiredAt: FieldValue.serverTimestamp()
        });

        console.log('[cleanup] expired gallery', g.id, '—', n, 'photos removed');
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
