import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';

// Brand fonts — DM Sans (body), Source Serif 4 (display headings),
// JetBrains Mono (code). Loaded via Starlight's head[] config rather
// than @import inside customCss so the CSS waterfall (custom.css → @import
// fonts.googleapis.com → fonts.gstatic.com) collapses into parallel
// requests. print-onload makes the stylesheet non-blocking; the
// <noscript> fallback keeps it working without JS. Same pattern web uses.
const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Source+Serif+4:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap';

export default defineConfig({
  site: 'https://docs.openma.dev',
  integrations: [
    starlight({
      title: 'openma',
      description: 'An open-source meta-platform for AI agents on Cloudflare.',
      logo: {
        src: './src/assets/logo.svg',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'preconnect',
            href: 'https://fonts.gstatic.com',
            crossorigin: '',
          },
        },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: FONT_HREF,
            media: 'print',
            onload: "this.media='all'",
          },
        },
        {
          tag: 'noscript',
          content: `<link rel="stylesheet" href="${FONT_HREF}">`,
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/open-ma/open-managed-agents',
        },
      ],
      editLink: {
        baseUrl:
          'https://github.com/open-ma/open-managed-agents/edit/main/apps/docs/',
      },
      lastUpdated: true,
      pagination: true,
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Welcome', link: '/' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Concepts', slug: 'concepts' },
          ],
        },
        {
          label: 'Use the Console',
          items: [
            { label: 'Getting Started', slug: 'console/getting-started' },
            {
              label: 'Connect Integrations',
              slug: 'console/integrations',
            },
          ],
        },
        {
          label: 'Build with the API',
          items: [
            { label: 'REST API', slug: 'build/api' },
            { label: 'CLI & SDK', slug: 'build/cli-sdk' },
            { label: 'Skills & Tools', slug: 'build/skills-and-tools' },
            { label: 'Vault & MCP', slug: 'build/vault-and-mcp' },
            { label: 'Custom Integrations', slug: 'build/integrations' },
          ],
        },
        {
          label: 'Self-host',
          items: [
            { label: 'Overview', slug: 'self-host/overview' },
            { label: 'Node + Docker (no Cloudflare)', slug: 'self-host/node-docker' },
            { label: 'Deploy on Cloudflare', slug: 'self-host/deploy' },
            { label: 'OAuth Apps', slug: 'self-host/oauth-apps' },
            { label: 'Operations', slug: 'self-host/operations' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'API Endpoints', slug: 'reference/api' },
            { label: 'Glossary', slug: 'reference/glossary' },
          ],
        },
        {
          label: 'Contribute',
          items: [
            { label: 'Contributing', slug: 'contribute' },
            { label: 'State Machines', slug: 'contribute/state-machines' },
            { label: 'Recovery & Idempotency', slug: 'contribute/recovery-and-idempotency' },
          ],
        },
        {
          // ↗ glyph in label is load-bearing: Starlight 0.38.4 doesn't
          // paint an external-link affordance on sidebar entries, so
          // without this prefix the Console link looks identical to
          // internal docs links.
          label: '↗ Console',
          link: 'https://app.openma.dev',
          attrs: { target: '_blank', rel: 'noopener' },
        },
      ],
    }),
    mdx(),
  ],
});
