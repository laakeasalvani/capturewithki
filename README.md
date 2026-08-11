# CaptureWithKi

Single-file website for CaptureWithKi, Khiara Salvani's wedding photography
business (`index.html`, CSS and JS embedded, no build step).

## Preview locally

Open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Publish with GitHub Pages

1. On GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `root`**.
2. The site will be live at `https://laakeasalvani.github.io/capturewithki/`.

## Editing content (CMS)

This site has a built-in editor. Click the small gear icon in the
bottom-right corner of any page and log in with the admin account created
in the Firebase console. Once logged in you can:

- Click any editable heading/paragraph to edit its text (saves automatically).
- Hover a photo and click "Change photo" to replace it.
- On the homepage, Portfolio page, and Testimonials page, add, delete, and
  drag-reorder items directly.

The security rules that control who can save changes are already turned on
and live — they're in `firestore.rules` and `storage.rules` in this repo,
and that same text has been pasted into the Firebase console's Rules tabs
so the live site is protected right now. Nobody but a logged-in admin can
change anything.

A couple of things worth knowing before you dive in:

- **Nobody has test-driven the editor yet.** Logging in requires the admin
  password, and no automated tool is ever allowed to know or guess that
  password — only Khiara can log in. That means the very first time she
  logs in and tries adding a photo, deleting a testimonial, or dragging a
  slide into a new order will be the first time anyone has actually done
  it. Everything has been checked carefully from the outside (the security
  rules, what a logged-out visitor sees, the fallback content if Firebase
  is ever unreachable), but the logged-in editing flow itself is untested
  until she tries it herself.
- **Editing an existing testimonial's words isn't supported yet.** If a
  quote or name needs to change, delete that testimonial and add a new one
  with the corrected text — don't try to click into the existing quote to
  fix a typo, that part isn't wired up.
- **The Portraits, Elopements, and Weddings pages aren't editable yet.**
  Their pricing text and photos still have to be changed by editing the
  code directly. Making those pages editable the same way is planned as a
  follow-up.

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

## Content to replace before launch

- **Photos** — the home page hero slideshow uses real, self-hosted photos
  (`images/`). Everything else (the "Selects" trio, the "Browse my work"
  category stage, the portfolio grid, and the journal thumbnails) still
  hotlinks to `assets-pw.pixieset.com`, a third-party theme vendor's demo
  CDN (from the "Odette" Pixieset theme) — not Khiara's photos, and not
  reliably hosted for outside use. Replace with real, self-hosted images
  before this site goes live for real clients.
- **Pricing** — real (Weddings, Portraits, Elopements sections).
- **Testimonials** — the three "Kind words" quotes are placeholder text.
- **Contact form** — the "Send inquiry" button only shows a client-side
  confirmation message; it does not actually send an email anywhere yet.
