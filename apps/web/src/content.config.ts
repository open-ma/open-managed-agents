// Content collection for blog posts.
//
// Posts live under src/content/blog/*.md (or .mdx). Frontmatter shape
// validated by the schema below — Astro errors at build if a post is
// missing required fields, which is the cheapest way to avoid drafts
// shipping with broken metadata.

import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(120),
    description: z.string().max(280),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    author: z.string().default("openma"),
    tags: z.array(z.string()).default([]),
    /** Hide from /blog index. Useful for unlisted posts shared via direct link. */
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
