import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../worker/index.js';

const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const env={SESSION_SECRET:'test-session-secret-that-is-at-least-32-bytes-long',GITHUB_CLIENT_SECRET:'mock-client-secret',GITHUB_APP_CLIENT_ID:'mock-client-id',GITHUB_APP_ID:'12345',GITHUB_APP_PRIVATE_KEY:keys.privateKey,GITHUB_INSTALLATION_ID:'99',ADMIN_GITHUB_USER_ID:'22123586',GITHUB_OWNER:'blacknight9',GITHUB_REPO:'huda_store',ALLOWED_ORIGIN:'https://blacknight9.github.io',PUBLIC_URL:'https://blacknight9.github.io/huda_store',OAUTH_CALLBACK_URL:'https://huda-store-admin.test/auth/callback'};
const req=(path,{method='GET',headers={},body}={})=>new Request(`https://huda-store-admin.test${path}`,{method,headers,body});
async function loginAs(id='22123586'){
  const old=globalThis.fetch;globalThis.fetch=async url=>String(url).includes('login/oauth/access_token')?Response.json({access_token:'mock-user-token'}):Response.json({id:Number(id),login:id==='22123586'?'blacknight9':'intruder'});
  try{const start=await worker.fetch(req('/auth/login'),env),authorize=new URL(start.headers.get('Location')),oauth=start.headers.get('Set-Cookie').split(';')[0];assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.equal(authorize.searchParams.get('code_challenge').length,43);const callback=await worker.fetch(req(`/auth/callback?code=mock-code&state=${encodeURIComponent(authorize.searchParams.get('state'))}`,{headers:{Cookie:oauth}}),env);return {callback,cookies:callback.headers.getSetCookie()};}finally{globalThis.fetch=old;}
}
const sessionFrom=cookies=>cookies.map(x=>x.split(';')[0]).find(x=>x.startsWith('__Host-huda_session='));
async function auth(){const result=await loginAs();assert.equal(result.callback.status,302);const cookie=sessionFrom(result.cookies);assert.ok(cookie);const response=await worker.fetch(req('/api/session',{headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN}}),env);assert.equal(response.status,200);return {cookie,csrf:(await response.json()).csrf};}
const jsonResponse=value=>Response.json(value);
function fakeCatalog(){
  const products=Array.from({length:8},(_,i)=>({id:String(10001+i),slug:`product-${i+1}`,name:`Product ${i+1}`,nameAr:`منتج ${i+1}`,category:'Objects',categoryAr:'قطع',keywords:[],description:'Description',descriptionAr:'الوصف',status:'available',visible:true,images:[`/images/${10001+i}/01.svg`]}));
  const docs={'src/data/products.json':products,'src/data/used-refs.json':products.map(p=>p.id),'src/data/settings.json':{store:{name:'Huda Store',tagline:'',logo:'',accent:'#80704f'},contact:{whatsapp:'',email:'',instagram:''},categories:[{name:'Objects',nameAr:'قطع'}]}};
  const blobs=new Map(),entries=[];let blobNo=0;for(const [path,value]of Object.entries(docs)){const sha=`blob-${++blobNo}`;blobs.set(sha,Buffer.from(JSON.stringify(value)).toString('base64'));entries.push({path,sha,type:'blob',mode:'100644'});}
  const trees=new Map([['tree-0',entries]]),commits=new Map([['head-0','tree-0']]);let head='head-0',treeNo=0,commitNo=0;
  const mock=async(input,init={})=>{const url=new URL(String(input)),method=init.method||'GET';
    if(url.pathname.startsWith('/app/installations/'))return jsonResponse({token:'mock-installation-token'});
    if(url.pathname.endsWith('/git/ref/heads/main')&&method==='GET')return jsonResponse({object:{sha:head}});
    const cm=url.pathname.match(/\/git\/commits\/([^/]+)$/);if(cm&&method==='GET'){const tree=commits.get(cm[1]);return tree?jsonResponse({sha:cm[1],tree:{sha:tree}}):jsonResponse({message:'not found'},404);}
    const tm=url.pathname.match(/\/git\/trees\/([^/]+)$/);if(tm&&method==='GET')return jsonResponse({sha:tm[1],tree:trees.get(tm[1])||[],truncated:false});
    const bm=url.pathname.match(/\/git\/blobs\/([^/]+)$/);if(bm&&method==='GET')return jsonResponse({sha:bm[1],encoding:'base64',content:blobs.get(bm[1])||''});
    if(url.pathname.endsWith('/git/blobs')&&method==='POST'){const b=JSON.parse(init.body),sha=`blob-${++blobNo}`;blobs.set(sha,b.encoding==='base64'?b.content:Buffer.from(b.content).toString('base64'));return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/trees')&&method==='POST'){const b=JSON.parse(init.body),next=new Map((trees.get(b.base_tree)||[]).map(e=>[e.path,e]));for(const entry of b.tree){if(entry.sha===null)next.delete(entry.path);else next.set(entry.path,entry);}const sha=`tree-${++treeNo}`;trees.set(sha,[...next.values()]);return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/commits')&&method==='POST'){const b=JSON.parse(init.body),sha=`commit-${++commitNo}`;commits.set(sha,b.tree);return jsonResponse({sha});}
    if(url.pathname.endsWith('/git/refs/heads/main')&&method==='PATCH'){const b=JSON.parse(init.body);assert.equal(b.force,false);head=b.sha;return jsonResponse({object:{sha:head}});}
    return jsonResponse({message:`unmocked ${method} ${url.pathname}`},500);
  };return {mock,products};
}
const webp=btoa(String.fromCharCode(...Uint8Array.of(82,73,70,70,12,0,0,0,87,69,66,80,1,2,3,4))),variants={full:webp,medium:webp,thumbnail:webp};

