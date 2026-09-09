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
const sigRecord = document.getElementById('sSigRecord');
const sigPhotogName = document.getElementById('sSigPhotogName');
const sigPhotogDate = document.getElementById('sSigPhotogDate');
const sigClientRole = document.getElementById('sSigClientRole');
const sigClientName = document.getElementById('sSigClientName');
const sigClientDate = document.getElementById('sSigClientDate');
const sigClient2Block = document.getElementById('sSigClient2Block');
const sigClient2Name = document.getElementById('sSigClient2Name');
const sigClient2Date = document.getElementById('sSigClient2Date');
const whoSignsEl = document.getElementById('sWhoSigns');

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

// Which partner the form is currently collecting. Both sign on this one link
// in turn, so after Client 1 signs the form comes back for Client 2 — and the
// sign handler needs to know which of them it just recorded without a fresh
// read from the server.
let awaitingSigner = 'client1';
let client1Label = 'Client';
let client2Label = '';

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

// The signature record, shown in its own panel below the form.
//
// It is deliberately NOT part of the agreement text. The document is frozen
// and hashed the moment it is sent, so a signature can never be written into
// it without breaking the one thing that hash exists to prove. Every
// e-signature service draws the same line: the agreement is fixed, the
// signature is a record attached to it.
//
// Her half is real from the start — she countersigns before the contract goes
// out, so it is filled in even while the client is still reading.
function renderSignatureRecord(data) {
  if (!sigRecord) return;
  sigRecord.hidden = false;

  // textContent throughout: these are names, one of which the client typed.
  sigPhotogName.textContent = data.photographerName || 'Khiara Salvani';
  sigPhotogDate.textContent = typeof data.photographerSignedAt === 'number'
    ? formatSignedAt(data.photographerSignedAt)
    : '\u2014';

  const hasClient2 = !!(data.client2Name && data.client2Name.trim());
  sigClientRole.textContent = hasClient2 ? 'Client 1' : 'Client';

  if (data.typedName && data.signedAt) {
    sigClientName.textContent = data.typedName;
    sigClientDate.textContent = formatSignedAt(data.signedAt);
  } else {
    // A dash and a plain statement, never a blank line. A blank reads as a
    // party who failed to sign; this reads as one who has not signed yet.
    sigClientName.textContent = '\u2014';
    sigClientDate.textContent = 'Not yet signed';
  }

  // The column only exists when the contract names a second client. Shown
  // with a dash while waiting, so the couple can see one signature is still
  // outstanding rather than assuming the agreement is done.
  sigClient2Block.hidden = !hasClient2;
  if (hasClient2) {
    if (data.typedName2 && data.signed2At) {
      sigClient2Name.textContent = data.typedName2;
      sigClient2Date.textContent = formatSignedAt(data.signed2At);
    } else {
      sigClient2Name.textContent = '\u2014';
      sigClient2Date.textContent = 'Not yet signed';
    }
  }
}

// The signature filling in as they type.
//
// The point is to make plain that the name they are typing IS the signature,
// rather than a form field on the way to producing one somewhere else. So the
// ink appears at full strength, exactly as it will read once signed.
//
// Which makes the date line load-bearing. It deliberately still says "Not yet
// signed" throughout, and this function never touches it — with the ink already
// looking final, the date is the only thing on the panel still saying the
// agreement has not been entered into. renderSignatureRecord and the sign
// handler own that line; this owns nothing but the name.
//
// Writes to whichever slot is currently being asked for, so the second partner
// gets the same behaviour on their turn without writing over the signature the
// first one already made. textContent, never innerHTML, like every other path
// that touches this panel: it is the client's own unescaped input.
function previewSignature() {
  if (!nameEl || !sigRecord || sigRecord.hidden) return;
  const slot = awaitingSigner === 'client2' ? sigClient2Name : sigClientName;
  if (!slot) return;
  const typed = nameEl.value.trim();
  // Back to the dash rather than a blank line if they clear the box — a blank
  // reads as a party who failed to sign, the same reasoning as elsewhere here.
  slot.textContent = typed || '—';
}

