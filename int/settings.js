import { db } from '../cms/firebase.js';
// The same uploader the website CMS uses, so a photo chosen here goes through
// exactly the path her site photos do — full quality, same 50MB ceiling.
import { uploadImage } from '../cms/edit-image.js';
import {
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Kept in sync with functions/lib/email.js. Shown as the starting point when
// no template has been saved yet; the function falls back to its own copy of
// this wording if the document is missing.
const DEFAULT_SUBJECT = 'Thank you for reaching out — CaptureWithKi';
const DEFAULT_BODY = [
  'Hi {first_name},',
  '',
  'Thank you so much for reaching out — your inquiry came through and I have it.',
  '',
  'I will get back to you within 48 hours.',
  '',
  'Talk soon,',
  'Khiara',
  'CaptureWithKi'
].join('\n');

export function initSettings(container) {
  container.innerHTML =
    '<h2 class="s-title">The thank-you email your clients receive</h2>' +
    '<p class="s-help">Write <code>{first_name}</code> anywhere and it becomes their first name. ' +
    'Leave a field empty to go back to the wording below.</p>' +
    '<label class="s-label">Subject<input id="sSubject" type="text"></label>' +
    '<label class="s-label">Message<textarea id="sBody" rows="12"></textarea></label>' +
    '<div class="s-photo">' +
      '<div class="s-label">Photo at the top of the email</div>' +
      '<p class="s-help">Optional. Leave it empty and the email simply has no photo. ' +
      'Many email apps hide pictures until the reader taps “show images”, so the ' +
      'email is written to read properly either way.</p>' +
      '<img id="sPhoto" class="s-photo-preview" alt="" hidden>' +
      '<p class="s-photo-none" id="sPhotoNone">No photo yet.</p>' +
      '<input id="sPhotoFile" type="file" accept="image/*" hidden>' +
      '<div class="s-actions">' +
        '<button type="button" id="sPhotoPick">Change photo</button>' +
        '<button type="button" id="sPhotoClear" class="s-secondary">Remove photo</button>' +
        '<span class="s-status" id="sPhotoStatus" aria-live="polite"></span>' +
      '</div>' +
    '</div>' +
    '<div class="s-actions"><button type="button" id="sSave">Save</button>' +
    '<button type="button" id="sReset" class="s-secondary">Reset to default</button>' +
    '<span class="s-status" id="sStatus" aria-live="polite"></span></div>' +
    '<h3 class="s-preview-title">Preview</h3>' +
    '<pre class="s-preview" id="sPreview"></pre>';

  const subject = container.querySelector('#sSubject');
  const body = container.querySelector('#sBody');
  const status = container.querySelector('#sStatus');
  const preview = container.querySelector('#sPreview');

  const photo = container.querySelector('#sPhoto');
  const photoNone = container.querySelector('#sPhotoNone');
  const photoFile = container.querySelector('#sPhotoFile');
  const photoPick = container.querySelector('#sPhotoPick');
  const photoClear = container.querySelector('#sPhotoClear');
  const photoStatus = container.querySelector('#sPhotoStatus');
  let photoUrl = '';

  function showPhoto(url) {
    photoUrl = url || '';
    photo.hidden = !photoUrl;
    if (photoUrl) photo.src = photoUrl;
    photoNone.hidden = !!photoUrl;
    photoClear.disabled = !photoUrl;
  }

  function photoFlash(text) {
    photoStatus.textContent = text;
    clearTimeout(photoStatus.__t);
    photoStatus.__t = setTimeout(function () { photoStatus.textContent = ''; }, 3000);
  }

  async function savePhoto(url) {
    await setDoc(doc(db, 'settings', 'email'), { clientImage: url }, { merge: true });
    showPhoto(url);
  }

  function updatePreview() {
    const s = subject.value.trim() || DEFAULT_SUBJECT;
    const b = body.value.trim() || DEFAULT_BODY;
    preview.textContent =
      'Subject: ' + s.replace(/[\r\n]+/g, ' ') + '\n\n' +
      b.split('{first_name}').join('Sarah');
  }

  function flash(text) {
    status.textContent = text;
    clearTimeout(status.__t);
    status.__t = setTimeout(function () { status.textContent = ''; }, 2500);
  }

  subject.addEventListener('input', updatePreview);
  body.addEventListener('input', updatePreview);

  container.querySelector('#sSave').addEventListener('click', async function () {
    try {
      await setDoc(doc(db, 'settings', 'email'), {
        clientSubject: subject.value.trim(),
        clientBody: body.value.trim()
      }, { merge: true });
      flash('Saved');
    } catch (err) {
      flash('Could not save: ' + (err && (err.code || err.message)));
    }
  });

  // The file input is a real element in the page and is opened by a direct
  // tap on the button with no dialogs in between — the same shape the
  // testimonial form needed, for the same iOS reason.
  photoPick.addEventListener('click', function () { photoFile.click(); });

  photoFile.addEventListener('change', async function () {
    const file = photoFile.files[0];
    if (!file) return;
    photoPick.disabled = true;
    photoClear.disabled = true;
    photoStatus.textContent = 'Uploading… this can take a moment on a phone.';
    try {
      const url = await uploadImage(file, 'emailBanner');
      await savePhoto(url);
      photoFlash('Photo saved — future emails will use it.');
    } catch (err) {
      photoFlash('Could not save that photo: ' + (err && (err.code || err.message)));
    } finally {
      photoPick.disabled = false;
      photoClear.disabled = !photoUrl;
      photoFile.value = '';
    }
  });

  photoClear.addEventListener('click', async function () {
    if (!photoUrl) return;
    if (!confirm('Remove the photo from the top of the email?')) return;
    photoClear.disabled = true;
    try {
      await savePhoto('');
      photoFlash('Photo removed.');
    } catch (err) {
      photoFlash('Could not remove it: ' + (err && (err.code || err.message)));
      photoClear.disabled = false;
    }
  });

  container.querySelector('#sReset').addEventListener('click', function () {
    subject.value = DEFAULT_SUBJECT;
    body.value = DEFAULT_BODY;
    updatePreview();
    flash('Reset — press Save to apply');
  });

  (async function () {
    try {
      const snap = await getDoc(doc(db, 'settings', 'email'));
      const d = snap.exists() ? snap.data() : {};
      subject.value = d.clientSubject || DEFAULT_SUBJECT;
      body.value = d.clientBody || DEFAULT_BODY;
      showPhoto(d.clientImage || '');
    } catch (err) {
      subject.value = DEFAULT_SUBJECT;
      body.value = DEFAULT_BODY;
      showPhoto('');
      flash('Could not load saved wording: ' + (err && (err.code || err.message)));
    }
    updatePreview();
  })();
}
