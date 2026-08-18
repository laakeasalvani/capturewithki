import { app, auth, db } from '../cms/firebase.js';
import { signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { collection, getDocs, query, orderBy } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const openGallery = httpsCallable(getFunctions(app, 'us-west1'), 'openGallery');

const noLink = document.getElementById('gNoLink');
const lock = document.getElementById('gLock');
const gallery = document.getElementById('gGallery');
const form = document.getElementById('gForm');
const passwordEl = document.getElementById('gPassword');
const enterBtn = document.getElementById('gEnter');
const errorEl = document.getElementById('gError');
const nameEl = document.getElementById('gName');
const metaEl = document.getElementById('gMeta');
const grid = document.getElementById('gGrid');
const gridNote = document.getElementById('gGridNote');

const viewer = document.getElementById('gViewer');
const viewerImg = document.getElementById('gViewerImg');
const countEl = document.getElementById('gCount');
const downloadEl = document.getElementById('gDownload');

let photos = [];
let current = 0;

// The site's own no-right-click rule deliberately does NOT apply here. These
// are paying clients collecting their own photos; blocking the gesture would
// fight the entire purpose of the page.

function show(which) {
  noLink.hidden = which !== 'nolink';
  lock.hidden = which !== 'lock';
  gallery.hidden = which !== 'gallery';
}

function galleryIdFromUrl() {
  const raw = new URLSearchParams(location.search).get('g');
  return typeof raw === 'string' ? raw.trim() : '';
}

const galleryId = galleryIdFromUrl();
if (!galleryId) {
  show('nolink');
} else {
  show('lock');
  passwordEl.focus();
}

form.addEventListener('submit', async function (e) {
  e.preventDefault();
  // The field is styled text-transform:uppercase, so a password typed in
  // lowercase LOOKED correct on screen while the lowercase text was what got
  // sent — a correct password refused, with the screen insisting it was right.
  // Generated passwords only ever use the uppercase alphabet in
  // gallery-auth.js, so folding case here is safe and loses nothing.
  const password = passwordEl.value.trim().toUpperCase();
  if (!password) {
    errorEl.textContent = 'Type the password Khiara gave you.';
    passwordEl.focus();
    return;
  }

  enterBtn.disabled = true;
  errorEl.textContent = 'Checking…';

  try {
    // The function decides everything. This page never learns whether the
    // gallery exists, whether it expired, or whether only the password was
    // wrong — one message covers all of it, so the link cannot be probed.
    const res = await openGallery({ galleryId: galleryId, password: password });
    const token = res.data && res.data.token;
    if (!token) throw new Error('no token');

    await signInWithCustomToken(auth, token);

    nameEl.textContent = res.data.title || 'Your gallery';
    errorEl.textContent = '';
    await loadPhotos(res.data.expiresAt);
    show('gallery');
  } catch (err) {
    const code = err && err.code;
    errorEl.textContent = code === 'functions/resource-exhausted'
      ? (err.message || 'Too many tries. Please wait a while and try again.')
      : 'That password is not right. Check the message from Khiara.';
    passwordEl.select();
  } finally {
    enterBtn.disabled = false;
  }
});

function daysLeft(expiresAt) {
  if (typeof expiresAt !== 'number') return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / 86400000);
}

