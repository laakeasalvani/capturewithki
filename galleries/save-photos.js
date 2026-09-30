// "Download all" on a phone: straight into the photo library, no zip.
//
// A zip lands on an iPhone in Files › Downloads, has to be tapped open, and
// even then the photos are still not in Photos. The only door a website has
// into the photo library is the share sheet's "Save N Images", so on an iPhone
// that is what this uses. Android needs none of this — a downloaded photo shows
// up in Gallery on its own — and a computer keeps the zip.
//
// Two things shape the iPhone flow and are not negotiable:
//
//   1. The share sheet only opens straight after a tap. Loading the photos
//      takes minutes, so the tap that opens the box cannot also open the sheet;
//      the photos load while the box is up and a second tap saves them.
//   2. Every photo in a round is held in the page's memory until the sheet
//      takes it. A 2.5GB wedding does not fit, so big galleries go in rounds.
//
// The bytes handed over are the ORIGINAL file, exactly as uploaded — fetched
// from fullUrl and never drawn to a canvas or re-encoded. Nothing here may ever
// touch thumbUrl.
import { planSaveBatches, totalBytes, imageTypeFor } from './save-plan.js';

// How many photos an iPhone can take in one round. A placeholder until it is
// measured on a real phone — see the test mode below.
const ROUND_MAX_COUNT = 50;
const ROUND_MAX_BYTES = 300 * 1024 * 1024;

const PARALLEL_FETCHES = 3;
const FETCH_TRIES = 3;
// Android saves one file at a time. 700ms is what the original one-by-one
// "Download all" used in production without the browser dropping any.
const ANDROID_GAP_MS = 700;

let el = null;      // the box's elements, built once
let run = null;     // the current attempt; replaced on every open

export function formatBytes(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
  const mb = n / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

// opts: { photos, kind: 'ios'|'android'|'desktop', testMode, onDesktopConfirm }
export function openSaveDialog(opts) {
  build();
  if (run) run.stop();
  run = createRun(opts);
  el.box.hidden = false;
  document.body.style.overflow = 'hidden';
  run.start();
  el.primary.focus();
}

function closeDialog() {
  if (run) { run.stop(); run = null; }
  el.box.hidden = true;
  document.body.style.overflow = '';
}

function build() {
  if (el) return;
  const box = document.createElement('div');
  box.className = 'g-save';
  box.hidden = true;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'gSaveTitle');
  box.innerHTML =
    '<div class="g-save-card">' +
      '<h2 class="g-save-title" id="gSaveTitle"></h2>' +
      '<p class="g-save-size"></p>' +
      '<p class="g-copy g-save-body"></p>' +
      '<div class="g-save-bar" hidden><span></span></div>' +
      '<button type="button" class="g-btn g-save-go"></button>' +
      '<p class="g-save-hint" aria-live="polite"></p>' +
      '<button type="button" class="g-save-cancel">Cancel</button>' +
      '<div class="g-save-test" hidden>' +
        '<p class="g-save-test-head">Test mode — photos per round</p>' +
        '<div class="g-save-test-sizes"></div>' +
        '<ol class="g-save-log"></ol>' +
      '</div>' +
    '</div>';
  document.body.appendChild(box);

  el = {
    box: box,
    title: box.querySelector('.g-save-title'),
    size: box.querySelector('.g-save-size'),
    body: box.querySelector('.g-save-body'),
    bar: box.querySelector('.g-save-bar'),
    barFill: box.querySelector('.g-save-bar span'),
    primary: box.querySelector('.g-save-go'),
    hint: box.querySelector('.g-save-hint'),
    cancel: box.querySelector('.g-save-cancel'),
    test: box.querySelector('.g-save-test'),
    testSizes: box.querySelector('.g-save-test-sizes'),
    log: box.querySelector('.g-save-log')
  };

  el.primary.addEventListener('click', function () { if (run) run.tap(); });
  el.cancel.addEventListener('click', closeDialog);
  box.addEventListener('click', function (e) { if (e.target === box) closeDialog(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !box.hidden) closeDialog();
  });
}

