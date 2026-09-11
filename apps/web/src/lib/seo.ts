// SEO helpers — JSON-LD structured data + reading time.
//
// Schema choice:
//   - Organization: emitted on every page in Base.astro. Tells Google
//     who the publisher is; powers the knowledge panel + sitelinks.
//   - WebSite: also on every page. Only describes routes that exist;
//     add SearchAction if and when the site ships a working search page.
//   - SoftwareApplication: emitted on the homepage. Tells Google this
//     site represents a product — eligible for software-style rich
//     snippets and reinforces the "Open Managed Agents" entity name.
//   - BlogPosting + BreadcrumbList: emitted only on /blog/[slug] pages.
//     Powers article rich results in Google.
//
// All structured data is JSON-LD in <script type="application/ld+json">.
// We deliberately avoid microdata / RDFa — JSON-LD is what Google
// recommends and it doesn't pollute the rendered HTML.

const SITE_URL = "https://openma.dev";
const REPO_URL = "https://github.com/openma-ai/open-managed-agents";
const ORG_NAME = "Open Managed Agents";
// Google's Organization.logo policy rejects SVG — Schema.org logo must
// be a raster format (PNG/JPG/GIF). The /logo.png file is rsvg-rendered
// from /logo.svg (the bracket-and-creature brand mark) at 950×610, well
// above Google's 112×112 minimum and high enough for downscaled display.
// IMPORTANT: do NOT point at /favicon-512.png — that's the auto-generated
// "om" square, identical to the placeholder Google falls back to when
// it can't find a proper Organization.logo.
//   https://developers.google.com/search/docs/appearance/structured-data/logo
const ORG_LOGO = `${SITE_URL}/logo.png`;

/** Word count → reading minutes. ~225 wpm matches Medium's heuristic. */
export function readingTimeMinutes(markdown: string): number {
  const words = markdown.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 225));
}

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: ORG_NAME,
    url: SITE_URL,
    logo: ORG_LOGO,
    // sameAs only includes verified handles. Adding a Twitter URL that
    // 404s ("not yet registered" placeholder) drops Google's confidence
    // in the entity — the @openma_dev handle was never registered. When
    // we register it (or any other social account), append the URL here.
    sameAs: [REPO_URL],
    description:
      "Open Managed Agents makes open-source software for running AI agents on your own infrastructure, using the Claude and OpenAI SDKs.",
  };
}

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORG_NAME,
    url: SITE_URL,
    description:
      "Run Claude and OpenAI agents on your own server with OpenMA. Find deployment guides, SDK examples and ways to connect your tools.",
  };
}

/**
 * SoftwareApplication schema for the homepage. Anchors the "Open Managed
 * Agents" entity in Google's knowledge graph and makes the page eligible
 * for software-style rich snippets (price, license, download).
 *
 * Keep this minimal — Google ignores most fields but uses name +
 * applicationCategory + offers + downloadUrl + license heavily.
 */
export function softwareApplicationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: ORG_NAME,
    alternateName: ["openma", "open-managed-agents"],
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Cross-platform",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    url: SITE_URL,
    downloadUrl: REPO_URL,
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    keywords:
      "OpenAI Agents API alternative, self-hosted OpenAI agents, Claude Managed Agents alternative, open-source agent platform, subagents, ACP, MCP, BYOK",
    featureList: [
      "Use the Claude and OpenAI SDKs",
      "OpenAI Agents API on Node",
      "Delegate subtasks to agents that share your files",
      "Claude Tag-style Slack publication",
      "MCP server hosting",
      "Vault-backed credentials",
      "Cloudflare Workers and Docker self-hosting",
    ],
    description:
      "Run agents on your own server with the Claude and OpenAI SDKs. OpenMA handles sessions, tools and recovery. Bring your own model keys and connect the files and services your agents need.",
    sameAs: [REPO_URL],
  };
}

export interface BlogPostSchemaInput {
  title: string;
  description: string;
  slug: string;
  publishedAt: Date;
  updatedAt?: Date;
  author: string;
  tags: string[];
  /** Image URL (absolute). Falls back to logo if absent. */
  image?: string;
}

export function blogPostSchema(p: BlogPostSchemaInput) {
  const url = `${SITE_URL}/blog/${p.slug}/`;
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: p.title,
    description: p.description,
    datePublished: p.publishedAt.toISOString(),
    dateModified: (p.updatedAt ?? p.publishedAt).toISOString(),
    author: {
      "@type": "Organization",
      name: p.author === "openma" ? ORG_NAME : p.author,
      url: SITE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: ORG_NAME,
      logo: { "@type": "ImageObject", url: ORG_LOGO },
    },
    image: p.image ?? `${SITE_URL}/og-default.png`,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    keywords: p.tags.join(", "),
  };
}

export function breadcrumbSchema(crumbs: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${SITE_URL}${c.path}`,
    })),
  };
}

export function faqPageSchema(items: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}
