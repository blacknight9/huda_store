import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const atomicJson = async (file, value) => {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await (await import('node:fs/promises')).rename(temp, file);
};
const slugify = value => value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const validateProduct = (p, products, existingId = '') => {
  for (const key of ['name','nameAr','category','categoryAr','description','descriptionAr']) if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`${key} is required`);
  if (!['available','on-request','unavailable'].includes(p.status)) throw new Error('Choose a valid availability status');
  if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > 12 || p.images.some(i => typeof i !== 'string' || !/^\/images\/[a-zA-Z0-9._/-]+$/.test(i) || i.includes('..'))) throw new Error('Add between 1 and 12 valid product images');
  if (products.some(x => x.id !== existingId && x.slug === p.slug)) throw new Error('That product URL already exists');
};

export async function readState(root) {
  const [products, refs, settings] = await Promise.all([
    readJson(path.join(root, 'src/data/products.json'), []),
    readJson(path.join(root, 'src/data/used-refs.json'), []),
    readJson(path.join(root, 'src/data/settings.json'), { store: { name: 'Huda Store', tagline: '', logo: '', accent: '#80704f' }, contact: { whatsapp: '', email: '', instagram: '' }, categories: [] }),
  ]);
  const git=await gitInfo(root);
  return { products, settings, categories: settings.categories?.length ? settings.categories : [...new Map(products.map(p => [p.category, { name: p.category, nameAr: p.categoryAr }])).values()], nextId: String(Math.max(10000, ...refs.map(Number)) + 1), dirty: git===null?null:git.length>0, changes:git };
}
async function gitInfo(root) {
  const { execFile } = await import('node:child_process');
  return new Promise(resolve => execFile('git', ['status', '--short'], { cwd: root }, (err, out) => resolve(err ? null : out.trim().split('\n').filter(Boolean))));
}

async function storeImages(root, images, id, previous = []) {
  const directory = path.join(root, 'public/images', id);
  await mkdir(directory, { recursive: true });
  const kept = previous.filter(x => typeof x === 'string' && x.startsWith(`/images/${id}/`) && !x.includes('..'));
  const result = [...kept];
  const occupied = new Set(previous.map(x=>path.basename(x,'.webp')));
  let nextImage = 1;
  if (images.length > 11 || images.reduce((sum,image)=>sum+(typeof image?.data==='string'?Buffer.byteLength(image.data,'base64'):0),0) > 28 * 1024 * 1024) throw new Error('Upload up to 11 images at a time, with a combined size under 28 MB');
  for (const image of images) {
    if (!image || !/^image\/(jpeg|png|webp|avif)$/.test(image.type) || typeof image.data !== 'string' || image.data.length > 16_000_000) throw new Error('Images must be JPEG, PNG, WebP or AVIF and under 12 MB each');
    const buffer = Buffer.from(image.data, 'base64');
    if (buffer.length > 12 * 1024 * 1024) throw new Error('Each image must be under 12 MB');
    const metadata = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
    if (!['jpeg','png','webp','avif'].includes(metadata.format)) throw new Error('Unsupported image format');
    while (occupied.has(String(nextImage).padStart(2,'0'))) nextImage++;
    const imageNumber=String(nextImage++).padStart(2,'0'); occupied.add(imageNumber);
    const filename = `${imageNumber}.webp`;
    const full = path.join(directory, filename);
    await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 2200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toFile(full);
    await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 800, height: 1100, fit: 'inside', withoutEnlargement: true }).webp({ quality: 81 }).toFile(full.replace('.webp','-md.webp'));
    await sharp(buffer, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 360, height: 460, fit: 'cover' }).webp({ quality: 78 }).toFile(full.replace('.webp','-thumb.webp'));
    result.push(`/images/${id}/${filename}`);
  }
  return result;
}

export async function saveProduct(root, payload) {
  const productsFile = path.join(root, 'src/data/products.json');
  const refsFile = path.join(root, 'src/data/used-refs.json');
  const [products, refs] = await Promise.all([readJson(productsFile, []), readJson(refsFile, [])]);
  let product; let removedImages=[];
  if (payload.id) {
    const at = products.findIndex(p => p.id === payload.id);
    if (at < 0) throw new Error('Product no longer exists. Refresh and try again.');
    const old = products[at];
    const images = await storeImages(root, payload.uploads || [], old.id, payload.images || old.images);
    product = { ...old, ...payload, id: old.id, slug: slugify(payload.slug || payload.name), images };
    delete product.uploads;
    if (payload.uploads?.length) delete product.sample;
    removedImages=old.images.filter(image=>!product.images.includes(image));
    validateProduct(product, products, old.id);
    products[at] = product;
  } else {
    const id = String(Math.max(10000, ...refs.map(Number)) + 1);
    product = { ...payload, id, slug: slugify(payload.slug || payload.name), keywords: (payload.keywords || []).filter(Boolean), images: await storeImages(root, payload.uploads || [], id), sample: false };
    delete product.uploads;
    validateProduct(product, products);
    products.push(product);
    refs.push(id);
  }
  await atomicJson(productsFile, products);
  await atomicJson(refsFile, [...new Set(refs)].sort((a,b)=>Number(a)-Number(b)));
  for (const image of removedImages) {
    const local=path.resolve(root,'public',`.${image}`);
    if (!local.startsWith(path.join(root,'public/images')+path.sep)) continue;
    await rm(local,{force:true});
    if(image.endsWith('.webp')) for(const suffix of ['-md.webp','-thumb.webp']) await rm(local.replace('.webp',suffix),{force:true});
  }
  return product;
}

