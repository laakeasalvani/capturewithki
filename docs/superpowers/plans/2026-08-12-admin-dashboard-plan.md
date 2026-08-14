# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private page at `/int/` where Khiara reads her inquiries, marks which she has replied to, keeps private notes, and edits the automatic thank-you email her clients receive.

**Architecture:** A separate static page (`int/index.html`) plus plain ES modules in `int/`, reusing the existing `cms/auth.js` and `cms/firebase.js` unchanged. Inquiries are read straight from Firestore by the browser under an admin-only rule; status and notes are written back under a rule that permits *only* those two fields. The auto-reply template lives in a new admin-only `settings/email` document which the Cloud Function reads with the Admin SDK, falling back to hardcoded wording if it is missing.

**Tech Stack:** Firebase JS SDK v10.13.0 (CDN modular, browser side), Firebase Admin SDK (already in `functions/`), Firestore. No build step, no npm outside `functions/`.

## Global Constraints

- No build step for the site. `int/*` are plain ES modules loaded directly by the browser, exactly like `cms/*`.
- Firebase client SDK pinned to exactly `10.13.0` in every browser-side import, matching every existing `cms/*.js` file.
- `int/` must import the EXISTING `../cms/auth.js` and `../cms/firebase.js`. Do not copy, fork or modify them — the CMS depends on them and is live.
- The dashboard is protected by Firebase Auth plus the `admins` check, never by the obscurity of the `/int/` path. The repository is public.
- A signed-in non-admin must see an explicit refusal message, never a blank or silently broken page.
- `inquiries` may be updated ONLY in `status` and `notes`. Client-submitted fields (name, email, phone, message, eventDate, sessionType, partnerName) must remain immutable to every client, including an admin. Create and delete stay closed to all clients.
- `settings/email` is admin-read AND admin-write. It must never be publicly readable.
- The Cloud Function must fall back to the hardcoded wording when `settings/email` is missing, unreadable, or has empty fields. A couple always receives something sensible.
- `{first_name}` is the only supported token in the auto-reply body. Anything else stays literal.
- The auto-reply SUBJECT must be stripped of CR/LF before use (header-injection guard). The BODY keeps its line breaks.
- The owner-notification email stays hardcoded and unchanged. Its "Reply to this email" line is what makes Reply reach the client.
- Deploys are always scoped: `firebase deploy --only firestore:rules` or `--only functions`. NEVER a bare `firebase deploy`.
- `RESEND_API_KEY` must never be printed, logged or committed.
- The public site, the CMS and the contact form must not regress. `index.html` carries 150 `data-cms-id` markers; this plan does not touch it at all.

---

## File Structure

```
capturewithki/
  int/
    index.html          (new — dashboard page: auth states + two screens)
    dashboard.css       (new — all dashboard styling)
    dashboard.js        (new — auth gate and screen switching, thin)
    inquiries.js        (new — load, render, status toggle, notes)
    settings.js         (new — auto-reply template editor)
  firestore.rules       (modify — scoped inquiries update + settings)
  functions/
    lib/email.js        (modify — clientEmail accepts an optional template)
    index.js            (modify — read settings/email, pass it in)
    test/email.test.js  (modify — template, token, fallback tests)
```

`dashboard.js` stays thin: it owns the auth gate and nothing else. `inquiries.js` and `settings.js` each own one screen and are independently testable by eye.

---

### Task 1: Security rules for inquiries and settings

**Files:**
- Modify: `firestore.rules`

**Interfaces:**
- Produces: the access contract every later task depends on. Admin-only read of `inquiries`; update restricted to `status` and `notes`; admin-only read/write of `settings`.

- [ ] **Step 1: Replace the `inquiries` block**

Find the existing block:

```
    match /inquiries/{id} {
      allow read: if isAdmin();
      allow write: if false;
    }
```

Replace it with:

