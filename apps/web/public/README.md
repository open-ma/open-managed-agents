# apps/web/public/

Static files served at the site root.

## Files

| File | Purpose |
|---|---|
| `logo.svg` | Brand wordmark — header logo + SVG favicon |
| `og-default.svg` | Source for `og-default.png` (1200×630 OG card) |
| `og-default.png` | Open Graph default image (1200×630) — referenced by `Base.astro` `og:image` |
| `apple-touch-icon.png` | 180×180 iOS home-screen icon |
| `favicon-512.png` / `favicon-192.png` / `favicon-32.png` / `favicon-16.png` | PWA + browser favicons |
| `site.webmanifest` | PWA manifest |
| `robots.txt` | Crawler directives + sitemap pointer |

## Regenerating the raster assets

The PNG files are committed (so the static site doesn't need a render
step at deploy time), but they can be reproduced from the source SVGs:

```bash
cd apps/web/public

# OG card
rsvg-convert -w 1200 -h 630 og-default.svg -o og-default.png

# Favicons (uses inline SVG generator script — see commit history for the
# square `om` mark used here)
rsvg-convert -w 180 -h 180 _favicon-square.svg -o apple-touch-icon.png
rsvg-convert -w 192 -h 192 _favicon-square.svg -o favicon-192.png
rsvg-convert -w 512 -h 512 _favicon-square.svg -o favicon-512.png
rsvg-convert -w 32 -h 32 _favicon-square.svg -o favicon-32.png
rsvg-convert -w 16 -h 16 _favicon-square.svg -o favicon-16.png
```

Requires `rsvg-convert` (`brew install librsvg`).

## What's not generated automatically

- `favicon.ico` — modern browsers don't need it; if a legacy crawler
  asks, the SVG icon and 32×32 PNG cover the case.
- Per-post OG images — `BlogPostSchemaInput.image` already supports
  per-post overrides. Wire `astro-og-canvas` later if blog volume
  justifies bespoke cards.
