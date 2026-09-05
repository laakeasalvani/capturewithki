import { app } from '../cms/firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const functions = getFunctions(app, 'us-west1');
const openContract = httpsCallable(functions, 'openContract');
const signContract = httpsCallable(functions, 'signContract');

const noLink = document.getElementById('sNoLink');
const loading = document.getElementById('sLoading');
const errorPanel = document.getElementById('sError');
const contractPanel = document.getElementById('sContract');
const confirmPanel = document.getElementById('sConfirm');

const clientNameEl = document.getElementById('sClientName');
const metaEl = document.getElementById('sMeta');
const bodyEl = document.getElementById('contract-body');

const form = document.getElementById('sSignForm');
const consentEl = document.getElementById('sConsent');
const nameEl = document.getElementById('sName');
const signBtn = document.getElementById('sSignBtn');
const signErrorEl = document.getElementById('sSignError');
const confirmTextEl = document.getElementById('sConfirmText');

function show(which) {
  noLink.hidden = which !== 'nolink';
  loading.hidden = which !== 'loading';
  errorPanel.hidden = which !== 'error';
  contractPanel.hidden = which !== 'contract';
  confirmPanel.hidden = which !== 'confirm';
}

function tokenFromUrl() {
  const raw = new URLSearchParams(location.search).get('t');
  return typeof raw === 'string' ? raw.trim() : '';
}

// A hint left by the redirect back from checkout, nothing more. Anyone can
// close the checkout tab, block the redirect, or type this parameter onto
// the URL themselves — it is never treated as proof of payment. Only
// openContract's own read of the contract's status (set by the webhook, or
// by the fake completion) may say the retainer is in.
function paidHintFromUrl() {
  return new URLSearchParams(location.search).get('paid') === '1';
}

function formatCents(cents) {
  if (!Number.isInteger(cents)) return null;
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-$' : '$') + grouped + '.' + rest;
}

function formatSignedAt(ms) {
  if (typeof ms !== 'number') return 'recently';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  } catch (e) {
    return 'recently';
  }
}

// status comes from openContract's read of the actual document — the only
// place this page trusts as proof of payment. opts.paidHint is the redirect
// parameter, a hint only; opts.checkoutFailed covers the case where signing
// worked but no payment session could be created. Never conflate the hint
// with the read: a contract can come back here with ?paid=1 long before, or
// even without, the webhook ever landing.
function signedMessage(status, signedAt, opts) {
  const o = opts || {};
  const signedLine = 'You signed this agreement on ' + formatSignedAt(signedAt) + '.';
  if (o.checkoutFailed) {
    return 'Your agreement is signed. We couldn’t open the payment page just now — ' +
      'Khiara will email you a link to pay the retainer shortly.';
  }
  if (status === 'paid') {
    return signedLine + ' Your retainer has been received — your date is held.';
  }
  if (o.paidHint) {
    return signedLine + ' Thanks — we’re confirming your payment now. ' +
      'This can take a minute; refresh this page to check.';
  }
  return signedLine;
}

function showConfirmed(status, signedAt, opts) {
  confirmTextEl.textContent = signedMessage(status, signedAt, opts);
  show('confirm');
}

const token = tokenFromUrl();
if (!token) {
  show('nolink');
} else {
  show('loading');
  openContract({ token: token }).then(function (res) {
    const data = res.data || {};

    clientNameEl.textContent = data.clientName
      ? 'Your agreement, ' + data.clientName
      : 'Your agreement';

    const metaParts = [];
    if (data.eventDate) metaParts.push('Event date: ' + data.eventDate);
    const total = formatCents(data.totalCents);
    const retainer = formatCents(data.retainerCents);
    if (total) metaParts.push('Total ' + total);
    if (retainer) metaParts.push('Retainer due ' + retainer);
    metaEl.textContent = metaParts.join(' · ');

    // documentSnapshot was rendered server-side by renderTemplate, which
    // escaped every client-supplied value. The remaining HTML is the
    // admin-authored template's own. innerHTML is correct HERE and only
    // because of that — never point it at anything a client can write.
    bodyEl.innerHTML = data.documentSnapshot || '';

    if (data.status === 'signed' || data.status === 'paid' || data.signedAt) {
      // The real status, read from the document, decides the message —
      // the ?paid=1 the client may have arrived with is only a hint that
      // gets consulted when the document itself doesn't yet say 'paid'.
      showConfirmed(data.status, data.signedAt, { paidHint: paidHintFromUrl() });
      return;
    }

    show('contract');
    nameEl.focus();
  }).catch(function () {
    // openContract deliberately returns one identical refusal for every bad
    // token, expired contract, or cancelled one, so a prober can't learn
    // which. This page must not undo that by showing anything more specific
    // — including for a genuine server error, which looks the same to a
    // client as a bad link either way.
    show('error');
  });
}

function updateSignBtn() {
  const nameOk = nameEl.value.trim().length > 0;
  signBtn.disabled = !(consentEl.checked && nameOk);
}
consentEl.addEventListener('change', updateSignBtn);
nameEl.addEventListener('input', updateSignBtn);

form.addEventListener('submit', function (e) {
  e.preventDefault();
  // A disabled button still permits Enter-key form submission, and the name field
  // is focused on load, so Enter is how many clients will submit. Without this,
  // a second Enter while the first call is in flight fires signContract twice and
  // writes two 'signed' rows into what is meant to be the legal audit trail.
  if (signBtn.disabled) return;
  const typedName = nameEl.value.trim();
  if (!consentEl.checked || !typedName) {
    updateSignBtn();
    return;
  }

  // Disabled immediately: without this, a double-tap on a slow connection
  // fires signContract twice. The function is idempotent so the second call
  // is harmless, but the client would see two spinners and assume it failed.
  signBtn.disabled = true;
  signErrorEl.textContent = 'Signing…';

  signContract({ token: token, typedName: typedName, consent: true }).then(function (res) {
    const data = res.data || {};
    signErrorEl.textContent = '';
    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }
    // The provider was unreachable (or, on a replay, no new session was
    // made). Say something true rather than something reassuring: the
    // agreement IS signed, and do not imply the date is held.
    showConfirmed(null, data.signedAt, { checkoutFailed: true });
  }).catch(function () {
    signErrorEl.textContent = 'Something went wrong sending your signature. Please try again.';
    updateSignBtn();
  });
});
