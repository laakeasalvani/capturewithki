# Inline CMS (Firebase) — Design

## Goal

Let Khiara log in on the live site (via a gear icon) and edit all photos and
words directly on the page, without touching code or redeploying. Backed by
Firebase (Auth + Firestore + Storage). No build step — `index.html` stays a
single file, Firebase loaded via CDN `<script type="module">`.

## Architecture

- `index.html`'s current hardcoded markup/arrays remain the **fallback
  content**. On load, the page fetches content from Firestore and overwrites
  the DOM/arrays wherever Firestore has data. If Firestore is unreachable
  (offline, misconfigured, outage), visitors see today's hardcoded site,
  never a blank or broken page.
- Nothing changes for visitors until the first edit is made. The first save
  to any given field/collection seeds Firestore with the current in-memory
  (fallback) data merged with that edit, so from then on that content is
  served from Firestore.
- Firebase JS SDK v9+ modular, loaded via CDN, no npm/build step.
- The Firebase config (apiKey, project ID, etc.) is committed in plain sight
  in `index.html`. This is normal Firebase practice — it is not a secret;
  access control is enforced entirely by Firestore/Storage security rules.

## Data model

**`content/site`** — single Firestore doc, one field per swap-in-place piece
of content, keyed by a stable id added to the HTML as `data-cms-id`:
- About bio text, intro paragraphs
- Pricing package names/prices/bullet lists (Weddings/Portraits/Elopements,
  3 fixed packages per page — count is not editable, only their text)
- Portraits/Elopements/Weddings category hero images (Couples, Engagement,
  Family, Maternity, Senior, etc.)
- About/contact/banner photos
- Contact page copy (headings/paragraphs only — form field labels and
  placeholders are NOT included, see Out of scope)

**Three CRUD collections**, each item ordered by a numeric sort field,
add/remove/reorder (drag-and-drop) supported:
- `heroSlides` — the homepage's 4-image hero slideshow (image only; alt text
  defaults to a generic string on new slides, not individually editable in
  MVP)
- `portfolioShots` — the portfolio grid (image, category tag, place caption)
- `testimonials` — the Love Letters carousel (photo, quote, names)

**Filmstrip strip** (homepage auto-scrolling row under the intro section) is
**not** an independent collection — it's derived automatically at render
time from the first 9 items in `portfolioShots`. Editing the portfolio grid
updates the filmstrip too.

## Auth

- Firebase Auth, email/password only. **No public sign-up UI.**
- Single admin now (Khiara), extensible to more later: an `admins`
  collection in Firestore holds one doc per allowed UID
  (`admins/{uid}`, empty/marker doc). To add a second editor later: create
  their user manually in the Firebase console, then add a doc with their
  UID to `admins` — no invite flow to build.
- Session persists across visits (Firebase default local persistence).

## Security rules

Firestore:
- `content/site`, `heroSlides/*`, `portfolioShots/*`, `testimonials/*`:
  public read, write only if `request.auth != null` AND a doc exists at
  `admins/{request.auth.uid}`.
- `admins/*`: no client read/write (managed manually via console).

Storage (`uploads/**`):
- Public read.
- Write only if `request.auth != null` (any authenticated user — in
  practice this is equivalent to "is admin" since no public sign-up exists,
  so only people the site owner has manually created an account for can
  ever be authenticated at all).

## Editing UX

- A small, low-opacity gear (⚙) sits fixed bottom-right on every page.
  Click → login modal (email + password). On success, modal closes and the
  gear becomes an "Edit Mode" toggle + Log out control.
- **Swap-in-place text**: in Edit Mode, hovering an editable text element
  reveals a pencil icon; clicking makes it `contenteditable`; autosaves to
  Firestore on blur, with a small "Saved" toast. Nav labels, button text,
  and form field labels are NOT editable (see Out of scope).
- **Swap-in-place images**: hovering reveals a "Change photo" overlay;
  click opens a file picker, uploads to Firebase Storage
  (`uploads/{section}/{timestamp}-{filename}`), updates the corresponding
  Firestore field with the new download URL. Old files in Storage are left
  in place (not auto-deleted) — simplest and safest; storage cost is
  negligible at this site's scale.
- **Collections** (hero slides, portfolio grid, testimonials): each item
  gets a delete (×) control and is drag-and-drop reorderable; an "+ Add"
  tile at the end opens the file picker for a new photo, then a small form
  for its caption/category or quote/names.
- Upload guardrails: image file types only, ~10MB cap, no client-side
  resizing/compression in this version.

## Firebase project setup (manual, by site owner)

Creating the Firebase project and first admin login requires signing in
with a Google account interactively, so these steps are done by Khiara, not
automated:
1. Create Firebase project at console.firebase.google.com.
2. Enable Authentication → Email/Password provider.
3. Create the first user (Khiara's login).
4. Enable Firestore (production mode) and Storage.
5. Copy the web app config snippet.
6. Add a doc to the `admins` collection with that first user's UID.

Implementation work picks up once the config snippet and the created UID
are shared.

## Out of scope

- Nav links, button labels ("Send inquiry", "Learn more", etc.), contact
  form field labels/placeholders, page routing/layout, colors/fonts — all
  stay hardcoded/code, not editable content.
- The contact form's actual send behavior (per README, it's currently
  client-side confirmation only) — unrelated to this feature, untouched.
- Client-side image resizing/compression on upload.
- Deleting orphaned Storage files when a photo is replaced/removed.
- Multi-admin invite UI (adding admins is a manual Firebase console step).

## Testing plan

- Manual verification in a local server (`python3 -m http.server`) against
  a real (dev) Firebase project:
  - Logged-out visitor: site renders identically to current hardcoded
    content when Firestore is empty; renders Firestore content once seeded.
  - Login flow: correct/incorrect credentials, session persistence across
    reload.
  - Each swap-in-place text field and image: edit, reload, confirm
    persisted.
  - Each collection: add, delete, reorder (drag), reload, confirm order
    and content persisted.
  - Security rules: attempt writes while logged out / via browser
    devtools console — confirm rejected.
  - Offline/Firestore-unreachable simulation: confirm fallback content
    still renders.
