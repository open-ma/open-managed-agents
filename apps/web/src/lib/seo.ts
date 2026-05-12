// SEO helpers — JSON-LD structured data + reading time.
//
// Schema choice:
//   - Organization: emitted on every page in Base.astro. Tells Google
//     who the publisher is; powers the knowledge panel + sitelinks.
//   - WebSite: also on every page. Includes a SearchAction stub so we
//     can wire up sitelinks search box later (currently no-op until we
//     have search).
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
const REPO_URL = "https://github.com/open-ma/open-managed-agents";
const ORG_NAME = "Open Managed Agents";
const ORG_LOGO = `${SITE_URL}/logo.svg`;
const TWITTER_HANDLE = "openma_dev"; // placeholder; update if/when registered

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
    sameAs: [
      REPO_URL,
      `https://twitter.com/${TWITTER_HANDLE}`,
    ],
    description:
      "Open Managed Agents — open-source, self-hostable alternative to Anthropic's Managed Agents. Cloudflare Workers + Durable Objects. Apache 2.0.",
  };
}

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORG_NAME,
    url: SITE_URL,
    description:
      "Open-source, self-hostable alternative to Anthropic's Managed Agents.",
    potentialAction: {
      "@type": "SearchAction",
      // Stub for future sitelinks search box. Google indexes this even
      // without a search page; if/when we add Pagefind, we wire the
      // urlTemplate to /search?q={search_term_string}.
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_URL}/search?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
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
    description:
      "Open-source, self-hostable alternative to Anthropic's Managed Agents. Cloudflare Workers + Durable Objects. Drop-in compatible API.",
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
