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