// Points the form at whichever partner still has to sign, and names them.
// Without this the second partner is shown a form they just watched somebody
// else fill in, with no indication it is now their turn.
function askSigner(who) {
  awaitingSigner = who;
  const name = who === 'client2' ? client2Label : client1Label;
  whoSignsEl.hidden = false;
  whoSignsEl.textContent = who === 'client2'
    ? name + ', it is your turn to sign. Your partner has signed above.'
    : name + ', please read the agreement above and sign below.';
  nameEl.value = '';
  consentEl.checked = false;
  signBtn.disabled = true;
  signErrorEl.textContent = '';
  // The box was just emptied, so empty the preview with it. Without this the
  // second partner is handed a form showing a name they did not type.
  previewSignature();
}

// Her timezone, not the reader's — and it must match the one the server uses
// for her countersignature (BUSINESS_TZ in functions/index.js). Left as the
// browser's own zone, a client signing at 23:00 Pacific saw themselves dated a
// day BEFORE the photographer on the same document, and a client abroad saw a
// different date again from the one stored in the audit record.
const BUSINESS_TZ = 'America/Los_Angeles';   // Portland, Oregon

function formatSignedAt(ms) {
  if (typeof ms !== 'number') return 'recently';
  try {
    return new Date(ms).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: BUSINESS_TZ
    });
  } catch (e) {
    // Noisy on purpose. This catch exists for an unparseable date, but it
    // will happily swallow a ReferenceError too — and it did: a deleted
    // BUSINESS_TZ turned every date on a signed contract into the word
    // "recently", which looks like a deliberate choice rather than a fault.
    // A silent fallback on a legal document is worse than a loud one.
    console.warn('[sign] could not format a date:', e && e.message);
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
  // Both names when both signed. Naming only the last one told a couple
  // "Signed by Sam Rivera" on an agreement Jordan had signed too — the very
  // thing a second signature was added to record. The names come from the
  // signature panel, which is populated either from openContract's read or
  // from the slot the server reported, so this cannot drift from what was
  // actually stored.
  const who = typeof o.typedName === 'string' ? o.typedName.trim() : '';
  const dash = '\u2014';
  const n1 = sigClientName ? sigClientName.textContent.trim() : '';
  const n2 = (sigClient2Block && !sigClient2Block.hidden && sigClient2Name)
    ? sigClient2Name.textContent.trim() : '';
  const both = (n1 && n1 !== dash && n2 && n2 !== dash) ? n1 + ' and ' + n2 : '';

  if (both || who) {
    signedByEl.textContent = 'Signed by ' + (both || who) + ' on ' + formatSignedAt(signedAt) + '.';
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
    // Names for the form's prompt, captured before any branch below returns.
    client1Label = data.clientName || 'Client';
    client2Label = (data.client2Name && data.client2Name.trim()) || 'Client 2';

    renderSignatureRecord(data);

    // One of two signatures is not a signed contract. A two-signer agreement
    // waiting on the second partner must NOT reach the confirm panel — it
    // shows the form again, addressed to them. Checked before the signed
    // branch below, which keys on signedAt and would otherwise swallow this
    // case the moment Client 1 signed.
    if (data.awaitingSigner === 'client2') {
      show('contract');
      askSigner('client2');
      return;
    }

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
    askSigner('client1');
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
nameEl.addEventListener('input', previewSignature);

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

    // The panel is drawn from openContract's read, which happened before this
    // signature existed — so without this it went on saying "Not yet signed"
    // on a contract the client had just signed, immediately below the words
    // confirming they had. There is no fresh read on this path, so update it
    // from what we know: the name they typed and the timestamp the server
    // returned.
    // Into the slot the SERVER says it recorded, not the one this page
    // assumed. signedSlot is authoritative — the server decides whose turn it
    // was from what is already on the contract, so trusting a local guess here
    // could write Client 2's name into Client 1's line.
    if (sigRecord && !sigRecord.hidden) {
      const toClient2 = data.signedSlot === 'client2';
      const nameSlot = toClient2 ? sigClient2Name : sigClientName;
      const dateSlot = toClient2 ? sigClient2Date : sigClientDate;
      nameSlot.textContent = typedName;
      dateSlot.textContent = formatSignedAt(data.signedAt);
    }
    // One of two signatures. Turn the form round and ask the second partner
    // rather than telling this couple the agreement is done — it is not, and
    // signContract has deliberately left the status alone to say so.
    if (data.complete === false) {
      askSigner('client2');
      signBtn.disabled = true;
      window.scrollTo({ top: whoSignsEl.getBoundingClientRect().top + window.scrollY - 20,
                        behavior: 'smooth' });
      return;
    }

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
