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
import { onCall, HttpsError } from 'firebase-functions/v2/https';
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
    const password = typeof data.password === 'string' ? data.password.trim() : '';

    // Checked before touching Firestore: the id becomes a document path and a
    // token claim, so its shape is not negotiable.
    if (!isValidGalleryId(galleryId) || !password) {
      throw new HttpsError('permission-denied', GALLERY_DENIED);
    }

    // Rate limited on a bucket of its own. Sharing the contact form's bucket
    // would mean a couple fumbling their password could block a real inquiry,
    // and a spammer hitting the form could lock a couple out of their photos.
    const now = Date.now();
    const ipHash = hashIp('gallery:' + (request.rawRequest && request.rawRequest.ip));
    try {
      const limit = await checkRateLimit(db, ipHash, now);
      if (!limit.allowed) {
        throw new HttpsError('resource-exhausted', 'Too many tries. Please wait an hour and try again.');
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      // A rate-limiter failure must not lock a couple out of their own photos.
      console.warn('[openGallery] rate limit check failed, allowing:', describeError(err));
    }

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
