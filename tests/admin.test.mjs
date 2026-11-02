import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';

const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const env={SESSION_SECRET:'test-session-secret-that-is-at-least-32-bytes-long',GITHUB_CLIENT_SECRET:'mock-client-secret',GITHUB_APP_CLIENT_ID:'mock-client-id',GITHUB_APP_ID:'12345',GITHUB_APP_PRIVATE_KEY:keys.privateKey,GITHUB_INSTALLATION_ID:'99',ADMIN_GITHUB_USER_ID:'351334834',GITHUB_OWNER:'hudastoreus',GITHUB_REPO:'huda_store',ALLOWED_ORIGIN:'https://hudastoreus.github.io',PUBLIC_URL:'https://hudastoreus.github.io/huda_store',OAUTH_CALLBACK_URL:'https://huda-store-admin.test/auth/callback'};
const req=(path,{method='GET',headers={},body}={})=>new Request(`https://huda-store-admin.test${path}`,{method,headers,body});
let loginSerial=0;
async function loginAs(id='351334834'){
  const old=globalThis.fetch;globalThis.fetch=async url=>String(url).includes('login/oauth/access_token')?Response.json({access_token:'mock-user-token'}):Response.json({id:Number(id),login:id==='351334834'?'hudastoreus':'intruder'});
  try{const start=await worker.fetch(req('/auth/login',{headers:{'CF-Connecting-IP':`test-login-${++loginSerial}`}}),env),authorize=new URL(start.headers.get('Location')),oauth=start.headers.get('Set-Cookie').split(';')[0];assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.equal(authorize.searchParams.get('code_challenge').length,43);const callback=await worker.fetch(req(`/auth/callback?code=mock-code&state=${encodeURIComponent(authorize.searchParams.get('state'))}`,{headers:{Cookie:oauth,'CF-Connecting-IP':`test-login-${loginSerial}`}}),env);return {callback,cookies:callback.headers.getSetCookie()};}finally{globalThis.fetch=old;}
}
const sessionFrom=cookies=>cookies.map(x=>x.split(';')[0]).find(x=>x.startsWith('__Host-huda_session='));
async function auth(){const result=await loginAs();assert.equal(result.callback.status,302);const cookie=sessionFrom(result.cookies);assert.ok(cookie);const response=await worker.fetch(req('/api/session',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(response.status,200);return {cookie,csrf:(await response.json()).csrf};}
const jsonResponse=(value,status=200)=>Response.json(value,{status});
function fakeCatalog(firstImages){
  const products=Array.from({length:8},(_,i)=>({id:String(10001+i),slug:`product-${i+1}`,name:`Product ${i+1}`,nameAr:`منتج ${i+1}`,category:'Objects',categoryAr:'قطع',keywords:[],description:'Description',descriptionAr:'الوصف',status:'available',visible:true,images:[`/images/${10001+i}/01.svg`]}));
  if(firstImages)products[0].images=firstImages;
  const docs={'src/data/products.json':products,'src/data/used-refs.json':products.map(p=>p.id),'src/data/settings.json':{store:{name:'Huda Store',tagline:'',logo:'',accent:'#80704f'},contact:{whatsapp:'',email:'',instagram:''},categories:[{name:'Objects',nameAr:'قطع'}]}};
  const blobs=new Map(),entries=[];let blobNo=0;for(const [path,value]of Object.entries(docs)){const sha=`blob-${++blobNo}`;blobs.set(sha,Buffer.from(JSON.stringify(value)).toString('base64'));entries.push({path,sha,type:'blob',mode:'100644'});}
  const trees=new Map([['tree-0',entries]]),commits=new Map([['head-0',{tree:'tree-0',parents:[]}]]);let head='head-0',treeNo=0,commitNo=0,lastTreeEntries=[],calls=0,failure=null;
  const mock=async(input,init={})=>{const url=new URL(String(input)),method=init.method||'GET';
    calls++;if(failure&&url.pathname.endsWith(failure.path)&&method===failure.method){const {status}=failure;failure=null;return jsonResponse({message:'simulated GitHub failure'},status);}
    if(url.pathname.startsWith('/app/installations/'))return jsonResponse({token:'mock-installation-token'});
    if(url.pathname.endsWith('/git/ref/heads/main')&&method==='GET')return jsonResponse({object:{sha:head}});
    const cm=url.pathname.match(/\/git\/commits\/([^/]+)$/);if(cm&&method==='GET'){const commit=commits.get(cm[1]);return commit?jsonResponse({sha:cm[1],tree:{sha:commit.tree}}):jsonResponse({message:'not found'},404);}
    const tm=url.pathname.match(/\/git\/trees\/([^/]+)$/);if(tm&&method==='GET')return jsonResponse({sha:tm[1],tree:trees.get(tm[1])||[],truncated:false});
    const bm=url.pathname.match(/\/git\/blobs\/([^/]+)$/);if(bm&&method==='GET')return jsonResponse({sha:bm[1],encoding:'base64',content:blobs.get(bm[1])||''});
    if(url.pathname.endsWith('/git/blobs')&&method==='POST'){const b=JSON.parse(init.body),sha=`blob-${++blobNo}`;blobs.set(sha,b.encoding==='base64'?b.content:Buffer.from(b.content).toString('base64'));return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/trees')&&method==='POST'){const b=JSON.parse(init.body),next=new Map((trees.get(b.base_tree)||[]).map(e=>[e.path,e]));lastTreeEntries=b.tree;for(const entry of b.tree){if(entry.sha===null)next.delete(entry.path);else next.set(entry.path,entry);}const sha=`tree-${++treeNo}`;trees.set(sha,[...next.values()]);return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/commits')&&method==='POST'){const b=JSON.parse(init.body),sha=`commit-${++commitNo}`;commits.set(sha,{tree:b.tree,parents:b.parents});return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/refs/heads/main')&&method==='PATCH'){const b=JSON.parse(init.body);assert.equal(b.force,false);if(commits.get(b.sha)?.parents?.[0]!==head)return jsonResponse({message:'Update is not a fast forward'},409);head=b.sha;return jsonResponse({object:{sha:head}});}
    return jsonResponse({message:`unmocked ${method} ${url.pathname}`},500);
  };return {mock,products,lastTreeEntries:()=>lastTreeEntries,calls:()=>calls,failNext:(path,method,status)=>{failure={path,method,status};},seedImagePath:path=>{const entry={path,sha:`orphan-${path}`,type:'blob',mode:'100644'};entries.push(entry);trees.set('tree-0',entries);}};
}
const webp=btoa(String.fromCharCode(...Uint8Array.of(82,73,70,70,12,0,0,0,87,69,66,80,1,2,3,4))),variants={full:webp,medium:webp,thumbnail:webp};

test('OAuth uses state and PKCE and allowlists the immutable numeric GitHub user ID',async()=>{
  const accepted=await loginAs();assert.equal(accepted.callback.status,302);assert.match(accepted.callback.headers.get('Location'),/login=success/);assert.ok(sessionFrom(accepted.cookies));
  const denied=await loginAs('999999');assert.equal(denied.callback.status,302);assert.match(denied.callback.headers.get('Location'),/error=unauthorized/);assert.equal(sessionFrom(denied.cookies),undefined);
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('bad state must stop before code exchange');};try{const start=await worker.fetch(req('/auth/login'),env),cookie=start.headers.get('Set-Cookie').split(';')[0],url=new URL(start.headers.get('Location'));const bad=await worker.fetch(req(`/auth/callback?code=x&state=wrong`,{headers:{Cookie:cookie}}),env);assert.equal(bad.status,400);assert.ok(url.searchParams.get('state'));}finally{globalThis.fetch=old;}
});

test('GitHub OAuth outages fail closed, return a controlled error, and clear temporary state',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('simulated upstream outage');};
  try{
    const start=await worker.fetch(req('/auth/login'),env),state=new URL(start.headers.get('Location')).searchParams.get('state'),oauth=start.headers.get('Set-Cookie').split(';')[0];
    const result=await worker.fetch(req(`/auth/callback?code=mock-code&state=${state}`,{headers:{Cookie:oauth}}),env);
    assert.equal(result.status,502);assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);assert.doesNotMatch(await result.text(),/simulated upstream outage/);
  }finally{globalThis.fetch=old;}
});

