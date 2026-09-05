// TEST-ONLY page. Completes a fake checkout session by calling the
// fakeCheckoutComplete callable, which itself refuses anything not on the
// hard-coded allowlist in functions/lib/payments.js — this page has no
// power of its own, it just triggers the server-side check.
import { app } from '../../cms/firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const functions = getFunctions(app, 'us-west1');
const fakeCheckoutComplete = httpsCallable(functions, 'fakeCheckoutComplete');

const contractIdEl = document.getElementById('fpContractId');
const amountEl = document.getElementById('fpAmount');
const btn = document.getElementById('fpBtn');
const msgEl = document.getElementById('fpMsg');

function formatCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(Math.round(n));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + grouped + '.' + rest;
}

function setMessage(text, kind) {
  msgEl.textContent = text;
  msgEl.className = kind ? 'fp-' + kind : '';
}

const params = new URLSearchParams(location.search);
const sessionId = (params.get('s') || '').trim();
const contractId = (params.get('c') || '').trim();
const amountCents = params.get('a');

contractIdEl.textContent = contractId || '(unknown)';
amountEl.textContent = amountCents !== null ? formatCents(amountCents) : '(unknown)';

if (!sessionId) {
  setMessage('No test session in this link. Nothing to pay.', 'error');
} else {
  btn.disabled = false;
}

btn.addEventListener('click', function () {
  btn.disabled = true;
  setMessage('Pretending to pay…', '');

  fakeCheckoutComplete({ sessionId: sessionId }).then(function () {
    setMessage('Done. This contract was marked paid as a TEST payment.', 'ok');
  }).catch(function (err) {
    btn.disabled = false;
    // Whatever the callable refused for — not allowlisted, already paid,
    // unknown session — this page shows it plainly, since only Laakea and
    // Khiara can ever reach this far in the first place.
    const message = (err && err.message) ? err.message : 'That test payment could not be completed.';
    setMessage(message, 'error');
  });
});
