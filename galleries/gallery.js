import { app, auth, db } from '../cms/firebase.js';
import { signInWithCustomToken } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { collection, getDocs, query, orderBy, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

// Shared with the Cloud Function, deliberately: the page has to reach the same
// answer the server did about how many parts there are and whether a finished
// zip still matches the gallery. Two copies of that arithmetic would drift.
// The file imports nothing from node, which is what makes this safe.
import { planZipParts, sourceFingerprint, partDocId } from '../functions/lib/gallery-zip.js';

const fns = getFunctions(app, 'us-west1');
const openGallery = httpsCallable(fns, 'openGallery');
// 15 minutes, matching the function's own timeout. The default 70 seconds
// would give up long before a 2GB gallery is packed.
const prepareGalleryZip = httpsCallable(fns, 'prepareGalleryZip', { timeout: 900000 });

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
  setupDownloadAll();

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



// "Download all", as one file.
//
// It used to fire one hidden <a download> per photo, 700ms apart. That works,
// but on a phone it is 240 separate saves arriving one at a time, each its own
// notification, and nothing to show for it but a Downloads folder you have to
// scroll. The couple wanted one file they could tap open.
//
// The zip is NOT built here. The old comment on this section was right that a
// wedding gallery is well over a gigabyte and a phone cannot hold that in
// memory. prepareGalleryZip builds it on the server and writes it to Storage;
// this page only asks for it and watches for it to appear.
//
// It watches rather than waits, on purpose. The call can time out, the phone
// can sleep, she can close the tab and walk away — the build carries on and
// the finished file is simply there when she comes back.

let zipPlan = [];
let zipFingerprint = '0:0';
let zipRecords = new Map();
let zipRequested = new Set();
let zipStarted = false;
let zipError = '';
let zipUnsub = null;

let dlWrap = null;
let dlButton = null;
let dlParts = null;
let dlNote = null;
let dlHint = null;

function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
  const mb = n / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

// What the server has actually got for one part. A record whose fingerprint no
// longer matches was built before she added or removed a photo, so it is a zip
// of the wrong gallery — treated as if it were not there at all.
function zipState(part) {
  const rec = zipRecords.get(partDocId(part.index));
  if (!rec || rec.fingerprint !== zipFingerprint) return { state: 'none' };
  if (rec.status === 'ready' && rec.url) return { state: 'ready', rec: rec };
  if (rec.status === 'building') return { state: 'building', rec: rec };
  if (rec.status === 'failed') return { state: 'failed', rec: rec };
  return { state: 'none', rec: rec };
}

function renderDownloadAll() {
  if (!dlWrap) return;

  const states = zipPlan.map(zipState);
  const multi = zipPlan.length > 1;
  const allReady = states.length > 0 && states.every(function (s) { return s.state === 'ready'; });
  const building = states.some(function (s) { return s.state === 'building'; }) ||
    (zipRequested.size > 0 && !allReady);
  const failed = states.some(function (s) { return s.state === 'failed'; }) || !!zipError;

  // The rows. A single-part gallery only gets one once it is ready — before
  // that the button says everything there is to say, and a greyed-out row
  // repeating it is just noise.
  dlParts.innerHTML = '';
  zipPlan.forEach(function (part, i) {
    const s = states[i];
    if (!multi && s.state !== 'ready') return;

    const li = document.createElement('li');
    li.className = 'g-dl-part';

    if (s.state === 'ready') {
      const a = document.createElement('a');
      a.className = 'g-btn g-dl-save';
      a.href = s.rec.url;
      // The file is already marked as an attachment on the server, so this is
      // belt and braces — but it is also what names the file for the couple.
      a.setAttribute('download', s.rec.name || '');
      a.textContent = multi
        ? 'Save part ' + part.index + ' of ' + part.total + ' (' + formatBytes(s.rec.bytes) + ')'
        : 'Save all ' + photos.length + ' photos (' + formatBytes(s.rec.bytes) + ')';
      li.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.className = 'g-dl-pending';
      span.textContent = 'Part ' + part.index + ' of ' + part.total + ' — ' +
        (s.state === 'building' ? 'getting ready…'
          : s.state === 'failed' ? 'did not finish'
            : 'waiting its turn');
      li.appendChild(span);
    }
    dlParts.appendChild(li);
  });

  // The button is for TAPPING, never for status. A disabled button reading
  // "Getting your photos ready…" directly above a live Save button repeats the
  // note word for word and gives the eye two pills where only one does
  // anything. While a build is running the note says so on its own.
  const someReady = states.some(function (s) { return s.state === 'ready'; });
  dlButton.hidden = allReady || (building && !failed);
  dlButton.textContent = failed ? 'Try again'
    : someReady ? 'Get the rest ready'
      : 'Download all ' + photos.length + (photos.length === 1 ? ' photo' : ' photos');

  const skipped = states.reduce(function (n, s) {
    return n + (s.state === 'ready' && s.rec.missing > 0 ? s.rec.missing : 0);
  }, 0);

  dlNote.textContent = failed
    ? (zipError || 'Something went wrong making your file.') +
      ' Tap Try again — or use the ↓ arrow on any photo to save it on its own.'
    : building
      ? 'Getting your photos ready. This takes a couple of minutes — you can leave ' +
        'this page open, or close it and come back later.'
      : allReady && skipped
        ? skipped + (skipped === 1 ? ' photo' : ' photos') + ' could not be added to the file. ' +
          'Use the ↓ arrow on those to save them on their own.'
        : '';

  // Only worth saying once there is a file to save.
  dlHint.hidden = !someReady;
}

// Ask the server for the first part that is neither done nor already being
// built. Called again on every change, so parts 2 and 3 follow on their own.
async function askForNextPart() {
  const next = zipPlan.find(function (part) {
    const s = zipState(part).state;
    return s !== 'ready' && s !== 'building';
  });
  if (!next || zipRequested.has(next.index)) return;

  zipRequested.add(next.index);
  zipError = '';
  renderDownloadAll();

  try {
    await prepareGalleryZip({ galleryId: galleryId, part: next.index });
  } catch (err) {
    const code = err && err.code;
    // The build outlives this call. A timeout here means the connection gave
    // up, not that the zip failed — the listener is what reports the truth.
    if (code === 'functions/deadline-exceeded' || code === 'functions/cancelled') return;
    const rec = zipRecords.get(partDocId(next.index));
    if (rec && (rec.status === 'building' || rec.status === 'ready')) return;
    zipRequested.delete(next.index);
    zipError = (err && err.message) || 'Something went wrong making your file.';
    renderDownloadAll();
  }
}

function setupDownloadAll() {
  const head = document.querySelector('.g-gallery-head');
  if (!head) return;

  zipPlan = planZipParts(photos);
  zipFingerprint = sourceFingerprint(photos);
  if (!zipPlan.length) return;

  if (!dlWrap) {
    dlWrap = document.createElement('div');
    dlWrap.className = 'g-dl';

    dlButton = document.createElement('button');
    dlButton.type = 'button';
    dlButton.id = 'gDownloadAll';
    dlButton.className = 'g-btn g-download-all';
    dlButton.addEventListener('click', function () {
      zipStarted = true;
      zipError = '';
      // A retry has to forget what was asked before, or the failed part would
      // be skipped over as "already requested" and the button would do nothing.
      zipRequested = new Set();
      askForNextPart();
    });

    dlParts = document.createElement('ul');
    dlParts.className = 'g-dl-parts';

    dlNote = document.createElement('p');
    dlNote.className = 'g-copy g-dl-note';
    dlNote.setAttribute('aria-live', 'polite');

    dlHint = document.createElement('p');
    dlHint.className = 'g-note g-dl-hint';
    dlHint.hidden = true;
    dlHint.textContent = 'On an iPhone the file lands in Files › Downloads. ' +
      'Tap it once and it opens into a folder with all your photos inside.';

    dlWrap.appendChild(dlButton);
    dlWrap.appendChild(dlParts);
    dlWrap.appendChild(dlNote);
    dlWrap.appendChild(dlHint);
    head.appendChild(dlWrap);
  }

  renderDownloadAll();

  if (zipUnsub) zipUnsub();
  zipUnsub = onSnapshot(
    collection(db, 'galleries', galleryId, 'zips'),
    function (snap) {
      zipRecords = new Map();
      snap.forEach(function (d) { zipRecords.set(d.id, d.data()); });
      renderDownloadAll();
      // Only ever continues a chain the couple started. A visitor who has not
      // tapped anything must not set a gigabyte of packing going.
      if (zipStarted) askForNextPart();
    },
    function (err) {
      console.warn('[gallery] could not watch the zip records:', err);
    }
  );
}