test('sessions expire, CSRF is required for writes, and logout clears the HttpOnly session',async()=>{
  const unauth=await worker.fetch(req('/api/catalog',{headers:{Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(unauth.status,401);
  const {cookie,csrf}=await auth();assert.match(cookie,/^__Host-huda_session=/);const setCookie=(await loginAs()).cookies.find(x=>x.startsWith('__Host-huda_session='));assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=None/);
  const bad=await worker.fetch(req('/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(bad.status,403);
  const out=await worker.fetch(req('/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf}}),env);assert.equal(out.status,200);assert.match(out.headers.get('Set-Cookie'),/Max-Age=0/);
  const now=Date.now;Date.now=()=>now()+3*60*60*1000;try{const expired=await worker.fetch(req('/api/session',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(expired.status,401);}finally{Date.now=now;}
});

test('GitHub API product create, unique reference, duplicate rejection, conflict detection, edit, and delete',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=body=>worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
    const draft={name:'Linen Pouch',nameAr:'حقيبة كتان',category:'Objects',categoryAr:'قطع',description:'Soft pouch',descriptionAr:'حقيبة ناعمة',keywords:['linen'],status:'available',visible:true,images:[]};
    const add=await send({operation:'upsert',baseCommitSha:'head-0',product:draft,uploads:[variants]});assert.equal(add.status,200);let result=await add.json();assert.equal(result.products.at(-1).id,'10009');assert.deepEqual(result.usedRefs.slice(-1),['10009']);assert.equal(result.products.at(-1).images[0],'/images/10009/01.webp');assert.equal(result.products.at(-1).nameAr,draft.nameAr);assert.equal(result.products.at(-1).descriptionAr,draft.descriptionAr);assert.equal(result.products.at(-1).keywords[0],'linen');
    const duplicate=await send({operation:'upsert',baseCommitSha:result.commitSha,product:{...draft,name:'Product 1'},uploads:[]});assert.equal(duplicate.status,400);
    const stale=await send({operation:'delete',baseCommitSha:'head-0',id:'10009'});assert.equal(stale.status,409);
    const edit=await send({operation:'upsert',baseCommitSha:result.commitSha,product:{...result.products.at(-1),name:'Updated Pouch'},uploads:[]});assert.equal(edit.status,200);result=await edit.json();assert.equal(result.products.at(-1).name,'Updated Pouch');
    const hide=await send({operation:'visibility',baseCommitSha:result.commitSha,id:'10009',visible:false});assert.equal(hide.status,200);result=await hide.json();assert.equal(result.products.at(-1).visible,false);
    const restore=await send({operation:'visibility',baseCommitSha:result.commitSha,id:'10009',visible:true});assert.equal(restore.status,200);result=await restore.json();assert.equal(result.products.at(-1).visible,true);
    const del=await send({operation:'delete',baseCommitSha:result.commitSha,id:'10009'});assert.equal(del.status,200);result=await del.json();assert.equal(result.products.some(p=>p.id==='10009'),false);assert.ok(result.usedRefs.includes('10009'));
    assert.deepEqual(fixture.lastTreeEntries().filter(entry=>entry.sha===null).map(entry=>entry.path).sort(),['public/images/10009/01-md.webp','public/images/10009/01-thumb.webp','public/images/10009/01.webp']);
  }finally{globalThis.fetch=old;}
});

test('product image order interleaves retained images and uploads without rewriting retained files',async()=>{
  const existing=['/images/10001/01.webp','/images/10001/02.webp'],fixture=fakeCatalog(existing),{cookie,csrf}=await auth(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    fixture.seedImagePath('public/images/10001/03.webp');
    const response=await worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert',baseCommitSha:'head-0',product:{...fixture.products[0],images:existing},uploads:[variants],imageOrder:['upload:0',existing[1],existing[0]]})}),env);
    assert.equal(response.status,200);const result=await response.json();
    assert.deepEqual(result.products[0].images,['/images/10001/04.webp',existing[1],existing[0]]);
    const imageWrites=fixture.lastTreeEntries().filter(entry=>entry.path.startsWith('public/images/10001/')).map(entry=>entry.path).sort();
    assert.deepEqual(imageWrites,['public/images/10001/04-md.webp','public/images/10001/04-thumb.webp','public/images/10001/04.webp']);
  }finally{globalThis.fetch=old;}
});

test('legacy image removal targets the public file exactly once',async()=>{
  const fixture=fakeCatalog(),{cookie,csrf}=await auth(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const response=await worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operation:'delete',baseCommitSha:'head-0',id:'10001'})}),env);
    assert.equal(response.status,200);const deletions=fixture.lastTreeEntries().filter(entry=>entry.sha===null).map(entry=>entry.path);
    assert.deepEqual(deletions,['public/images/10001/01.svg']);assert.equal(new Set(deletions).size,deletions.length);
  }finally{globalThis.fetch=old;}
});

test('invalid bodies and unsupported routes make no GitHub API calls',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const headers={Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
    const malformed=await worker.fetch(req('/api/products',{method:'POST',headers,body:'{'}),env);assert.equal(malformed.status,400);assert.equal(fixture.calls(),0);
    const unknown=await worker.fetch(req('/api/does-not-exist',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(unknown.status,404);assert.equal(fixture.calls(),0);
  }finally{globalThis.fetch=old;}
});

test('a concurrent write loses safely when the GitHub main ref advances',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=name=>worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert',baseCommitSha:'head-0',product:{name,nameAr:'منتج جديد',category:'Objects',categoryAr:'قطع',description:'Description',descriptionAr:'الوصف',keywords:[],status:'available',visible:true,images:[]},uploads:[variants]})}),env);
    const [a,b]=await Promise.all([send('First'),send('Second')]),statuses=[a.status,b.status].sort();assert.deepEqual(statuses,[200,409]);
    const conflict=await (a.status===409?a:b).json();assert.match(conflict.error,/main branch changed|Catalog changed in another tab/);
  }finally{globalThis.fetch=old;}
});

test('GitHub blob API failures return errors without advancing main',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;fixture.failNext('/git/blobs','POST',503);
  try{
    const response=await worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert',baseCommitSha:'head-0',product:{name:'Product',nameAr:'منتج',category:'Objects',categoryAr:'قطع',description:'Description',descriptionAr:'الوصف',keywords:[],status:'available',visible:true,images:[]},uploads:[variants]})}),env);
    assert.equal(response.status,503);assert.match((await response.json()).error,/simulated GitHub failure/);
    const ref=await worker.fetch(req('/api/catalog',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal((await ref.json()).commitSha,'head-0');
  }finally{globalThis.fetch=old;}
});

test('product image writes reject more than 8 total images and incomplete order without committing',async()=>{
  const existing=Array.from({length:8},(_,i)=>`/images/10001/${String(i+1).padStart(2,'0')}.webp`),fixture=fakeCatalog(existing),{cookie,csrf}=await auth(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=body=>worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
    const tooMany=await send({operation:'upsert',baseCommitSha:'head-0',product:{...fixture.products[0],images:existing},uploads:[variants]});assert.equal(tooMany.status,400);assert.match((await tooMany.json()).error,/no more than 8/);
    const badOrder=await send({operation:'upsert',baseCommitSha:'head-0',product:{...fixture.products[0],images:existing},uploads:[],imageOrder:existing.slice(1)});assert.equal(badOrder.status,400);assert.equal(fixture.lastTreeEntries().length,0);
  }finally{globalThis.fetch=old;}
});

test('product validation rejects missing bilingual fields, malformed images, and invalid prices before a commit',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=(product,uploads=[])=>worker.fetch(req('/api/products',{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({operation:'upsert',baseCommitSha:'head-0',product,uploads})}),env);
    const missing=await send({name:'',nameAr:'',category:'Objects',categoryAr:'قطع',description:'',descriptionAr:'',keywords:[],status:'available',images:[]});assert.equal(missing.status,400);assert.match((await missing.json()).error,/name is required/);assert.equal(fixture.lastTreeEntries().length,0);
    const badImage=await send({name:'Valid',nameAr:'صحيح',category:'Objects',categoryAr:'قطع',description:'Description',descriptionAr:'الوصف',keywords:[],status:'available',price:'$10',images:[]},[{full:'not-base64!',medium:webp,thumbnail:webp}]);assert.equal(badImage.status,400);assert.match((await badImage.json()).error,/Image data is invalid/);assert.equal(fixture.lastTreeEntries().length,0);
    const badPrice=await send({name:'Valid',nameAr:'صحيح',category:'Objects',categoryAr:'قطع',description:'Description',descriptionAr:'الوصف',keywords:[],status:'available',price:{amount:5},images:[]});assert.equal(badPrice.status,400);assert.match((await badPrice.json()).error,/Price label/);assert.equal(fixture.lastTreeEntries().length,0);
  }finally{globalThis.fetch=old;}
});