export async function deleteProduct(root, id) {
  const productsFile = path.join(root, 'src/data/products.json');
  const products = await readJson(productsFile, []);
  if (!products.some(p => p.id === id)) throw new Error('Product not found');
  await atomicJson(productsFile, products.filter(p => p.id !== id));
  // Reference numbers are intentionally retained forever in used-refs.json.
  await rm(path.join(root, 'public/images', id), { recursive: true, force: true });
}

export async function saveSettings(root, settings) {
  const candidateAccent = /^#[0-9a-fA-F]{6}$/.test(settings.store?.accent) ? settings.store.accent : '#80704f';
  const channel = hex => { const c=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
  const contrast=(Math.max(channel(candidateAccent),channel('#f8f7f4'))+.05)/(Math.min(channel(candidateAccent),channel('#f8f7f4'))+.05);
  const clean = {
    store: { name: String(settings.store?.name || '').trim(), tagline: String(settings.store?.tagline || '').trim(), logo: settings.store?.logo === '/images/brand/logo.webp' ? settings.store.logo : '', accent: contrast>=4.5 ? candidateAccent : '#80704f' },
    contact: { whatsapp: String(settings.contact?.whatsapp || '').replace(/[^+\d]/g,''), email: String(settings.contact?.email || '').trim(), instagram: String(settings.contact?.instagram || '').trim() },
    categories: Array.isArray(settings.categories) ? settings.categories.filter(c => c.name?.trim() && c.nameAr?.trim()).map(c => ({ name: c.name.trim(), nameAr: c.nameAr.trim() })) : [],
  };
  if (!clean.store.name) throw new Error('Store name is required');
  if (clean.contact.instagram && !/^https:\/\//i.test(clean.contact.instagram)) throw new Error('Instagram link must start with https://');
  await atomicJson(path.join(root, 'src/data/settings.json'), clean);
  return clean;
}

export async function manageCategory(root, payload) {
  const settingsFile = path.join(root, 'src/data/settings.json');
  const productsFile = path.join(root, 'src/data/products.json');
  const [settings, products] = await Promise.all([readJson(settingsFile, { store:{name:'Huda Store',tagline:'',logo:'',accent:'#80704f'},contact:{whatsapp:'',email:'',instagram:''},categories:[] }),readJson(productsFile,[])]);
  const categories = settings.categories?.length ? [...settings.categories] : [...new Map(products.map(p => [p.category,{name:p.category,nameAr:p.categoryAr}])).values()];
  if (payload.action === 'add') {
    const category = { name:String(payload.category?.name||'').trim(), nameAr:String(payload.category?.nameAr||'').trim() };
    if (!category.name || !category.nameAr) throw new Error('Enter the category name in English and Arabic');
    if (categories.some(c=>c.name.toLowerCase()===category.name.toLowerCase())) throw new Error('That category already exists');
    categories.push(category);
  } else {
    const at = Number(payload.index); const old = categories[at];
    if (!old) throw new Error('Category not found');
    if (payload.action === 'rename') {
      const next = { name:String(payload.category?.name||'').trim(), nameAr:String(payload.category?.nameAr||'').trim() };
      if (!next.name || !next.nameAr) throw new Error('Enter both category labels');
      if (categories.some((c,i)=>i!==at&&c.name.toLowerCase()===next.name.toLowerCase())) throw new Error('That category already exists');
      for (const p of products) if (p.category===old.name) { p.category=next.name; p.categoryAr=next.nameAr; }
      categories[at]=next;
    } else if (payload.action === 'delete') {
      if (products.some(p=>p.category===old.name)) throw new Error('Move products to another category before deleting this one');
      categories.splice(at,1);
    } else throw new Error('Unknown category action');
  }
  settings.categories=categories;
  await atomicJson(settingsFile,settings);
  await atomicJson(productsFile,products);
  return categories;
}

export async function saveLogo(root, image) {
  if (!image || !/^image\/(jpeg|png|webp|avif)$/.test(image.type) || typeof image.data !== 'string' || image.data.length > 16_000_000) throw new Error('Choose a JPEG, PNG, WebP or AVIF image under 12 MB');
  const buffer = Buffer.from(image.data, 'base64');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('Logo must be under 12 MB');
  const file = path.join(root, 'public/images/brand/logo.webp');
  await mkdir(path.dirname(file), { recursive: true });
  await sharp(buffer, { limitInputPixels: 20_000_000 }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toFile(file);
  return '/images/brand/logo.webp';
}
