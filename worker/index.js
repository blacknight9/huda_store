const API = 'https://api.github.com';
const SESSION_COOKIE = '__Host-huda_session';
const OAUTH_COOKIE = '__Host-huda_oauth';
const SESSION_SECONDS = 2 * 60 * 60;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const limitBuckets = new Map();

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64url = text => Uint8Array.from(atob(text.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const randomToken = (length=32) => { const b=new Uint8Array(length); crypto.getRandomValues(b); return b64url(b); };
const safeEqual = (a,b) => { const x=encoder.encode(String(a)), y=encoder.encode(String(b)); if(x.length!==y.length)return false; let d=0; for(let i=0;i<x.length;i++)d|=x[i]^y[i]; return d===0; };
const cookieMap = header => Object.fromEntries((header||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
const cookie = (name,value,maxAge,{httpOnly=true,sameSite='None'}={}) => `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; SameSite=${sameSite}${httpOnly?'; HttpOnly':''}`;
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});

async function hmac(secret,value) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value))));
}
async function hash(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))); }
async function makeSession(env,userId,login) {
  const payload={id:String(userId),login,exp:Math.floor(Date.now()/1000)+SESSION_SECONDS,csrf:randomToken(24)};
  const body=b64url(encoder.encode(JSON.stringify(payload)));
  return {value:`${body}.${await hmac(env.SESSION_SECRET,body)}`,payload};
}
async function getSession(request,env) {
  const value=cookieMap(request.headers.get('Cookie'))[SESSION_COOKIE]||'';
  const [body,signature,...rest]=value.split('.');
  if(!body||!signature||rest.length||!safeEqual(signature,await hmac(env.SESSION_SECRET,body)))return null;
  try { const s=JSON.parse(decoder.decode(unb64url(body))); if(s.exp<=Date.now()/1000||s.id!==String(env.ADMIN_GITHUB_USER_ID))return null; return s; }
  catch { return null; }
}
function cors(request,env) {
  const origin=request.headers.get('Origin');
  if(origin!==env.ALLOWED_ORIGIN)return {};
  return {'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type,X-CSRF-Token','Access-Control-Max-Age':'600','Vary':'Origin'};
}
function originOk(request,env) { return request.headers.get('Origin')===env.ALLOWED_ORIGIN; }
function limited(request,key,limit,windowMs) {
  const now=Date.now(), ip=request.headers.get('CF-Connecting-IP')||'unknown', k=`${key}:${ip}`;
  let row=limitBuckets.get(k); if(!row||now>row.until)row={count:0,until:now+windowMs}; row.count++; limitBuckets.set(k,row);
  if(limitBuckets.size>5000)for(const [id,item] of limitBuckets)if(now>item.until)limitBuckets.delete(id);
  return row.count<=limit;
}
function setOauthCookie(env,value,age=600) { return cookie(OAUTH_COOKIE,value,age,{sameSite:'Lax'}); }
function apiUrl(env,path) { return `${API}/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}${path}`; }

