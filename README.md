# CaptureWithKi

Single-file website for CaptureWithKi, Khiara Netherly's wedding photography
business (`index.html`, CSS and JS embedded, no build step).

## Preview locally

Open `index.html` directly in a browser, or serve it:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Publish with GitHub Pages

1. On GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `root`**.
2. The site will be live at `https://laasalvani.github.io/capturewithki/`.

## Content to replace before launch

- **Photos** — currently hotlinked to `assets-pw.pixieset.com`, a third-party
  theme vendor's demo CDN (from the "Odette" Pixieset theme). These are not
  Khiara's real photos and are not reliably hosted for outside use — they
  could disappear or get blocked at any time. Replace with real, self-hosted
  images before this site goes live for real clients.
- **Pricing** — the three collection tiers ($2,800 / $4,200 / $6,500) and
  add-on prices are placeholder figures (marked in the HTML source).
- **Testimonials** — the three "Kind words" quotes are placeholder text.
- **Contact form** — the "Send inquiry" button only shows a client-side
  confirmation message; it does not actually send an email anywhere yet.
