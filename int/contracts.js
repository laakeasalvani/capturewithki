import { db, app } from '../cms/firebase.js';
import {
  collection, query, orderBy, getDocs, limit
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import { computeFeeBlock, DEFAULT_RETAINER_PERCENT } from '../functions/lib/contracts.js';
import { formatCents } from '../functions/lib/contract-email.js';
import { toMillis } from '../functions/lib/gallery-expiry.js';

const fns = getFunctions(app, 'us-west1');
const createContractFn = httpsCallable(fns, 'createContract');
const sendContractFn = httpsCallable(fns, 'sendContract');
const markRetainerReceivedFn = httpsCallable(fns, 'markRetainerReceived');

// A contract is never opened, signed, or paid the instant it's sent — the
// window below is how long "sent, nothing back yet" is still normal. Past it,
// the likeliest explanation is not "she hasn't checked her email", it's "the
// email never arrived" — this is the number that decides which of those two
// this dashboard tells her.
const STALE_SENT_MS = 48 * 60 * 60 * 1000;

const TEMPLATE_LABELS = { wedding: 'Wedding', elopement: 'Elopement', portrait: 'Portrait' };

function templateLabel(key) {
  return TEMPLATE_LABELS[key] || (key || 'contract');
}

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtWhen(ts) {
  const ms = toMillis(ts);
  if (ms === null) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// Travel fee is entered in WHOLE dollars only — no cents, no decimal point.
// Blank means "no travel fee" (0 cents), which is a normal, valid answer, not
// an error. Anything else that isn't a clean non-negative whole number is
// refused (returns null) rather than guessed at, because a guess here becomes
// a wrong number on a signed legal document. Never round through a float —
// this never produces a fraction of a cent in the first place.
function wholeDollarsToCents(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw).trim().replace(/,/g, '');
  if (cleaned === '') return 0;
  if (!/^\d+$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isSafeInteger(dollars)) return null;
  return dollars * 100;
}

// Her public site promises the balance is due up to two weeks before the
// event, so that is the default offered here. Only offered when eventDate
// parses as an actual date — a free-text answer like "sometime in June"
// must not turn into a guessed, wrong date on a signed legal document, so
// this returns '' rather than guessing, and the field is left for her to
// type into herself.
function defaultBalanceDueDate(eventDateStr) {
  const raw = String(eventDateStr === undefined || eventDateStr === null ? '' : eventDateStr).trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) return '';
  const due = new Date(parsed.getTime());
  due.setDate(due.getDate() - 14);
  // Same options as formatLongDate in functions/index.js, so the default
  // reads exactly like every other date already in the document.
  return due.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Client-callable errors carry the useful sentence in `message` (that's
// exactly what HttpsError puts there, and several of these messages — the
// isDraft-template refusal chief among them — are written to be read by her,
// verbatim, not swallowed or replaced with a generic line).
function describeErr(err) {
  return (err && (err.message || err.code)) || 'Something went wrong. Please try again.';
}

export function initContracts(container) {
  container.innerHTML =
    '<h2 class="s-title">Contracts</h2>' +
    '<p class="s-help">Start a contract from an inquiry, or from scratch. ' +
    'Sending freezes the wording and emails the client a link to read and sign it. ' +
    'A date is only held once a contract is both <strong>signed and paid</strong> — ' +
    'watch for that exact wording below, because signed alone is not enough.</p>' +

    '<section class="c-block">' +
      '<h3 class="c-block-title">Start from an inquiry</h3>' +
      '<div id="cInquiries" class="c-inquiry-list"><p class="s-help">Loading inquiries&#8230;</p></div>' +
      '<div class="s-actions"><button type="button" id="cBlank" class="s-secondary">New contract, no inquiry</button></div>' +
    '</section>' +

    '<section id="cComposer" class="c-block c-composer" hidden></section>' +

    '<h3 class="c-block-title">Contracts</h3>' +
    '<div id="cList" class="c-list"><p class="s-help">Loading&#8230;</p></div>';

  const inquiriesBox = container.querySelector('#cInquiries');
  const composerBox = container.querySelector('#cComposer');
  const listBox = container.querySelector('#cList');

  let inquiries = [];
  let packages = [];
  let contracts = [];

  // ---------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------

  async function loadInquiries() {
    const snap = await getDocs(
      query(collection(db, 'inquiries'), orderBy('createdAt', 'desc'), limit(50))
    );
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    // Already-archived inquiries are done deals or dead ends — not worth
    // cluttering the one list she uses to start a contract.
    return out.filter(function (i) { return i.archived !== true; });
  }

  async function loadPackages() {
    // Deliberately NO orderBy. Firestore silently EXCLUDES any document missing
    // the field being ordered on — so one package hand-created without `order`
    // would vanish from this picker with no error, no warning, and nothing in
    // the console. These nine documents are created by hand, which makes that
    // slip likely rather than theoretical, and an invisible package looks
    // identical to an empty collection.
    //
    // Fetch everything and sort here instead: a package with no `order` sinks
    // to the bottom of the list rather than disappearing from it.
    const snap = await getDocs(collection(db, 'packages'));
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    out.sort(function (a, b) {
      const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return String(a.label || '').localeCompare(String(b.label || ''));
    });
    return out;
  }

  async function loadContracts() {
    const snap = await getDocs(query(collection(db, 'contracts'), orderBy('createdAt', 'desc')));
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }

  // ---------------------------------------------------------------------
  // Inquiry list -> "Send contract"
  // ---------------------------------------------------------------------

  function renderInquiries() {
    if (!inquiries.length) {
      inquiriesBox.innerHTML = '<p class="s-help">No open inquiries. You can still start a contract from scratch below.</p>';
      return;
    }
    inquiriesBox.innerHTML = inquiries.map(function (i) {
      return '<div class="c-inquiry-row" data-id="' + esc(i.id) + '">' +
        '<div class="c-inquiry-who">' +
          '<strong class="c-inquiry-name"></strong>' +
          '<span class="c-inquiry-meta">' + esc(i.eventDate || 'No date given') + ' &middot; ' + esc(i.email) + '</span>' +
        '</div>' +
        '<button type="button" class="c-send-from">Send contract</button>' +
      '</div>';
    }).join('');
    // The couple's name came off the public contact form — a stranger's own
    // words. It goes in as text, never as markup, same rule as clientName
    // everywhere else in this file.
    inquiriesBox.querySelectorAll('.c-inquiry-row').forEach(function (row) {
      const i = inquiries.filter(function (x) { return x.id === row.getAttribute('data-id'); })[0];
      if (!i) return;
      row.querySelector('.c-inquiry-name').textContent =
        i.partnerName ? (i.name || '') + ' & ' + i.partnerName : (i.name || '(no name given)');
    });
    inquiriesBox.querySelectorAll('.c-send-from').forEach(function (btn, idx) {
      btn.addEventListener('click', function () { openComposer(inquiries[idx]); });
    });
  }

  container.querySelector('#cBlank').addEventListener('click', function () { openComposer(null); });

  // ---------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------

  function packageOptionsHtml() {
    if (!packages.length) return '<option value="">No packages set up yet</option>';
    return '<option value="">Choose a package&#8230;</option>' + packages.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.label) + ' — ' + esc(formatCents(p.priceCents)) + '</option>';
    }).join('');
  }

  function openComposer(inquiry) {
    const prefillName = inquiry
      ? (inquiry.partnerName ? (inquiry.name || '') + ' & ' + inquiry.partnerName : (inquiry.name || ''))
      : '';
    composerBox.innerHTML =
      '<h3 class="c-block-title">' + (inquiry ? 'New contract' : 'New contract, no inquiry') + '</h3>' +
      '<label class="s-label">Client name(s)<input type="text" id="cName" maxlength="200"></label>' +
      // Optional — a portrait client has no second party. Left empty, the
      // contract renders "Client 2: Not applicable". Until this field existed
      // there was no way to fill it in at all, so every wedding and elopement
      // said "Not applicable" for a couple.
      '<label class="s-label">Client 2 name (optional)' +
        '<input type="text" id="cClient2" maxlength="200" placeholder="The second person signing, if there is one">' +
      '</label>' +
      '<label class="s-label">Client email<input type="email" id="cEmail" maxlength="254"></label>' +
      '<label class="s-label">Client phone (optional)<input type="text" id="cPhone" maxlength="40"></label>' +
      '<label class="s-label">Event date<input type="text" id="cDate" maxlength="40" placeholder="e.g. June 14, 2027"></label>' +
      '<p class="c-li-error" id="cDateError" hidden>Set an event date before sending — a contract created without one can never be sent and cannot be deleted.</p>' +
      // Optional, and genuinely so: a time may not be settled when the
      // contract goes out. Left empty they render "To be confirmed". But the
      // wedding and elopement agreements promise N hours of coverage, so
      // leaving these blank when they ARE known states an obligation with no
      // start to count from.
      '<label class="s-label">Start time (optional)<input type="text" id="cStartTime" maxlength="40" placeholder="e.g. 2:00 PM"></label>' +
      '<label class="s-label">End time (optional)<input type="text" id="cEndTime" maxlength="40" placeholder="e.g. 10:00 PM"></label>' +
      '<label class="s-label">Event location<input type="text" id="cLocation" maxlength="300" placeholder="Venue or city — this is not on the inquiry form yet"></label>' +

      '<label class="s-label">Balance due date<input type="text" id="cBalanceDue" maxlength="40" placeholder="e.g. May 29, 2027"></label>' +
      '<p class="c-li-error" id="cBalanceDueError" hidden>Set a balance due date before sending — it prints as a blank line in the contract otherwise.</p>' +

      '<label class="s-label">Package' +
        '<select id="cPackage">' + packageOptionsHtml() + '</select>' +
      '</label>' +
      '<p class="s-help" id="cWhichAgreement"></p>' +

      // The catalogue figure is a DEFAULT. Her weddings are advertised
      // "starting from", so this booking's real price is whatever she quoted.
      // Pre-filled when a package is chosen; change it and everything below
      // follows, including the retainer.
      '<label class="s-label">Package price for this booking, in whole dollars' +
        '<input type="text" inputmode="numeric" id="cPrice" placeholder="0" maxlength="10">' +
      '</label>' +
      '<p class="s-help">Pre-filled from the package. Change it for a bigger day or a custom quote.</p>' +
      '<p class="c-li-error" id="cPriceError" hidden>Package price has to be a whole dollar amount above zero (no cents).</p>' +

      '<label class="s-label">Travel fee, in whole dollars (optional)' +
        '<input type="text" inputmode="numeric" id="cTravel" placeholder="0" maxlength="10">' +
      '</label>' +
      '<p class="c-li-error" id="cTravelError" hidden>Travel fee has to be a whole dollar amount (no cents) — leave it blank for $0.</p>' +

      '<div class="c-totals" id="cFeeBlock">' +
        '<div class="c-totals-row"><span>Package price</span><strong id="cFeePackage">$0.00</strong></div>' +
        '<div class="c-totals-row"><span>Travel fees</span><strong id="cFeeTravel">$0.00</strong></div>' +
        '<div class="c-totals-row"><span>Total</span><strong id="cFeeTotal">$0.00</strong></div>' +
        '<div class="c-totals-row"><span>Retainer (' + DEFAULT_RETAINER_PERCENT + '%)</span><strong id="cFeeRetainer">$0.00</strong></div>' +
        '<div class="c-totals-row"><span>Remaining balance</span><strong id="cFeeBalance">$0.00</strong></div>' +
        '<div class="c-totals-row"><span>Balance due date</span><strong id="cFeeBalanceDueDate">&mdash;</strong></div>' +
      '</div>' +

      '<div class="s-actions">' +
        '<button type="button" id="cSend">Create &amp; send contract</button>' +
        '<button type="button" id="cCancel" class="s-secondary">Cancel</button>' +
        '<span class="s-status" id="cStatus" aria-live="polite"></span>' +
      '</div>' +

      '<div id="cResult" class="c-result" hidden></div>';

    composerBox.hidden = false;
    composerBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const nameEl = composerBox.querySelector('#cName');
    const client2El = composerBox.querySelector('#cClient2');
    const emailEl = composerBox.querySelector('#cEmail');
    const phoneEl = composerBox.querySelector('#cPhone');
    const dateEl = composerBox.querySelector('#cDate');
    const dateErrorEl = composerBox.querySelector('#cDateError');
    const startTimeEl = composerBox.querySelector('#cStartTime');
    const endTimeEl = composerBox.querySelector('#cEndTime');
    const locationEl = composerBox.querySelector('#cLocation');
    const balanceDueEl = composerBox.querySelector('#cBalanceDue');
    const balanceDueErrorEl = composerBox.querySelector('#cBalanceDueError');
    const packageEl = composerBox.querySelector('#cPackage');
    const whichAgreementEl = composerBox.querySelector('#cWhichAgreement');
    const priceEl = composerBox.querySelector('#cPrice');
    const priceErrorEl = composerBox.querySelector('#cPriceError');
    const travelEl = composerBox.querySelector('#cTravel');
    const travelErrorEl = composerBox.querySelector('#cTravelError');
    const feePackageEl = composerBox.querySelector('#cFeePackage');
    const feeTravelEl = composerBox.querySelector('#cFeeTravel');
    const feeTotalEl = composerBox.querySelector('#cFeeTotal');
    const feeRetainerEl = composerBox.querySelector('#cFeeRetainer');
    const feeBalanceEl = composerBox.querySelector('#cFeeBalance');
    const feeBalanceDueDateEl = composerBox.querySelector('#cFeeBalanceDueDate');
    const statusEl = composerBox.querySelector('#cStatus');
    const resultBox = composerBox.querySelector('#cResult');
    const sendBtn = composerBox.querySelector('#cSend');

    // The client's own typed name is the one thing here that did NOT
    // originate with her — it came off the public contact form. Set as text
    // (an input's .value, never interpolated into an innerHTML string), same
    // rule as clientName everywhere else in this file.
    nameEl.value = prefillName;
    if (inquiry) {
      emailEl.value = inquiry.email || '';
      phoneEl.value = inquiry.phone || '';
      dateEl.value = inquiry.eventDate || '';
      // Inquiries don't collect a venue today, so this starts blank on
      // purpose — nothing to prefill it from yet.
    }

    // True once she has typed into the balance-due field herself. Before
    // that, changing the event date is allowed to keep updating the default;
    // after that, her own answer is never overwritten out from under her.
    let balanceDueTouched = false;
    balanceDueEl.value = defaultBalanceDueDate(dateEl.value);

    function selectedPackage() {
      return packages.filter(function (p) { return p.id === packageEl.value; })[0] || null;
    }

    // The one function that decides what she sees and what gets written must
    // be the SAME function, imported, not reimplemented — otherwise a bug in
    // a hand-rolled browser copy could show her one number while the server
    // writes another into a signed document.
    function recompute() {
      const pkg = selectedPackage();
      const travelCents = wholeDollarsToCents(travelEl.value);
      const travelInvalid = travelCents === null;
      travelErrorEl.hidden = !travelInvalid;

      // Blank means "use the package price", NOT zero — a blank field must
      // never quietly produce a free contract.
      const priceRaw = priceEl.value.trim();
      const priceCents = priceRaw === '' ? (pkg ? pkg.priceCents : 0) : wholeDollarsToCents(priceRaw);
      const priceInvalid = priceRaw !== '' && (priceCents === null || priceCents <= 0);
      priceErrorEl.hidden = !priceInvalid;

      const fees = computeFeeBlock({
        packagePriceCents: priceInvalid ? 0 : priceCents,
        travelFeesCents: travelInvalid ? 0 : travelCents
      });

      feePackageEl.textContent = formatCents(fees.packagePriceCents);
      feeTravelEl.textContent = formatCents(fees.travelFeesCents);
      feeTotalEl.textContent = formatCents(fees.totalCents);
      feeRetainerEl.textContent = formatCents(fees.retainerCents);
      feeBalanceEl.textContent = formatCents(fees.balanceCents);

      const balanceDueDate = balanceDueEl.value.trim();
      const balanceDueEmpty = !balanceDueDate;
      balanceDueErrorEl.hidden = !balanceDueEmpty;
      feeBalanceDueDateEl.textContent = balanceDueDate || '—';

      // Same shape as the balance-due check above, and for a worse reason:
      // createContract now refuses a blank event date outright, so this is
      // what shows her why before she presses the button.
      const eventDate = dateEl.value.trim();
      const eventDateEmpty = !eventDate;
      dateErrorEl.hidden = !eventDateEmpty;

      whichAgreementEl.textContent = pkg
        ? 'This will send the ' + templateLabel(pkg.templateKey) + ' agreement.'
        : 'Choose a package to see which agreement it will send.';

      return {
        pkg: pkg, travelCents: travelCents, travelInvalid: travelInvalid, fees: fees,
        priceCents: priceCents, priceInvalid: priceInvalid, priceOverridden: priceRaw !== '',
        balanceDueDate: balanceDueDate, balanceDueEmpty: balanceDueEmpty,
        eventDate: eventDate, eventDateEmpty: eventDateEmpty
      };
    }

    // Choosing a package pre-fills its price. Overwriting whatever she has
    // typed is correct here: she just chose a DIFFERENT package, so a price
    // carried over from the previous one would be wrong and silently so.
    packageEl.addEventListener('change', function () {
      const pkg = selectedPackage();
      priceEl.value = pkg && Number.isInteger(pkg.priceCents)
        ? String(Math.round(pkg.priceCents / 100))
        : '';
      recompute();
    });
    priceEl.addEventListener('input', recompute);
    travelEl.addEventListener('input', recompute);
    // Only auto-fills while she hasn't touched the field herself — see
    // balanceDueTouched above. An unparseable event date clears the default
    // rather than leaving a stale guess sitting there.
    dateEl.addEventListener('input', function () {
      if (!balanceDueTouched) {
        balanceDueEl.value = defaultBalanceDueDate(dateEl.value);
      }
      recompute();
    });
    balanceDueEl.addEventListener('input', function () {
      balanceDueTouched = true;
      recompute();
    });
    recompute();

    composerBox.querySelector('#cCancel').addEventListener('click', function () {
      composerBox.hidden = true;
      composerBox.innerHTML = '';
    });

    sendBtn.addEventListener('click', async function () {
      const state = recompute();
      const clientName = nameEl.value.trim();
      const clientEmail = emailEl.value.trim();
      if (!clientName) { statusEl.textContent = 'Type the client’s name first.'; nameEl.focus(); return; }
      if (!clientEmail) { statusEl.textContent = 'Type the client’s email first.'; emailEl.focus(); return; }
      if (!state.pkg) { statusEl.textContent = 'Choose a package first.'; return; }
      if (state.priceInvalid) {
        statusEl.textContent = 'Fix the package price first — it has to be a whole dollar amount above zero.';
        priceEl.focus();
        return;
      }
      if (state.travelInvalid) {
        statusEl.textContent = 'Fix the travel fee first — it has to be a whole dollar amount.';
        travelEl.focus();
        return;
      }
      if (state.eventDateEmpty) {
        statusEl.textContent = 'Set an event date first.';
        dateEl.focus();
        return;
      }
      if (state.balanceDueEmpty) {
        statusEl.textContent = 'Set a balance due date first.';
        balanceDueEl.focus();
        return;
      }

      sendBtn.disabled = true;
      statusEl.textContent = 'Creating contract…';
      resultBox.hidden = true;

      let contractId;
      try {
        const res = await createContractFn({
          inquiryId: inquiry ? inquiry.id : null,
          clientName: clientName,
          // createContract has always accepted and stored these three; nothing
          // collected them, so they were dead fields until now. All three are
          // optional server-side and stay optional here.
          client2Name: client2El.value.trim(),
          clientEmail: clientEmail,
          clientPhone: phoneEl.value.trim(),
          eventDate: state.eventDate,
          startTime: startTimeEl.value.trim(),
          endTime: endTimeEl.value.trim(),
          eventLocation: locationEl.value.trim(),
          balanceDueDate: state.balanceDueDate,
          packageId: state.pkg.id,
          // The price SHE confirmed on this booking, not the catalogue figure.
          // Sent only when she actually typed one; otherwise the server falls
          // back to the package's own price.
          packagePriceCents: state.priceOverridden ? state.priceCents : undefined,
          travelFeesCents: state.travelCents
        });
        contractId = res.data.contractId;
      } catch (err) {
        statusEl.textContent = 'Could not create the contract: ' + describeErr(err);
        sendBtn.disabled = false;
        return;
      }

      statusEl.textContent = 'Sending…';
      try {
        const res = await sendContractFn({ contractId: contractId });
        statusEl.textContent = '';
        resultBox.hidden = false;
        resultBox.innerHTML =
          '<p class="c-sent-ok">Sent. The client can read and sign it at the link below.</p>' +
          '<p class="c-sent-link"><code>' + esc(res.data.signUrl) + '</code></p>';
        await refreshContracts();
      } catch (err) {
        // The contract WAS created (it exists as a draft in the list below,
        // and can be sent from there once whatever is wrong is fixed) — this
        // message must say that plainly rather than reading like nothing
        // happened, which would invite her to press the button again and
        // create a second draft for the same booking.
        statusEl.textContent = '';
        resultBox.hidden = false;
        resultBox.innerHTML = '<p class="c-alert-loud">The contract was saved as a draft, but sending failed: ' +
          esc(describeErr(err)) + ' You can try sending it again from the list below.</p>';
        await refreshContracts();
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Contracts list — status must never overstate itself. A green tick next
  // to a signed-but-unpaid contract is how a date gets double-booked.
  // ---------------------------------------------------------------------

  function statusInfo(c, now) {
    const status = c.status;
    if (status === 'sent') {
      const sentMs = toMillis(c.sentAt);
      const stale = sentMs !== null && (now - sentMs) > STALE_SENT_MS;
      if (stale) {
        return { cls: 'c-status-loud', label: 'Not opened yet — the email may not have arrived.' };
      }
      return { cls: 'c-status-sent', label: 'Sent — not opened yet' };
    }
    if (status === 'opened') return { cls: 'c-status-opened', label: 'Read, not signed yet' };
    if (status === 'signed') {
      // signedAt alone is never booked. Her own contracts say the date is
      // reserved only once BOTH the signed agreement and the retainer have
      // arrived — retainerReceivedAt (stamped by markRetainerReceived, a
      // manual Venmo/cheque/cash record) is the only thing that can promote
      // a SIGNED contract to booked without a Stripe payment landing.
      return c.retainerReceivedAt
        ? { cls: 'c-status-paid', label: 'Booked — date held' }
        : { cls: 'c-status-signed', label: 'Signed — retainer not yet received. The date is not held.' };
    }
    // A fake payment is not a booking. sign/fake-pay/ exists so Khiara can
    // walk the whole flow herself, and isTestPayment is written by all three
    // paid-writers (fakeCheckoutComplete, stripeWebhook, chaseContracts'
    // reconciliation) — until now nothing read it, so her own test payment
    // rendered on this screen as a genuine booking, in the same green badge,
    // against a date nobody had paid for.
    if (status === 'paid') {
      return c.isTestPayment
        ? { cls: 'c-status-loud', label: 'TEST payment — no money was taken' }
        : { cls: 'c-status-paid', label: 'Booked — retainer paid' };
    }
    if (status === 'void') return { cls: 'c-status-void', label: 'Voided' };
    if (status === 'cancelled') return { cls: 'c-status-void', label: 'Cancelled' };
    return { cls: 'c-status-draft', label: 'Draft — not sent yet' };
  }

  function cardHtml(c) {
    const info = statusInfo(c, Date.now());
    return '<article class="c-card" data-id="' + esc(c.id) + '">' +
      '<header class="c-card-head">' +
        '<h3 class="c-card-name"></h3>' +
        '<span class="c-status-badge ' + info.cls + '">' + esc(info.label) + '</span>' +
      '</header>' +
      (info.cls === 'c-status-loud' ? '<p class="c-alert-loud">' + esc(info.label) + '</p>' : '') +
      // An amount mismatch is the one refusal where money has already moved
      // and the system declined to record it — and the chase ladder will keep
      // dunning a client who has paid. stripeWebhook stamps the contract so
      // the problem is visible HERE, rather than only as a console.error in
      // Cloud Logging that nobody opens. The string is written by the webhook
      // from two amounts, never by a client, and is escaped anyway.
      (c.paymentAnomaly
        ? '<p class="c-alert-loud">PAYMENT PROBLEM: a payment arrived for the wrong amount (' +
            esc(c.paymentAnomaly) + ') and was NOT recorded. Money may already have moved — ' +
            'check Stripe before chasing this client.</p>'
        : '') +
      '<dl class="c-meta">' +
        '<div><dt>Event date</dt><dd>' + esc(c.eventDate || 'Not given') + '</dd></div>' +
        '<div><dt>Package</dt><dd>' + esc(c.packageLabel || 'Not given') + '</dd></div>' +
        '<div><dt>Total</dt><dd>' + esc(formatCents(c.totalCents)) + '</dd></div>' +
        '<div><dt>Retainer</dt><dd>' + esc(formatCents(c.retainerCents)) + '</dd></div>' +
        '<div><dt>Balance due</dt><dd>' + esc(formatCents(c.balanceCents)) + '</dd></div>' +
        '<div><dt>Created</dt><dd>' + esc(fmtWhen(c.createdAt)) + '</dd></div>' +
        '<div><dt>Sent</dt><dd>' + esc(fmtWhen(c.sentAt)) + '</dd></div>' +
        '<div><dt>First opened</dt><dd>' + (c.firstOpenedAt ? esc(fmtWhen(c.firstOpenedAt)) + ' (' + (c.openCount || 1) + '&times;)' : 'Never') + '</dd></div>' +
        '<div><dt>Signed</dt><dd>' + esc(c.signedAt ? fmtWhen(c.signedAt) : 'Not signed') + '</dd></div>' +
        '<div><dt>Signed by</dt><dd class="c-signed-by"></dd></div>' +
        '<div><dt>Retainer received</dt><dd>' + (c.retainerReceivedAt ? esc(fmtWhen(c.retainerReceivedAt)) : 'Not yet') + '</dd></div>' +
      '</dl>' +
      // The exact document the client signed, plus the evidence, wherever she
      // already is. Collapsed by default and loaded on demand: the audit trail
      // is a subcollection read per contract, and doing nine of those on every
      // list render would be wasteful for something she opens occasionally.
      (c.documentSnapshot
        ? '<div class="c-reveal s-actions">' +
            '<button type="button" class="c-toggle-doc s-secondary" aria-expanded="false">' +
              'View the signed contract and signature details' +
            '</button>' +
            '<div class="c-doc-panel" hidden>' +
              '<div class="c-doc-actions s-actions">' +
                '<button type="button" class="c-print s-secondary">Print / save as PDF</button>' +
              '</div>' +
              '<div class="c-doc-body"></div>' +
              '<div class="c-doc-cert"></div>' +
              '<div class="c-doc-audit"></div>' +
            '</div>' +
          '</div>'
        : '') +
      (c.status === 'draft'
        ? '<div class="s-actions">' +
            '<button type="button" class="c-resend">Send</button>' +
            '<span class="s-status c-card-status" aria-live="polite"></span>' +
          '</div>'
        : '') +
      (c.status === 'signed'
        ? '<div class="s-actions">' +
            (c.retainerReceivedAt
              ? '<button type="button" class="c-retainer-undo s-secondary">Undo — retainer not actually received</button>'
              : '<button type="button" class="c-retainer-mark">Mark retainer received</button>') +
            '<span class="s-status c-retainer-status" aria-live="polite"></span>' +
          '</div>'
        : '') +
    '</article>';
  }


  // ---------------------------------------------------------------------
  // The signed contract and its evidence, shown where she already works.
  //
  // Everything here already existed in Firestore and could only be reached
  // by asking a developer to read a database record — which is exactly the
  // moment you least want that dependency. Nothing new is stored; this only
  // makes producible what was already being kept.
  // ---------------------------------------------------------------------

  function certRowsHtml(label, sig, when) {
    if (!sig) return '';
    return '<div class="c-cert-party">' +
      '<h4>' + esc(label) + '</h4>' +
      '<dl class="c-cert">' +
        '<div><dt>Typed name</dt><dd>' + esc(sig.typedName || '—') + '</dd></div>' +
        '<div><dt>Signed at</dt><dd>' + esc(when) + '</dd></div>' +
        '<div><dt>IP address</dt><dd>' + esc(sig.ip || 'unknown') + '</dd></div>' +
        '<div><dt>Device</dt><dd>' + esc(sig.userAgent || 'unknown') + '</dd></div>' +
        '<div><dt>Consent given</dt><dd>' + (sig.consentGiven ? 'Yes' : 'NO') + '</dd></div>' +
        '<div><dt>Consent wording</dt><dd>' + esc(sig.consentTextVersion || '—') + '</dd></div>' +
        // The binding between the signature and the exact words signed. If a
        // template is edited later this no longer matches the new text, which
        // is what proves the signed version was not swapped.
        '<div><dt>Document fingerprint</dt><dd class="c-hash">' + esc(sig.documentHash || '—') + '</dd></div>' +
      '</dl>' +
    '</div>';
  }

  function certHtml(c) {
    const two = !!(c.signature && c.signature2);
    let out = '<section class="c-cert-block">' +
      '<h3>Signature details</h3>' +
      '<p class="s-help">This is the record of who signed, when, and what they ' +
        'signed. It is kept for you — it is not printed on the agreement itself, ' +
        'the same way an e-signature service keeps a certificate separate from ' +
        'the contract.</p>';
    out += certRowsHtml('Photographer', {
      typedName: 'Khiara Salvani',
      ip: 'n/a — countersigned by Khiara from her own signed-in account',
      userAgent: 'n/a',
      consentGiven: true,
      consentTextVersion: 'offered these terms',
      documentHash: c.documentHash
    }, fmtWhen(c.sentAt));
    out += certRowsHtml(two ? 'Client 1' : 'Client', c.signature, fmtWhen(c.signedAt));
    if (c.signature2) out += certRowsHtml('Client 2', c.signature2, fmtWhen(c.signed2At));
    if (two && c.signature.ip && c.signature.ip === c.signature2.ip) {
      out += '<p class="s-help">Both signatures came from the same IP address. ' +
        'That is expected when a couple signs together on one device, and is a ' +
        'known limit of using a single link for both.</p>';
    }
    return out + '</section>';
  }

  function auditHtml(events) {
    if (!events.length) return '';
    const label = {
      created: 'Contract created', sent: 'Sent to the client',
      opened: 'Opened by the client', signed: 'Signed',
      'signed-client2': 'Signed by the second client',
      'retainer-received': 'Retainer marked received',
      'retainer-unmarked': 'Retainer mark removed',
      paid: 'Payment recorded', 'paid-reconciled': 'Payment found by reconciliation',
      refunded: 'Refunded', voided: 'Voided'
    };
    return '<section class="c-cert-block">' +
      '<h3>What happened, and when</h3>' +
      '<ol class="c-audit">' +
        events.map(function (e) {
          return '<li><span class="c-audit-when">' + esc(fmtWhen(e.at)) + '</span>' +
            '<span class="c-audit-what">' + esc(label[e.event] || e.event) + '</span>' +
            (e.typedName ? '<span class="c-audit-who">' + esc(e.typedName) + '</span>' : '') +
          '</li>';
        }).join('') +
      '</ol></section>';
  }

  async function loadAudit(contractId) {
    const snap = await getDocs(collection(db, 'contracts', contractId, 'audit'));
    return snap.docs.map(function (d) { return d.data(); })
      .sort(function (a, b) { return (toMillis(a.at) || 0) - (toMillis(b.at) || 0); });
  }

  function renderContracts() {
    if (!contracts.length) {
      listBox.innerHTML = '<p class="s-help">No contracts yet.</p>';
      return;
    }
    listBox.innerHTML = contracts.map(cardHtml).join('');
    contracts.forEach(function (c) {
      const card = listBox.querySelector('.c-card[data-id="' + c.id + '"]');
      if (!card) return;
      // clientName and signature.typedName are text a CLIENT typed (clientName
      // arrives off the public contact form via the inquiry; typedName is
      // literally what they typed to sign). Neither has been escaped by
      // anything upstream — this project escapes at render, not at storage —
      // so both are set via textContent here, never interpolated into the
      // innerHTML template strings above.
      card.querySelector('.c-card-name').textContent = c.clientName || '(no name)';
      // BOTH signers. Naming only the first left a two-signer contract
      // reading as though one partner had signed it alone.
      const n1 = c.signature && c.signature.typedName;
      const n2 = c.signature2 && c.signature2.typedName;
      card.querySelector('.c-signed-by').textContent =
        n1 && n2 ? n1 + ' and ' + n2 : (n1 || '—');

      const toggle = card.querySelector('.c-toggle-doc');
      if (toggle) {
        const panel = card.querySelector('.c-doc-panel');
        const bodyBox = card.querySelector('.c-doc-body');
        const certBox = card.querySelector('.c-doc-cert');
        const auditBox = card.querySelector('.c-doc-audit');
        let loaded = false;
        toggle.addEventListener('click', async function () {
          const opening = panel.hidden;
          panel.hidden = !opening;
          toggle.setAttribute('aria-expanded', String(opening));
          toggle.textContent = opening
            ? 'Hide the signed contract'
            : 'View the signed contract and signature details';
          if (!opening || loaded) return;
          loaded = true;

          // documentSnapshot was rendered server-side by renderTemplate, which
          // escaped every client-supplied value; what remains is the
          // admin-authored template's own markup. innerHTML is correct here
          // and ONLY because of that — the same reasoning as sign.js.
          bodyBox.innerHTML = c.documentSnapshot || '';
          certBox.innerHTML = certHtml(c);
          auditBox.innerHTML = '<p class="s-help">Loading the history\u2026</p>';
          try {
            auditBox.innerHTML = auditHtml(await loadAudit(c.id));
          } catch (err) {
            // Never blocks the document itself. The contract and the
            // signatures are the part she needs; the event log is context.
            auditBox.innerHTML = '<p class="s-help">Could not load the history.</p>';
          }
        });

        const printBtn = card.querySelector('.c-print');
        if (printBtn) {
          printBtn.addEventListener('click', function () {
            // Marks THIS card as the one to print. The print stylesheet hides
            // everything else on the page, so what comes out is the agreement
            // and its certificate — not the dashboard around it.
            document.body.classList.add('c-printing');
            card.classList.add('c-print-me');
            const clear = function () {
              document.body.classList.remove('c-printing');
              card.classList.remove('c-print-me');
              window.removeEventListener('afterprint', clear);
            };
            window.addEventListener('afterprint', clear);
            window.print();
          });
        }
      }

      const resendBtn = card.querySelector('.c-resend');
      if (resendBtn) {
        const status = card.querySelector('.c-card-status');
        resendBtn.addEventListener('click', async function () {
          resendBtn.disabled = true;
          status.textContent = 'Sending…';
          try {
            await sendContractFn({ contractId: c.id });
            status.textContent = '';
            await refreshContracts();
          } catch (err) {
            status.textContent = 'Could not send it: ' + describeErr(err);
            resendBtn.disabled = false;
          }
        });
      }

      // The retainer control: marking it is reversible on purpose. A mis-tap
      // on a money record — the wrong card, a client who paid by Venmo but
      // hasn't actually sent it yet — has to be undoable without a console.
      const markBtn = card.querySelector('.c-retainer-mark');
      const undoBtn = card.querySelector('.c-retainer-undo');
      const retainerStatus = card.querySelector('.c-retainer-status');
      if (markBtn) {
        markBtn.addEventListener('click', async function () {
          markBtn.disabled = true;
          retainerStatus.textContent = 'Saving…';
          try {
            await markRetainerReceivedFn({ contractId: c.id, received: true });
            retainerStatus.textContent = '';
            await refreshContracts();
          } catch (err) {
            retainerStatus.textContent = 'Could not save: ' + describeErr(err);
            markBtn.disabled = false;
          }
        });
      }
      if (undoBtn) {
        undoBtn.addEventListener('click', async function () {
          undoBtn.disabled = true;
          retainerStatus.textContent = 'Saving…';
          try {
            await markRetainerReceivedFn({ contractId: c.id, received: false });
            retainerStatus.textContent = '';
            await refreshContracts();
          } catch (err) {
            retainerStatus.textContent = 'Could not undo: ' + describeErr(err);
            undoBtn.disabled = false;
          }
        });
      }
    });
  }

  async function refreshContracts() {
    try {
      contracts = await loadContracts();
      renderContracts();
    } catch (err) {
      listBox.innerHTML = '<p class="s-help">Could not load contracts: ' + esc(describeErr(err)) + '</p>';
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  (async function boot() {
    try {
      inquiries = await loadInquiries();
      renderInquiries();
    } catch (err) {
      inquiriesBox.innerHTML = '<p class="s-help">Could not load inquiries: ' + esc(describeErr(err)) + '</p>';
    }
    try {
      packages = await loadPackages();
    } catch (err) {
      console.warn('[contracts] could not load packages:', describeErr(err));
    }
    await refreshContracts();
  })();
}