function createRun(opts) {
  const photos = opts.photos;
  const kind = opts.kind;
  const total = totalBytes(photos);
  const sizeText = plural(photos.length, 'photo', 'photos') + ' · ' + formatBytes(total);

  let stopped = false;
  let abort = null;
  let wakeLock = null;

  // --- iPhone state
  let caps = { maxCount: ROUND_MAX_COUNT, maxBytes: ROUND_MAX_BYTES };
  let batches = [];
  let round = 0;
  let phase = 'loading';   // loading | ready | sharing | done
  let loadedCount = 0;
  let loadedBytes = 0;
  let files = null;
  let missing = [];        // photos that would not load, across all rounds
  let note = '';
  let roundStartedAt = 0;

  // --- Android state
  let saved = 0;

  function start() {
    el.title.textContent = 'Save all ' + plural(photos.length, 'photo', 'photos');
    el.size.textContent = sizeText;
    el.log.innerHTML = '';
    el.test.hidden = !(opts.testMode && kind === 'ios');
    if (opts.testMode && kind === 'ios') buildTestSizes();

    if (kind === 'ios') {
      replan();
      loadRound();
    } else {
      phase = 'ready';
    }
    render();
  }

  function stop() {
    stopped = true;
    if (abort) abort.abort();
    files = null;
    releaseWake();
  }

  function replan() {
    batches = planSaveBatches(photos, caps);
    round = 0;
    missing = [];
  }

  // --- rendering ------------------------------------------------------------

  function render() {
    if (stopped) return;
    el.cancel.textContent = phase === 'done' ? 'Close' : 'Cancel';
    if (kind === 'ios') renderIos();
    else if (kind === 'android') renderAndroid();
    else renderDesktop();
  }

  function renderIos() {
    const b = batches[round];
    const multi = batches.length > 1;
    el.body.textContent = 'These are the full-size originals, exactly as Khiara delivered them. ' +
      'Make sure your phone has at least ' + formatBytes(total) + ' of free space' +
      (multi ? ', and keep this page open — your phone saves them in ' + batches.length +
        ' rounds of about ' + Math.round(photos.length / batches.length) + '.' : '.');

    el.bar.hidden = phase !== 'loading';
    if (phase === 'loading' && b) {
      el.barFill.style.width = Math.round(100 * loadedCount / b.photos.length) + '%';
    }

    // Honest about a round that came up short: "all 60" when only 57 loaded
    // would promise three photos the sheet is never given.
    const short = files && b && files.length < b.photos.length;
    const label = b && (multi ? 'photos ' + b.first + '–' + b.last
      : short ? plural(files.length, 'photo', 'photos') : 'all ' + photos.length);
    el.primary.disabled = phase === 'loading' || phase === 'sharing';
    if (phase === 'loading') {
      el.primary.textContent = 'Getting ready… ' + loadedCount + ' of ' + b.photos.length;
    } else if (phase === 'ready') {
      el.primary.textContent = 'Save ' + label + ' to Photos';
    } else if (phase === 'sharing') {
      el.primary.textContent = 'Saving…';
    } else {
      el.primary.textContent = 'Done';
    }

    const count = files ? files.length : 0;
    let hint = note;
    if (!hint && phase === 'ready') {
      hint = 'In the menu that opens, tap “Save ' + count + (count === 1 ? ' Image' : ' Images') +
        '”. They go straight into your Photos app.';
    }
    if (!hint && phase === 'done') {
      hint = 'All done — your photos are in your Photos app.';
    }
    if (missing.length && (phase === 'done' || phase === 'ready')) {
      hint += ' ' + plural(missing.length, 'photo', 'photos') + ' would not load. ' +
        (missing.length === 1 ? 'Use the ↓ arrow on that one to save it on its own.'
          : 'Use the ↓ arrow on those to save them one at a time.');
    }
    el.hint.textContent = hint.trim();
  }

  function renderAndroid() {
    el.body.textContent = 'These are the full-size originals, exactly as Khiara delivered them. ' +
      'Make sure your phone has at least ' + formatBytes(total) + ' of free space. ' +
      'If your phone asks to allow multiple downloads, tap Allow.';
    el.bar.hidden = phase !== 'saving';
    if (phase === 'saving') el.barFill.style.width = Math.round(100 * saved / photos.length) + '%';
    el.primary.disabled = phase === 'saving';
    el.primary.textContent = phase === 'saving' ? 'Saving ' + saved + ' of ' + photos.length + '…'
      : phase === 'done' ? 'Done'
        : 'Save all ' + plural(photos.length, 'photo', 'photos');
    el.hint.textContent = phase === 'saving'
      ? 'Keep this page open until it finishes.'
      : phase === 'done'
        ? 'All done — they are in your Gallery or Google Photos, in the Download folder.'
        : '';
  }

  function renderDesktop() {
    el.body.textContent = 'These are the full-size originals, exactly as Khiara delivered them, ' +
      'in one zip file. Make sure you have at least ' + formatBytes(total) + ' of free space.';
    el.bar.hidden = true;
    el.primary.disabled = false;
    el.primary.textContent = 'Download all';
    el.hint.textContent = '';
  }

  // --- the button -----------------------------------------------------------

  function tap() {
    if (phase === 'done') { closeDialog(); return; }
    if (kind === 'ios') { if (phase === 'ready') share(); return; }
    if (kind === 'android') { if (phase === 'ready') saveAndroid(); return; }
    closeDialog();
    opts.onDesktopConfirm();
  }

  // --- iPhone: load a round, then share it ----------------------------------

  async function loadRound() {
    if (stopped) return;
    const b = batches[round];
    phase = 'loading';
    loadedCount = 0;
    loadedBytes = 0;
    files = null;
    roundStartedAt = Date.now();
    abort = new AbortController();
    const signal = abort.signal;
    holdWake();
    render();

    const out = new Array(b.photos.length);
    let next = 0;
    async function worker() {
      while (next < b.photos.length && !signal.aborted) {
        const i = next++;
        const p = b.photos[i];
        const file = await fetchOriginal(p, signal);
        if (signal.aborted) return;
        if (file) { out[i] = file; loadedBytes += file.size; }
        else missing.push(p);
        loadedCount++;
        render();
      }
    }
    const workers = [];
    for (let k = 0; k < PARALLEL_FETCHES; k++) workers.push(worker());
    await Promise.all(workers);
    if (signal.aborted || stopped) return;

    releaseWake();
    files = out.filter(Boolean);
    logTest('Round ' + (round + 1) + ' of ' + batches.length + ': loaded ' + files.length +
      ' photos (' + formatBytes(loadedBytes) + ') in ' +
      Math.round((Date.now() - roundStartedAt) / 1000) + 's');

    if (!files.length) {
      // Nothing in this round would load. Say so rather than offer to share
      // an empty list, and move on so one bad round cannot strand the rest.
      note = 'Those photos would not load. Check your connection.';
      afterRound();
      return;
    }
    phase = 'ready';
    note = '';
    render();
  }

  async function fetchOriginal(p, signal) {
    for (let attempt = 1; attempt <= FETCH_TRIES; attempt++) {
      try {
        // no-store, deliberately: the viewer may already have loaded this
        // photo through an <img>, which sends no Origin header. Reusing that
        // cached copy for a fetch fails the cross-origin check in Safari.
        const res = await fetch(p.fullUrl, { signal: signal, cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        return new File([blob], p.name || 'photo.jpg', {
          type: imageTypeFor(blob.type || res.headers.get('Content-Type'), p.name)
        });
      } catch (err) {
        if (signal.aborted) return null;
        console.warn('[gallery] could not load', p.name, 'try', attempt, err);
        if (attempt < FETCH_TRIES) await wait(1000 * attempt);
      }
    }
    return null;
  }

  async function share() {
    const count = files.length;
    const bytes = files.reduce(function (n, f) { return n + f.size; }, 0);
    phase = 'sharing';
    note = '';
    render();
    try {
      // Files only. Adding a title or url changes what the sheet offers, and
      // "Save N Images" is the only option that matters here.
      await navigator.share({ files: files });
      logTest('Round ' + (round + 1) + ': shared ' + count + ' photos (' + formatBytes(bytes) + ') ✓');
      afterRound();
    } catch (err) {
      const name = (err && err.name) || 'Error';
      logTest('Round ' + (round + 1) + ': share of ' + count + ' photos (' + formatBytes(bytes) +
        ') did not finish — ' + name + (err && err.message ? ': ' + err.message : ''));
      phase = 'ready';
      note = name === 'AbortError'
        ? 'Nothing was saved. Tap the button again, then choose “Save ' + count + ' Images”.'
        : 'That did not work. Tap the button to try again.';
      render();
    }
  }

  function afterRound() {
    files = null; // let the photos go before loading the next round
    round++;
    if (round < batches.length) {
      loadRound();
    } else {
      phase = 'done';
      if (!note || /would not load/.test(note)) note = '';
      render();
    }
  }

  // --- Android: plain downloads, one after another ---------------------------

  async function saveAndroid() {
    phase = 'saving';
    saved = 0;
    holdWake();
    render();
    for (const p of photos) {
      if (stopped) return;
      const a = document.createElement('a');
      a.href = p.fullUrl;
      a.setAttribute('download', p.name || 'photo.jpg');
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      saved++;
      render();
      await wait(ANDROID_GAP_MS);
    }
    releaseWake();
    phase = 'done';
    render();
  }

  // --- keeping the screen on -------------------------------------------------

  // A locked screen stalls the loading. Best effort only — not every phone
  // supports it, and nothing breaks without it.
  async function holdWake() {
    try {
      if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      // Closed while the request was pending: let the screen sleep again.
      if (stopped) releaseWake();
    } catch (err) { /* not available; carry on */ }
  }
  function releaseWake() {
    if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; }
  }

  // --- test mode ---------------------------------------------------------------
  // Only with ?test=save in the address. Lets Laakea find, on a real iPhone,
  // how big a round can be before the phone refuses. Remove once measured.

  function buildTestSizes() {
    el.testSizes.innerHTML = '';
    [25, 50, 100, 200, Infinity].forEach(function (n) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-save-test-size';
      b.textContent = isFinite(n) ? String(n) : 'All';
      b.setAttribute('aria-pressed', String(caps.maxCount === n));
      b.addEventListener('click', function () {
        if (abort) abort.abort();
        caps = { maxCount: n, maxBytes: Infinity };
        el.testSizes.querySelectorAll('button').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        logTest('— switched to ' + b.textContent + ' per round —');
        replan();
        note = '';
        loadRound();
      });
      el.testSizes.appendChild(b);
    });
  }

  function logTest(line) {
    if (!opts.testMode) return;
    const li = document.createElement('li');
    li.textContent = line;
    el.log.appendChild(li);
  }

  return { start: start, stop: stop, tap: tap };
}

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