```
    // Inquiries hold client contact details, so unlike the CMS collections
    // they are NOT publicly readable. Only the Cloud Function creates them,
    // via the Admin SDK, which bypasses these rules.
    //
    // Updates are deliberately narrow: an admin may change ONLY the status
    // and her own private note. What the client actually wrote — name,
    // email, phone, message — stays immutable to every client, including
    // her and including anyone who obtains her session.
    match /inquiries/{id} {
      allow read: if isAdmin();
      allow create, delete: if false;
      allow update: if isAdmin()
        && request.resource.data.diff(resource.data)
             .affectedKeys().hasOnly(['status', 'notes'])
        && (!('status' in request.resource.data)
            || request.resource.data.status in ['new', 'replied'])
        && (!('notes' in request.resource.data)
            || (request.resource.data.notes is string
                && request.resource.data.notes.size() <= 5000));
    }
```

- [ ] **Step 2: Add the `settings` block**

Insert immediately after the `inquiries` block:

```
    // Dashboard-owned settings, e.g. the auto-reply email template.
    // Admin-only both ways — there is no reason for the public to read it.
    match /settings/{docId} {
      allow read: if isAdmin();
      allow write: if isAdmin();
    }
```

- [ ] **Step 3: Capture the live baseline BEFORE deploying**

```bash
P=capturewithki-69dd3; B="https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents"
for c in heroSlides portfolioShots filmstripShots testimonials; do printf "read %-16s " "$c"; curl -s -o /dev/null -w "%{http_code}\n" "$B/$c"; done
printf "read %-16s " "inquiries"; curl -s -o /dev/null -w "%{http_code}\n" "$B/inquiries"
```

Expected: the four CMS collections `200`, `inquiries` `403`. Record it.

- [ ] **Step 4: Deploy, scoped**

```bash
firebase deploy --only firestore:rules --project capturewithki-69dd3
```

- [ ] **Step 5: Re-measure and compare**

Re-run the Step 3 commands, plus:

```bash
printf "read %-16s " "settings"; curl -s -o /dev/null -w "%{http_code}\n" "$B/settings"
printf "unauth write inquiries "; curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/inquiries" -H 'Content-Type: application/json' -d '{"fields":{"p":{"stringValue":"x"}}}'
```

Required: four CMS collections still `200`; `inquiries`, `settings` both `403`; unauthenticated write `403`.

**If any CMS collection returns anything but 200, the live site is broken. Stop, report BLOCKED, change nothing else.**

- [ ] **Step 6: Confirm the live site still serves**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://laakeasalvani.github.io/capturewithki/
```

Expected `200`.

- [ ] **Step 7: Commit**

```bash
git add firestore.rules
git commit -m "Allow admins to update inquiry status and notes only; add settings"
```

---

### Task 2: Dashboard shell and auth gate

**Files:**
- Create: `int/index.html`, `int/dashboard.css`, `int/dashboard.js`

**Interfaces:**
- Consumes: `initAuth`, `login`, `logout`, `onAdminChange` from `../cms/auth.js`; `auth` from `../cms/firebase.js`; `onAuthStateChanged` from the pinned Firebase Auth SDK.
- Produces: the four DOM containers later tasks render into — `#dashLoading`, `#dashLogin`, `#dashDenied`, `#dashApp` — plus `#screenInquiries` and `#screenSettings` inside `#dashApp`, and the tab buttons `#tabInquiries` / `#tabSettings`.

- [ ] **Step 1: Create `int/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CaptureWithKi — Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="dashboard.css">
</head>
<body>

<div id="dashLoading" class="dash-state">Loading…</div>

<div id="dashLogin" class="dash-state" hidden>
  <form id="dashLoginForm" class="dash-card">
    <h1>CaptureWithKi</h1>
    <p class="dash-sub">Admin sign in</p>
    <label for="dashEmail">Email</label>
    <input id="dashEmail" type="email" autocomplete="username" required>
    <label for="dashPassword">Password</label>
    <input id="dashPassword" type="password" autocomplete="current-password" required>
    <p class="dash-error" id="dashLoginError" aria-live="polite"></p>
    <button type="submit">Sign in</button>
  </form>
</div>

<div id="dashDenied" class="dash-state" hidden>
  <div class="dash-card">
    <h1>No access</h1>
    <p>You are signed in, but this account is not set up as an admin, so the dashboard cannot be shown.</p>
    <button type="button" id="dashDeniedLogout">Sign out</button>
  </div>
</div>

<div id="dashApp" hidden>
  <header class="dash-header">
    <span class="dash-brand">CaptureWithKi</span>
    <nav class="dash-tabs">
      <button type="button" id="tabInquiries" class="on">Inquiries</button>
      <button type="button" id="tabSettings">Auto-reply</button>
    </nav>
    <button type="button" id="dashLogout" class="dash-logout">Sign out</button>
  </header>

  <main>
    <section id="screenInquiries"></section>
    <section id="screenSettings" hidden></section>
  </main>
</div>

<script type="module" src="dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `int/dashboard.css`**

```css
:root{
  --cream:#E8DFCE; --bg:#F2ECE0; --paper:#FAF6EE; --ink:#171614;
  --muted:#6B6560; --line:#DCD0BC; --khaki:#6E7C5C;
  --display:"Cormorant Garamond",serif; --sans:"Jost",Arial,sans-serif;
}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;}

