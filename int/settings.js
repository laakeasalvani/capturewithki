import { db } from '../cms/firebase.js';
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
    '<div class="s-actions"><button type="button" id="sSave">Save</button>' +
    '<button type="button" id="sReset" class="s-secondary">Reset to default</button>' +
    '<span class="s-status" id="sStatus" aria-live="polite"></span></div>' +
    '<h3 class="s-preview-title">Preview</h3>' +
    '<pre class="s-preview" id="sPreview"></pre>';

  const subject = container.querySelector('#sSubject');
  const body = container.querySelector('#sBody');
  const status = container.querySelector('#sStatus');
  const preview = container.querySelector('#sPreview');

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
    } catch (err) {
      subject.value = DEFAULT_SUBJECT;
      body.value = DEFAULT_BODY;
      flash('Could not load saved wording: ' + (err && (err.code || err.message)));
    }
    updatePreview();
  })();
}