async function loadPhotos(expiresAt) {
  const snap = await getDocs(query(collection(db, 'galleries', galleryId, 'photos'), orderBy('order')));
  photos = [];
  snap.forEach(function (d) { photos.push(Object.assign({ id: d.id }, d.data())); });

  const left = daysLeft(expiresAt);
  if (left === null) {
    metaEl.textContent = photos.length + (photos.length === 1 ? ' photo' : ' photos');
  } else {
    // Said plainly, because the photos really are deleted afterwards.
    metaEl.textContent = photos.length + (photos.length === 1 ? ' photo' : ' photos') +
      ' · available for ' + left + (left === 1 ? ' more day' : ' more days') +
      ' — please download the ones you want to keep';
  }

  if (!photos.length) {
    gridNote.textContent = 'Khiara has not added the photos yet. Check back shortly.';
    return;
  }
  gridNote.textContent = '';
  buildDownloadAll();

  grid.innerHTML = '';
  photos.forEach(function (p, i) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'g-tile';
    tile.setAttribute('aria-label', 'Open photo ' + (i + 1));
    const dl = document.createElement('a');
    dl.className = 'g-tile-dl';
    dl.href = p.fullUrl;
    dl.setAttribute('download', p.name || 'photo.jpg');
    dl.setAttribute('aria-label', 'Download this photo');
    dl.textContent = '\u2193';
    // The tile is a button; without this the click would open the preview too.
    dl.addEventListener('click', function (e) { e.stopPropagation(); });

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    // Browsing uses the small preview. The full-size original is fetched only
    // when they download it — an 800-photo gallery of originals would be well
    // over a gigabyte and would never finish on a phone.
    img.src = p.thumbUrl || p.fullUrl;
    tile.appendChild(img);
    tile.addEventListener('click', function () { openViewer(i); });
    grid.appendChild(tile);
    // Outside the button, because a link inside a button is invalid markup and
    // browsers handle it inconsistently. The wrapper positions it over the tile.
    const wrap = document.createElement('div');
    wrap.className = 'g-tile-wrap';
    grid.replaceChild(wrap, tile);
    wrap.appendChild(tile);
    wrap.appendChild(dl);
  });
}

function openViewer(i) {
  if (!photos.length) return;
  current = (i + photos.length) % photos.length;
  const p = photos[current];
  viewerImg.src = p.fullUrl;
  viewerImg.alt = p.name || '';
  countEl.textContent = (current + 1) + ' of ' + photos.length;
  downloadEl.href = p.fullUrl;
  downloadEl.setAttribute('download', p.name || 'photo.jpg');
  viewer.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeViewer() {
  viewer.hidden = true;
  viewerImg.removeAttribute('src');
  document.body.style.overflow = '';
}

document.getElementById('gClose').addEventListener('click', closeViewer);
document.getElementById('gPrev').addEventListener('click', function () { openViewer(current - 1); });
document.getElementById('gNext').addEventListener('click', function () { openViewer(current + 1); });

viewer.addEventListener('click', function (e) {
  // Clicking the backdrop closes; clicking the photo or a control does not.
  if (e.target === viewer) closeViewer();
});

document.addEventListener('keydown', function (e) {
  if (viewer.hidden) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') openViewer(current - 1);
  if (e.key === 'ArrowRight') openViewer(current + 1);
});


// "Download all", one photo at a time.
//
// Deliberately not a zip: a 500-photo wedding is well over a gigabyte, and
// building that in a phone's memory is the single most likely thing to fail.
// Saving them one after another is slower but it either works or tells you
// which photo it stopped on.
function buildDownloadAll() {
  const head = document.querySelector('.g-gallery-head');
  if (!head || document.getElementById('gDownloadAll')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'gDownloadAll';
  btn.className = 'g-btn g-download-all';
  btn.textContent = 'Download all ' + photos.length + ' photos';

  const note = document.createElement('p');
  note.className = 'g-copy g-dl-note';
  note.setAttribute('aria-live', 'polite');

  btn.addEventListener('click', async function () {
    btn.disabled = true;
    // Browsers ask before saving many files at once. Say so first, or it looks
    // like something has gone wrong.
    note.textContent = 'Starting… your browser may ask permission to save several files. Please say yes.';

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const a = document.createElement('a');
      a.href = p.fullUrl;
      a.setAttribute('download', p.name || ('photo-' + (i + 1) + '.jpg'));
      document.body.appendChild(a);
      a.click();
      a.remove();
      note.textContent = 'Saving ' + (i + 1) + ' of ' + photos.length + '…';
      // A pause between each: firing hundreds at once makes a browser drop most
      // of them silently.
      await new Promise(function (r) { setTimeout(r, 700); });
    }

    note.textContent = 'All ' + photos.length + ' sent to your downloads. ' +
      'If any are missing, use the arrow on that photo to save it again.';
    btn.disabled = false;
  });

  head.appendChild(btn);
  head.appendChild(note);
}
