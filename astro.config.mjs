// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build
export default defineConfig({
  site: 'https://regardless.cl',
  integrations: [
    sitemap({
      filter: (page) => !/\/v[123]\/?$/.test(page),
    }),
  ],
});
