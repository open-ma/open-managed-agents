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

What ships:

| | |
|---|---|
| Sitemap | `/sitemap-index.xml` — auto-generated, with priority + changefreq per route |
| RSS | `/blog/rss.xml` — drafts excluded, full descriptions |
| `robots.txt` | allows all, points at sitemap, disallows `/drafts/` |
| Canonical URLs | per-page via `canonical` prop on Base layout |
| Open Graph | full set (title, description, type, image, locale, article:published_time, article:modified_time) |
| Twitter Card | summary_large_image, with creator + site handle |
| JSON-LD | `Organization` + `WebSite` (with SearchAction stub) on every page; `BlogPosting` + `BreadcrumbList` on each post |
| Reading time | computed from word count, shown on post + emitted in JSON-LD as `wordCount` if needed later |
| theme-color | matches light/dark brand color so browser chrome blends in |
| robots meta | `index, follow, max-image-preview:large, max-snippet:-1` (eligibility for rich results) |
| Performance | font preconnect; `display=swap`; static output; assets served from CF edge |
| Semantic HTML | `<nav aria-label>`, `<time datetime>`, `<article>`, breadcrumb `<ol>` |

JSON-LD lives in `src/lib/seo.ts` — `organizationSchema()`, `websiteSchema()`,
`blogPostSchema()`, `breadcrumbSchema()`. Pass extra schemas via the `schemas`
prop on `<Base>` and they're injected as `<script type="application/ld+json">`.

Validate after deploy:
- [Google Rich Results Test](https://search.google.com/test/rich-results) — paste a blog post URL, expect "Article" detected.
- [Schema.org validator](https://validator.schema.org/) — paste any page URL.
- [Twitter Card validator](https://cards-dev.twitter.com/validator) (legacy but still works).

## What's not built yet (skeleton scope)

- Real Tailwind typography plugin (currently inline `.prose` styles)
- Author bios / multi-author support
- Pagination on `/blog/`
- Categories / tag pages (would help long-tail SEO once content > ~30 posts)
- Newsletter signup
- **og-default.png** — referenced in Base.astro but not committed. Drop a 1200×630 PNG at `public/og-default.png` before launch. Or wire up per-post OG image generation via `astro-og-canvas` / `satori-html` (build-time, no runtime cost) — the `BlogPostSchemaInput.image` field already supports per-post overrides.
- Pagefind static search (`pnpm add pagefind` + post-build script). The `WebSite` JSON-LD already has the `SearchAction` stub.
- Twitter handle `@openma_dev` is a placeholder; update `src/lib/seo.ts` `TWITTER_HANDLE` after registration.

These are deliberate omissions — add when content volume justifies.
