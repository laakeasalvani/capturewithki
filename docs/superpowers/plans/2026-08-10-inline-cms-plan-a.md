# Inline CMS — Plan A (Core Infrastructure + Home/About/Contact/Portfolio/Hero/Testimonials) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gear-icon login (Firebase Auth) that lets the site owner edit, in place, on the live page: the hero slideshow, the portfolio grid (+ its derived filmstrip), the Love Letters testimonials, the home/about intro copy, the contact heading, and five key photos — all backed by Firestore + Storage, with the site's current hardcoded content as an always-available offline fallback.

**Architecture:** `index.html` keeps its current hardcoded markup/arrays as fallback content. A set of small ES modules under `cms/` (loaded via `<script type="module">`, no build step) fetch Firestore data on load and override the DOM/collections where data exists; in Edit Mode (after admin login) those same modules turn text into `contenteditable`, images into upload targets, and the three collections (hero slides, portfolio shots, testimonials) into add/delete/drag-reorder lists. First edit to any given field/collection lazily seeds Firestore with today's fallback data.

**Tech Stack:** Firebase JS SDK v10.13.0 (modular, via `https://www.gstatic.com/firebasejs/10.13.0/...` CDN imports — no npm, no bundler), Firebase Auth (email/password), Firestore, Cloud Storage for Firebase. Vanilla JS ES modules, native HTML5 drag-and-drop.

## Global Constraints