test('category management and branding updates commit atomically to GitHub',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=(path,body)=>worker.fetch(req(path,{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
    const category=await send('/api/categories',{action:'rename',index:0,category:{name:'Home',nameAr:'منزل'},baseCommitSha:'head-0'});assert.equal(category.status,200);let result=await category.json();assert.equal(result.categories[0].name,'Home');
    const catalog=await worker.fetch(req('/api/catalog',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);const loaded=await catalog.json();assert.equal(loaded.products[0].category,'Home');assert.equal(loaded.products[0].categoryAr,'منزل');
    const added=await send('/api/categories',{action:'add',category:{name:'Gifts',nameAr:'هدايا'},baseCommitSha:result.commitSha});assert.equal(added.status,200);result=await added.json();assert.ok(result.categories.some(c=>c.name==='Gifts'));
    const duplicate=await send('/api/categories',{action:'add',category:{name:'gifts',nameAr:'هدايا'},baseCommitSha:result.commitSha});assert.equal(duplicate.status,400);
    const deleted=await send('/api/categories',{action:'delete',index:1,baseCommitSha:result.commitSha});assert.equal(deleted.status,200);result=await deleted.json();assert.equal(result.categories.some(c=>c.name==='Gifts'),false);
    const inUse=await send('/api/categories',{action:'delete',index:0,baseCommitSha:result.commitSha});assert.equal(inUse.status,400);
    const settings=await send('/api/settings',{baseCommitSha:result.commitSha,store:{name:'Huda Home',tagline:'Welcome',accent:'#75613e'},contact:{whatsapp:'15551234567',email:'hello@example.com',instagram:'https://instagram.com/huda'},logoUpload:null});assert.equal(settings.status,200);result=await settings.json();assert.equal(result.settings.store.name,'Huda Home');assert.equal(result.settings.contact.email,'hello@example.com');
  }finally{globalThis.fetch=old;}
});

test('online admin has an accessible login and mobile layout; static UI contains no credentials',async()=>{
  const html=await readFile(new URL('../public/admin/index.html',import.meta.url),'utf8'),js=await readFile(new URL('../public/admin/admin.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/admin/admin.css',import.meta.url),'utf8');
  assert.match(html,/name="viewport"/);assert.match(html,/Sign in with GitHub/);assert.match(html,/aria-label="Admin sections"/);assert.match(css,/@media\(max-width:700px\)/);assert.match(js,/Main image/);assert.match(js,/data-move-image/);assert.match(js,/page\.pathname\.replace/);assert.doesNotMatch(js,/gho_[A-Za-z0-9]{10,}|github_pat_/);
});

test('admin image URLs remain inside the Pages repository with or without an admin trailing slash',async()=>{
  const js=await readFile(new URL('../public/admin/admin.js',import.meta.url),'utf8'),definition=js.match(/const asset=src=>\{[\s\S]*?\};/)?.[0];assert.ok(definition);
  const cases=['https://hudastoreus.github.io/huda_store/admin/','https://hudastoreus.github.io/huda_store/admin','https://hudastoreus.github.io/huda_store/admin/index.html'];
  for(const href of cases){const location={href,pathname:new URL(href).pathname},asset=new Function('location','URL',`return (${definition.slice('const asset='.length,-1)});`)(location,URL);assert.equal(asset('/images/10001/01.svg'),'https://hudastoreus.github.io/huda_store/images/10001/01.svg');}
});

test('online admin points to the configured Huda Store Worker without placeholders',async()=>{
  const config=JSON.parse(await readFile(new URL('../public/admin/config.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(config),['apiBase']);
  assert.equal(config.apiBase,'https://huda-store-admin.alloy212.workers.dev');
  assert.doesNotMatch(config.apiBase,/REPLACE_WITH|blacknight9|apptikar/);
});

test('public catalog contract preserves ordered images, bilingual fields, filters, status, and permanent references',async()=>{
  const products=JSON.parse(await readFile(new URL('../src/data/products.json',import.meta.url),'utf8')),
    app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),card=app.match(/function ProductImage\([\s\S]*?\n\nexport default function App/);
  assert.ok(card);assert.match(card[0],/product\.images\[index % product\.images\.length\]/);
  assert.match(app,/filter\(p => p\.visible !== false\)/);assert.match(app,/p\.status==='available'/);assert.match(app,/selected\.price\|\|t\.priceRequest/);
  assert.match(app,/p\.id,p\.name,p\.nameAr,p\.category,p\.categoryAr,\.\.\.p\.keywords/);assert.match(app,/field==='name'\?p\.nameAr/);assert.match(app,/p\.descriptionAr/);
  for(const product of products){assert.match(product.id,/^\d{5,}$/);assert.ok(product.images.length>=1&&product.images.length<=8);for(const image of product.images){const path=new URL(`../public${image}`,import.meta.url);await readFile(path);}}
});

test('admin prevents duplicate product submissions and retains drafts on failed requests',async()=>{
  const js=await readFile(new URL('../public/admin/admin.js',import.meta.url),'utf8');
  assert.match(js,/if\(productSaving\)return/);assert.match(js,/catch\(e\)\{[\s\S]{0,100}product-message/);
  assert.match(js,/await optimizeProductImage\(item\.file\)/);assert.ok(js.indexOf('await optimizeProductImage(item.file)')<js.indexOf("request('/api/products'"));
});

test('Wrangler preserves Cloudflare dashboard variables and requires the three Worker secrets',async()=>{
  const source=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),config=JSON.parse(source);
  assert.equal(config.name,'huda-store-admin');assert.equal(config.main,'worker/index.js');assert.equal(config.keep_vars,true);assert.equal('vars' in config,false);assert.doesNotMatch(source,/REPLACE_WITH/);
  assert.deepEqual([...config.secrets.required].sort(),['GITHUB_APP_PRIVATE_KEY','GITHUB_CLIENT_SECRET','SESSION_SECRET'].sort());
});