function corsResponse(request,env,response) {
  const headers=new Headers(response.headers); for(const [k,v] of Object.entries(cors(request,env)))headers.set(k,v);
  headers.set('Cache-Control','no-store');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

async function startLogin(request,env) {
  if(!limited(request,'login',12,15*60_000))return json({error:'Too many sign-in attempts. Try again shortly.'},429);
  const state=randomToken(32), verifier=randomToken(48), exp=Math.floor(Date.now()/1000)+600;
  const unsigned=`${state}.${verifier}.${exp}`; const signed=`${unsigned}.${await hmac(env.SESSION_SECRET,unsigned)}`;
  const challenge=b64url(await hash(verifier));
  const url=new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id',env.GITHUB_APP_CLIENT_ID); url.searchParams.set('redirect_uri',env.OAUTH_CALLBACK_URL);
  url.searchParams.set('state',state); url.searchParams.set('code_challenge',challenge); url.searchParams.set('code_challenge_method','S256'); url.searchParams.set('allow_signup','false');
  return new Response(null,{status:302,headers:{Location:url.toString(),'Cache-Control':'no-store','Set-Cookie':setOauthCookie(env,signed)}});
}
async function finishLogin(request,env) {
  const url=new URL(request.url), code=url.searchParams.get('code'), state=url.searchParams.get('state');
  const oauth=cookieMap(request.headers.get('Cookie'))[OAUTH_COOKIE]||'';
  const [savedState,verifier,expText,sig,...extra]=oauth.split('.'); const unsigned=`${savedState}.${verifier}.${expText}`;
  const clear=setOauthCookie(env,'',0);
  if(!limited(request,'oauth-callback',24,60*60_000))return new Response('Too many authorization attempts.',{status:429,headers:{'Set-Cookie':clear,'Cache-Control':'no-store'}});
  if(!code||!state||extra.length||!savedState||!safeEqual(state,savedState)||Number(expText)<=Date.now()/1000||!safeEqual(sig||'',await hmac(env.SESSION_SECRET,unsigned)))return new Response('OAuth state check failed. Please sign in again.',{status:400,headers:{'Set-Cookie':clear,'Cache-Control':'no-store'}});
  let tokenData,user;
  try {
    const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:env.GITHUB_APP_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:env.OAUTH_CALLBACK_URL,code_verifier:verifier})});
    tokenData=await tokenResponse.json().catch(()=>({}));
    if(!tokenResponse.ok||!tokenData.access_token)return new Response('GitHub authorization failed. Please try again.',{status:502,headers:{'Set-Cookie':clear,'Cache-Control':'no-store'}});
    const userResponse=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${tokenData.access_token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Huda-Store-Admin'}});
    user=await userResponse.json().catch(()=>({}));
    if(!userResponse.ok)return new Response('GitHub authorization failed. Please try again.',{status:502,headers:{'Set-Cookie':clear,'Cache-Control':'no-store'}});
  } catch {
    return new Response('GitHub authorization is temporarily unavailable. Please try again.',{status:502,headers:{'Set-Cookie':clear,'Cache-Control':'no-store'}});
  }
  if(String(user.id)!==String(env.ADMIN_GITHUB_USER_ID))return new Response(null,{status:302,headers:{Location:`${env.PUBLIC_URL}/admin/?error=unauthorized`,'Set-Cookie':clear,'Cache-Control':'no-store'}});
  // Discard the OAuth user token immediately. Repository API calls use short-lived
  // installation tokens minted inside the Worker from the App private-key secret.
  const session=await makeSession(env,user.id,user.login);
  const headers=new Headers({Location:`${env.PUBLIC_URL}/admin/?login=success`,'Cache-Control':'no-store'});headers.append('Set-Cookie',clear);headers.append('Set-Cookie',cookie(SESSION_COOKIE,session.value,SESSION_SECONDS));
  return new Response(null,{status:302,headers});
}

