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

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const OWNER_EMAIL = 'capturewithki@gmail.com';

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
