import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';

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
            { label: 'Deploy', slug: 'self-host/deploy' },
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
            { label: 'Recovery & Idempotency', slug: 'contribute/recovery-and-idempotency' },
          ],
        },
        {
          label: '↗ Console',
          link: 'https://app.openma.dev',
          attrs: { target: '_blank', rel: 'noopener' },
        },
      ],
    }),
    mdx(),
  ],
});
