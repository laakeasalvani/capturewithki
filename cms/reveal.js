// Every photo stays invisible until ITS OWN photo has painted.
//
// The previous approach hid everything behind one flag, `cms-pending`, and
// dropped that flag the moment the HERO finished loading. Every other photo
// became visible on the hero's schedule rather than its own, so any image
// whose real source had not arrived yet painted the placeholder baked into
// index.html — a stock photo — and flipped to Khiara's a moment later. That
// is the flash.
//
// Keying off each image individually is also why this covers photos added in
// future: nothing here holds a list of which images exist.

const PENDING = 'cms-img-pending';

// Bounded backoff rather than an endless retry. A genuinely missing file would
// otherwise be re-requested forever, on a phone, on her clients' data.
const RETRY_DELAYS = [1000, 2000, 4000, 8000];

// Images still waiting, so a returning connection or a re-shown tab can give
// them another go without keeping a timer running for each.
const waiting = new Set();

export function markPending(img) {
  if (!img) return;
  img.classList.add(PENDING);
}

function reveal(img) {
  img.classList.remove(PENDING);
  waiting.delete(img);
  if (img.__cwkCleanup) { img.__cwkCleanup(); img.__cwkCleanup = null; }
}

// Already decoded — the browser had it cached and painted nothing wrong.
function isReady(img) {
  return img.complete && img.naturalWidth > 0;
}

function attempt(img) {
  const url = img.__cwkWanted;
  if (!url) return;

  // Re-assigning the same src is what actually retries. Setting it to '' first
  // makes the browser treat it as a fresh request rather than a no-op.
  if (img.getAttribute('src') === url && !isReady(img)) {
    img.removeAttribute('src');
  }
  img.setAttribute('src', url);
}

function schedule(img) {
  const n = img.__cwkTries || 0;
  if (n >= RETRY_DELAYS.length) {
    // Out of quick attempts. Stay blank — a wrong photo is worse than a gap —
    // but stay in `waiting` so a reconnect or a tab switch can try again.
    return;
  }
  img.__cwkTries = n + 1;
  img.__cwkTimer = setTimeout(function () { attempt(img); }, RETRY_DELAYS[n]);
}

// Point an image at its real source and reveal it only once that source has
// painted. Safe to call more than once for the same image.
export function showWhenLoaded(img, url) {
  if (!img) return;
  if (!url) { reveal(img); return; }

  markPending(img);
  img.__cwkWanted = url;
  img.__cwkTries = 0;
  waiting.add(img);

  if (img.__cwkCleanup) img.__cwkCleanup();

  const onLoad = function () { reveal(img); };
  const onError = function () { schedule(img); };
  img.addEventListener('load', onLoad);
  img.addEventListener('error', onError);
  img.__cwkCleanup = function () {
    img.removeEventListener('load', onLoad);
    img.removeEventListener('error', onError);
    clearTimeout(img.__cwkTimer);
  };

  // The src may already be correct and decoded — a cached hit, or a second
  // call for the same url. No event would fire in that case.
  if (img.getAttribute('src') === url && isReady(img)) { reveal(img); return; }

  attempt(img);
}

// An image with no CMS override: the markup's own photo IS the current one,
// so there is nothing to swap and nothing to hide it for.
export function showAsIs(img) {
  if (!img) return;
  if (isReady(img)) { reveal(img); return; }
  markPending(img);
  waiting.add(img);
  const done = function () { reveal(img); };
  img.addEventListener('load', done, { once: true });
  img.addEventListener('error', done, { once: true });
}

function retryWaiting() {
  waiting.forEach(function (img) {
    if (isReady(img)) { reveal(img); return; }
    img.__cwkTries = 0;
    attempt(img);
  });
}

// "Keep retrying" without a permanent timer: try again when the browser says
// the connection is back, or when the visitor returns to the tab.
export function initRetries() {
  window.addEventListener('online', retryWaiting);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) retryWaiting();
  });
}

// For tests and debugging.
export function pendingCount() {
  return waiting.size;
}
