import { db, app } from '../cms/firebase.js';
import {
  collection, query, orderBy, getDocs, limit
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js';
import {
  sumLineItems, computeRetainerCents, computeBalanceCents, DEFAULT_RETAINER_PERCENT,
  renderTemplate, MAX_LINE_ITEMS
} from '../functions/lib/contracts.js';
import { formatCents } from '../functions/lib/contract-email.js';
import { toMillis } from '../functions/lib/gallery-expiry.js';

const fns = getFunctions(app, 'us-west1');
const createContractFn = httpsCallable(fns, 'createContract');
const sendContractFn = httpsCallable(fns, 'sendContract');

// A contract is never opened, signed, or paid the instant it's sent — the
// window below is how long "sent, nothing back yet" is still normal. Past it,
// the likeliest explanation is not "she hasn't checked her email", it's "the
// email never arrived" — this is the number that decides which of those two
// this dashboard tells her.
const STALE_SENT_MS = 48 * 60 * 60 * 1000;

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

// She types dollars, everywhere this system stores cents. Commas and stray
// whitespace are tolerated ("1,200" is a very normal thing to type); anything
// that doesn't leave a clean non-negative number is refused rather than
// guessed at, because a guess here becomes a wrong number on a legal
// document. Never round through a float total — round once, at the cent.
function dollarsToCents(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw).trim().replace(/,/g, '');
  if (cleaned === '' || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

function centsToDollarsStr(cents) {
  if (!Number.isInteger(cents)) return '';
  return (cents / 100).toFixed(2);
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
  let templates = [];
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
    const snap = await getDocs(query(collection(db, 'packages'), orderBy('order', 'asc')));
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    return out;
  }

  async function loadTemplates() {
    const snap = await getDocs(collection(db, 'contractTemplates'));
    const out = [];
    snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
    // Real templates before the seeded placeholder, so the default selection
    // in the composer is the one that can actually be sent, whenever one exists.
    out.sort(function (a, b) { return (a.isDraft === true ? 1 : 0) - (b.isDraft === true ? 1 : 0); });
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
      const who = i.partnerName ? esc(i.name) + ' &amp; ' + esc(i.partnerName) : esc(i.name);
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
    return '<option value="">Choose a package&#8230;</option>' + packages.map(function (p, idx) {
      return '<option value="' + idx + '">' + esc(p.label) + ' — ' + esc(formatCents(p.amountCents)) + '</option>';
    }).join('');
  }

  function templateOptionsHtml() {
    if (!templates.length) return '<option value="">No contract templates found</option>';
    return templates.map(function (t) {
      const label = (t.name || t.id) + (t.isDraft === true ? ' — DRAFT (cannot be sent)' : '');
      return '<option value="' + esc(t.id) + '">' + esc(label) + '</option>';
    }).join('');
  }

  function lineItemRowHtml(label, dollars) {
    return '<div class="c-line-item-wrap">' +
      '<div class="c-line-item">' +
        '<input type="text" class="c-li-label" maxlength="120" placeholder="e.g. Travel" value="' + esc(label || '') + '">' +
        '<span class="c-li-dollar">$</span>' +
        '<input type="text" inputmode="decimal" class="c-li-amount" placeholder="0.00" value="' + esc(dollars || '') + '">' +
        '<button type="button" class="c-li-remove" aria-label="Remove this line item">&#10005;</button>' +
      '</div>' +
      '<p class="c-li-error" hidden>Not a valid amount &#8212; this line is not counted in the total.</p>' +
    '</div>';
  }

  function openComposer(inquiry) {
    const prefillName = inquiry
      ? (inquiry.partnerName ? (inquiry.name || '') + ' & ' + inquiry.partnerName : (inquiry.name || ''))
      : '';
    composerBox.innerHTML =
      '<h3 class="c-block-title">' + (inquiry ? 'New contract' : 'New contract, no inquiry') + '</h3>' +
      '<label class="s-label">Client name(s)<input type="text" id="cName" maxlength="200"></label>' +
      '<label class="s-label">Client email<input type="email" id="cEmail" maxlength="254"></label>' +
      '<label class="s-label">Client phone (optional)<input type="text" id="cPhone" maxlength="40"></label>' +
      '<label class="s-label">Event date<input type="text" id="cDate" maxlength="40" placeholder="e.g. June 14, 2027"></label>' +
      '<label class="s-label">Event location<input type="text" id="cLocation" maxlength="300" placeholder="Venue or city — this is not on the inquiry form yet"></label>' +

      '<label class="s-label">Package' +
        '<select id="cPackage">' + packageOptionsHtml() + '</select>' +
      '</label>' +
      '<div class="s-actions" style="margin:0 0 18px;"><button type="button" id="cAddPackage" class="s-secondary">Add package as line item</button></div>' +

      '<div class="c-line-items" id="cLineItems"></div>' +
      '<div class="s-actions" style="margin:0 0 18px;"><button type="button" id="cAddLine" class="s-secondary">Add line item</button></div>' +

      '<div class="c-totals">' +
        '<div class="c-totals-row"><span>Total</span><strong id="cTotal">$0.00</strong></div>' +
        '<div class="c-totals-row">' +
          '<label class="c-retainer-label">Retainer %' +
            '<input type="text" inputmode="decimal" id="cRetainerPct" value="' + DEFAULT_RETAINER_PERCENT + '">' +
          '</label>' +
          '<label class="c-retainer-label">Retainer $' +
            '<input type="text" inputmode="decimal" id="cRetainerDollar">' +
          '</label>' +
        '</div>' +
        '<div class="c-totals-row"><span>Balance due later</span><strong id="cBalance">$0.00</strong></div>' +
      '</div>' +

      '<label class="s-label">Send with template' +
        '<select id="cTemplate">' + templateOptionsHtml() + '</select>' +
      '</label>' +

      '<div class="s-actions">' +
        '<button type="button" id="cPreview" class="s-secondary">Preview</button>' +
        '<button type="button" id="cSend">Create &amp; send contract</button>' +
        '<button type="button" id="cCancel" class="s-secondary">Cancel</button>' +
        '<span class="s-status" id="cStatus" aria-live="polite"></span>' +
      '</div>' +

      '<div id="cPreviewBox" class="c-preview" hidden></div>' +
      '<div id="cResult" class="c-result" hidden></div>';

    composerBox.hidden = false;
    composerBox.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const nameEl = composerBox.querySelector('#cName');
    const emailEl = composerBox.querySelector('#cEmail');
    const phoneEl = composerBox.querySelector('#cPhone');
    const dateEl = composerBox.querySelector('#cDate');
    const locationEl = composerBox.querySelector('#cLocation');
    const packageEl = composerBox.querySelector('#cPackage');
    const lineItemsEl = composerBox.querySelector('#cLineItems');
    const totalEl = composerBox.querySelector('#cTotal');
    const balanceEl = composerBox.querySelector('#cBalance');
    const pctEl = composerBox.querySelector('#cRetainerPct');
    const retainerDollarEl = composerBox.querySelector('#cRetainerDollar');
    const templateEl = composerBox.querySelector('#cTemplate');
    const statusEl = composerBox.querySelector('#cStatus');
    const previewBox = composerBox.querySelector('#cPreviewBox');
    const resultBox = composerBox.querySelector('#cResult');
    const sendBtn = composerBox.querySelector('#cSend');

    // The client's own typed name is the one thing here that did NOT
    // originate with her — it came off the public contact form. Set as text,
    // never interpolated into the innerHTML strings above.
    nameEl.value = prefillName;
    if (inquiry) {
      emailEl.value = inquiry.email || '';
      phoneEl.value = inquiry.phone || '';
      dateEl.value = inquiry.eventDate || '';
      // Inquiries don't collect a venue today, so this starts blank on
      // purpose — nothing to prefill it from yet.
    }

    // Which of the two retainer inputs she edited last decides which one
    // drives the other, so typing in either field does something sensible
    // instead of one silently overwriting the other on every keystroke.
    //
    // Declared before anything below can call recompute() — recompute() reads
    // this `let` binding, and reading a `let` before its own declaration line
    // has run throws rather than reading `undefined`. addLineItem() below
    // calls recompute() immediately, so this must come first or every event
    // listener registered after that first call is never reached at all.
    let retainerDriver = 'pct';

    function addLineItem(label, dollars) {
      if (lineItemsEl.children.length >= MAX_LINE_ITEMS) return;
      lineItemsEl.insertAdjacentHTML('beforeend', lineItemRowHtml(label, dollars));
      recompute();
    }

    function currentLineItems() {
      return Array.prototype.map.call(lineItemsEl.querySelectorAll('.c-line-item-wrap'), function (wrap) {
        const label = wrap.querySelector('.c-li-label').value.trim();
        const raw = wrap.querySelector('.c-li-amount').value.trim();
        const cents = dollarsToCents(raw);
        // Surfaced immediately, in place, rather than letting a mistyped
        // amount just vanish from the total with nothing to explain why.
        const errorEl = wrap.querySelector('.c-li-error');
        if (errorEl) errorEl.hidden = !(raw !== '' && cents === null);
        return { label: label, amountCents: cents };
      });
    }

    function recompute() {
      const validItems = currentLineItems().filter(function (i) {
        return i.label && Number.isInteger(i.amountCents) && i.amountCents >= 0;
      });
      const totalCents = sumLineItems(validItems);
      totalEl.textContent = formatCents(totalCents);

      let percent = parseFloat(pctEl.value);
      if (!Number.isFinite(percent)) percent = DEFAULT_RETAINER_PERCENT;

      if (retainerDriver === 'dollar') {
        const rc = dollarsToCents(retainerDollarEl.value);
        percent = totalCents > 0 && Number.isInteger(rc) ? Math.round((rc / totalCents) * 10000) / 100 : 0;
        percent = Math.max(0, Math.min(100, percent));
        pctEl.value = String(percent);
      }
      const retainerCents = computeRetainerCents(totalCents, percent);
      if (retainerDriver !== 'dollar' || !document.activeElement || document.activeElement !== retainerDollarEl) {
        retainerDollarEl.value = centsToDollarsStr(retainerCents);
      }
      balanceEl.textContent = formatCents(computeBalanceCents(totalCents, retainerCents));
      return { totalCents: totalCents, percent: percent, retainerCents: retainerCents, lineItems: validItems };
    }

    lineItemsEl.addEventListener('input', recompute);
    lineItemsEl.addEventListener('click', function (e) {
      const rm = e.target.closest('.c-li-remove');
      if (!rm) return;
      rm.closest('.c-line-item-wrap').remove();
      recompute();
    });
    pctEl.addEventListener('input', function () { retainerDriver = 'pct'; recompute(); });
    retainerDollarEl.addEventListener('input', function () { retainerDriver = 'dollar'; recompute(); });

    composerBox.querySelector('#cAddLine').addEventListener('click', function () { addLineItem('', ''); });
    composerBox.querySelector('#cAddPackage').addEventListener('click', function () {
      const idx = packageEl.value;
      if (idx === '') return;
      const pkg = packages[Number(idx)];
      if (!pkg) return;
      addLineItem(pkg.label, centsToDollarsStr(pkg.amountCents));
    });

    addLineItem('', '');

    function selectedTemplate() {
      return templates.filter(function (t) { return t.id === templateEl.value; })[0] || null;
    }

    composerBox.querySelector('#cPreview').addEventListener('click', function () {
      const tpl = selectedTemplate();
      if (!tpl) {
        previewBox.hidden = false;
        previewBox.textContent = 'No contract template is available to preview against.';
        return;
      }
      const t = recompute();
      const fields = {
        client_name: nameEl.value.trim(),
        client_email: emailEl.value.trim(),
        event_date: dateEl.value.trim(),
        event_location: locationEl.value.trim(),
        total: formatCents(t.totalCents),
        retainer: formatCents(t.retainerCents),
        balance: formatCents(computeBalanceCents(t.totalCents, t.retainerCents)),
        line_items: t.lineItems.map(function (i) { return i.label + ' — ' + formatCents(i.amountCents); }).join('; ')
      };
      // renderTemplate escapes every one of these values itself (same function
      // sendContract uses server-side) — the only unescaped HTML here is her
      // own template markup, which she authored. That is what makes innerHTML
      // safe on this one line; nothing client-supplied reaches it unescaped.
      previewBox.innerHTML = renderTemplate(tpl.html, fields);
      previewBox.hidden = false;
      if (tpl.isDraft === true) {
        previewBox.insertAdjacentHTML('afterbegin',
          '<p class="c-alert-loud">This template is marked DRAFT. Sending will be refused until a real, non-draft template is chosen.</p>');
      }
    });

    composerBox.querySelector('#cCancel').addEventListener('click', function () {
      composerBox.hidden = true;
      composerBox.innerHTML = '';
    });

    sendBtn.addEventListener('click', async function () {
      const t = recompute();
      const clientName = nameEl.value.trim();
      const clientEmail = emailEl.value.trim();
      if (!clientName) { statusEl.textContent = 'Type the client’s name first.'; nameEl.focus(); return; }
      if (!clientEmail) { statusEl.textContent = 'Type the client’s email first.'; emailEl.focus(); return; }
      if (!t.lineItems.length || t.totalCents <= 0) {
        statusEl.textContent = 'Add at least one line item with an amount.';
        return;
      }
      const tpl = selectedTemplate();
      if (!tpl) { statusEl.textContent = 'Choose a contract template first.'; return; }

      sendBtn.disabled = true;
      statusEl.textContent = 'Creating contract…';
      resultBox.hidden = true;

      let contractId;
      try {
        const res = await createContractFn({
          inquiryId: inquiry ? inquiry.id : null,
          clientName: clientName,
          clientEmail: clientEmail,
          clientPhone: phoneEl.value.trim(),
          eventDate: dateEl.value.trim(),
          eventLocation: locationEl.value.trim(),
          lineItems: t.lineItems,
          retainerPercent: t.percent
        });
        contractId = res.data.contractId;
      } catch (err) {
        statusEl.textContent = 'Could not create the contract: ' + describeErr(err);
        sendBtn.disabled = false;
        return;
      }

      statusEl.textContent = 'Sending…';
      try {
        const res = await sendContractFn({ contractId: contractId, templateId: tpl.id });
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
    if (status === 'signed') return { cls: 'c-status-signed', label: 'Signed — retainer NOT paid. The date is not held.' };
    if (status === 'paid') return { cls: 'c-status-paid', label: 'Booked — retainer paid' };
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
      '<dl class="c-meta">' +
        '<div><dt>Event date</dt><dd>' + esc(c.eventDate || 'Not given') + '</dd></div>' +
        '<div><dt>Total</dt><dd>' + esc(formatCents(c.totalCents)) + '</dd></div>' +
        '<div><dt>Retainer</dt><dd>' + esc(formatCents(c.retainerCents)) + '</dd></div>' +
        '<div><dt>Balance due</dt><dd>' + esc(formatCents(c.balanceCents)) + '</dd></div>' +
        '<div><dt>Created</dt><dd>' + esc(fmtWhen(c.createdAt)) + '</dd></div>' +
        '<div><dt>Sent</dt><dd>' + esc(fmtWhen(c.sentAt)) + '</dd></div>' +
        '<div><dt>First opened</dt><dd>' + (c.firstOpenedAt ? esc(fmtWhen(c.firstOpenedAt)) + ' (' + (c.openCount || 1) + '&times;)' : 'Never') + '</dd></div>' +
        '<div><dt>Signed</dt><dd>' + esc(c.signedAt ? fmtWhen(c.signedAt) : 'Not signed') + '</dd></div>' +
        '<div><dt>Signed by</dt><dd class="c-signed-by"></dd></div>' +
      '</dl>' +
      (c.status === 'draft'
        ? '<div class="s-actions">' +
            '<label class="c-inline-label">Template' +
              '<select class="c-resend-template">' + templateOptionsHtml() + '</select>' +
            '</label>' +
            '<button type="button" class="c-resend">Send</button>' +
            '<span class="s-status c-card-status" aria-live="polite"></span>' +
          '</div>'
        : '') +
    '</article>';
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
      card.querySelector('.c-signed-by').textContent =
        c.signature && c.signature.typedName ? c.signature.typedName : '—';

      const resendBtn = card.querySelector('.c-resend');
      if (resendBtn) {
        const templateSel = card.querySelector('.c-resend-template');
        const status = card.querySelector('.c-card-status');
        resendBtn.addEventListener('click', async function () {
          const templateId = templateSel.value;
          if (!templateId) { status.textContent = 'Choose a template first.'; return; }
          resendBtn.disabled = true;
          status.textContent = 'Sending…';
          try {
            await sendContractFn({ contractId: c.id, templateId: templateId });
            status.textContent = '';
            await refreshContracts();
          } catch (err) {
            status.textContent = 'Could not send it: ' + describeErr(err);
            resendBtn.disabled = false;
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
    try {
      templates = await loadTemplates();
    } catch (err) {
      console.warn('[contracts] could not load templates:', describeErr(err));
    }
    await refreshContracts();
  })();
}
