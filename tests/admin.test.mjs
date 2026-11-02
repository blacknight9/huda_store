import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { saveProduct, deleteProduct, readState, manageCategory, saveSettings } from '../scripts/admin-core.mjs';
import { publishProject } from '../scripts/publish.mjs';
const exec=promisify(execFile);
async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'huda-admin-'));
  await mkdir(path.join(root,'src/data'),{recursive:true}); await mkdir(path.join(root,'public/images'),{recursive:true});
  await writeFile(path.join(root,'src/data/products.json'),'[]\n'); await writeFile(path.join(root,'src/data/used-refs.json'),'[]\n');
  await writeFile(path.join(root,'src/data/settings.json'),JSON.stringify({store:{name:'Huda Store',tagline:'',logo:'',accent:'#80704f'},contact:{whatsapp:'',email:'',instagram:''},categories:[]}));
  return root;
}
const image=async()=>({type:'image/png',data:(await sharp({create:{width:12,height:10,channels:3,background:'#9a8765'}}).png().toBuffer()).toString('base64')});
const payload=async extra=>({name:'Linen Pouch',nameAr:'حقيبة كتان',category:'Bags',categoryAr:'حقائب',description:'A small pouch',descriptionAr:'حقيبة صغيرة',keywords:['linen'],status:'available',visible:true,uploads:[await image()],...extra});

test('product add, edit, permanent reference, and delete lifecycle',async t=>{
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const created=await saveProduct(root,await payload());
  assert.equal(created.id,'10001'); assert.match(created.images[0],/^\/images\/10001\/01\.webp$/);
  assert.equal((await readState(root)).products.length,1);
  const edited=await saveProduct(root,{...created,name:'Linen Travel Pouch',uploads:[],images:created.images});
  assert.equal(edited.id,'10001'); assert.equal(edited.name,'Linen Travel Pouch');
  await deleteProduct(root,created.id);
  const state=await readState(root); assert.equal(state.products.length,0); assert.equal(state.nextId,'10002');
});

test('category management updates bilingual product labels and prevents unsafe removal',async t=>{
  const root=await fixture(); t.after(()=>rm(root,{recursive:true,force:true}));
  const created=await saveProduct(root,await payload());
  await manageCategory(root,{action:'rename',index:0,category:{name:'Accessories',nameAr:'إكسسوارات'}});
  assert.equal((await readState(root)).products[0].category,'Accessories');
  await assert.rejects(()=>manageCategory(root,{action:'delete',index:0}),/Move products/);
  await saveSettings(root,{store:{name:'Huda Store'},contact:{},categories:[{name:'Accessories',nameAr:'إكسسوارات'}]});
  await deleteProduct(root,created.id); await manageCategory(root,{action:'delete',index:0});
  assert.equal((await readState(root)).categories.length,0);
});

test('publish stages, commits, and pushes to configured Git remote',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'huda-publish-')); const bare=await mkdtemp(path.join(os.tmpdir(),'huda-remote-'));
  t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(bare,{recursive:true,force:true});});
  const remote=path.join(bare,'remote.git'); await exec('git',['init','--bare',remote]); await exec('git',['init','-b','main'],{cwd:root});
  await exec('git',['config','user.name','Huda Store Test'],{cwd:root}); await exec('git',['config','user.email','huda-test@example.invalid'],{cwd:root});
  await exec('git',['remote','add','origin',remote],{cwd:root}); await writeFile(path.join(root,'catalog.json'),'test product data\n');
  await exec('git',['add','.'],{cwd:root}); await exec('git',['commit','-m','Initial test setup'],{cwd:root}); await exec('git',['push','-u','origin','main'],{cwd:root});
  await writeFile(path.join(root,'catalog.json'),'updated product data\n');
  const output=await publishProject(root); assert.match(output,/main/);
  const {stdout}=await exec('git',['--git-dir',remote,'show','main:catalog.json']); assert.equal(stdout,'updated product data\n');
});

test('local admin rejects unauthorized and cross-origin writes',async t=>{
  const root=await fixture(); await mkdir(path.join(root,'admin'),{recursive:true});
  await writeFile(path.join(root,'admin/index.html'),'<meta name="huda-session" content="__HUDA_SESSION__">');
  const probe=net.createServer(); let port;
  try { await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);}); port=probe.address().port; await new Promise(resolve=>probe.close(resolve)); }
  catch(error) { await rm(root,{recursive:true,force:true}); t.skip(`Sandbox blocks localhost sockets (${error.code})`); return; }
  const server=spawn(process.execPath,[new URL('../scripts/admin-server.mjs',import.meta.url).pathname],{cwd:root,env:{...process.env,HUDA_ADMIN_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));await rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`; let html='';
  for(let i=0;i<40;i++){try{const response=await fetch(`${base}/admin`);if(response.ok){html=await response.text();break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(html.includes('huda-session'),'local admin server should start');
  const token=html.match(/content="([a-f0-9]{64})"/)[1];
  const unauthorized=await fetch(`${base}/api/delete`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({id:'10001'})}); assert.equal(unauthorized.status,401);
  const crossOrigin=await fetch(`${base}/api/delete`,{method:'POST',headers:{Origin:'https://attacker.example','X-Huda-Session':token,'Content-Type':'application/json'},body:JSON.stringify({id:'10001'})}); assert.equal(crossOrigin.status,403);
  const imageData=await image();
  const added=await fetch(`${base}/api/product`,{method:'POST',headers:{Origin:base,'X-Huda-Session':token,'Content-Type':'application/json'},body:JSON.stringify(await payload({uploads:[imageData]}))});
  assert.equal(added.status,200); const result=await added.json(); assert.equal(result.product.id,'10001');
  const removed=await fetch(`${base}/api/delete`,{method:'POST',headers:{Origin:base,'X-Huda-Session':token,'Content-Type':'application/json'},body:JSON.stringify({id:'10001'})}); assert.equal(removed.status,200);
});
