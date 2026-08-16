import { db, app } from '../cms/firebase.js';
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import { uploadGalleryPhoto, nextPhotoOrder } from './gallery-upload.js';

const fns = getFunctions(app, 'us-west1');
const createGalleryFn = httpsCallable(fns, 'createGallery');
const regeneratePasswordFn = httpsCallable(fns, 'regenerateGalleryPassword');

const SITE = 'https://capturewithki.com';

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function galleryLink(id) {
  return SITE + '/galleries/?g=' + id;
}

export function initGalleries(container) {
  container.innerHTML =
    '<h2 class="s-title">Client galleries</h2>' +
    '<p class="s-help">Make a gallery, add the photos, then send the link and password to the couple. ' +
    'The clock does not start until you press Send.</p>' +
    '<div class="g-new">' +
      '<label class="s-label">Couple&#8217;s name' +
        '<input id="gNewTitle" type="text" maxlength="120" placeholder="Sarah &amp; Ronan">' +
      '</label>' +
      '<div class="s-actions">' +
        '<button type="button" id="gCreate">Create gallery</button>' +
        '<span class="s-status" id="gCreateStatus" aria-live="polite"></span>' +
      '</div>' +
    '</div>' +
    '<div id="gList" class="g-list"><p class="s-help">Loading&#8230;</p></div>';

  const titleEl = container.querySelector('#gNewTitle');
  const createBtn = container.querySelector('#gCreate');
  const createStatus = container.querySelector('#gCreateStatus');
  const list = container.querySelector('#gList');

  function flash(el, text, ms) {
    el.textContent = text;
    clearTimeout(el.__t);
    el.__t = setTimeout(function () { el.textContent = ''; }, ms || 4000);
  }

  // The plaintext password exists for exactly one moment: the response to
  // createGallery. It is never stored and cannot be looked up again, so it is
  // shown until she dismisses it rather than fading like a toast.
  function showPassword(galleryId, password, note) {
    const box = document.createElement('div');
    box.className = 'g-password';
    box.innerHTML =
      '<p class="g-password-note">' + esc(note) + '</p>' +
      '<p class="g-password-value"><code>' + esc(password) + '</code></p>' +
      '<p class="g-password-warn">This is the only time it is shown. Copy it now &#8212; ' +
      'it is stored scrambled and cannot be looked up later.</p>' +
      '<div class="s-actions">' +
        '<button type="button" class="g-copy-pw">Copy password</button>' +
        '<button type="button" class="g-copy-link s-secondary">Copy link</button>' +
        '<button type="button" class="g-dismiss s-secondary">Done</button>' +
        '<span class="s-status"></span>' +
      '</div>';
    const status = box.querySelector('.s-status');
    box.querySelector('.g-copy-pw').addEventListener('click', function () {
      navigator.clipboard.writeText(password)
        .then(function () { flash(status, 'Password copied'); })
        .catch(function () { flash(status, 'Could not copy — select it by hand'); });
    });
    box.querySelector('.g-copy-link').addEventListener('click', function () {
      navigator.clipboard.writeText(galleryLink(galleryId))
        .then(function () { flash(status, 'Link copied'); })
        .catch(function () { flash(status, 'Could not copy — select it by hand'); });
    });
    box.querySelector('.g-dismiss').addEventListener('click', function () { box.remove(); });
    list.parentNode.insertBefore(box, list);
  }

  createBtn.addEventListener('click', async function () {
    const title = titleEl.value.trim();
    if (!title) { flash(createStatus, 'Type the couple&#8217;s name first.'); titleEl.focus(); return; }
    createBtn.disabled = true;
    createStatus.textContent = 'Creating…';
    try {
      const res = await createGalleryFn({ title: title });
      titleEl.value = '';
      createStatus.textContent = '';
      showPassword(res.data.galleryId, res.data.password, 'Gallery created for ' + title + '.');
      await render();
    } catch (err) {
      flash(createStatus, 'Could not create it: ' + (err && (err.code || err.message)));
    } finally {
      createBtn.disabled = false;
    }
  });

  async function loadGalleries() {
    const q = query(collection(db, 'galleries'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }

  function cardHtml(g) {
    const statusLabel = g.status === 'live' ? 'Live'
      : g.status === 'expired' ? 'Expired' : 'Not sent yet';
    return '<article class="g-card" data-id="' + esc(g.id) + '">' +
      '<header class="g-card-head">' +
        '<h3 class="g-card-title">' + esc(g.title) + '</h3>' +
        '<span class="g-status g-status-' + esc(g.status) + '">' + statusLabel + '</span>' +
      '</header>' +
      '<dl class="g-meta">' +
        '<div><dt>Photos</dt><dd class="g-count">' + (g.photoCount || 0) + '</dd></div>' +
        '<div><dt>Created</dt><dd>' + fmtDate(g.createdAt) + '</dd></div>' +
        '<div><dt>Sent</dt><dd>' + fmtDate(g.sentAt) + '</dd></div>' +
        '<div><dt>Expires</dt><dd>' + fmtDate(g.expiresAt) + '</dd></div>' +
      '</dl>' +
      '<p class="g-link"><code>' + esc(galleryLink(g.id)) + '</code></p>' +
      '<div class="s-actions">' +
        '<label class="g-upload-label">Add photos' +
          '<input type="file" class="g-upload" accept="image/*" multiple>' +
        '</label>' +
        '<button type="button" class="g-copy s-secondary">Copy link</button>' +
        '<button type="button" class="g-newpw s-secondary">New password</button>' +
        '<button type="button" class="g-delete s-secondary">Delete</button>' +
        '<span class="s-status g-card-status" aria-live="polite"></span>' +
      '</div>' +
      '<div class="g-progress" hidden><div class="g-progress-bar"></div></div>' +
    '</article>';
  }

  async function render() {
    let galleries;
    try {
      galleries = await loadGalleries();
    } catch (err) {
      list.innerHTML = '<p class="s-help">Could not load galleries: ' +
        esc(err && (err.code || err.message)) + '</p>';
      return;
    }
    if (!galleries.length) {
      list.innerHTML = '<p class="s-help">No galleries yet.</p>';
      return;
    }
    list.innerHTML = galleries.map(cardHtml).join('');
    galleries.forEach(function (g) { wireCard(g); });
  }

  function wireCard(g) {
    const card = list.querySelector('.g-card[data-id="' + g.id + '"]');
    if (!card) return;
    const status = card.querySelector('.g-card-status');
    const progress = card.querySelector('.g-progress');
    const bar = card.querySelector('.g-progress-bar');
    const countEl = card.querySelector('.g-count');

    card.querySelector('.g-copy').addEventListener('click', function () {
      navigator.clipboard.writeText(galleryLink(g.id))
        .then(function () { flash(status, 'Link copied'); })
        .catch(function () { flash(status, 'Could not copy'); });
    });

    card.querySelector('.g-newpw').addEventListener('click', async function () {
      if (!confirm('Make a new password for ' + g.title + '?\n\nThe old one stops working for anyone who has not opened the gallery yet.')) return;
      try {
        const res = await regeneratePasswordFn({ galleryId: g.id });
        showPassword(g.id, res.data.password, 'New password for ' + g.title + '.');
      } catch (err) {
        flash(status, 'Could not change it: ' + (err && (err.code || err.message)));
      }
    });

    card.querySelector('.g-delete').addEventListener('click', async function () {
      if (!confirm('Delete "' + g.title + '" and all ' + (g.photoCount || 0) + ' photos?\n\nThis cannot be undone.')) return;
      flash(status, 'Deleting…', 60000);
      try {
        await deleteGallery(g.id);
        await render();
      } catch (err) {
        flash(status, 'Could not delete it: ' + (err && (err.code || err.message)));
      }
    });

    card.querySelector('.g-upload').addEventListener('change', async function (e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      await uploadMany(g, files, { status: status, progress: progress, bar: bar, countEl: countEl });
    });
  }

  // Uploaded one at a time on purpose. A wedding is hundreds of full-size
  // photos; firing them all at once saturates her connection, makes progress
  // meaningless, and is far more likely to fail partway with no idea where.
  async function uploadMany(g, files, ui) {
    const total = files.length;
    let done = 0;
    let failed = 0;

    ui.progress.hidden = false;
    ui.bar.style.width = '0%';
    const warn = 'Uploading ' + total + ' photo' + (total === 1 ? '' : 's') + '. Keep this page open.';
    ui.status.textContent = warn;

    const guard = function (e) { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', guard);

    // Read the starting position once. Asking per photo would be another
    // query per file, and recomputing from a count is the mistake that
    // corrupted every CMS collection.
    let order;
    try {
      order = await nextPhotoOrder(db, g.id);
    } catch (err) {
      window.removeEventListener('beforeunload', guard);
      ui.progress.hidden = true;
      flash(ui.status, 'Could not start: ' + (err && (err.code || err.message)));
      return;
    }

    for (const file of files) {
      try {
        await uploadGalleryPhoto({ db: db, galleryId: g.id, file: file, order: order });
        order++;
        done++;
      } catch (err) {
        failed++;
        console.warn('[galleries] upload failed for', file.name, err);
      }
      const pct = Math.round(((done + failed) / total) * 100);
      ui.bar.style.width = pct + '%';
      ui.status.textContent = warn + ' ' + (done + failed) + ' of ' + total +
        (failed ? ' (' + failed + ' failed)' : '');
    }

    window.removeEventListener('beforeunload', guard);
    ui.progress.hidden = true;

    if (failed) {
      flash(ui.status, done + ' added, ' + failed + ' failed. Try the failed ones again.', 15000);
    } else {
      flash(ui.status, done + ' photo' + (done === 1 ? '' : 's') + ' added.');
    }
    await render();
  }

  // Firestore has no recursive delete from the browser, so the photo records
  // are removed explicitly. The Storage files are left to the scheduled
  // cleanup, which is the one place that knows how to delete them in bulk.
  async function deleteGallery(galleryId) {
    const photos = await getDocs(collection(db, 'galleries', galleryId, 'photos'));
    for (const p of photos.docs) {
      await deleteDoc(doc(db, 'galleries', galleryId, 'photos', p.id));
    }
    await deleteDoc(doc(db, 'galleries', galleryId));
  }

  render();
}
