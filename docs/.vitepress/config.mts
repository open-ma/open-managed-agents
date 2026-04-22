import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Open Managed Agents',
  description: 'A framework for building AI-powered managed agents',
  cleanUrls: true,
  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started/' },
      { text: 'Architecture', link: '/architecture/' }
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/getting-started/' },
          { text: 'Installation', link: '/getting-started/installation' },
          { text: 'Quick Start', link: '/getting-started/quick-start' }
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Overview', link: '/architecture/' },
          { text: 'Agent Runtime', link: '/architecture/runtime' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/open-ma/open-managed-agents' }
    ]
  }
})
