# apps/web — openma marketing + blog

Astro 5 static site. Lives at **www.openma.dev** (apex `openma.dev` is
currently the Console SPA on the main worker; merging this site with
the apex is a deliberate later step that requires moving Console to
`app.openma.dev`).

## Layout

```
apps/web/
├── astro.config.mjs        # Astro 5 + Tailwind v4 + sitemap
├── wrangler.jsonc          # Cloudflare custom-domain deploy config
├── public/                 # Static files (logo, og-images, robots.txt)
└── src/
    ├── content.config.ts   # Blog frontmatter schema (title, description, publishedAt, …)
    ├── content/blog/       # Posts as .md or .mdx
    ├── layouts/Base.astro  # Shared header/footer/SEO/RSS link
    ├── pages/
    │   ├── index.astro             # Landing
    │   ├── blog/index.astro        # Blog list
    │   ├── blog/[...slug].astro    # Single post
    │   └── blog/rss.xml.ts         # RSS feed
    └── styles/global.css   # Tailwind import + design tokens (mirror Console)
```

## Dev

```bash
pnpm --filter @open-managed-agents/web dev
# → http://localhost:4321
```

## Build

```bash
pnpm --filter @open-managed-agents/web build
# Static output → apps/web/dist
```

## Deploy

```bash
pnpm --filter @open-managed-agents/web deploy
# Builds + wrangler deploy → www.openma.dev
```

## Adding a blog post

1. `apps/web/src/content/blog/your-slug.md`
2. Frontmatter:
   ```yaml
   ---
   title: "Post title"
   description: "One-sentence description (max 280 chars)"
   publishedAt: 2026-05-08
   author: openma                # optional, defaults to "openma"
   tags: ["intro", "byok"]       # optional
   draft: true                   # optional, hides from /blog index
   ---
   ```
3. Markdown body (or MDX if you need components).

URL becomes `/blog/your-slug/`.

## Design tokens

CSS custom properties in `src/styles/global.css` mirror Console's tokens
(`--color-bg`, `--color-fg`, `--color-brand`, etc.) so cross-domain
navigation feels consistent. Theme is system-preference with a
localStorage override (same as Console).

## SEO

- Sitemap: `https://www.openma.dev/sitemap-index.xml` (auto-generated)
- RSS: `https://www.openma.dev/blog/rss.xml`
- Per-page `<meta>` + Open Graph in `Base.astro` props
- Canonical URLs via `canonical` prop

## What's not built yet (skeleton scope)

- Real Tailwind typography plugin (currently inline `.prose` styles)
- Author bios / multi-author support
- Pagination on `/blog/`
- Categories / tag pages
- Newsletter signup
- og-default.png hero image (placeholder reference in Base.astro)
- Search

These are deliberate omissions — add when content volume justifies.
