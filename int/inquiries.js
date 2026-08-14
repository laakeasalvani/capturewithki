import { db } from '../cms/firebase.js';
import {
  collection, query, orderBy, limit, getDocs, doc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let root = null;
let items = [];

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function whenText(ts) {
  if (!ts || typeof ts.toDate !== 'function') return 'Unknown date';
  return ts.toDate().toLocaleString();
}

function orNone(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s ? esc(s) : '<span class="q-none">Not given</span>';
}

// The Firestore rule caps `notes` at 5000 characters, and Firestore re-checks
// that limit against the full document on every write — so an oversized note
// would make the whole inquiry (including a plain status toggle) permanently
// un-updatable. The write itself is simply rejected, so the dashboard can't
// create that state, but Khiara would hit a confusing failure. The
// maxlength="5000" on the notes textarea below stops her at the UI instead,
// mirroring the Firestore rule.
function render() {
  if (!items.length) {
    root.innerHTML = '<p class="q-empty">No inquiries yet. When someone uses the contact form, they will appear here.</p>';
    return;
  }

  const failed = items.filter(function (i) {
    return i.emailError || i.emailToOwnerSent === false;
  });

  let html = '';
  if (failed.length) {
    html += '<div class="q-warn"><strong>' + failed.length +
      (failed.length === 1 ? ' inquiry' : ' inquiries') +
      ' may not have reached your inbox.</strong> They are saved here safely — the email notification failed, so check these even if you never saw an email.</div>';
  }

  items.forEach(function (i) {
    const who = i.partnerName ? esc(i.name) + ' &amp; ' + esc(i.partnerName) : esc(i.name);
    const isNew = i.status !== 'replied';
    html +=
      '<article class="q-card' + (isNew ? ' q-new' : '') + '" data-id="' + esc(i.id) + '">' +
        '<header class="q-head">' +
          '<h2>' + who + '</h2>' +
          '<span class="q-when">' + esc(whenText(i.createdAt)) + '</span>' +
        '</header>' +
        ((i.emailError || i.emailToOwnerSent === false)
          ? '<p class="q-failed">The email notification for this one failed.</p>' : '') +
        '<dl class="q-fields">' +
          '<dt>Email</dt><dd><a href="mailto:' + esc(i.email) + '">' + esc(i.email) + '</a></dd>' +
          '<dt>Phone</dt><dd><a href="tel:' + esc(i.phone) + '">' + esc(i.phone) + '</a></dd>' +
          '<dt>Date</dt><dd>' + orNone(i.eventDate) + '</dd>' +
          '<dt>Session</dt><dd>' + orNone(i.sessionType) + '</dd>' +
        '</dl>' +
        '<p class="q-message">' + orNone(i.message) + '</p>' +
        '<div class="q-actions">' +
          '<button type="button" class="q-status" data-id="' + esc(i.id) + '">' +
            (isNew ? 'Mark replied' : 'Mark unreplied') +
          '</button>' +
          '<span class="q-badge">' + (isNew ? 'New' : 'Replied') + '</span>' +
        '</div>' +
        '<label class="q-note-label">Private note (only you see this)' +
          '<textarea class="q-note" data-id="' + esc(i.id) + '" rows="2" maxlength="5000">' + esc(i.notes || '') + '</textarea>' +
        '</label>' +
        '<p class="q-saved" data-saved="' + esc(i.id) + '" aria-live="polite"></p>' +
      '</article>';
  });

  root.innerHTML = html;
}

async function load() {
  root.innerHTML = '<p class="q-empty">Loading inquiries…</p>';
  try {
    const snap = await getDocs(
      query(collection(db, 'inquiries'), orderBy('createdAt', 'desc'), limit(100))
    );
    items = [];
    snap.forEach(function (d) { items.push(Object.assign({ id: d.id }, d.data())); });
    render();
  } catch (err) {
    root.innerHTML = '<p class="q-warn">Could not load inquiries: ' +
      esc(err && (err.code || err.message)) + '</p>';
  }
}

function flash(id, text) {
  const el = root.querySelector('[data-saved="' + id + '"]');
  if (!el) return;
  el.textContent = text;
  clearTimeout(el.__t);
  el.__t = setTimeout(function () { el.textContent = ''; }, 2000);
}

export function initInquiries(container) {
  root = container;

  root.addEventListener('click', async function (e) {
    const btn = e.target.closest('.q-status');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const item = items.filter(function (i) { return i.id === id; })[0];
    if (!item) return;
    const next = item.status === 'replied' ? 'new' : 'replied';
    btn.disabled = true;
    try {
      await updateDoc(doc(db, 'inquiries', id), { status: next });
      item.status = next;
      render();
      flash(id, 'Saved');
    } catch (err) {
      flash(id, 'Could not save: ' + (err && (err.code || err.message)));
      btn.disabled = false;
    }
  });

  root.addEventListener('focusout', async function (e) {
    const area = e.target.closest && e.target.closest('.q-note');
    if (!area) return;
    const id = area.getAttribute('data-id');
    const item = items.filter(function (i) { return i.id === id; })[0];
    if (!item) return;
    const value = area.value;
    if (value === (item.notes || '')) return;
    try {
      await updateDoc(doc(db, 'inquiries', id), { notes: value });
      item.notes = value;
      flash(id, 'Note saved');
    } catch (err) {
      flash(id, 'Could not save note: ' + (err && (err.code || err.message)));
    }
  }, true);

  load();
}
