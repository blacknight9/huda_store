import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2); const get = (name) => { const index=args.indexOf(`--${name}`); return index<0?undefined:args[index+1]; };
const required = ['name','nameAr','category','categoryAr','description','descriptionAr'];
const input = Object.fromEntries(required.map(k => [k,get(k)]));
const listArg=(name)=>(get(name)||'').split(',').map(x=>x.trim()).filter(Boolean);
for (const k of required) if (!input[k]) { console.error(`Missing --${k}`); process.exit(1); }
const imageIndex=args.indexOf('--image'); const imageArgs=[];
for(let i=imageIndex+1;imageIndex>=0&&i<args.length&&!args[i].startsWith('--');i++)imageArgs.push(args[i]);
if (!imageArgs.length || imageIndex < 0) { console.error('Provide one or more --image FILE arguments'); process.exit(1); }
if (imageArgs.some(f => !existsSync(f))) { console.error('One or more image files do not exist'); process.exit(1); }
if (get('status')&&!['available','on-request','unavailable'].includes(get('status'))) { console.error('--status must be available, on-request, or unavailable'); process.exit(1); }
const catalogFile = path.resolve('src/data/products.json'); const refsFile = path.resolve('src/data/used-refs.json');
const lock = `${catalogFile}.lock`;
try { await mkdir(lock); } catch { console.error('Another product addition is in progress (or a stale lock exists). Resolve the lock before retrying.'); process.exit(1); }
try {
  const products = JSON.parse(await readFile(catalogFile,'utf8')); const used = JSON.parse(await readFile(refsFile,'utf8'));
  const usedSet = new Set(used); if (usedSet.size!==used.length || used.some(id=>!/^\d{5,}$/.test(id)) || products.some(p=>!usedSet.has(p.id)) || products.some((p,i)=>products.findIndex(x=>x.id===p.id)!==i)) throw new Error('Catalog or permanent reference registry is inconsistent; validate and repair it before adding another product.');
  const id = String(Math.max(10000,...used.map(Number))+1); const slug = (get('slug') || input.name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if (!slug || products.some(p=>p.slug===slug)) throw new Error('Slug is empty or already exists; pass a unique --slug.');
  const imageDir = path.resolve(`public/images/${id}`); await mkdir(imageDir,{recursive:true}); const images=[];
  for (let i=0;i<imageArgs.length;i++) { const filename=`${String(i+1).padStart(2,'0')}.webp`; await sharp(imageArgs[i]).rotate().resize({width:1400,height:1800,fit:'inside',withoutEnlargement:true}).webp({quality:83}).toFile(path.join(imageDir,filename)); await sharp(imageArgs[i]).rotate().resize({width:800,height:1100,fit:'inside',withoutEnlargement:true}).webp({quality:81}).toFile(path.join(imageDir,`${String(i+1).padStart(2,'0')}-md.webp`)); images.push(`/images/${id}/${filename}`); const thumb=`${String(i+1).padStart(2,'0')}-thumb.webp`; await sharp(imageArgs[i]).rotate().resize({width:360,height:460,fit:'cover'}).webp({quality:78}).toFile(path.join(imageDir,thumb)); }
  const sizes=listArg('sizes'); const colors=listArg('colors');
  const product={id,slug,...input,keywords:listArg('keywords'),status:get('status')||'available',...(get('price')?{price:get('price')}:{}),...(sizes.length||colors.length?{variants:{...(sizes.length?{sizes}:{}),...(colors.length?{colors}:{})}}:{}),images};
  products.push(product); used.push(id);
  const catTemp=`${catalogFile}.tmp`;const refsTemp=`${refsFile}.tmp`;
  await writeFile(catTemp,JSON.stringify(products,null,2)+'\n',{flag:'wx'}); await writeFile(refsTemp,JSON.stringify(used,null,2)+'\n',{flag:'wx'});
  await rename(catTemp,catalogFile); await rename(refsTemp,refsFile);
  console.log(`Added ${id} (${slug}) with ${images.length} optimized image(s). Review and commit src/data/products.json, src/data/used-refs.json, and public/images/${id}/.`);
} finally { await rm(lock,{recursive:true,force:true}); }
