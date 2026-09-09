import { app } from '../cms/firebase.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';

const functions = getFunctions(app, 'us-west1');
const openContract = httpsCallable(functions, 'openContract');
const signContract = httpsCallable(functions, 'signContract');
// Called only from a click on the pay button below — never on page load. It
// mints a checkout session, and openContract runs on every load.
const startRetainerPayment = httpsCallable(functions, 'startRetainerPayment');

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
const confirmTitleEl = document.getElementById('sConfirmTitle');
const confirmTextEl = document.getElementById('sConfirmText');
const signedByEl = document.getElementById('sSignedBy');
const emailedCopyEl = document.getElementById('sEmailedCopy');
const payBox = document.getElementById('sPay');
const payNoteEl = document.getElementById('sPayNote');
const payBtn = document.getElementById('sPayBtn');
const payErrorEl = document.getElementById('sPayError');

// The retainer, as openContract read it off the document. Kept so the confirm
// panel can name the amount — a signed-unpaid client must be told what is
// owed, not just that something is.
let retainerCents = null;

// Whether the server has a payment provider configured at all — read from
// openContract's response, because the page itself has no way to read
// PAYMENT_PROVIDER (a server env var). While this is false, nothing on this
// page may mention a payment page, a payment link, or imply a date is held:
// there is no provider that could ever make either true. Kept module-level
// so the post-sign handler below (which gets no fresh read of its own) can
// still branch on it.
let paymentsOn = false;

// One calm sentence for every failure to open checkout, whether the provider
// refused, the network died, or the function threw. The error code never
// reaches the client.
const PAY_FAILED = 'We couldn’t open the payment page just now. Please try again in a moment.';

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

// The signature is applied to the document at DISPLAY time and is never merged
// into the stored snapshot.
//
// That snapshot is hashed the moment it is sent, and that hash is the whole
// proof that the client signed exactly what they were shown. Writing their name
// into it after the fact would break the one thing it exists to establish. So
// the template carries empty slots, the hash covers the document WITH those
// slots empty, and this fills them in the browser.
//
// Before this existed the signature block rendered as blank lines — including
// Khiara's own — so a printed copy of a signed agreement looked signed by
// nobody, with the evidence living only in a database row.
function applySignatures(data) {
  function fill(slot, value) {
    const nodes = bodyEl.querySelectorAll('[data-sig="' + slot + '"]');
    for (const el of nodes) el.textContent = value;   // textContent: the name is the client's own input
  }

  if (data.typedName && data.signedAt) {
    const when = formatSignedAt(data.signedAt);
    fill('c1-sig', data.typedName);
    fill('c1-name', data.typedName);
    fill('c1-date', when);
  }

  // No second client on this booking: remove the block rather than leave it
  // showing em dashes under a "CLIENT 2" heading, which reads as a party who
  // failed to sign instead of one who was never required to.
  const c2 = bodyEl.querySelector('[data-sig-block="client2"]');
  if (c2 && !(data.client2Name && data.client2Name.trim())) c2.remove();
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

  // A contract already marked paid is true regardless of the CURRENT
  // provider setting — this checks the document's own status, not
  // paymentsOn, so a client whose retainer already came through does not
  // get told the date "will be held" if Stripe is later switched off.
  // Checked first, above the payments-off branch, for exactly that reason.
  //
  // o.retainerReceived counts the same. When Khiara marks a retainer that
  // arrived some other way, markRetainerReceived stamps retainerReceivedAt
  // and deliberately leaves status at 'signed' — so status alone left the two
  // parties disagreeing: her dashboard said "Booked — date held" while this
  // sentence went on saying the date would be held once the retainer arrived.
  if (status === 'paid' || o.retainerReceived) {
    return signedLine + ' Your retainer has been received — your date is held.';
  }

  // Payments are off: no sentence here may mention a payment page, a
  // payment link, or a retry, because none of those exist to fail or
  // succeed. This states only what the contract itself says — that the
  // date is held once the retainer reaches Khiara some other way — and
  // never that it is held now. It does say HOW the retainer gets paid,
  // because nothing else on this page or in any email ever told the client
  // that, and "reaches Khiara" on its own is not an instruction.
  if (!o.paymentsOn) {
    return signedLine + ' Your date will be held once your retainer reaches Khiara. ' +
      'She will be in touch with the payment details.';
  }

  // Named in the message itself, not only on the button, so the amount owed
  // and the fact that the date is not held survive even if the pay block is
  // hidden. Every other surface in this system says this; this page is the
  // one that used to say "You're all set" instead.
  const amount = formatCents(retainerCents);
  const owed = amount
    ? ' The retainer of ' + amount + ' has not been paid yet, and your date is not held until it is.'
    : ' The retainer has not been paid yet, and your date is not held until it is.';
  if (o.checkoutFailed) {
    return 'Your agreement is signed.' + owed +
      ' We couldn’t open the payment page just now — you can try again below.';
  }
  if (o.paidHint) {
    return signedLine + ' Thanks — we’re confirming your payment now. ' +
      'This can take a minute; refresh this page to check.';
  }
  return signedLine + owed;
}