.dash-state{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.dash-state[hidden]{display:none;}
.dash-card{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:30px;width:min(92vw,360px);}
.dash-card h1{font-family:var(--display);font-weight:400;font-size:26px;margin:0 0 4px;}
.dash-sub{margin:0 0 18px;color:var(--muted);font-size:13px;}
.dash-card label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px;}
.dash-card input{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:6px;font-size:15px;font-family:inherit;}
.dash-card button{margin-top:18px;background:var(--khaki);color:#fff;border:none;border-radius:20px;padding:9px 20px;font-size:14px;font-family:inherit;cursor:pointer;}
.dash-card button:disabled{opacity:.55;cursor:default;}
.dash-error{color:#a33;font-size:13px;min-height:17px;margin:10px 0 0;}

.dash-header{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px 20px;background:var(--paper);border-bottom:1px solid var(--line);}
.dash-brand{font-family:var(--display);font-size:20px;}
.dash-tabs{display:flex;gap:8px;margin-left:auto;}
.dash-tabs button{background:none;border:1px solid var(--line);border-radius:18px;padding:6px 15px;font-family:inherit;font-size:13px;cursor:pointer;color:var(--muted);}
.dash-tabs button.on{background:var(--khaki);border-color:var(--khaki);color:#fff;}
.dash-logout{background:none;border:none;color:var(--muted);text-decoration:underline;cursor:pointer;font-family:inherit;font-size:13px;}

main{padding:22px 20px 60px;max-width:900px;margin:0 auto;}
</style>
```

Note: the file is CSS, so do NOT include the trailing `</style>` — that line is an artefact of this code block. End the file after the `main{...}` rule.

- [ ] **Step 3: Create `int/dashboard.js`**

```js
import { initAuth, login, logout, onAdminChange } from '../cms/auth.js';
import { auth } from '../cms/firebase.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { initInquiries } from './inquiries.js';
import { initSettings } from './settings.js';

const loading = document.getElementById('dashLoading');
const loginView = document.getElementById('dashLogin');
const denied = document.getElementById('dashDenied');
const app = document.getElementById('dashApp');

const form = document.getElementById('dashLoginForm');
const errorEl = document.getElementById('dashLoginError');
const submitBtn = form.querySelector('button[type="submit"]');

const screens = {
  inquiries: document.getElementById('screenInquiries'),
  settings: document.getElementById('screenSettings')
};
const tabs = {
  inquiries: document.getElementById('tabInquiries'),
  settings: document.getElementById('tabSettings')
};

function show(which) {
  loading.hidden = which !== 'loading';
  loginView.hidden = which !== 'login';
  denied.hidden = which !== 'denied';
  app.hidden = which !== 'app';
}

function selectTab(name) {
  Object.keys(screens).forEach(function (k) {
    screens[k].hidden = k !== name;
    tabs[k].classList.toggle('on', k === name);
  });
}

tabs.inquiries.addEventListener('click', function () { selectTab('inquiries'); });
tabs.settings.addEventListener('click', function () { selectTab('settings'); });

form.addEventListener('submit', function (e) {
  e.preventDefault();
  errorEl.textContent = '';
  submitBtn.disabled = true;
  login(
    document.getElementById('dashEmail').value.trim(),
    document.getElementById('dashPassword').value
  ).catch(function () {
    errorEl.textContent = 'Wrong email or password.';
  }).then(function () {
    submitBtn.disabled = false;
  });
});

function signOut() {
  logout().then(function () { window.location.reload(); });
}
document.getElementById('dashLogout').addEventListener('click', signOut);
document.getElementById('dashDeniedLogout').addEventListener('click', signOut);

// Auth resolves in two steps: cms/auth.js notifies admin state immediately
// (with a stale default), and Firebase separately restores any saved session
// a moment later. Painting before BOTH have spoken is what flashes the login
// form at someone who is already signed in — so hold on "Loading…" until
// authResolved is true.
let authResolved = false;
let currentUser = null;
let adminActive = false;
let started = false;

function paint() {
  if (!authResolved) { show('loading'); return; }

  if (adminActive) {
    show('app');
    if (!started) {
      started = true;
      initInquiries(screens.inquiries);
      initSettings(screens.settings);
    }
    return;
  }
  // Signed in but not an admin is a different situation from signed out, and
  // must say so rather than silently showing a login form.
  show(currentUser ? 'denied' : 'login');
}

onAuthStateChanged(auth, function (user) {
  authResolved = true;
  currentUser = user;
  paint();
});

onAdminChange(function (active) {
  adminActive = active;
  paint();
});

initAuth();
```

- [ ] **Step 4: Verify the signed-out state**

Serve the repository root over HTTP and open `/int/`. Confirm:
- the login form is visible, and `#dashApp` and `#dashDenied` are hidden
- no console errors
- `document.getElementById('dashApp').hidden === true`

- [ ] **Step 5: Commit**

```bash
git add int/index.html int/dashboard.css int/dashboard.js
git commit -m "Add admin dashboard shell with auth gate"
```

---

### Task 3: Inquiries list

**Files:**
- Create: `int/inquiries.js`
- Modify: `int/dashboard.css` (append list styles)

**Interfaces:**
- Consumes: `db` from `../cms/firebase.js`.
- Produces: `initInquiries(container)` — called once by `dashboard.js` after admin state is confirmed.

- [ ] **Step 1: Create `int/inquiries.js`**

```js
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
          '<textarea class="q-note" data-id="' + esc(i.id) + '" rows="2">' + esc(i.notes || '') + '</textarea>' +
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
```

- [ ] **Step 2: Append list styles to `int/dashboard.css`**

```css
.q-empty{color:var(--muted);}
.q-warn{background:#fdf3f3;border:1px solid #e6c3c3;color:#7a2e2e;padding:12px 14px;border-radius:8px;margin-bottom:18px;font-size:14px;}
.q-card{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px;}
.q-card.q-new{border-left:3px solid var(--khaki);}
.q-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.q-head h2{font-family:var(--display);font-weight:400;font-size:21px;margin:0;}
.q-when{color:var(--muted);font-size:12px;margin-left:auto;}
.q-failed{background:#fdf3f3;color:#7a2e2e;padding:8px 10px;border-radius:6px;font-size:13px;margin:10px 0 0;}
.q-fields{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:14px 0 0;font-size:14px;}
.q-fields dt{color:var(--muted);}
.q-fields dd{margin:0;}
.q-fields a{color:var(--khaki);}
.q-none{color:var(--muted);}
.q-message{white-space:pre-wrap;margin:14px 0 0;padding-top:12px;border-top:1px solid var(--line);font-size:14px;}
.q-actions{display:flex;align-items:center;gap:12px;margin-top:16px;}
.q-status{background:none;border:1px solid var(--khaki);color:var(--khaki);border-radius:16px;padding:6px 14px;font-family:inherit;font-size:13px;cursor:pointer;}
.q-status:disabled{opacity:.5;cursor:default;}
.q-badge{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;}
.q-note-label{display:block;margin-top:14px;font-size:12px;color:var(--muted);}
.q-note{display:block;width:100%;margin-top:5px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-family:inherit;font-size:14px;resize:vertical;}
.q-saved{min-height:16px;margin:6px 0 0;font-size:12px;color:var(--khaki);}
```

- [ ] **Step 3: Verify signed out**

Load `/int/` signed out. Confirm the login form still shows and NO inquiry data appears anywhere in the DOM (`document.body.innerHTML` must not contain any client email address).

- [ ] **Step 4: Commit**

```bash
git add int/inquiries.js int/dashboard.css
git commit -m "Add inquiries list with status toggle and private notes"
```

---

### Task 4: Auto-reply editor

**Files:**
- Create: `int/settings.js`
- Modify: `int/dashboard.css` (append editor styles)

**Interfaces:**
- Consumes: `db` from `../cms/firebase.js`.
- Produces: `initSettings(container)`. Writes `settings/email` with fields `clientSubject` and `clientBody`.

- [ ] **Step 1: Create `int/settings.js`**

```js
import { db } from '../cms/firebase.js';
import {
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

// Kept in sync with functions/lib/email.js. Shown as the starting point when
// no template has been saved yet; the function falls back to its own copy of
// this wording if the document is missing.
const DEFAULT_SUBJECT = 'Thank you for reaching out — CaptureWithKi';
const DEFAULT_BODY = [
  'Hi {first_name},',
  '',
  'Thank you so much for reaching out — your inquiry came through and I have it.',
  '',
  'I will get back to you within 48 hours.',
  '',
  'Talk soon,',
  'Khiara',
  'CaptureWithKi'
].join('\n');

export function initSettings(container) {
  container.innerHTML =
    '<h2 class="s-title">The thank-you email your clients receive</h2>' +
    '<p class="s-help">Write <code>{first_name}</code> anywhere and it becomes their first name. ' +
    'Leave a field empty to go back to the wording below.</p>' +
    '<label class="s-label">Subject<input id="sSubject" type="text"></label>' +
    '<label class="s-label">Message<textarea id="sBody" rows="12"></textarea></label>' +
    '<div class="s-actions"><button type="button" id="sSave">Save</button>' +
    '<button type="button" id="sReset" class="s-secondary">Reset to default</button>' +
    '<span class="s-status" id="sStatus" aria-live="polite"></span></div>' +
    '<h3 class="s-preview-title">Preview</h3>' +
    '<pre class="s-preview" id="sPreview"></pre>';

  const subject = container.querySelector('#sSubject');
  const body = container.querySelector('#sBody');
  const status = container.querySelector('#sStatus');
  const preview = container.querySelector('#sPreview');

  function updatePreview() {
    const s = subject.value.trim() || DEFAULT_SUBJECT;
    const b = body.value.trim() || DEFAULT_BODY;
    preview.textContent =
      'Subject: ' + s.replace(/[\r\n]+/g, ' ') + '\n\n' +
      b.split('{first_name}').join('Sarah');
  }

  function flash(text) {
    status.textContent = text;
    clearTimeout(status.__t);
    status.__t = setTimeout(function () { status.textContent = ''; }, 2500);
  }

  subject.addEventListener('input', updatePreview);
  body.addEventListener('input', updatePreview);

  container.querySelector('#sSave').addEventListener('click', async function () {
    try {
      await setDoc(doc(db, 'settings', 'email'), {
        clientSubject: subject.value.trim(),
        clientBody: body.value.trim()
      }, { merge: true });
      flash('Saved');
    } catch (err) {
      flash('Could not save: ' + (err && (err.code || err.message)));
    }
  });

  container.querySelector('#sReset').addEventListener('click', function () {
    subject.value = DEFAULT_SUBJECT;
    body.value = DEFAULT_BODY;
    updatePreview();
    flash('Reset — press Save to apply');
  });

  (async function () {
    try {
      const snap = await getDoc(doc(db, 'settings', 'email'));
      const d = snap.exists() ? snap.data() : {};
      subject.value = d.clientSubject || DEFAULT_SUBJECT;
      body.value = d.clientBody || DEFAULT_BODY;
    } catch (err) {
      subject.value = DEFAULT_SUBJECT;
      body.value = DEFAULT_BODY;
      flash('Could not load saved wording: ' + (err && (err.code || err.message)));
    }
    updatePreview();
  })();
}
```

- [ ] **Step 2: Append editor styles to `int/dashboard.css`**

```css
.s-title{font-family:var(--display);font-weight:400;font-size:23px;margin:0 0 6px;}
.s-help{color:var(--muted);font-size:13px;margin:0 0 18px;}
.s-help code{background:var(--cream);padding:1px 5px;border-radius:4px;}
.s-label{display:block;font-size:12px;color:var(--muted);margin-bottom:14px;}
.s-label input,.s-label textarea{display:block;width:100%;margin-top:5px;padding:9px 11px;border:1px solid var(--line);border-radius:6px;font-family:inherit;font-size:14px;}
.s-label textarea{resize:vertical;line-height:1.5;}
.s-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.s-actions button{background:var(--khaki);color:#fff;border:none;border-radius:18px;padding:8px 18px;font-family:inherit;font-size:14px;cursor:pointer;}
.s-secondary{background:none !important;border:1px solid var(--line) !important;color:var(--muted) !important;}
.s-status{font-size:13px;color:var(--khaki);}
.s-preview-title{font-family:var(--display);font-weight:400;font-size:18px;margin:26px 0 8px;}
.s-preview{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:14px;white-space:pre-wrap;font-family:inherit;font-size:14px;margin:0;}
```

- [ ] **Step 3: Verify signed out**

Load `/int/` signed out; confirm the login form shows and no settings UI is reachable.

- [ ] **Step 4: Commit**

```bash
git add int/settings.js int/dashboard.css
git commit -m "Add auto-reply template editor"
```

---

### Task 5: Function reads the saved template

**Files:**
- Modify: `functions/lib/email.js`
- Modify: `functions/index.js`
- Modify: `functions/test/email.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `clientEmail(inquiry, template)` — `template` optional. When absent or empty, the existing hardcoded wording is used unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `functions/test/email.test.js`:

```js
test('clientEmail uses a saved template and substitutes the first name', () => {
  const e = clientEmail({ name: 'Sarah Chen' }, {
    clientSubject: 'Got your note!',
    clientBody: 'Hey {first_name},\n\nSpeak soon.\nK'
  });
  assert.equal(e.subject, 'Got your note!');
  assert.ok(e.text.includes('Hey Sarah,'));
  assert.ok(!e.text.includes('{first_name}'));
});

test('clientEmail falls back when the template is missing or empty', () => {
  const def = clientEmail({ name: 'Sarah Chen' });
  assert.match(def.text, /48 hours/);
  const empty = clientEmail({ name: 'Sarah Chen' }, { clientSubject: '', clientBody: '   ' });
  assert.equal(empty.subject, def.subject);
  assert.equal(empty.text, def.text);
});

test('a saved subject cannot smuggle a newline', () => {
  const e = clientEmail({ name: 'Sarah' }, {
    clientSubject: 'Hello\nBcc: someone@evil.com',
    clientBody: 'Hi {first_name}'
  });
  assert.ok(!e.subject.includes('\n'));
});

test('a saved body keeps its line breaks', () => {
  const e = clientEmail({ name: 'Sarah' }, { clientBody: 'One\n\nTwo' });
  assert.ok(e.text.includes('One\n\nTwo'));
});

test('every occurrence of the token is replaced', () => {
  const e = clientEmail({ name: 'Sarah' }, { clientBody: '{first_name} {first_name}' });
  assert.equal(e.text, 'Sarah Sarah');
});

test('a non-object template is ignored rather than throwing', () => {
  for (const bad of [null, 'x', 42, [], undefined]) {
    const e = clientEmail({ name: 'Sarah' }, bad);
    assert.match(e.text, /48 hours/);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd functions && npm test`
Expected: the new tests fail — `clientEmail` ignores its second argument.

- [ ] **Step 3: Rewrite `clientEmail` in `functions/lib/email.js`**

Replace the existing `clientEmail` with:

```js
const DEFAULT_CLIENT_SUBJECT = 'Thank you for reaching out — CaptureWithKi';
const DEFAULT_CLIENT_BODY = [
  'Hi {first_name},',
  '',
  'Thank you so much for reaching out — your inquiry came through and I have it.',
  '',
  'I will get back to you within 48 hours.',
  '',
  'Talk soon,',
  'Khiara',
  'CaptureWithKi'
].join('\n');

export function clientEmail(i, template) {
  const first = oneLine(i.name).trim().split(' ')[0] || 'there';

  // A saved template is optional. Anything that is not a plain object, or
  // whose fields are blank, falls back to the wording above — a couple must
  // always receive something sensible.
  const t = (template && typeof template === 'object' && !Array.isArray(template)) ? template : {};
  const rawSubject = typeof t.clientSubject === 'string' ? t.clientSubject.trim() : '';
  const rawBody = typeof t.clientBody === 'string' ? t.clientBody.trim() : '';

  // The subject is a mail header, so it must never carry a line break.
  // The body is free text and keeps hers.
  const subject = oneLine(rawSubject || DEFAULT_CLIENT_SUBJECT).trim();
  const text = (rawBody || DEFAULT_CLIENT_BODY).split('{first_name}').join(first);

  return { subject: subject, text: text };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd functions && npm test`
Expected: all tests pass, including the 6 new ones.

- [ ] **Step 5: Read the template in `functions/index.js`**

Immediately before the client-email `try` block, insert:

```js
    // The owner can reword the thank-you from the dashboard. A missing or
    // unreadable document is not an error: clientEmail falls back to the
    // hardcoded wording, so a couple always gets a sensible reply.
    let template = null;
    try {
      const tSnap = await db.collection('settings').doc('email').get();
      if (tSnap.exists) template = tSnap.data();
    } catch (err) {
      console.warn('[submitInquiry] could not read the auto-reply template:', describeError(err));
    }
```

and change the client send to pass it:

```js
      const m = clientEmail(inquiry, template);
```

Leave the owner email, the ordering, the single `ref.update`, and the `{ok:true}` return exactly as they are.

- [ ] **Step 6: Confirm the module still loads**

```bash
cd functions && npm test && node --input-type=module -e "import('./index.js').then(m => console.log(Object.keys(m)))"
```

Expected: all tests pass; prints `[ 'submitInquiry' ]`.

- [ ] **Step 7: Commit**

```bash
git add functions/lib/email.js functions/index.js functions/test/email.test.js
git commit -m "Let the dashboard's saved template drive the thank-you email"
```

---

### Task 6: Deploy the function and verify end to end

**Files:**
- Modify: `README.md`

**Interfaces:** none — deploys and proves the whole path.

- [ ] **Step 1: Deploy, scoped**

```bash
firebase deploy --only functions --project capturewithki-69dd3
```

A trailing "Artifact Registry cleanup policy" warning is cosmetic and expected; the line that matters is `Successful update operation`.

- [ ] **Step 2: Confirm the fallback still works**

With no `settings/email` document saved yet, submit one inquiry through the live contact form using a test address the tester controls. Confirm the thank-you arrives with the ORIGINAL wording.

Note the rate limit is 5 per hour per IP; if it triggers, wait rather than working around it.

- [ ] **Step 3: Confirm a saved template is used**

In the dashboard, change the subject and body (keeping `{first_name}`), save, then submit another inquiry. Confirm the new wording arrives with the name substituted.

- [ ] **Step 4: Confirm the notification email is unchanged**

Confirm the owner notification still arrives with its original layout and that pressing Reply still addresses the client.

- [ ] **Step 5: Document it in `README.md`**

Add after the contact-form section:

```markdown
## Admin dashboard

A private page at `/int/` where Khiara reads inquiries, marks them replied,
keeps private notes, and edits the automatic thank-you clients receive.

It reuses the same login as the site's CMS. The `/int/` path is convenience,
not security — this repository is public. Access is enforced by Firebase Auth
plus the `admins` check, and by Firestore rules.

Inquiries can be updated ONLY in `status` and `notes`. What a client actually
wrote is immutable to every client, including an admin. Creating and deleting
inquiries is closed to everyone; only the Cloud Function creates them.

The thank-you wording lives in the Firestore document `settings/email`
(`clientSubject`, `clientBody`), admin-only both ways. `{first_name}` is
substituted. If the document is missing or blank, the function falls back to
the wording hardcoded in `functions/lib/email.js`.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document the admin dashboard"
```

---

## Deferred to a follow-up

- **Site statistics** — photo counts, testimonial counts, inquiries per month. The owner explicitly wants this next, after v1.
- Client galleries and their active/expiry table — separate sub-project.
- Payments, invoicing, contracts — deferred by the owner.
- Deleting inquiries, searching, filtering, pagination past 100.
- Editing the owner-notification email.
