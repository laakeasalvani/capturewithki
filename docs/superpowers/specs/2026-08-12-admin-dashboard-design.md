# Admin Dashboard — Design

Second backend sub-project for CaptureWithKi, after the contact form. Client
galleries and payments/contracts remain separate, later specs.

## Problem

The contact form now records every inquiry to Firestore and emails Khiara.
But there is nowhere for her to see them. Today the only way to read an
inquiry is the Firebase console, which is a developer tool she should never
need to open.

There is also a blind spot with real consequences: if a notification email
fails, the inquiry is safely saved with `emailError` set, but **nothing
surfaces it**. From the couple's side that is indistinguishable from being
ignored.

## Goal

A private page where Khiara reads her inquiries, tracks which she has
replied to, keeps her own notes, and edits the automatic thank-you her
clients receive.

## Where it lives

`/int/` — its own page (`int/index.html`), not part of the public site's
single-file structure. Visitors never download it. The path is deliberately
short and memorable because the owner will type it by hand.

The path is **convenience, not security**. The repository is public, so
`/int/` is discoverable. Protection comes entirely from Firebase Auth plus
the `admins` check, exactly as the CMS does.

Works unchanged on both `laakeasalvani.github.io/capturewithki/int/` and
`capturewithki.com/int/` once the custom domain finishes propagating.

## Auth

Reuses `cms/auth.js` unmodified — `login`, `logout`, `isAdmin`,
`onAdminChange`, `initAuth`. That module is UI-agnostic; only `cms/main.js`
binds it to the site's gear icon. The dashboard supplies its own login form.

Behaviour:
- Signed out → a login form, nothing else rendered.
- Signed in but not in `admins` → an explicit "this account cannot access
  the dashboard" message and a log-out button. Not a silent blank page:
  the CMS already had a bug of exactly that shape and it cost an evening.
- Signed in as an admin → the dashboard.

## Screen 1 — Inquiries

Every document in `inquiries`, newest first, limited to the most recent 100.

Each row shows: name (and partner), email, phone, event date, session type,
message, and when it arrived. Email and phone are `mailto:`/`tel:` links so
the page is usable from her phone.

**Failed emails are surfaced at the top**, not buried in a row. Any inquiry
with `emailError`, or with `emailToOwnerSent: false`, appears in a banner
saying she may not have been notified about it. This is the blind spot the
dashboard exists to close.

Per inquiry she can:
- toggle **status** between `new` and `replied`
- write a **private note** (`notes`), saved on blur, visible only to admins

Sorting, searching and filtering are out of scope for v1.

## Screen 2 — Auto-reply editor

Edits the thank-you email clients receive: its subject and its body.

Stored in a new Firestore document `settings/email`, with fields
`clientSubject` and `clientBody`. Admin-only read and write — unlike the
CMS's `content/site`, there is no reason for the public to read it.

`{first_name}` in the body is replaced with the client's first name. It is
the only supported token; anything else is left as literal text.

`functions/index.js` reads `settings/email` with the Admin SDK before
sending. If the document is missing, unreadable, or has empty fields, it
**falls back to the wording currently hardcoded in `functions/lib/email.js`**.
A couple always receives something sensible — the same fallback philosophy
the CMS uses for page content.

The owner-notification email stays hardcoded. Its layout is load-bearing
(the "Reply to this email" line is what makes Reply reach the client), and
it is not client-facing.

## Security rules

`inquiries` is currently `allow write: if false`, which denies everyone
including Khiara. It opens **only** enough for status and notes:

```
match /inquiries/{id} {
  allow read: if isAdmin();
  allow create, delete: if false;
  allow update: if isAdmin()
    && request.resource.data.diff(resource.data)
         .affectedKeys().hasOnly(['status', 'notes']);
}
```

This is deliberately narrow. Even a logged-in admin — or someone who
obtained her session — **cannot alter what the client actually wrote**.
Name, email, phone and message stay immutable. Only the Cloud Function,
which bypasses rules via the Admin SDK, can create an inquiry, and nothing
can delete one.

New:

```
match /settings/{docId} {
  allow read: if isAdmin();
  allow write: if isAdmin();
}
```

## Out of scope

- Site statistics (photo counts, testimonial counts, inquiries per month).
  The owner explicitly wants this **later**; it is the next addition after
  v1, not part of it.
- Client galleries and their active/expiry table — separate sub-project.
- Payments, invoicing, contracts — deferred by the owner.
- Deleting inquiries. Permanent, no undo, and a mis-tap loses a real
  client's details.
- Pagination beyond the most recent 100.
- Editing the owner-notification email.
- Any in-dashboard notification of new inquiries; the notification email is
  the alert.

## Testing plan

- Signed out: the page renders only a login form; no inquiry data is
  present anywhere in the DOM.
- Signed in as a non-admin: the explicit refusal message appears, not a
  blank page.
- Rules, verified against the live project by REST: `inquiries` and
  `settings` unreadable while signed out; an update touching any field
  other than `status`/`notes` is rejected; create and delete rejected.
- Status toggle and note save persist across a reload.
- An inquiry with `emailError` set appears in the warning banner.
- Auto-reply editor: save a template containing `{first_name}`, submit a
  real inquiry, confirm the received email uses the new wording with the
  name substituted.
- Fallback: with `settings/email` absent, confirm the email still sends
  using the hardcoded default.
- Regression: the public site and CMS are untouched; the contact form still
  submits and still emails.
