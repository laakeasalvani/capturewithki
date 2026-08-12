# CaptureWithKi — project context for Claude

Khiara Salvani's wedding photography site. Laakea (the owner's collaborator)
drives the work; Khiara is the photographer who actually uses it.

**Live site:** https://laakeasalvani.github.io/capturewithki/ (GitHub Pages, `main` branch, repo root)
**Firebase project:** `capturewithki-69dd3` — Blaze plan
**Owner's inbox:** netherlyk23@gmail.com

---

## THE ONE THING BLOCKING PROGRESS RIGHT NOW

The contact-form backend is finished except for its final deploy-and-test step,
which is blocked on **buying and verifying the domain `capturewithki.com` in
Resend**.

Check whether it is unblocked:

```bash
host capturewithki.com                                   # does it resolve yet?
firebase functions:secrets:access RESEND_API_KEY --project capturewithki-69dd3 >/dev/null && echo "secret set"
```

The `RESEND_API_KEY` secret **is already set**. Only the domain is outstanding.

**Why this blocks:** Resend's shared `resend.dev` sender is test-only — it can
only deliver to the Resend account holder's own address. Without a verified
domain, the notification to Khiara would arrive but **every client thank-you
email would 403**, which is the core feature. Do not deploy the function until
the domain shows Verified in Resend.

When it is verified, run **Task 8** of
`docs/superpowers/plans/2026-08-11-contact-form-backend-plan.md`.

---

## Where the work lives

| What | Where |
|---|---|
| Live CMS (done, merged, deployed) | `main` |
| Contact-form backend (7/8 tasks done) | branch `contact-form`, worktree `.worktrees/contact-form` |

**Task 8 must run inside the worktree**, not the main checkout — the plan, the
function code and the branch all live there:

```bash
cd /Users/laakeasalvani/capturewithki/.worktrees/contact-form
```

Nothing on `contact-form` is merged. The only part of it that has touched
production is the Firestore rules (Task 6), which are deployed and verified.

### Documents that matter

- `docs/superpowers/specs/2026-08-10-inline-cms-design.md` — CMS design
- `docs/superpowers/plans/2026-08-10-inline-cms-plan-a.md` — CMS plan (complete)
- `docs/superpowers/specs/2026-08-11-contact-form-backend-design.md` — backend design
- `docs/superpowers/plans/2026-08-11-contact-form-backend-plan.md` — backend plan (Task 8 outstanding)
- `.superpowers/sdd/<plan-name>/progress.md` — **the execution ledger. Read this
  before doing anything.** It records every defect found, every deviation from
  the plan and why, and every deferred item. It is git-ignored and lives inside
  whichever checkout the plan is in.

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
4. **The site has no build step.** `index.html` + plain ES modules in `cms/`.
   npm exists only inside `functions/`. Do not introduce a bundler.
5. **Do not break the CMS.** `index.html` carries 150 `data-cms-id` markers
   (126 text, 18 image, 5 attr, 1 options, 2 item-text) and the form ids
   `n1 n2 em ph dt cl ms send sent`. Changing or dropping any of them breaks
   Khiara's ability to edit her own site. Count them before and after any edit
   to that file.
6. **Verify claims yourself.** Run `npm test` in `functions/` after any change
   there rather than trusting a report — a subagent has already once reported
   passing tests for a command that was erroring.

---

## What exists

### The CMS (live)
Khiara clicks a small gear in the site footer, logs in with Firebase Auth, and
edits text and photos in place. Four Firestore collections back it:
`heroSlides`, `portfolioShots`, `filmstripShots`, `testimonials`, plus a single
`content/site` document for everything else. Admin status = a document exists at
`admins/{uid}`.

Known limitations, all deliberate:
- Reordering uses HTML5 drag-and-drop, which **does not work on touch**. She can
  add, delete and swap photos on a phone but must use a computer to reorder.
- The footer gear is 7×11px and the delete badges 18×18px — too small to tap
  comfortably on a phone. **Two small fixes were proposed and never built:**
  bigger tap targets on small screens, and ←/→ move buttons as a touch-friendly
  alternative to dragging.
- If `gstatic.com` is unreachable the Portfolio grid renders empty (the hero and
  filmstrip have static fallbacks; the 36-item grid does not).

### The contact-form backend (branch `contact-form`, 7/8 done)
A callable Cloud Function `submitInquiry` (`functions/index.js`, Node 20, region
`us-west1`) that: checks a honeypot and submission timing, validates input,
rate-limits by hashed IP, **writes the inquiry to Firestore before sending any
email**, then emails Khiara (with Reply-To set to the client) and sends the
couple a thank-you — both via Resend.

38 unit tests cover `functions/lib/{validate,spam,email}.js`. `functions/index.js`
itself has **no** automated tests; Task 8's live checklist is the only coverage
it gets, and that checklist is written out in the ledger.

---

## After Task 8

Merge order and remaining roadmap, in the owner's stated priority:

1. **Finish Task 8**, then merge `contact-form` into `main` and push.
2. **Admin dashboard** — Khiara views inquiries, marks them read/replied.
   ⚠️ Blocker already identified: `inquiries` currently has `allow write: if
   false`, which denies *everyone* including her. That sub-project must decide
   between a narrowly scoped `allow update: if isAdmin()` with a field
   allowlist, or routing dashboard writes through an admin-only callable.
3. **Client galleries** — secret link + password, auto-expiring, with an admin
   view showing active galleries, upload date and deletion date.
4. **Payments/contracts** — deliberately deferred by the owner. Recommendation
   on the table: Stripe plus an established e-signature service rather than
   building signing in-house.

Two smaller items worth doing whenever convenient: the mobile tap-target and
move-button fixes listed above.

---

## Working style that has worked here

Use the `superpowers` skills: brainstorm → write a spec → write a plan →
execute with `subagent-driven-development` (fresh implementer per task, review
after each). Across this project that process caught **17 real defects**, and
roughly 13 of them originated in the *plans*, not the implementations —
including validation that crashed on hostile input, a spam check that would have
silently binned real clients whose phone clock ran fast, a rate limiter a burst
walked straight through, and a hidden form field named exactly the thing
browsers like to autofill. None would have surfaced in casual testing. They
would have surfaced as *"someone said they contacted me and I never got it."*

Keep the reviews. They are the reason this works.
