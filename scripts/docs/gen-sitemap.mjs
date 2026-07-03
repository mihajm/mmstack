// Generates sitemap.xml from the prerendered docs output. Run after
// `nx build docs`, before the Pages artifact is uploaded. Walks every
// prerendered index.html so the sitemap always matches the real route set.
//
// Base URL comes from DOCS_SITE_URL (set it when using a custom domain);
// defaults to the GitHub Pages project URL.
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const OUT_DIR = 'dist/apps/docs/browser';
const BASE = (process.env.DOCS_SITE_URL ?? 'https://mihajm.github.io/mmstack').replace(
  /\/$/,
  '',
);

/** Collect the route path of every prerendered index.html (skipping the SPA 404). */
function collectRoutes(dir, root = dir, routes = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectRoutes(full, root, routes);
    } else if (entry === 'index.html') {
      const rel = relative(root, dir).split('\\').join('/');
      if (rel === '404') continue;
      routes.push(rel === '' ? '/' : `/${rel}/`);
    }
  }
  return routes;
}

const routes = collectRoutes(OUT_DIR).sort();
const lastmod = new Date().toISOString().slice(0, 10);

const body = routes
  .map(
    (route) =>
      `  <url>\n    <loc>${BASE}${route}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`,
  )
  .join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

writeFileSync(join(OUT_DIR, 'sitemap.xml'), xml);
console.log(`sitemap.xml written with ${routes.length} URLs (base ${BASE})`);