function showConfirmed(status, signedAt, opts) {
  const o = opts || {};
  confirmTextEl.textContent = signedMessage(status, signedAt, o);

  // "You're all set" is true of exactly one state: paid, and that is true
  // regardless of the current paymentsOn setting — checked first, same
  // reasoning as signedMessage above. While payments are off and the
  // contract is not paid, the title is simply "Signed": there is no payment
  // state to describe, so nothing here may imply one ("retainer still due"
  // names a payment path that does not exist right now).
  if (status === 'paid' || o.retainerReceived) {
    confirmTitleEl.textContent = 'You’re all set';
  } else if (!o.paymentsOn) {
    confirmTitleEl.textContent = 'Signed';
  } else {
    // Every other way this panel is reached is a signed contract with the
    // retainer still owed, where the date is not held and saying otherwise
    // is how a date gets given away.
    confirmTitleEl.textContent = 'Signed — retainer still due';
  }

  const amount = formatCents(retainerCents);

  // The pay block is never shown while payments are off — gated first, and
  // separately from needsPayment, so a stale or wrong needsPayment value can
  // never surface it. Kept (not deleted) for when Stripe returns: the button
  // is offered only when the document itself says signed-and-unpaid, and NOT
  // when the client has just come back from a successful checkout with
  // ?paid=1 — the webhook can be seconds behind, and putting a pay button in
  // front of someone who has already paid invites a second payment.
  if (o.paymentsOn && o.needsPayment && !o.paidHint) {
    payNoteEl.textContent = amount
      ? 'Your retainer of ' + amount + ' has not been paid yet. Your date is not ' +
        'held until it is.'
      : 'Your retainer has not been paid yet. Your date is not held until it is.';
    payBtn.textContent = amount ? 'Pay the retainer — ' + amount : 'Pay the retainer';
    payBtn.disabled = false;
    payErrorEl.textContent = '';
    payBox.hidden = false;
  } else {
    payBox.hidden = true;
  }

  // Who signed, and when. This appears nowhere in the frozen documentSnapshot
  // — that is hashed at send time and must never be rewritten — so it is
  // rendered here instead, from what openContract returned (or, on the visit
  // where the signature was just made, from what was typed into the form).
  // textContent, never innerHTML: the name is the client's own input.
  const who = typeof o.typedName === 'string' ? o.typedName.trim() : '';
  if (who) {
    signedByEl.textContent = 'Signed by ' + who + ' on ' + formatSignedAt(signedAt) + '.';
    signedByEl.hidden = false;
  } else {
    signedByEl.textContent = '';
    signedByEl.hidden = true;
  }

  // Only true on the visit where the signature was just made. On every later
  // visit to this link nothing is being sent, and saying a copy is on its way
  // is simply false.
  emailedCopyEl.hidden = o.justSigned !== true;

  show('confirm');

  // The agreement itself must stay on screen. #contract-body lives inside
  // #sContract, so show('confirm') hides it — and this page is what
  // signedCopyEmail calls the client's permanent record. Hiding the document
  // on the page that IS the record defeats the whole point of it. The signing
  // form goes away instead: it is already signed and must not be offered again.
  contractPanel.hidden = false;
  form.hidden = true;
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

    // Kept for the confirm panel, which has to be able to name the amount
    // still owed on a signed-but-unpaid contract.
    retainerCents = data.retainerCents;

    // Read once here and kept module-level: the post-sign handler below
    // gets no fresh openContract read of its own; it has to know whether
    // payments are on from this same value.
    paymentsOn = data.paymentsEnabled === true;

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
    applySignatures(data);

    if (data.status === 'signed' || data.status === 'paid' || data.signedAt) {
      // The real status, read from the document, decides the message —
      // the ?paid=1 the client may have arrived with is only a hint that
      // gets consulted when the document itself doesn't yet say 'paid'.
      // needsPayment comes from the document too (signed, and no paidAt), and
      // is what puts the pay button on the panel. Without it, a client whose
      // checkout was abandoned had no route back to paying at all.
      showConfirmed(data.status, data.signedAt, {
        paidHint: paidHintFromUrl(),
        needsPayment: data.needsPayment === true,
        paymentsOn: paymentsOn,
        // A retainer Khiara recorded by hand. Read from the document, exactly
        // like status — never inferred from anything on the URL.
        retainerReceived: typeof data.retainerReceivedAt === 'number',
        typedName: data.typedName
      });
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
    if (!paymentsOn) {
      // checkoutUrl is null because payments are off — the normal state
      // today, not a failure. Nothing went wrong, so nothing here may
      // apologise, offer a retry, or mention payment at all.
      showConfirmed(null, data.signedAt, {
        needsPayment: false, paymentsOn: false,
        typedName: typedName, justSigned: true
      });
      return;
    }
    // Payments ARE on and the provider was still unreachable (or, on a
    // replay, no new session was made). Say something true rather than
    // something reassuring: the agreement IS signed, and do not imply the
    // date is held. needsPayment is true because we have just this second
    // signed and nothing has been paid, so the pay button is offered as
    // the retry.
    showConfirmed(null, data.signedAt, {
      checkoutFailed: true, needsPayment: true, paymentsOn: true,
      typedName: typedName, justSigned: true
    });
  }).catch(function () {
    signErrorEl.textContent = 'Something went wrong sending your signature. Please try again.';
    updateSignBtn();
  });
});

// The pay button. Same guard the sign button carries: a disabled button still
// permits an Enter-key activation, and re-entering here while a call is in
// flight would mint a second checkout session.
payBtn.addEventListener('click', function () {
  if (payBtn.disabled) return;
  payBtn.disabled = true;
  payErrorEl.textContent = 'Opening the payment page…';

  startRetainerPayment({ token: token }).then(function (res) {
    const data = res.data || {};
    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }
    if (data.alreadyPaid) {
      // The webhook landed while this page was open. Reload rather than
      // patch the panel by hand, so what is shown comes from a fresh read of
      // the document — the only thing this page trusts as proof of payment.
      window.location.reload();
      return;
    }
    payErrorEl.textContent = PAY_FAILED;
    payBtn.disabled = false;
  }).catch(function () {
    // One calm message. startRetainerPayment refuses a bad or cancelled token
    // with the same words as every other refusal, and nothing more specific
    // than that may reach the page.
    payErrorEl.textContent = PAY_FAILED;
    payBtn.disabled = false;
  });
});