function derLength(size) { if(size<128)return Uint8Array.of(size); const parts=[];while(size){parts.unshift(size&255);size>>=8;}return Uint8Array.of(0x80|parts.length,...parts); }
function der(tag,bytes) { return Uint8Array.of(tag,...derLength(bytes.length),...bytes); }
function pkcs1ToPkcs8(pkcs1) {
  const oid=Uint8Array.of(0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00);
  const content=Uint8Array.of(...der(0x02,Uint8Array.of(0)),...oid,...der(0x04,pkcs1)); return der(0x30,content);
}
function pemBytes(pem) { const content=pem.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g,'');return Uint8Array.from(atob(content),c=>c.charCodeAt(0)); }
async function installationToken(env) {
  const now=Math.floor(Date.now()/1000), header=b64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'}))), payload=b64url(encoder.encode(JSON.stringify({iat:now-30,exp:now+540,iss:env.GITHUB_APP_ID})));
  const signingInput=`${header}.${payload}`, key=await crypto.subtle.importKey('pkcs8',pkcs1ToPkcs8(pemBytes(env.GITHUB_APP_PRIVATE_KEY)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const jwt=`${signingInput}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(signingInput))))}`;
  const response=await fetch(`${API}/app/installations/${encodeURIComponent(env.GITHUB_INSTALLATION_ID)}/access_tokens`,{method:'POST',headers:{Authorization:`Bearer ${jwt}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Huda-Store-Admin','Content-Type':'application/json'},body:JSON.stringify({repositories:[env.GITHUB_REPO],permissions:{contents:'write'}})});
  const data=await response.json(); if(!response.ok||!data.token)throw new Error(`Could not authorize the GitHub App installation (${response.status}).`);
  return data.token;
}
async function github(env,token,path,init={}) {
  const response=await fetch(apiUrl(env,path),{...init,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'Huda-Store-Admin','Content-Type':'application/json',...(init.headers||{})}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) { const error=new Error(data.message||`GitHub API returned ${response.status}`);error.status=response.status;throw error; }
  return data;
}

async function repoState(env,token) {
  const ref=await github(env,token,'/git/ref/heads/main');
  const head=ref.object.sha, commit=await github(env,token,`/git/commits/${head}`), tree=await github(env,token,`/git/trees/${commit.tree.sha}?recursive=1`);
  if(tree.truncated)throw new Error('Repository tree is too large to safely update.');
  const entries=new Map(tree.tree.filter(x=>x.type==='blob').map(x=>[x.path,x.sha]));
  const read=async file=>{const sha=entries.get(file);if(!sha)throw new Error(`Repository is missing required file: ${file}`);const blob=await github(env,token,`/git/blobs/${sha}`);return JSON.parse(decoder.decode(Uint8Array.from(atob(blob.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));};
  const [products,usedRefs,settings]=await Promise.all([read('src/data/products.json'),read('src/data/used-refs.json'),read('src/data/settings.json')]);
  return {head,treeSha:commit.tree.sha,entries,products,usedRefs,settings};
}
async function commitFiles(env,token,state,files,deletions,message) {
  const tree=[];
  for(const [path,item] of Object.entries(files)) {
    const blob=await github(env,token,'/git/blobs',{method:'POST',body:JSON.stringify({content:item.content,encoding:item.encoding||'utf-8'})});
    tree.push({path,mode:'100644',type:'blob',sha:blob.sha});
  }
  for(const path of deletions)tree.push({path,mode:'100644',type:'blob',sha:null});
  const nextTree=await github(env,token,'/git/trees',{method:'POST',body:JSON.stringify({base_tree:state.treeSha,tree})});
  const commit=await github(env,token,'/git/commits',{method:'POST',body:JSON.stringify({message,tree:nextTree.sha,parents:[state.head]})});
  try { await github(env,token,'/git/refs/heads/main',{method:'PATCH',body:JSON.stringify({sha:commit.sha,force:false})}); }
  catch(error) { if(error.status===409||error.status===422){const conflict=new Error('The main branch changed while you were editing. Reload the catalog and reapply your changes; nothing was overwritten.');conflict.status=409;throw conflict;}throw error; }
  return commit.sha;
}
const asFile=value=>({content:JSON.stringify(value,null,2)+'\n'});
const slugify=text=>String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
function validateProduct(product,products,id='') {
  for(const key of ['name','nameAr','category','categoryAr','description','descriptionAr'])if(typeof product[key]!=='string'||!product[key].trim()||product[key].length>2000)throw new Error(`${key} is required and must be under 2,000 characters.`);
  if(!['available','on-request','unavailable'].includes(product.status))throw new Error('Invalid availability status.');
  if(!Array.isArray(product.keywords)||product.keywords.length>40||product.keywords.some(x=>typeof x!=='string'||x.length>80))throw new Error('Invalid product keywords.');
  if(!Array.isArray(product.images)||product.images.length<1||product.images.length>8||new Set(product.images).size!==product.images.length||product.images.some(x=>typeof x!=='string'||!x.startsWith(`/images/${id}/`)||x.includes('..')))throw new Error('Products need 1–8 unique images stored under their product reference.');
  if(products.some(p=>p.id!==id&&p.slug===product.slug))throw new Error('That product URL already exists.');
}
function decodeImage64(data) {
  if(typeof data!=='string'||data.length>Math.ceil(MAX_IMAGE_BYTES*4/3)+8||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new Error('Image data is invalid or too large.');
  const binary=atob(data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(bytes.length>MAX_IMAGE_BYTES||bytes.length<12||String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='WEBP')throw new Error('Images must be optimized WebP files under 3 MB each.');
  return bytes;
}
function b64(bytes) { let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(binary); }
function validateVariants(upload) {
  if(!upload||!upload.full||!upload.medium||!upload.thumbnail)throw new Error('Each image requires full, medium, and thumbnail WebP variants.');
  const result={};for(const [key,file] of Object.entries({full:upload.full,medium:upload.medium,thumbnail:upload.thumbnail}))result[key]=b64(decodeImage64(file));return result;
}
function imagePathList(id,basePath) {
  const relative=String(basePath).replace(/^\/+/,'');const base=relative.startsWith('public/')?relative:`public/${relative}`;
  return base.endsWith('.webp')?[base,base.replace(/\.webp$/,'-md.webp'),base.replace(/\.webp$/,'-thumb.webp')]:[base];
}
async function productsWrite(env,token,body,state) {
  if(!Array.isArray(state.usedRefs)||new Set(state.usedRefs).size!==state.usedRefs.length||state.usedRefs.some(x=>typeof x!=='string'||!/^\d{5,}$/.test(x))||!Array.isArray(state.products)||state.products.some(p=>!state.usedRefs.includes(p.id))||new Set(state.products.map(p=>p.id)).size!==state.products.length)throw new Error('Catalog references are inconsistent. Repair the catalog before editing.');
  if(body.baseCommitSha!==state.head) { const e=new Error('Catalog changed in another tab. Reload before saving.');e.status=409;throw e; }
  const products=[...state.products], refs=[...state.usedRefs], files={}, deletions=[];
  if(body.operation==='delete') {
    const id=String(body.id||''); const at=products.findIndex(x=>x.id===id);if(at<0)throw new Error('Product not found.');
    const old=products.splice(at,1)[0]; for(const img of old.images||[])deletions.push(...imagePathList(id,img));
  } else if(body.operation==='visibility'||body.operation==='upsert') {
    const editing=body.operation==='upsert'&&body.product?.id;
    const at=editing?products.findIndex(x=>x.id===String(body.product.id)):-1;
    if(editing&&at<0)throw new Error('Product no longer exists. Reload and retry.');
    const old=at>=0?products[at]:null;
    let id=old?.id;
    if(body.operation==='visibility') { const i=products.findIndex(x=>x.id===String(body.id));if(i<0)throw new Error('Product not found.');products[i]={...products[i],visible:body.visible===true}; }
    else {
      if(!body.product||typeof body.product!=='object')throw new Error('Product data is required.');
      if(!old) { id=String(Math.max(10000,...refs.map(Number))+1);refs.push(id); }
      const kept=Array.isArray(body.product.images)?body.product.images:[];
      const oldImages=old?.images||[];
      if(new Set(kept).size!==kept.length||kept.some(image=>!oldImages.includes(image)))throw new Error('An image path is duplicated or is not part of this product.');
      for(const image of oldImages)if(!kept.includes(image))deletions.push(...imagePathList(id,image));
      const uploads=body.uploads||[];if(!Array.isArray(uploads)||uploads.length>8)throw new Error('Upload no more than 8 images at once.');
      if(kept.length+uploads.length>8)throw new Error('A product can have no more than 8 images. Remove an image before adding another.');
      const imageOrder=body.imageOrder===undefined?[...kept,...uploads.map((_,i)=>`upload:${i}`)]:body.imageOrder;
      if(!Array.isArray(imageOrder)||imageOrder.length!==kept.length+uploads.length||new Set(imageOrder).size!==imageOrder.length)throw new Error('Image order must include each existing image and upload exactly once.');
      const orderedUploads=imageOrder.filter(item=>typeof item==='string'&&/^upload:\d+$/.test(item)).map(item=>Number(item.slice(7)));
      if(imageOrder.some(item=>typeof item!=='string'||(!kept.includes(item)&&!/^upload:\d+$/.test(item)))||kept.some(image=>!imageOrder.includes(image))||orderedUploads.length!==uploads.length||new Set(orderedUploads).size!==uploads.length||orderedUploads.some(index=>index>=uploads.length))throw new Error('Image order contains an unknown, missing, or repeated image.');
      let total=0;const occupied=new Set(oldImages.map(x=>x.match(/\/(\d+)\.webp$/)?.[1]).filter(Boolean));
      for(const path of state.entries.keys()){const match=path.match(new RegExp(`^public/images/${id}/(\\d+)\\.webp$`));if(match)occupied.add(match[1]);}
      let next=1;
      const uploadedPaths=[];
      for(const upload of uploads) {
        while(occupied.has(String(next).padStart(2,'0')))next++;
        const stem=String(next++).padStart(2,'0');occupied.add(stem);
        const variants=validateVariants(upload);total+=Object.values(variants).reduce((n,x)=>n+x.length*.75,0);if(total>MAX_UPLOAD_BYTES)throw new Error('Combined optimized image uploads must be under 16 MB.');
        const base=`public/images/${id}/${stem}.webp`;
        for(const [variant,suffix] of [['full',''],['medium','-md'],['thumbnail','-thumb']])files[`${base.replace('.webp',suffix+'.webp')}`]={content:variants[variant],encoding:'base64'};
        uploadedPaths.push(`/${base.replace(/^public\//,'')}`);
      }
      const imagePaths=imageOrder.map(item=>item.startsWith('upload:')?uploadedPaths[Number(item.slice(7))]:item);
      const product={...body.product,id,slug:slugify(body.product.name),images:imagePaths,keywords:Array.isArray(body.product.keywords)?body.product.keywords:[],visible:body.product.visible!==false};
      if(product.price!==undefined&&(typeof product.price!=='string'||product.price.length>120))throw new Error('Price label must be text under 120 characters.');
      delete product.uploads; if(uploads.length)delete product.sample;
      validateProduct(product,products,id);
      if(old)products[at]=product;else products.push(product);
    }
  } else throw new Error('Unknown product operation.');
  const permanent=[...new Set(refs)].sort((a,b)=>Number(a)-Number(b));
  files['src/data/products.json']=asFile(products);files['src/data/used-refs.json']=asFile(permanent);
  const sha=await commitFiles(env,token,state,files,deletions,body.operation==='delete'?'Delete Huda Store product':body.operation==='visibility'?'Update Huda Store product visibility':'Save Huda Store product');
  return {commitSha:sha,products,usedRefs:permanent};
}
async function categoriesWrite(env,token,body,state) {
  if(body.baseCommitSha!==state.head){const e=new Error('Catalog changed in another tab. Reload before saving.');e.status=409;throw e;}
  const settings=structuredClone(state.settings),products=structuredClone(state.products);
  const categories=Array.isArray(settings.categories)&&settings.categories.length?settings.categories:[...new Map(products.map(p=>[p.category,{name:p.category,nameAr:p.categoryAr}])).values()];
  if(body.action==='add') { const c=cleanCategory(body.category);if(categories.some(x=>x.name.toLowerCase()===c.name.toLowerCase()))throw new Error('Category already exists.');categories.push(c); }
  else { const at=Number(body.index),old=categories[at];if(!old)throw new Error('Category not found.');
    if(body.action==='rename'){const c=cleanCategory(body.category);if(categories.some((x,i)=>i!==at&&x.name.toLowerCase()===c.name.toLowerCase()))throw new Error('Category already exists.');for(const p of products)if(p.category===old.name){p.category=c.name;p.categoryAr=c.nameAr;}categories[at]=c;}
    else if(body.action==='delete'){if(products.some(p=>p.category===old.name))throw new Error('Reassign its products before deleting this category.');categories.splice(at,1);}else throw new Error('Unknown category action.');
  }
  settings.categories=categories;
  const sha=await commitFiles(env,token,state,{'src/data/settings.json':asFile(settings),'src/data/products.json':asFile(products)},[],'Update Huda Store categories');return {commitSha:sha,categories};
}
function cleanCategory(value) {const name=String(value?.name||'').trim(),nameAr=String(value?.nameAr||'').trim();if(!name||!nameAr||name.length>80||nameAr.length>80)throw new Error('Enter English and Arabic names up to 80 characters.');return {name,nameAr};}
function contrast(hex,bg='#f8f7f4') {const lum=h=>{const c=h.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*c[0]+.7152*c[1]+.0722*c[2];};return (Math.max(lum(hex),lum(bg))+.05)/(Math.min(lum(hex),lum(bg))+.05);}
async function settingsWrite(env,token,body,state) {
  if(body.baseCommitSha!==state.head){const e=new Error('Catalog changed in another tab. Reload before saving.');e.status=409;throw e;}
  const store=body.store||{},contact=body.contact||{},name=String(store.name||'').trim();if(!name||name.length>80)throw new Error('Store name is required and must be under 80 characters.');
  const accent=/^#[0-9a-fA-F]{6}$/.test(store.accent)?store.accent:'#80704f';if(contrast(accent)<4.5)throw new Error('Choose a brand color with at least 4.5:1 contrast on the storefront background.');
  const whatsapp=String(contact.whatsapp||'').replace(/[^+\d]/g,'');if(whatsapp.length>18)throw new Error('WhatsApp number is too long.');
  const email=String(contact.email||'').trim();if(email&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254))throw new Error('Enter a valid email address.');
  const instagram=String(contact.instagram||'').trim();if(instagram&&(!/^https:\/\//i.test(instagram)||instagram.length>500))throw new Error('Instagram link must be HTTPS.');
  let logo=state.settings.store.logo||'';const files={};
  if(body.logoUpload){const bytes=decodeImage64(body.logoUpload);files['public/images/brand/logo.webp']={content:b64(bytes),encoding:'base64'};logo='/images/brand/logo.webp';}
  const settings={store:{name,tagline:String(store.tagline||'').trim().slice(0,140),logo,accent},contact:{whatsapp,email,instagram},categories:state.settings.categories||[]};
  const sha=await commitFiles(env,token,state,{'src/data/settings.json':asFile(settings),...files},[],'Update Huda Store branding');return {commitSha:sha,settings};
}

async function authorized(request,env,write=false) {
  const session=await getSession(request,env);if(!session)return {response:json({error:'Sign in required.'},401)};
  if(write&&(!originOk(request,env)||!safeEqual(request.headers.get('X-CSRF-Token')||'',session.csrf)))return {response:json({error:'CSRF check failed.'},403)};
  if(write&&!limited(request,'write',40,60*60_000))return {response:json({error:'Too many updates. Try again later.'},429)};
  return {session};
}
async function readBody(request) { const length=Number(request.headers.get('Content-Length')||0);if(length>MAX_BODY)throw new Error('Request body is too large.');const text=await request.text();if(text.length>MAX_BODY)throw new Error('Request body is too large.');try{return JSON.parse(text);}catch{throw new Error('Invalid JSON body.');} }

export async function fetchHandler(request,env) {
  const url=new URL(request.url), headers=cors(request,env);
  if(url.pathname==='/health')return json({ok:true});
  if(url.pathname==='/auth/login'&&request.method==='GET')return startLogin(request,env);
  if(url.pathname==='/auth/callback'&&request.method==='GET')return finishLogin(request,env);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Max-Age':'600'}});
  if(url.pathname.startsWith('/api/')&&!originOk(request,env))return json({error:'Origin not allowed.'},403);
  try {
    if(url.pathname==='/api/session'&&request.method==='GET') {
      const auth=await authorized(request,env);if(auth.response)return corsResponse(request,env,auth.response);
      return corsResponse(request,env,json({user:{id:auth.session.id,login:auth.session.login},csrf:auth.session.csrf,expiresAt:auth.session.exp}));
    }
    if(url.pathname==='/api/logout'&&request.method==='POST') {
      const auth=await authorized(request,env,true);if(auth.response)return corsResponse(request,env,auth.response);
      return corsResponse(request,env,json({ok:true},200,{'Set-Cookie':cookie(SESSION_COOKIE,'',0)}));
    }
    if(!url.pathname.startsWith('/api/'))return json({error:'Not found.'},404);
    const write=request.method==='POST';if(!write&&request.method!=='GET')return json({error:'Method not allowed.'},405);
    const route=url.pathname;
    if(!((route==='/api/catalog'&&request.method==='GET')||((route==='/api/products'||route==='/api/categories'||route==='/api/settings')&&write)))return json({error:'Not found.'},404);
    const auth=await authorized(request,env,write);if(auth.response)return corsResponse(request,env,auth.response);
    if(!limited(request,'read',120,60_000))return corsResponse(request,env,json({error:'Too many requests.'},429));
    const body=write?await readBody(request):null;
    const token=await installationToken(env);
    const state=await repoState(env,token);
    if(route==='/api/catalog'&&request.method==='GET')return corsResponse(request,env,json({commitSha:state.head,products:state.products,usedRefs:state.usedRefs,settings:state.settings,categories:state.settings.categories||[]}));
    if(route==='/api/products')return corsResponse(request,env,json(await productsWrite(env,token,body,state)));
    if(route==='/api/categories')return corsResponse(request,env,json(await categoriesWrite(env,token,body,state)));
    if(route==='/api/settings')return corsResponse(request,env,json(await settingsWrite(env,token,body,state)));
  } catch(error) {const status=error.status||400;return corsResponse(request,env,json({error:error.message||'Request failed.'},status));}
}

export default { fetch:fetchHandler };
