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

function showConfirmed(signedAt) {
  confirmTextEl.textContent = 'You signed this agreement on ' + formatSignedAt(signedAt) + '.';
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

    if (data.status === 'signed' || data.signedAt) {
      showConfirmed(data.signedAt);
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
    showConfirmed(data.signedAt);
  }).catch(function () {
    signErrorEl.textContent = 'Something went wrong sending your signature. Please try again.';
    updateSignBtn();
  });
});