test('OAuth uses state and PKCE and allowlists the immutable numeric GitHub user ID',async()=>{
  const accepted=await loginAs();assert.equal(accepted.callback.status,302);assert.match(accepted.callback.headers.get('Location'),/login=success/);assert.ok(sessionFrom(accepted.cookies));
  const denied=await loginAs('999999');assert.equal(denied.callback.status,302);assert.match(denied.callback.headers.get('Location'),/error=unauthorized/);assert.equal(sessionFrom(denied.cookies),undefined);
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('bad state must stop before code exchange');};try{const start=await worker.fetch(req('/auth/login'),env),cookie=start.headers.get('Set-Cookie').split(';')[0],url=new URL(start.headers.get('Location'));const bad=await worker.fetch(req(`/auth/callback?code=x&state=wrong`,{headers:{Cookie:cookie}}),env);assert.equal(bad.status,400);assert.ok(url.searchParams.get('state'));}finally{globalThis.fetch=old;}
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
    const add=await send({operation:'upsert',baseCommitSha:'head-0',product:draft,uploads:[variants]});assert.equal(add.status,200);let result=await add.json();assert.equal(result.products.at(-1).id,'10009');assert.deepEqual(result.usedRefs.slice(-1),['10009']);assert.equal(result.products.at(-1).images[0],'/images/10009/01.webp');
    const duplicate=await send({operation:'upsert',baseCommitSha:result.commitSha,product:{...draft,name:'Product 1'},uploads:[]});assert.equal(duplicate.status,400);
    const stale=await send({operation:'delete',baseCommitSha:'head-0',id:'10009'});assert.equal(stale.status,409);
    const edit=await send({operation:'upsert',baseCommitSha:result.commitSha,product:{...result.products.at(-1),name:'Updated Pouch'},uploads:[]});assert.equal(edit.status,200);result=await edit.json();assert.equal(result.products.at(-1).name,'Updated Pouch');
    const del=await send({operation:'delete',baseCommitSha:result.commitSha,id:'10009'});assert.equal(del.status,200);result=await del.json();assert.equal(result.products.some(p=>p.id==='10009'),false);assert.ok(result.usedRefs.includes('10009'));
  }finally{globalThis.fetch=old;}
});

test('category management and branding updates commit atomically to GitHub',async()=>{
  const {cookie,csrf}=await auth(),fixture=fakeCatalog(),old=globalThis.fetch;globalThis.fetch=fixture.mock;
  try{
    const send=(path,body)=>worker.fetch(req(path,{method:'POST',headers:{Cookie:cookie,Origin:env.ALLOWED_ORIGIN,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
    const category=await send('/api/categories',{action:'rename',index:0,category:{name:'Home',nameAr:'منزل'},baseCommitSha:'head-0'});assert.equal(category.status,200);let result=await category.json();assert.equal(result.categories[0].name,'Home');
    const settings=await send('/api/settings',{baseCommitSha:result.commitSha,store:{name:'Huda Home',tagline:'Welcome',accent:'#75613e'},contact:{whatsapp:'15551234567',email:'hello@example.com',instagram:'https://instagram.com/huda'},logoUpload:null});assert.equal(settings.status,200);result=await settings.json();assert.equal(result.settings.store.name,'Huda Home');assert.equal(result.settings.contact.email,'hello@example.com');
  }finally{globalThis.fetch=old;}
});

test('online admin has an accessible login and mobile layout; static UI contains no credentials',async()=>{
  const html=await readFile(new URL('../public/admin/index.html',import.meta.url),'utf8'),js=await readFile(new URL('../public/admin/admin.js',import.meta.url),'utf8'),css=await readFile(new URL('../public/admin/admin.css',import.meta.url),'utf8');
  assert.match(html,/name="viewport"/);assert.match(html,/Sign in with GitHub/);assert.match(html,/aria-label="Admin sections"/);assert.match(css,/@media\(max-width:700px\)/);assert.doesNotMatch(js,/gho_[A-Za-z0-9]{10,}|github_pat_/);
});

test('Wrangler preserves Cloudflare dashboard variables and requires the three Worker secrets',async()=>{
  const source=await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'),config=JSON.parse(source);
  assert.equal(config.name,'huda-store-admin');assert.equal(config.main,'worker/index.js');assert.equal(config.keep_vars,true);assert.equal('vars' in config,false);assert.doesNotMatch(source,/REPLACE_WITH/);
  assert.deepEqual([...config.secrets.required].sort(),['GITHUB_APP_PRIVATE_KEY','GITHUB_CLIENT_SECRET','SESSION_SECRET'].sort());
});
