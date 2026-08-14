# CaptureWithKi — project context for Claude

Khiara Salvani's wedding photography site. Laakea drives the work; Khiara is the
photographer who actually uses it.

**Live site:** https://capturewithki.com (GitHub Pages, `main` branch, repo root, custom domain + HTTPS)
**Admin dashboard:** https://capturewithki.com/int/
**Firebase project:** `capturewithki-69dd3` — Blaze plan
**Owner's inbox:** netherlyk23@gmail.com

---

## State of play

Everything built so far is **merged into `main` and live**. There is no
outstanding branch and no half-finished deploy. `main` is the only source of
truth; delete stale worktrees under `.worktrees/` rather than reviving them.

| Shipped | Notes |
|---|---|
| Inline CMS | Gear in the footer → Firebase Auth login → edit text and photos in place |
| Contact-form backend | `submitInquiry` Cloud Function, emails Khiara + auto thank-you, both via Resend |
| Admin dashboard | `/int/` — view inquiries, mark read/replied, edit the thank-you template |
| Custom domain | capturewithki.com, verified in Resend so client emails actually deliver |
| Image compression | Repo images 67MB → 35MB; browser-side shrink before every CMS upload |
| Hero-flash fix | Page stays hidden until the real hero photo has genuinely painted |

---

## HARD RULES — these protect a live business

1. **Never run a bare `firebase deploy`.** `firebase.json` declares Functions,
   Firestore rules and Storage rules. Always scope it:
   - `firebase deploy --only firestore:rules --project capturewithki-69dd3`
   - `firebase deploy --only functions --project capturewithki-69dd3`
2. **Never print, log, commit or echo `RESEND_API_KEY`.** It is a genuine
   secret, stored in Firebase Functions Secrets. (The Firebase *web config* in
   `cms/firebase.js` is deliberately public — that one is fine.)
3. **Never ask for, guess or use Khiara's password**, and never create Firebase
   or Resend accounts on her behalf. Anything needing her Google login is hers
   to do — give exact click-by-click steps instead.
4. **The site has no build step.** `index.html` + plain ES modules in `cms/` and
   `int/`. npm exists only inside `functions/`. Do not introduce a bundler.
5. **Do not break the CMS.** `index.html` carries **114** `data-cms-id` markers
   and the contact-form ids `n1 n2 em ph dt cl ms send sent`. Changing or
   dropping any of them breaks Khiara's ability to edit her own site. Count them
   before and after any edit to that file.
6. **Firebase client SDK is pinned to exactly `10.13.0`** in every browser-side
   gstatic import. Mixing versions across modules breaks Auth silently.
7. **Verify claims yourself.** Run `npm test` in `functions/` after any change
   there rather than trusting a report — a subagent has already once reported
   passing tests for a command that was erroring.

---

## The hero reveal — read this before touching page load

`<html>` starts with class `cms-pending`, which hides the hero. It is removed in
exactly two places, and the balance between them is load-bearing:

- **`cms/main.js`** waits for the visible hero `<img>`'s own `load`/`error`
  event, then removes it. Capped at 8s.
- **`index.html`** has an inline `setTimeout` at **12000ms** as a last resort for
  when the CMS modules never run at all (CDN blocked, offline, script error).

**The inline timer must always be longer than the module's cap.** It was
originally 2000ms, and that *was* the old-photo-flash bug: it fired while
Firestore and a multi-megabyte Storage download were still in flight, lifting
the guard and letting the browser paint the only hero image it already had —
the previous photo, from cache. Shortening it reintroduces the bug, and the bug
only reproduces when the *old* images are already cached, so a naive test on a
clean profile will look fine.

Accepted tradeoff, chosen by the owner: a brief blank hero rather than a wrong
photo.

---

## How the CMS works

Khiara clicks the footer gear, logs in with Firebase Auth, then clicks the gear
again to toggle edit mode on. (It does **not** auto-enter edit mode — that was a
reported bug and is fixed. Signing in alone must never start editing.)

Four Firestore collections back it: `heroSlides`, `portfolioShots`,
`filmstripShots`, `testimonials`, plus a single `content/site` document for
everything else. Admin status = a document exists at `admins/{uid}`.

**To give someone edit access:** create a Firebase Auth user for them, then add
a document at `admins/{their-uid}`. That is the whole mechanism.

Known limitations, all deliberate:
- Reordering uses HTML5 drag-and-drop, which **does not work on touch**. She can
  add, delete and swap photos on a phone but must use a computer to reorder.
- The footer gear and the 18×18px delete badges are too small to tap
  comfortably. **Two fixes were proposed and never built:** bigger tap targets
  on small screens, and ←/→ move buttons as a touch-friendly alternative.
- If `gstatic.com` is unreachable the Portfolio grid renders empty (hero and
  filmstrip have static fallbacks; the 36-item grid does not).

---

## Known outstanding work

1. **41 CMS-uploaded images (~77MB) are still uncompressed.** Only files
   uploaded *since* the browser-side shrink landed are optimised. Claude cannot
   write to Storage. Options: re-upload them through the CMS, or install the
   Firebase **Resize Images** extension (recommended), or build a one-off
   compress button.
2. **Test inquiries** from backend development are still in Firestore and need
   deleting from the console.
3. **Client galleries** — secret link + password, auto-expiring, with an admin
   view showing active galleries, upload date and deletion date. Specified by
   the owner, not started.
4. **Payments / invoicing / deposits / contracts** — deliberately deferred.
   Recommendation on the table: Stripe plus an established e-signature service
   rather than building signing in-house.
5. **Site statistics** in the dashboard — mentioned, not specified.
6. The mobile tap-target and move-button fixes above.

---

## Working style that has worked here

Use the `superpowers` skills: brainstorm → write a spec → write a plan →
execute with `subagent-driven-development` (fresh implementer per task, review
after each). The execution ledger lives at `.superpowers/sdd/<plan-name>/progress.md`
— it is git-ignored, records every defect and deviation, and is worth reading
before resuming any plan.

Across this project that process caught **21+ real defects**, and most of them
originated in the *plans*, not the implementations — including validation that
crashed on hostile input, a spam check that would have silently binned real
clients whose phone clock ran fast, a rate limiter a burst walked straight
through, and a hidden form field named exactly the thing browsers like to
autofill. None would have surfaced in casual testing. They would have surfaced
as *"someone said they contacted me and I never got it."*

Keep the reviews. They are the reason this works.

One more lesson, learned the hard way twice: **a fix is not verified until it is
verified under the conditions that produced the bug.** The hero flash survived a
first "fix" because it was tested on a cold cache, and the bug requires a warm
one.