- No build step. Every new file is either plain `.js` (ES module, imported via `<script type="module">`) or `.css`, loaded directly by the browser — matches this repo's existing single-file, zero-build philosophy (see `README.md`).
- Firebase SDK version is pinned to `10.13.0` in every import across every `cms/*.js` file — do not mix versions.
- The Firebase config object (from the user's Firebase console) is not a secret and is committed in plain sight in `cms/firebase.js`. Do not attempt to hide or gitignore it.
- Public read / admin-only write on every collection, enforced by Firestore & Storage security rules (Task 2) — never rely on client-side checks alone.
- No public sign-up UI anywhere. The login modal has only email + password fields, no "create account" path.
- Fallback-first rendering: if a Firestore read fails or returns nothing, the page must render exactly what it renders today. Never blank/broken on Firestore outage.
- Image uploads: image MIME types only, 10MB max, no client-side resizing/compression (documented limitation, not a bug).
- Native HTML5 drag-and-drop is desktop-reliable but not guaranteed on mobile touch — acceptable since the site owner edits primarily from a laptop; note this to the user, do not attempt to build custom touch-drag polyfill in this plan.
- Out of scope for this plan (see design spec `docs/superpowers/specs/2026-08-10-inline-cms-design.md`): nav links, button labels, contact form field labels/placeholders, FAQ/process-step copy, Portraits/Elopements/Weddings pricing text & images (tracked as a separate follow-up "Plan B" — same mechanism, just more `data-cms-id` tags, deliberately deferred to keep this plan shippable on its own).

---

## File Structure

```
capturewithki/
  index.html                          (modified — script tags, gear/modal markup, data-cms-id attributes, hero wrapper div, deletion of now-superseded inline script blocks)
  README.md                           (modified — note the CMS + Firebase setup)
  firestore.rules                     (new — reference copy of the rules pasted into the Firebase console)
  storage.rules                       (new — same, for Storage)
  cms/
    firebase.js                       (new — initializes Firebase app/auth/db/storage, exports them)
    auth.js                           (new — login/logout, admin-state pub/sub)
    content-store.js                  (new — get/set for the single `content/site` doc, used by swap-in-place fields)
    edit-text.js                      (new — generic contenteditable-on-click text binding)
    edit-image.js                     (new — generic click-to-upload image binding)
    collection-store.js               (new — generic Firestore CRUD + reorder for ordered collections)
    collection-ui.js                  (new — generic delete button + native drag-and-drop reorder + "+ Add" tile, used by hero/portfolio/testimonials)
    hero.js                           (new — wires heroSlides collection to the homepage hero slideshow, replaces the old inline slideshow JS)
    portfolio.js                      (new — wires portfolioShots collection to the grid + derives the filmstrip from it, replaces the old inline `shots` array/renderGrid)
    testimonials.js                   (new — wires testimonials collection to the Love Letters carousel, replaces the old inline `llData` array)
    main.js                           (new — orchestrator: calls every module's init function in order, wires the gear/modal DOM)
    cms.css                           (new — all CMS-specific styling: gear, modal, toast, editable outlines, image overlay, collection add/delete/drag)
```

---

### Task 1: Firebase SDK bootstrap

**Files:**
- Create: `cms/firebase.js`
- Modify: `index.html` (add one `<script type="module" src="cms/firebase.js"></script>` tag, placed right after the existing closing `</script>` of the classic inline script, before `</body>`)

**Interfaces:**
- Produces: `app`, `auth`, `db`, `storage` — the four Firebase service instances every later `cms/*.js` module imports from `./firebase.js`.

- [ ] **Step 1: Create `cms/firebase.js`**

```js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyCFo69Vwo7I_-XwTEM1zS5_6TyJGgXYZaQ",
  authDomain: "capturewithki-69dd3.firebaseapp.com",
  projectId: "capturewithki-69dd3",
  storageBucket: "capturewithki-69dd3.firebasestorage.app",
  messagingSenderId: "416670397460",
  appId: "1:416670397460:web:1ca701f1e068029d8e6301"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
```

- [ ] **Step 2: Add the script tag to `index.html`**

Find the closing tag of the existing classic script (the line is exactly `</script>` immediately followed by `</body>`), and insert before `</body>`:

```html
<script type="module" src="cms/firebase.js"></script>
</body>
```

- [ ] **Step 3: Manually verify**

Run `python3 -m http.server 8000` from the `capturewithki` directory, open `http://localhost:8000` in a browser, open DevTools console. Confirm there are zero red errors (a successful load logs nothing from this file — no errors is the pass condition).

- [ ] **Step 4: Commit**

```bash
git add cms/firebase.js index.html
git commit -m "Add Firebase SDK bootstrap for CMS"
```

---

### Task 2: Firestore & Storage security rules

**Files:**
- Create: `firestore.rules`
- Create: `storage.rules`

**Interfaces:**
- Produces: the access-control contract every later task's read/write calls depend on — public read, admin-only write.

- [ ] **Step 1: Create `firestore.rules`**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null &&
        exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }

    match /content/{docId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /heroSlides/{itemId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /portfolioShots/{itemId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /testimonials/{itemId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /admins/{uid} {
      allow read: if false;
      allow write: if false;
    }
  }
}
```

- [ ] **Step 2: Create `storage.rules`**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{allPaths=**} {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

- [ ] **Step 3: Paste both into the Firebase console**

In the Firebase console: **Firestore Database → Rules** tab, replace the contents with `firestore.rules`, click **Publish**. Then **Storage → Rules** tab, replace with `storage.rules`, click **Publish**.

- [ ] **Step 4: Manually verify writes are blocked while logged out**

With the local server running and the page open (logged out), open DevTools console and run:

```js
import('./cms/firebase.js').then(async (m) => {
  const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
  try {
    await setDoc(doc(m.db, 'content', 'site'), { hack: true });
    console.log('FAIL: write succeeded, rules are not enforcing');
  } catch (e) {
    console.log('OK, write blocked:', e.code);
  }
});
```

Expected: logs `OK, write blocked: permission-denied`.

- [ ] **Step 5: Commit**

```bash
git add firestore.rules storage.rules
git commit -m "Add Firestore and Storage security rules"
```

---

### Task 3: Gear icon, login modal, and auth module

**Files:**
- Create: `cms/auth.js`
- Create: `cms/main.js`
- Create: `cms/cms.css`
- Modify: `index.html` (gear/modal markup, `<link>` for `cms.css`, `<script type="module" src="cms/main.js">`)

**Interfaces:**
- Consumes: `auth`, `db` from `cms/firebase.js` (Task 1).
- Produces: `login(email, password): Promise<void>`, `logout(): Promise<void>`, `isAdmin(): boolean`, `onAdminChange(cb: (active: boolean) => void): void`, `initAuth(): void` — every later task's edit UI subscribes via `onAdminChange`.

- [ ] **Step 1: Create `cms/auth.js`**

```js
import { auth, db } from './firebase.js';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let adminActive = false;
const listeners = [];

function notify() {
  listeners.forEach(function (cb) { cb(adminActive); });
}

export function onAdminChange(cb) {
  listeners.push(cb);
  cb(adminActive);
}

export function isAdmin() {
  return adminActive;
}

export function login(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function logout() {
  return signOut(auth);
}

export function initAuth() {
  setPersistence(auth, browserLocalPersistence).then(function () {
    onAuthStateChanged(auth, async function (user) {
      if (!user) {
        adminActive = false;
        notify();
        return;
      }
      try {
        const adminDoc = await getDoc(doc(db, 'admins', user.uid));
        adminActive = adminDoc.exists();
      } catch (e) {
        console.warn('[cms] admin check failed:', e.code || e.message);
        adminActive = false;
      }
      notify();
    });
  });
}
```

- [ ] **Step 2: Create `cms/cms.css`**

```css
.cms-gear{
  position:fixed;right:18px;bottom:18px;z-index:500;
  width:40px;height:40px;border-radius:50%;border:none;
  background:rgba(23,22,20,.35);color:#fff;font-size:18px;
  cursor:pointer;opacity:.55;transition:opacity .2s;
}
.cms-gear:hover{opacity:1;}
.cms-gear.cms-admin{background:var(--khaki);opacity:.85;}

.cms-modal-backdrop{
  position:fixed;inset:0;background:rgba(23,22,20,.5);
  display:none;align-items:center;justify-content:center;z-index:600;
}
.cms-modal-backdrop.open{display:flex;}
.cms-modal{
  background:var(--paper);padding:28px;border-radius:10px;
  width:min(90vw,320px);font-family:var(--sans);
}
.cms-modal h3{margin:0 0 14px;font-family:var(--display);font-weight:400;font-size:22px;}
.cms-modal label{display:block;font-size:13px;margin:12px 0 4px;color:var(--muted);}
.cms-modal input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px;}
.cms-modal-actions{display:flex;justify-content:space-between;align-items:center;margin-top:18px;}
.cms-modal-error{color:#a33;font-size:13px;min-height:16px;margin-top:8px;}
.cms-modal-close{background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;}
.cms-modal button[type="submit"]{background:var(--khaki);color:#fff;border:none;border-radius:20px;padding:8px 18px;cursor:pointer;font-size:14px;}

.cms-edit-badge{
  position:fixed;right:64px;bottom:18px;z-index:500;
  background:var(--khaki);color:#fff;border-radius:20px;
  padding:8px 16px;font-family:var(--sans);font-size:13px;
  display:none;align-items:center;gap:10px;
}
.cms-edit-badge.visible{display:flex;}
.cms-edit-badge button{background:none;border:none;color:#fff;text-decoration:underline;cursor:pointer;font-size:13px;}

.cms-toast{
  position:fixed;left:50%;bottom:70px;transform:translate(-50%,10px);
  background:rgba(23,22,20,.85);color:#fff;padding:8px 16px;border-radius:20px;
  font-family:var(--sans);font-size:13px;opacity:0;transition:opacity .2s, transform .2s;
  z-index:700;pointer-events:none;
}
.cms-toast.show{opacity:1;transform:translate(-50%,0);}
```

- [ ] **Step 3: Create `cms/main.js`**

```js
import { initAuth, login, logout, isAdmin, onAdminChange } from './auth.js';

(function () {
  initAuth();

  const gear = document.getElementById('cmsGear');
  const modal = document.getElementById('cmsModalBackdrop');
  const form = document.getElementById('cmsLoginForm');
  const errorEl = document.getElementById('cmsLoginError');
  const badge = document.getElementById('cmsEditBadge');
  const logoutBtn = document.getElementById('cmsLogoutBtn');

  gear.addEventListener('click', function () {
    if (isAdmin()) return;
    modal.classList.add('open');
  });

  document.getElementById('cmsModalClose').addEventListener('click', function () {
    modal.classList.remove('open');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.textContent = '';
    const email = document.getElementById('cmsEmail').value.trim();
    const password = document.getElementById('cmsPassword').value;
    login(email, password)
      .then(function () {
        modal.classList.remove('open');
        form.reset();
      })
      .catch(function () {
        errorEl.textContent = 'Wrong email or password.';
      });
  });

  logoutBtn.addEventListener('click', function () {
    logout();
  });

  onAdminChange(function (active) {
    gear.classList.toggle('cms-admin', active);
    badge.classList.toggle('visible', active);
  });
})();
```

- [ ] **Step 4: Add markup and asset tags to `index.html`**

Add inside `<head>`, after the existing `<link href="https://fonts.googleapis.com/css2...">` line:

```html
<link rel="stylesheet" href="cms/cms.css">
```

Add immediately before the closing `</footer>` tag's following content (i.e., right after `</footer>`, before the `<script>` that starts the classic inline script):

```html
<button class="cms-gear" id="cmsGear" aria-label="Site settings">&#9881;</button>

<div class="cms-edit-badge" id="cmsEditBadge">
  Edit mode is on
  <button type="button" id="cmsLogoutBtn">Log out</button>
</div>

<div class="cms-modal-backdrop" id="cmsModalBackdrop">
  <div class="cms-modal">
    <h3>Log in</h3>
    <form id="cmsLoginForm">
      <label for="cmsEmail">Email</label>
      <input id="cmsEmail" type="email" required>
      <label for="cmsPassword">Password</label>
      <input id="cmsPassword" type="password" required>
      <div class="cms-modal-error" id="cmsLoginError"></div>
      <div class="cms-modal-actions">
        <button type="button" class="cms-modal-close" id="cmsModalClose">Cancel</button>
        <button type="submit">Log in</button>
      </div>
    </form>
  </div>
</div>
```

Then, right after the `<script type="module" src="cms/firebase.js"></script>` tag added in Task 1, add:

```html
<script type="module" src="cms/main.js"></script>
```

- [ ] **Step 5: Manually verify the full login flow**

With the local server running: click the gear, confirm the modal opens. Enter the wrong password, confirm "Wrong email or password." appears. Enter the correct email/password (the user you created in the Firebase console), confirm the modal closes and the "Edit mode is on" badge appears bottom-right. Reload the page — confirm the badge is still showing (session persisted). Click **Log out**, confirm the badge disappears.

- [ ] **Step 6: Commit**

```bash
git add cms/auth.js cms/main.js cms/cms.css index.html
git commit -m "Add gear-icon login and admin session handling"
```

---

### Task 4: Content store for swap-in-place fields

**Files:**
- Create: `cms/content-store.js`

**Interfaces:**
- Consumes: `db` from `cms/firebase.js`.
- Produces: `loadSiteContent(): Promise<object>`, `getField(key: string, fallback: string): string`, `setField(key: string, value: string): Promise<void>` — consumed by `edit-text.js` and `edit-image.js` (Tasks 5, 6).

- [ ] **Step 1: Create `cms/content-store.js`**

```js
import { db } from './firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

let cache = {};
let loaded = false;

export async function loadSiteContent() {
  try {
    const snap = await getDoc(doc(db, 'content', 'site'));
    cache = snap.exists() ? snap.data() : {};
  } catch (e) {
    cache = {};
  }
  loaded = true;
  return cache;
}

export function getField(key, fallback) {
  if (!loaded) return fallback;
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
}

export async function setField(key, value) {
  cache[key] = value;
  await setDoc(doc(db, 'content', 'site'), { [key]: value }, { merge: true });
}
```

- [ ] **Step 2: Wire the load call into `cms/main.js`**

Replace the entire contents of `cms/main.js` with the version below. It is the Task 3 file with two changes: the new `loadSiteContent` import, and the IIFE becomes `async` so content loads before auth init.

```js
import { initAuth, login, logout, isAdmin, onAdminChange } from './auth.js';
import { loadSiteContent } from './content-store.js';

(async function () {
  await loadSiteContent();
  initAuth();

  const gear = document.getElementById('cmsGear');
  const modal = document.getElementById('cmsModalBackdrop');
  const form = document.getElementById('cmsLoginForm');
  const errorEl = document.getElementById('cmsLoginError');
  const badge = document.getElementById('cmsEditBadge');
  const logoutBtn = document.getElementById('cmsLogoutBtn');

  gear.addEventListener('click', function () {
    if (isAdmin()) return;
    modal.classList.add('open');
  });

  document.getElementById('cmsModalClose').addEventListener('click', function () {
    modal.classList.remove('open');
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorEl.textContent = '';
    const email = document.getElementById('cmsEmail').value.trim();
    const password = document.getElementById('cmsPassword').value;
    login(email, password)
      .then(function () {
        modal.classList.remove('open');
        form.reset();
      })
      .catch(function () {
        errorEl.textContent = 'Wrong email or password.';
      });
  });

  logoutBtn.addEventListener('click', function () {
    logout();
  });

  onAdminChange(function (active) {
    gear.classList.toggle('cms-admin', active);
    badge.classList.toggle('visible', active);
  });
})();
```

Tasks 5, 6, 9, 10, and 11 each add one more import line at the top and one more init call inside this same async IIFE — their "Wire into `cms/main.js`" steps say exactly where.

- [ ] **Step 3: Manually verify**

In DevTools console on the loaded page: `import('./cms/content-store.js').then(m => console.log(m.getField('nonexistent.key', 'fallback-value')))`. Expected: logs `fallback-value`.

- [ ] **Step 4: Commit**

```bash
git add cms/content-store.js cms/main.js
git commit -m "Add Firestore content store for swap-in-place fields"
```

---

### Task 5: Swap-in-place text editing

**Files:**
- Create: `cms/edit-text.js`
- Modify: `index.html` (add `data-cms-id`/`data-cms-type="text"` to the 9 fields below; add script import/init call)
- Modify: `cms/cms.css` (append editable-state styles)
- Modify: `cms/main.js` (import + init call)

**Interfaces:**
- Consumes: `getField`, `setField` (Task 4), `onAdminChange` (Task 3).
- Produces: `initTextEditing(): void`.

- [ ] **Step 1: Create `cms/edit-text.js`**

```js
import { getField, setField } from './content-store.js';
import { onAdminChange } from './auth.js';

function applyContent(el) {
  const id = el.getAttribute('data-cms-id');
  const value = getField(id, el.__cmsFallback);
  el.innerHTML = value;
}

function showSavedToast() {
  let toast = document.getElementById('cmsToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'cmsToast';
    toast.className = 'cms-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = 'Saved';
  toast.classList.add('show');
  clearTimeout(toast.__timer);
  toast.__timer = setTimeout(function () { toast.classList.remove('show'); }, 1500);
}

export function initTextEditing() {
  const fields = document.querySelectorAll('[data-cms-type="text"]');

  fields.forEach(function (el) {
    el.__cmsFallback = el.innerHTML;
    applyContent(el);
  });

  onAdminChange(function (active) {
    fields.forEach(function (el) {
      el.classList.toggle('cms-editable', active);
      if (!active) {
        el.contentEditable = 'false';
        el.classList.remove('cms-editing');
      }
    });
  });

  document.addEventListener('click', function (e) {
    const el = e.target.closest('.cms-editable');
    if (!el || el.contentEditable === 'true') return;
    el.contentEditable = 'true';
    el.classList.add('cms-editing');
    el.focus();
  });

  document.addEventListener(
    'focusout',
    function (e) {
      const el = e.target.closest && e.target.closest('[data-cms-type="text"]');
      if (!el || el.contentEditable !== 'true') return;
      el.contentEditable = 'false';
      el.classList.remove('cms-editing');
      const id = el.getAttribute('data-cms-id');
      setField(id, el.innerHTML).then(showSavedToast);
    },
    true
  );
}
```

- [ ] **Step 2: Append editable-state styles to `cms/cms.css`**

```css
.cms-editable{outline:1px dashed transparent;cursor:text;transition:outline-color .15s;}
.cms-editable:hover{outline-color:var(--khaki);}
.cms-editable.cms-editing{outline:1px solid var(--khaki);outline-offset:2px;}
```

- [ ] **Step 3: Add `data-cms-id`/`data-cms-type="text"` to the 9 fields in `index.html`**

| # | `data-cms-id` | Current line | Exact edit |
|---|---|---|---|
| 1 | `home.heading` | 414 | `<h2 class="h2">Wedding photographer...` → `<h2 class="h2" data-cms-id="home.heading" data-cms-type="text">Wedding photographer...` |
| 2 | `home.paragraph1` | 415 | `<p>I photograph weddings as living...` → `<p data-cms-id="home.paragraph1" data-cms-type="text">I photograph weddings as living...` |
| 3 | `home.paragraph2` | 416 | `<p>I love modern celebrations...` → `<p data-cms-id="home.paragraph2" data-cms-type="text">I love modern celebrations...` |
| 4 | `about.heading` | 477 | `<h2 class="h2">A bit about me</h2>` → `<h2 class="h2" data-cms-id="about.heading" data-cms-type="text">A bit about me</h2>` |
| 5 | `about.paragraph1` | 478 | `<p>I grew up in Beaverton...` → `<p data-cms-id="about.paragraph1" data-cms-type="text">I grew up in Beaverton...` |
| 6 | `about.paragraph2` | 479 | `<p>These days I&#8217;m based...` → `<p data-cms-id="about.paragraph2" data-cms-type="text">These days I&#8217;m based...` |
| 7 | `about.paragraph3` | 480 | `<p>If you&#8217;re looking for someone...` → `<p data-cms-id="about.paragraph3" data-cms-type="text">If you&#8217;re looking for someone...` |
| 8 | `contact.eyebrow` | 895 | `<span class="index">Inquiries</span>` → `<span class="index" data-cms-id="contact.eyebrow" data-cms-type="text">Inquiries</span>` |
| 9 | `contact.heading` | 896 | `<h1 class="display">Let&#8217;s Capture Your Story</h1>` → `<h1 class="display" data-cms-id="contact.heading" data-cms-type="text">Let&#8217;s Capture Your Story</h1>` |

For each row, use the Edit tool with the "Current line" text as `old_string` (include enough of the line to be unique — each of these lines is already unique in the file) and the "Exact edit" result as `new_string`.

- [ ] **Step 4: Wire into `cms/main.js`**

Add the import:

```js
import { initTextEditing } from './edit-text.js';
```

Inside the async IIFE, right after `await loadSiteContent();`, add:

```js
initTextEditing();
```

- [ ] **Step 5: Manually verify**

Load the page, log in. Hover over "A bit about me" on the About page — confirm a dashed outline appears. Click it, confirm it becomes an editable text cursor, change the text, click elsewhere. Confirm a "Saved" toast appears bottom-center. Reload the page — confirm the edited text persisted. Log out and reload — confirm the dashed outline no longer appears on hover and the text is not clickable-to-edit.

- [ ] **Step 6: Commit**

```bash
git add cms/edit-text.js cms/cms.css cms/main.js index.html
git commit -m "Add swap-in-place text editing for home/about/contact copy"
```

---

### Task 6: Swap-in-place image editing

**Files:**
- Create: `cms/edit-image.js`
- Modify: `index.html` (add `data-cms-id`/`data-cms-type="image"` to the 5 images below; add script import/init call)
- Modify: `cms/cms.css` (append image-overlay styles)
- Modify: `cms/main.js` (import + init call)

**Interfaces:**
- Consumes: `storage` (Task 1), `getField`/`setField` (Task 4), `onAdminChange` (Task 3).
- Produces: `initImageEditing(): void`, `uploadImage(file: File, pathPrefix: string): Promise<string>` (returns the download URL) — reused as-is by `collection-ui.js` (Task 8) for collection item photo uploads.

- [ ] **Step 1: Create `cms/edit-image.js`**

```js
import { storage } from './firebase.js';
import { ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js';
import { getField, setField } from './content-store.js';
import { onAdminChange } from './auth.js';

const MAX_BYTES = 10 * 1024 * 1024;

export async function uploadImage(file, pathPrefix) {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is larger than 10MB.');
  }
  const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-100);
  const path = 'uploads/' + pathPrefix + '/' + Date.now() + '-' + safeName;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, file);
  return getDownloadURL(fileRef);
}

function applyImage(img) {
  const id = img.getAttribute('data-cms-id');
  const value = getField(id, img.__cmsFallback);
  img.src = value;
  if (value !== img.__cmsFallback) {
    img.removeAttribute('srcset');
  }
}

function buildOverlay(img) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cms-image-overlay';
  btn.textContent = 'Change photo';
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', function () {
      const file = input.files[0];
      if (!file) return;
      const id = img.getAttribute('data-cms-id');
      uploadImage(file, id)
        .then(function (url) { return setField(id, url); })
        .then(function () { applyImage(img); })
        .catch(function (err) { alert(err.message); });
    });
    input.click();
  });
  return btn;
}

export function initImageEditing() {
  const images = document.querySelectorAll('[data-cms-type="image"]');

  images.forEach(function (img) {
    img.__cmsFallback = img.getAttribute('src');
    applyImage(img);
    img.parentNode.appendChild(buildOverlay(img));
  });

  onAdminChange(function (active) {
    document.querySelectorAll('.cms-image-overlay').forEach(function (btn) {
      btn.classList.toggle('cms-visible', active);
    });
  });
}
```

- [ ] **Step 2: Append image-overlay styles to `cms/cms.css`**

```css
.cms-image-overlay{
  display:none;position:absolute;left:50%;bottom:16px;transform:translateX(-50%);
  padding:8px 16px;background:rgba(23,22,20,.75);color:#fff;border:none;
  border-radius:20px;font-family:var(--sans);font-size:13px;cursor:pointer;z-index:50;
}
.cms-image-overlay.cms-visible{display:block;}
```

- [ ] **Step 3: Add `data-cms-id`/`data-cms-type="image"` to the 5 images in `index.html`**

| # | `data-cms-id` | Current line | Exact edit |
|---|---|---|---|
| 1 | `home.introImage` | 412 | `<img src="images/about-bio-2.jpg" srcset=...>` → add `data-cms-id="home.introImage" data-cms-type="image"` right after `<img ` |
| 2 | `home.banner` | 458 | `<img src="images/home-banner.jpg" alt="">` → `<img src="images/home-banner.jpg" alt="" data-cms-id="home.banner" data-cms-type="image">` |
| 3 | `about.bioImage` | 475 | `<img src="images/about-bio.jpg" srcset=...>` → add `data-cms-id="about.bioImage" data-cms-type="image"` right after `<img ` |
| 4 | `about.banner` | 487 | `<img src="images/about-banner.jpg" alt="">` → `<img src="images/about-banner.jpg" alt="" data-cms-id="about.banner" data-cms-type="image">` |
| 5 | `contact.photo` | 906 | `<img src="images/contact-photo.jpg" alt="">` → `<img src="images/contact-photo.jpg" alt="" data-cms-id="contact.photo" data-cms-type="image">` |

For rows 1 and 3 (which have a `srcset`/`sizes` attribute), insert `data-cms-id="..." data-cms-type="image"` as new attributes right after the `src="..."` attribute, before `srcset`, leaving `srcset`/`sizes`/`width`/`height`/`alt` untouched — `edit-image.js` strips `srcset` at runtime only once a real edit has been made (Step 1 above), so the responsive fallback keeps working until then.

- [ ] **Step 4: Wire into `cms/main.js`**

Add the import:

```js
import { initImageEditing } from './edit-image.js';
```

Inside the async IIFE, right after `initTextEditing();`, add:

```js
initImageEditing();
```

- [ ] **Step 5: Manually verify**

Log in, go to the About page, hover the bio photo — confirm a "Change photo" button appears near the bottom of the image. Click it, pick a different image file from disk, confirm the photo updates immediately. Reload — confirm the new photo persisted. In the Firebase console under **Storage**, confirm a new file appears under `uploads/about.bioImage/`. Log out — confirm the "Change photo" button no longer appears on hover.

- [ ] **Step 6: Commit**

```bash
git add cms/edit-image.js cms/cms.css cms/main.js index.html
git commit -m "Add swap-in-place image editing for home/about/contact photos"
```

---

### Task 7: Generic collection store

**Files:**
- Create: `cms/collection-store.js`

**Interfaces:**
- Consumes: `db` from `cms/firebase.js`.
- Produces: `loadCollection(name: string): Promise<Array<{id: string, ...}>>`, `seedCollection(name: string, items: Array<object>): Promise<void>`, `addCollectionItem(name: string, data: object, order: number): Promise<string>` (returns new doc id), `deleteCollectionItem(name: string, id: string): Promise<void>`, `reorderCollection(name: string, orderedIds: string[]): Promise<void>` — consumed by `hero.js`, `portfolio.js`, `testimonials.js` (Tasks 9–11) via `collection-ui.js` (Task 8).

- [ ] **Step 1: Create `cms/collection-store.js`**

```js
import { db } from './firebase.js';
import {
  collection,
  doc,
  getDocs,
  addDoc,
  deleteDoc,
  writeBatch,
  query,
  orderBy
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

export async function loadCollection(name) {
  try {
    const q = query(collection(db, name), orderBy('order'));
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(function (docSnap) {
      items.push(Object.assign({ id: docSnap.id }, docSnap.data()));
    });
    return items;
  } catch (e) {
    return [];
  }
}

export async function seedCollection(name, items) {
  const batch = writeBatch(db);
  items.forEach(function (item, index) {
    const itemRef = doc(collection(db, name));
    batch.set(itemRef, Object.assign({}, item, { order: index }));
  });
  await batch.commit();
}

export async function addCollectionItem(name, data, order) {
  const itemRef = await addDoc(collection(db, name), Object.assign({}, data, { order: order }));
  return itemRef.id;
}

export async function deleteCollectionItem(name, id) {
  await deleteDoc(doc(db, name, id));
}

export async function reorderCollection(name, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach(function (id, index) {
    batch.update(doc(db, name, id), { order: index });
  });
  await batch.commit();
}
```

- [ ] **Step 2: Manually verify**

In DevTools console: `import('./cms/collection-store.js').then(m => m.loadCollection('heroSlides')).then(console.log)`. Expected: logs `[]` (collection doesn't exist yet — that's correct, no error thrown).

- [ ] **Step 3: Commit**

```bash
git add cms/collection-store.js
git commit -m "Add generic Firestore collection CRUD and reorder helpers"
```

---

### Task 8: Generic collection edit UI (delete, drag-reorder, add)

**Files:**
- Create: `cms/collection-ui.js`
- Modify: `cms/cms.css` (append collection-tile styles)

**Interfaces:**
- Consumes: `uploadImage` (Task 6).
- Produces: `makeCollectionEditable(options: { onAdd(): void, onDelete(id: string): void, onReorder(orderedIds: string[]): void }): { attachTile(tile: HTMLElement, itemId: string): void, buildAddTile(): HTMLElement }` — consumed by `hero.js`, `portfolio.js`, `testimonials.js` (Tasks 9–11). `attachTile` adds a delete button and drag handlers to an already-rendered tile element; `buildAddTile` returns a standalone "+ Add" element the caller appends to its container.

- [ ] **Step 1: Create `cms/collection-ui.js`**

```js
export function makeCollectionEditable(options) {
  const onAdd = options.onAdd;
  const onDelete = options.onDelete;
  const onReorder = options.onReorder;
  let dragEl = null;

  function attachTile(tile, itemId) {
    tile.setAttribute('draggable', 'true');
    tile.dataset.cmsItemId = itemId;
    tile.classList.add('cms-collection-tile');

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cms-collection-delete';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (confirm('Delete this item?')) onDelete(itemId);
    });
    tile.appendChild(del);

    tile.addEventListener('dragstart', function () {
      dragEl = tile;
      tile.classList.add('cms-dragging');
    });
    tile.addEventListener('dragend', function () {
      tile.classList.remove('cms-dragging');
      dragEl = null;
      const container = tile.parentNode;
      const orderedIds = Array.prototype.slice
        .call(container.children)
        .filter(function (el) { return el.dataset && el.dataset.cmsItemId; })
        .map(function (el) { return el.dataset.cmsItemId; });
      onReorder(orderedIds);
    });
    tile.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (!dragEl || dragEl === tile) return;
      const rect = tile.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      tile.parentNode.insertBefore(dragEl, before ? tile : tile.nextSibling);
    });
  }

  function buildAddTile() {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'cms-collection-add';
    tile.textContent = '+ Add';
    tile.addEventListener('click', onAdd);
    return tile;
  }

  return { attachTile: attachTile, buildAddTile: buildAddTile };
}
```

- [ ] **Step 2: Append collection-tile styles to `cms/cms.css`**

```css
.cms-collection-tile{position:relative;}
.cms-collection-tile.cms-dragging{opacity:.35;}
.cms-collection-delete{
  display:none;position:absolute;top:6px;right:6px;width:24px;height:24px;
  border-radius:50%;border:none;background:rgba(23,22,20,.75);color:#fff;
  cursor:pointer;font-size:15px;line-height:1;z-index:60;
}
.cms-editmode .cms-collection-delete{display:block;}
.cms-collection-add{
  display:none;align-items:center;justify-content:center;min-height:120px;
  border:1px dashed var(--khaki);background:transparent;color:var(--khaki);
  font-family:var(--sans);font-size:14px;cursor:pointer;border-radius:6px;
}
.cms-editmode .cms-collection-add{display:flex;}
```

Note: `.cms-editmode` is a class each of Tasks 9–11 toggles on their own container via `onAdminChange`, not set here — `collection-ui.js` only styles for it.

- [ ] **Step 3: Commit**

```bash
git add cms/collection-ui.js cms/cms.css
git commit -m "Add generic collection edit UI (delete, drag-reorder, add)"
```

---

### Task 9: Hero slideshow wired to `heroSlides` collection

**Files:**
- Create: `cms/hero.js`
- Modify: `index.html` (wrap the 4 hardcoded `.slide` divs in a `#heroSlides` mount point; delete the now-superseded inline hero-slideshow script block; add script import/init call)
- Modify: `cms/cms.css` (append hero-specific tile sizing)
- Modify: `cms/main.js` (import + init call)

**Interfaces:**
- Consumes: `loadCollection`, `seedCollection`, `addCollectionItem`, `deleteCollectionItem`, `reorderCollection` (Task 7), `makeCollectionEditable`, `uploadImage` (Tasks 6, 8), `onAdminChange` (Task 3).
- Produces: `initHero(): Promise<void>`.

- [ ] **Step 1: Wrap the hero slides in `index.html`**

Find (around line 389-393):

```html
  <div class="hero">
    <div class="slide on"><img src="images/elopement-mountains.jpg" alt="Eloping couple embracing in front of the Ko'olau mountains" style="object-position:50% 58%;"></div>
    <div class="slide"><img src="images/maternity-walk.jpg" alt="Pregnant couple holding hands while walking on the beach" style="object-position:40% 45%;"></div>
    <div class="slide"><img src="images/park-embrace.jpg" alt="Couple embracing in a sunlit park" style="object-position:50% 35%;"></div>
    <div class="slide"><img src="images/family-palm.jpg" alt="Family of four sitting on the beach under a palm tree" style="object-position:50% 55%;"></div>

    <div class="hero-cta">
```

Replace with:

```html
  <div class="hero">
    <div class="hero-slides" id="heroSlides" style="display:contents;"></div>

    <div class="hero-cta">
```

(Deleting the 4 hardcoded `.slide` divs entirely — their content becomes `hero.js`'s fallback data in Step 2.)

- [ ] **Step 2: Create `cms/hero.js`**

```js
import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection } from './collection-store.js';
import { makeCollectionEditable } from './collection-ui.js';
import { uploadImage } from './edit-image.js';
import { onAdminChange } from './auth.js';

const COLLECTION = 'heroSlides';
const FALLBACK = [
  { src: 'images/elopement-mountains.jpg', alt: 'Eloping couple embracing in front of the Koʻolau mountains', objectPosition: '50% 58%' },
  { src: 'images/maternity-walk.jpg', alt: 'Pregnant couple holding hands while walking on the beach', objectPosition: '40% 45%' },
  { src: 'images/park-embrace.jpg', alt: 'Couple embracing in a sunlit park', objectPosition: '50% 35%' },
  { src: 'images/family-palm.jpg', alt: 'Family of four sitting on the beach under a palm tree', objectPosition: '50% 55%' }
];

let items = [];
let usingFallback = true;
let index = 0;
let timer;

const mount = document.getElementById('heroSlides');
const framesEl = document.getElementById('frames');
const counter = document.getElementById('counter');

function render() {
  mount.innerHTML = '';
  framesEl.innerHTML = '';

  items.forEach(function (item, i) {
    const slide = document.createElement('div');
    slide.className = 'slide' + (i === 0 ? ' on' : '');
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = item.alt || '';
    img.style.objectPosition = item.objectPosition || '50% 50%';
    slide.appendChild(img);
    mount.appendChild(slide);

    const thumb = document.createElement('button');
    thumb.setAttribute('aria-label', 'Frame ' + (i + 1));
    thumb.innerHTML = '<img alt="" src="' + item.src + '">';
    thumb.addEventListener('click', function () { show(i); auto(); });
    framesEl.appendChild(thumb);
  });

  if (!usingFallback) {
    const ui = makeCollectionEditable({
      onAdd: handleAdd,
      onDelete: handleDelete,
      onReorder: handleReorder
    });
    Array.prototype.forEach.call(mount.children, function (slide, i) {
      ui.attachTile(slide, items[i].id);
    });
    mount.appendChild(ui.buildAddTile());
  }

  index = 0;
  show(0);
  auto();
}

function show(n) {
  const slides = mount.querySelectorAll('.slide');
  const thumbs = framesEl.querySelectorAll('button');
  index = (n + slides.length) % slides.length;
  slides.forEach(function (s, k) { s.classList.toggle('on', k === index); });
  thumbs.forEach(function (t, k) { t.classList.toggle('on', k === index); });
  counter.textContent = 'Frame ' + String(index + 1).padStart(2, '0');
}

function auto() {
  clearInterval(timer);
  timer = setInterval(function () { show(index + 1); }, 6800);
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  render();
}

async function handleAdd() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    await ensureSeeded();
    const url = await uploadImage(file, 'heroSlides');
    await addCollectionItem(COLLECTION, { src: url, alt: '', objectPosition: '50% 50%' }, items.length);
    items = await loadCollection(COLLECTION);
    render();
  });
  input.click();
}

async function handleDelete(id) {
  await deleteCollectionItem(COLLECTION, id);
  items = await loadCollection(COLLECTION);
  render();
}

async function handleReorder(orderedIds) {
  await reorderCollection(COLLECTION, orderedIds);
  items = await loadCollection(COLLECTION);
}

export async function initHero() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  render();

  document.getElementById('prev').addEventListener('click', function () { show(index - 1); auto(); });
  document.getElementById('next').addEventListener('click', function () { show(index + 1); auto(); });

  onAdminChange(async function (active) {
    if (active) {
      await ensureSeeded();
      mount.classList.toggle('cms-editmode', true);
    } else {
      mount.classList.remove('cms-editmode');
    }
  });
}
```

- [ ] **Step 3: Delete the now-superseded inline hero-slideshow script in `index.html`**

In the classic `<script>` block, find and delete this entire block (originally around lines 1026-1050):

```js
  /* ---------- hero: filmstrip scrubber ---------- */
  var slides = document.querySelectorAll('.hero .slide');
  var framesEl = document.getElementById('frames');
  var counter = document.getElementById('counter');
  var i = 0, timer;

  slides.forEach(function(s, k){
    var b = document.createElement('button');
    b.setAttribute('aria-label', 'Frame ' + (k+1));
    b.innerHTML = '<img alt="" src="' + s.querySelector('img').getAttribute('src') + '">';
    b.addEventListener('click', function(){ show(k); auto(); });
    framesEl.appendChild(b);
  });
  var thumbs = framesEl.querySelectorAll('button');

  function show(n){
    i = (n + slides.length) % slides.length;
    slides.forEach(function(s,k){ s.classList.toggle('on', k === i); });
    thumbs.forEach(function(t,k){ t.classList.toggle('on', k === i); });
    counter.textContent = 'Frame ' + String(i+1).padStart(2,'0');
  }
  function auto(){ clearInterval(timer); timer = setInterval(function(){ show(i+1); }, 6800); }
  document.getElementById('next').addEventListener('click', function(){ show(i+1); auto(); });
  document.getElementById('prev').addEventListener('click', function(){ show(i-1); auto(); });
  show(0); auto();
```

Leave everything above and below this block (routing, filmstrip auto-scroll, portfolio archive, etc.) untouched.

- [ ] **Step 4: Append hero-specific styles to `cms/cms.css`**

```css
#heroSlides .cms-collection-delete{top:16px;right:16px;}
#heroSlides .cms-collection-add{
  position:absolute;left:16px;bottom:120px;z-index:10;
  width:auto;min-height:auto;padding:8px 16px;background:rgba(23,22,20,.55);color:#fff;
}
```

- [ ] **Step 5: Wire into `cms/main.js`**

Add the import:

```js
import { initHero } from './hero.js';
```

Inside the async IIFE, right after `initImageEditing();`, add:

```js
await initHero();
```

- [ ] **Step 6: Manually verify**

Reload the page logged out — confirm the hero slideshow looks and behaves exactly as before (4 slides, auto-advancing, prev/next, frame thumbnails, counter). Log in — confirm a delete (×) button appears on the current slide and an "+ Add" state becomes available (check the Firestore console: a `heroSlides` collection now exists with 4 seeded documents). Delete one slide, confirm it's removed and the thumbnails/counter update. Add a new slide via file upload, confirm it appears. Drag a slide to reorder it, confirm the order persists after reload.

- [ ] **Step 7: Commit**

```bash
git add cms/hero.js cms/cms.css cms/main.js index.html
git commit -m "Wire hero slideshow to Firestore heroSlides collection"
```

---

### Task 10: Portfolio grid + derived filmstrip wired to `portfolioShots` collection

**Files:**
- Create: `cms/portfolio.js`
- Modify: `index.html` (delete the now-superseded inline `shots` array/`renderGrid`; replace hardcoded filmstrip markup with an empty mount point; add script import/init call)
- Modify: `cms/cms.css` (append portfolio/filmstrip tile sizing)
- Modify: `cms/main.js` (import + init call)

**Interfaces:**
- Consumes: same as Task 9 (`collection-store.js`, `collection-ui.js`, `uploadImage`, `onAdminChange`).
- Produces: `initPortfolio(): Promise<void>`.

- [ ] **Step 1: Delete the inline `shots` array and `renderGrid` in `index.html`**

In the classic `<script>` block, find and delete this entire block (originally around lines 1100-1150):

```js
  /* ---------- portfolio archive ---------- */
  var shots = [
    {src:'kiss-windy.jpg', cat:'portraits', place:'Honolulu, Oʻahu'},
    ... (all entries) ...
    {src:'pricing-final-banner.jpg', cat:'portraits', place:'Pacific Northwest'}
  ];
  var grid = document.getElementById('grid');

  function renderGrid(){
    grid.innerHTML = '';
    shots.forEach(function(s){
      var d = document.createElement('div');
      d.className = 'shot' + (s.wide ? ' wide' : '');
      d.innerHTML = '<div class="frame marked"><img loading="lazy" alt="" src="' + B + s.src + '"></div>';
      grid.appendChild(d);
    });
  }
  renderGrid();
```

(The `var B = 'images/';` line near the top of the script is still used elsewhere — do not delete it.)

- [ ] **Step 2: Replace the hardcoded filmstrip markup in `index.html`**

Find (around lines 422-443):

```html
  <div class="filmstrip">
    <div class="filmstrip-track">
      <div class="frame marked"><img src="images/gallery-a.jpg" alt=""></div>
      ...(18 total divs)...
    </div>
  </div>
```

Replace with:

```html
  <div class="filmstrip">
    <div class="filmstrip-track" id="filmstripTrack"></div>
  </div>
```

- [ ] **Step 3: Create `cms/portfolio.js`**

```js
import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection } from './collection-store.js';
import { makeCollectionEditable } from './collection-ui.js';
import { uploadImage } from './edit-image.js';
import { onAdminChange } from './auth.js';

const COLLECTION = 'portfolioShots';
const FALLBACK = [
  { src: 'images/kiss-windy.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/maternity-beach.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/wedding-carry.jpg', cat: 'weddings', place: 'Kualoa Ranch' },
  { src: 'images/couple-park.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/gallery-a.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/gallery-b.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-c.jpg', cat: 'portraits', place: 'Lanikai' },
  { src: 'images/gallery-d.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/gallery-e.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/gallery-f.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-g.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/gallery-h.jpg', cat: 'portraits', place: 'Lanikai' },
  { src: 'images/gallery-i.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-01.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/grid-02-wide.jpg', cat: 'portraits', place: 'Kāhala', wide: true },
  { src: 'images/grid-03.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-04.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-05.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/grid-06-wide.jpg', cat: 'portraits', place: 'Pacific Northwest', wide: true },
  { src: 'images/grid-07.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-08.jpg', cat: 'portraits', place: 'Honolulu, Oʻahu' },
  { src: 'images/grid-09.jpg', cat: 'weddings', place: 'Kualoa Ranch' },
  { src: 'images/grid-10.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/grid-11.jpg', cat: 'portraits', place: 'Waimānalo', wide: true },
  { src: 'images/grid-12.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/about-bio.jpg', cat: 'portraits', place: 'North Shore' },
  { src: 'images/about-bio-2.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/about-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/contact-photo.jpg', cat: 'elopements', place: 'Kualoa Ranch' },
  { src: 'images/home-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' },
  { src: 'images/portfolio-banner.jpg', cat: 'elopements', place: 'Kualoa Ranch', wide: true },
  { src: 'images/pricing-hero.jpg', cat: 'portraits', place: 'Waimānalo' },
  { src: 'images/pricing-portraits.jpg', cat: 'portraits', place: 'Kualoa Ranch' },
  { src: 'images/pricing-elopements.jpg', cat: 'portraits', place: 'Kāhala' },
  { src: 'images/pricing-weddings-banner.jpg', cat: 'weddings', place: 'Kualoa Ranch', wide: true },
  { src: 'images/pricing-final-banner.jpg', cat: 'portraits', place: 'Pacific Northwest' }
];

let items = [];
let usingFallback = true;

const grid = document.getElementById('grid');
const filmstripTrack = document.getElementById('filmstripTrack');

function renderGrid() {
  grid.innerHTML = '';
  const ui = usingFallback ? null : makeCollectionEditable({
    onAdd: handleAdd,
    onDelete: handleDelete,
    onReorder: handleReorder
  });

  items.forEach(function (item) {
    const tile = document.createElement('div');
    tile.className = 'shot' + (item.wide ? ' wide' : '');
    tile.innerHTML = '<div class="frame marked"><img loading="lazy" alt="" src="' + item.src + '"></div>';
    grid.appendChild(tile);
    if (ui) ui.attachTile(tile, item.id);
  });

  if (ui) grid.appendChild(ui.buildAddTile());
}

function renderFilmstrip() {
  filmstripTrack.innerHTML = '';
  const first9 = items.slice(0, 9);
  first9.concat(first9).forEach(function (item, i) {
    const frame = document.createElement('div');
    frame.className = 'frame marked';
    if (i >= first9.length) frame.setAttribute('aria-hidden', 'true');
    frame.innerHTML = '<img src="' + item.src + '" alt="">';
    filmstripTrack.appendChild(frame);
  });
}

function render() {
  renderGrid();
  renderFilmstrip();
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
  render();
}

async function handleAdd() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    await ensureSeeded();
    const url = await uploadImage(file, 'portfolioShots');
    await addCollectionItem(COLLECTION, { src: url, cat: 'portraits', place: '' }, items.length);
    items = await loadCollection(COLLECTION);
    render();
  });
  input.click();
}

async function handleDelete(id) {
  await deleteCollectionItem(COLLECTION, id);
  items = await loadCollection(COLLECTION);
  render();
}

async function handleReorder(orderedIds) {
  await reorderCollection(COLLECTION, orderedIds);
  items = await loadCollection(COLLECTION);
  renderFilmstrip();
}

export async function initPortfolio() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  render();

  onAdminChange(async function (active) {
    if (active) {
      await ensureSeeded();
      grid.classList.toggle('cms-editmode', true);
    } else {
      grid.classList.remove('cms-editmode');
    }
  });
}
```

- [ ] **Step 4: Append portfolio/filmstrip styles to `cms/cms.css`**

```css
.cms-collection-add.shot{aspect-ratio:3/4;}
```

- [ ] **Step 5: Wire into `cms/main.js`**

Add the import:

```js
import { initPortfolio } from './portfolio.js';
```

Inside the async IIFE, right after `await initHero();`, add:

```js
await initPortfolio();
```

- [ ] **Step 6: Manually verify**

Reload logged out — confirm the portfolio grid and homepage filmstrip render exactly as before. Log in, go to the Portfolio page — confirm delete buttons and a "+ Add" tile appear, add a new photo, confirm it appears in the grid. Go to the homepage — confirm the filmstrip still auto-scrolls (it will reflect whatever the first 9 portfolio items now are). Delete a portfolio item that was among the first 9, reload, confirm the filmstrip updated to reflect the new first-9.

- [ ] **Step 7: Commit**

```bash
git add cms/portfolio.js cms/cms.css cms/main.js index.html
git commit -m "Wire portfolio grid and derived filmstrip to Firestore portfolioShots collection"
```

---

### Task 11: Testimonials wired to `testimonials` collection

**Files:**
- Create: `cms/testimonials.js`
- Modify: `index.html` (delete the now-superseded inline `llData` array and Love Letters render logic; add a small add/delete/name/quote edit form; add script import/init call)
- Modify: `cms/cms.css` (append testimonials-specific styles)
- Modify: `cms/main.js` (import + init call)

**Interfaces:**
- Consumes: same as Task 9.
- Produces: `initTestimonials(): Promise<void>`.

- [ ] **Step 1: Delete the inline `llData` and Love Letters logic in `index.html`**

In the classic `<script>` block, find and delete this entire block (originally around lines 1152-1188):

```js
  /* ---------- love letters carousel ---------- */
  var llData = [
    {img:'images/gallery-a.jpg', quote:'She caught the ten seconds I was most afraid I’d forget.', who:'Mailani & Josh'},
    ... (all entries) ...
    {img:'images/grid-12.jpg', quote:'She made my anxious, awkward-in-photos self feel completely at ease.', who:'Jenna & Chris'}
  ];
  var llIndex = 0;
  var llImg = document.getElementById('llImg');
  var llQuote = document.getElementById('llQuote');
  var llWho = document.getElementById('llWho');
  var llCount = document.getElementById('llCount');
  function renderLL(){
    var d = llData[llIndex];
    llImg.style.opacity = 0;
    llQuote.style.opacity = 0;
    llWho.style.opacity = 0;
    setTimeout(function(){
      llImg.src = d.img;
      llQuote.textContent = d.quote;
      llWho.textContent = d.who.toUpperCase();
      llCount.textContent = (llIndex + 1) + ' / ' + llData.length;
      llImg.style.opacity = 1;
      llQuote.style.opacity = 1;
      llWho.style.opacity = 1;
    }, 200);
  }
  document.getElementById('llPrev').addEventListener('click', function(){
    llIndex = (llIndex - 1 + llData.length) % llData.length;
    renderLL();
  });
  document.getElementById('llNext').addEventListener('click', function(){
    llIndex = (llIndex + 1) % llData.length;
    renderLL();
  });
```

- [ ] **Step 2: Add edit controls markup to the Testimonials section in `index.html`**

Find (lines 875-880):

```html
      <div class="ll-nav">
        <button class="ll-arrow" id="llPrev" aria-label="Previous">&#8592;</button>
        <span class="ll-count" id="llCount">1 / 6</span>
        <button class="ll-arrow" id="llNext" aria-label="Next">&#8594;</button>
      </div>
    </div>
  </div>
```

Replace with:

```html
      <div class="ll-nav">
        <button class="ll-arrow" id="llPrev" aria-label="Previous">&#8592;</button>
        <span class="ll-count" id="llCount">1 / 6</span>
        <button class="ll-arrow" id="llNext" aria-label="Next">&#8594;</button>
      </div>
      <div class="cms-ll-controls" id="cmsLLControls" style="display:none;">
        <button type="button" id="cmsLLMoveLeft" aria-label="Move earlier">&#8592; Move</button>
        <button type="button" id="cmsLLMoveRight" aria-label="Move later">Move &#8594;</button>
        <button type="button" id="cmsLLDelete">Delete this one</button>
        <button type="button" id="cmsLLAdd">+ Add testimonial</button>
      </div>
    </div>
  </div>
```

(`cmsLLControls` becomes a new sibling of `.ll-nav`, both inside `.ll-panel` — no other structure changes.)

- [ ] **Step 3: Create `cms/testimonials.js`**

```js
import { loadCollection, seedCollection, addCollectionItem, deleteCollectionItem, reorderCollection } from './collection-store.js';
import { uploadImage } from './edit-image.js';
import { onAdminChange } from './auth.js';

const COLLECTION = 'testimonials';
const FALLBACK = [
  { img: 'images/gallery-a.jpg', quote: 'She caught the ten seconds I was most afraid I’d forget.', who: 'Mailani & Josh' },
  { img: 'images/grid-03.jpg', quote: 'Calm the whole day. Our families still talk about how easy she made it.', who: 'Renée & Tomás' },
  { img: 'images/gallery-h.jpg', quote: 'We booked for the portfolio and stayed for the person.', who: 'Ava & Sam' },
  { img: 'images/grid-04.jpg', quote: 'It felt like hanging out with a friend who happened to have a camera.', who: 'Noa & Leilani' },
  { img: 'images/grid-07.jpg', quote: 'Every photo looks like a memory, not a pose.', who: 'Sarah & Michael' },
  { img: 'images/grid-12.jpg', quote: 'She made my anxious, awkward-in-photos self feel completely at ease.', who: 'Jenna & Chris' }
];

let items = [];
let usingFallback = true;
let index = 0;

const llImg = document.getElementById('llImg');
const llQuote = document.getElementById('llQuote');
const llWho = document.getElementById('llWho');
const llCount = document.getElementById('llCount');
const controls = document.getElementById('cmsLLControls');

function renderLL() {
  const d = items[index];
  llImg.style.opacity = 0;
  llQuote.style.opacity = 0;
  llWho.style.opacity = 0;
  setTimeout(function () {
    llImg.src = d.img;
    llQuote.textContent = d.quote;
    llWho.textContent = d.who.toUpperCase();
    llCount.textContent = (index + 1) + ' / ' + items.length;
    llImg.style.opacity = 1;
    llQuote.style.opacity = 1;
    llWho.style.opacity = 1;
  }, 200);
}

async function ensureSeeded() {
  if (!usingFallback) return;
  await seedCollection(COLLECTION, FALLBACK);
  items = await loadCollection(COLLECTION);
  usingFallback = false;
}

async function handleAdd() {
  const quote = prompt('Quote:');
  if (!quote) return;
  const who = prompt('Names (e.g. "Mailani & Josh"):');
  if (!who) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async function () {
    const file = input.files[0];
    if (!file) return;
    await ensureSeeded();
    const url = await uploadImage(file, 'testimonials');
    await addCollectionItem(COLLECTION, { img: url, quote: quote, who: who }, items.length);
    items = await loadCollection(COLLECTION);
    index = items.length - 1;
    renderLL();
  });
  input.click();
}

async function handleDelete() {
  if (items.length <= 1) {
    alert('At least one testimonial is required.');
    return;
  }
  if (!confirm('Delete this testimonial?')) return;
  await ensureSeeded();
  await deleteCollectionItem(COLLECTION, items[index].id);
  items = await loadCollection(COLLECTION);
  index = 0;
  renderLL();
}

async function handleMove(offset) {
  const target = index + offset;
  if (target < 0 || target >= items.length) return;
  await ensureSeeded();
  const orderedIds = items.map(function (item) { return item.id; });
  const moved = orderedIds.splice(index, 1)[0];
  orderedIds.splice(target, 0, moved);
  await reorderCollection(COLLECTION, orderedIds);
  items = await loadCollection(COLLECTION);
  index = target;
  renderLL();
}

export async function initTestimonials() {
  const loaded = await loadCollection(COLLECTION);
  if (loaded.length > 0) {
    items = loaded;
    usingFallback = false;
  } else {
    items = FALLBACK;
    usingFallback = true;
  }
  renderLL();

  document.getElementById('llPrev').addEventListener('click', function () {
    index = (index - 1 + items.length) % items.length;
    renderLL();
  });
  document.getElementById('llNext').addEventListener('click', function () {
    index = (index + 1) % items.length;
    renderLL();
  });
  document.getElementById('cmsLLAdd').addEventListener('click', handleAdd);
  document.getElementById('cmsLLDelete').addEventListener('click', handleDelete);
  document.getElementById('cmsLLMoveLeft').addEventListener('click', function () { handleMove(-1); });
  document.getElementById('cmsLLMoveRight').addEventListener('click', function () { handleMove(1); });

  onAdminChange(async function (active) {
    if (active) await ensureSeeded();
    controls.style.display = active ? 'flex' : 'none';
  });
}
```

Two notes on this module, both intentional:
- Reordering uses "← Move" / "Move →" buttons rather than drag-and-drop. The carousel shows one testimonial at a time, so there is nothing to drag *between* — the buttons move the currently-shown testimonial one position earlier/later, which is the same capability the design spec calls for.
- Editing an existing testimonial's quote/names is via delete-and-re-add in this version (no inline text editing on the carousel) — acceptable for an MVP given testimonials change rarely. Flag to the user as a known limitation, not a bug.

- [ ] **Step 4: Append testimonials-specific styles to `cms/cms.css`**

```css
.cms-ll-controls{gap:12px;margin-top:14px;}
.cms-ll-controls button{
  background:none;border:1px solid var(--khaki);color:var(--khaki);
  border-radius:16px;padding:6px 14px;font-family:var(--sans);font-size:12px;cursor:pointer;
}
```

- [ ] **Step 5: Wire into `cms/main.js`**

Add the import:

```js
import { initTestimonials } from './testimonials.js';
```

Inside the async IIFE, right after `await initPortfolio();`, add:

```js
await initTestimonials();
```

- [ ] **Step 6: Manually verify**

Reload logged out — confirm the Love Letters carousel looks and cycles exactly as before, and no edit controls are visible. Log in, go to Testimonials — confirm the Move/Delete/Add buttons appear. Add a new testimonial (quote, names, photo), confirm it appears and the counter updates (e.g. "7 / 7"). Click "← Move" and confirm the counter decrements (the testimonial moved one position earlier) and the carousel still shows the same quote; reload and confirm the new order persisted. Delete a testimonial, confirm it's removed. Try deleting when only one testimonial remains — confirm the "at least one required" alert appears and nothing is deleted.

- [ ] **Step 7: Commit**

```bash
git add cms/testimonials.js cms/cms.css cms/main.js index.html
git commit -m "Wire Love Letters carousel to Firestore testimonials collection"
```

---

### Task 12: End-to-end verification, fallback/offline check, README update

**Files:**
- Modify: `README.md`

**Interfaces:**
- None — this task only verifies and documents.

- [ ] **Step 1: Full offline-fallback check**

With the local server running, open DevTools → Network tab → set throttling to **Offline**, then hard-reload the page. Confirm: the hero slideshow, portfolio grid, filmstrip, and testimonials carousel all still render with their original content (today's photos/quotes), the gear icon is visible, and no console errors block rendering. Set Network back to **Online**.

- [ ] **Step 2: Full logged-out security check**

In DevTools console (logged out), repeat the Task 2 Step 4 check against each of the four write-protected paths (`content/site`, `heroSlides`, `portfolioShots`, `testimonials`) — for each, attempt a `setDoc`/`addDoc` and confirm `permission-denied`. Also attempt a Storage upload while logged out (via `uploadBytes` on `ref(storage, 'uploads/test/x.txt')`) and confirm it's rejected.

- [ ] **Step 3: Full logged-in walkthrough**

Log in once, and in a single pass: edit one text field on each of Home/About/Contact, replace one image on each of Home/About/Contact, add+delete+reorder a hero slide, add+delete+reorder a portfolio shot, add+delete a testimonial. Reload after each and confirm persistence. Log out and confirm every edit control disappears and the page still renders correctly as a normal visitor would see it.

- [ ] **Step 4: Update `README.md`**

Add a new section after the existing "## Publish with GitHub Pages" section:

```markdown
## Editing content (CMS)

This site has a built-in editor. Click the small gear icon in the
bottom-right corner of any page and log in with the admin account created
in the Firebase console. Once logged in you can:

- Click any editable heading/paragraph to edit its text (saves automatically).
- Hover a photo and click "Change photo" to replace it.
- On the homepage, Portfolio page, and Testimonials page, add, delete, and
  drag-reorder items directly.

Firebase project: `capturewithki-69dd3`. Security rules live in
`firestore.rules` and `storage.rules` in this repo (also the source of
truth pasted into the Firebase console's Rules tabs). To add a second
admin, create their user in the Firebase console under Authentication,
then add a document to the `admins` Firestore collection whose document ID
is their UID.

See `docs/superpowers/specs/2026-08-10-inline-cms-design.md` for the full
design, and `docs/superpowers/plans/2026-08-10-inline-cms-plan-a.md` for
what's covered by this pass vs. deferred (pricing page text/photos are not
yet editable — same mechanism, just not wired up yet).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "Document CMS usage in README"
```

---

## Deferred to a follow-up plan ("Plan B")

Both items below are deliberate scope cuts from the approved design spec, not
oversights. Neither needs new architecture — both reuse mechanisms this plan
already builds and proves.

1. **Pricing pages.** Applying the same `data-cms-id`/`data-cms-type`
   mechanism from Tasks 5–6 to the Portraits, Elopements, and Weddings pages:
   page intro heading/paragraphs, each package's name/price/bullet list, and
   each package's/category's photo. Purely more markup tagging.
2. **Inline editing of existing testimonial quotes/names.** In this plan,
   changing a testimonial's words means deleting it and re-adding it. Wiring
   the carousel's `#llQuote`/`#llWho` elements through `edit-text.js` requires
   one change `edit-text.js` doesn't support yet: writing back to a
   *collection item* rather than to the single `content/site` doc.
