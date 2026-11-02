import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const catalogPath = resolve('src/data/products.json');
const usedPath = resolve('src/data/used-refs.json');
const products = JSON.parse(readFileSync(catalogPath, 'utf8'));
const used = JSON.parse(readFileSync(usedPath, 'utf8'));
const fail = (message) => { console.error(`Catalog validation failed: ${message}`); process.exitCode = 1; };
if (!Array.isArray(products) || !Array.isArray(used)) throw new Error('Catalog and used-refs must be arrays');
const ids = new Set(); const slugs = new Set();
for (const p of products) {
  for (const key of ['id','slug','name','nameAr','category','categoryAr','description','descriptionAr']) if (typeof p[key] !== 'string' || !p[key].trim()) fail(`product missing ${key}`);
  if (!/^\d{5,}$/.test(p.id)) fail(`invalid reference number ${p.id}`);
  if (ids.has(p.id)) fail(`duplicate reference ${p.id}`); ids.add(p.id);
  if (slugs.has(p.slug)) fail(`duplicate slug ${p.slug}`); slugs.add(p.slug);
  if (!['available','on-request','unavailable'].includes(p.status)) fail(`${p.id} has invalid status`);
  if (p.sample!==undefined&&typeof p.sample!=='boolean') fail(`${p.id} sample marker must be a boolean`);
  if (!Array.isArray(p.images) || p.images.length < 1) fail(`${p.id} has no images`);
  for (const image of p.images ?? []) { if (!image.startsWith('/images/') || image.includes('..')) fail(`${p.id} has unsafe image path ${image}`); else if (!existsSync(resolve('public', image.slice(1)))) fail(`${p.id} missing image ${image}`); else if(image.endsWith('.webp')) for(const suffix of ['-md.webp','-thumb.webp']) if(!existsSync(resolve('public',image.slice(1).replace('.webp',suffix)))) fail(`${p.id} missing responsive image ${image.replace('.webp',suffix)}`); }
}
if (new Set(used).size !== used.length) fail('used-refs contains duplicates');
for (const id of ids) if (!used.includes(id)) fail(`${id} is missing from permanent used-refs registry`);
console.log(`Validated ${products.length} products and ${used.length} permanent references.`);
