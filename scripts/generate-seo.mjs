import { writeFile, readFile } from 'node:fs/promises';
const repo = process.env.GITHUB_REPOSITORY || '';
const [owner, name] = repo.split('/');
const site = process.env.HUDA_SITE_URL ? `${process.env.HUDA_SITE_URL.replace(/\/$/,'')}/` : owner && name ? `https://${owner}.github.io/${name === `${owner}.github.io` ? '' : `${name}/`}` : 'https://example.com/';
await writeFile('dist/robots.txt', `User-agent: *\nAllow: /\nSitemap: ${site}sitemap.xml\n`);
const products=JSON.parse(await readFile('src/data/products.json','utf8'));
const urls=[site,...products.map(p=>`${site}product/${p.id}`)];
await writeFile('dist/sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url=>`<url><loc>${url}</loc></url>`).join('')}</urlset>\n`);
