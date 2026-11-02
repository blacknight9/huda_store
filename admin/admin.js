const token = document.querySelector('meta[name="huda-session"]').content;
const $ = selector => document.querySelector(selector);
let state;
let editingImages = [];
let confirmation;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const notify = message => { const toast=$('#toast'); toast.textContent=message; toast.classList.add('show'); setTimeout(()=>toast.classList.remove('show'),3000); };
const api = async (url, body) => {
  const response = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json','X-Huda-Session':token}, body:JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
};
const getState = async () => { const response=await fetch('/api/state'); if(!response.ok) throw new Error('Could not read catalog data'); state=await response.json(); render(); };
const imageSrc = p => p?.images?.[0] || '/images/fallback.svg';
const displayStatus = p => p.visible===false?'<span class="status-pill hidden">Hidden</span>':p.status==='available'?'<span class="status-pill">Available</span>':p.status==='on-request'?'<span class="status-pill request">On request</span>':'<span class="status-pill unavailable">Unavailable</span>';
const row = p => `<article class="product-row"><img src="${esc(imageSrc(p))}" alt="" loading="lazy"><div><span class="title">${esc(p.name)}</span><span class="sub">${esc(p.nameAr)} · Ref ${esc(p.id)}</span></div><span class="category">${esc(p.category)}</span>${displayStatus(p)}<span class="reference">${esc(p.id)}</span><div class="row-actions"><button data-edit="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">Edit</button><button data-toggle="${esc(p.id)}" aria-label="${p.visible===false?'Restore':'Hide'} ${esc(p.name)}">${p.visible===false?'Restore':'Hide'}</button><button class="delete" data-delete="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">Delete</button></div></article>`;
function render() {
  const all=state.products;
  $('#metric-products').textContent=all.filter(p=>p.visible!==false).length;
  $('#metric-categories').textContent=state.categories.length;
  $('#metric-unavailable').textContent=all.filter(p=>p.status==='unavailable').length;
  $('#metric-hidden').textContent=all.filter(p=>p.visible===false).length;
  $('#welcome-title').textContent=`Welcome, ${state.settings.store.name}`;
  const recent=[...all].slice(-5).reverse(); $('#recent-products').innerHTML=recent.length?recent.map(row).join(''):'<div class="empty">No products yet. Add your first product to get started.</div>';
  const query=$('#product-search').value.trim().toLowerCase(); const filter=$('#product-filter').value;
  const shown=all.filter(p=>(filter==='all'||(filter==='visible'?p.visible!==false:p.visible===false))&&(!query||`${p.id} ${p.name} ${p.nameAr} ${p.category}`.toLowerCase().includes(query)));
  $('#all-products').innerHTML=shown.length?shown.map(row).join(''):'<div class="empty">No products match this view.</div>';
  $('#category-list').innerHTML=state.categories.map((c,i)=>`<article class="category-row"><div><b>${esc(c.name)}</b><small>${state.products.filter(p=>p.category===c.name).length} products</small></div><div dir="rtl"><b>${esc(c.nameAr)}</b></div><div class="actions"><button class="button outline" data-category-edit="${i}">Rename</button><button class="button outline" data-category-delete="${i}">Delete</button></div></article>`).join('')||'<div class="empty">No categories yet. Add one to organize products.</div>';
  const select=$('#product-form select[name=category]'); const prior=select.value; select.innerHTML=state.categories.map(c=>`<option value="${esc(c.name)}" data-ar="${esc(c.nameAr)}">${esc(c.name)} · ${esc(c.nameAr)}</option>`).join(''); if(prior)select.value=prior;
  $('#settings-form [name=name]').value=state.settings.store.name||''; $('#settings-form [name=tagline]').value=state.settings.store.tagline||''; $('#settings-form [name=whatsapp]').value=state.settings.contact.whatsapp||''; $('#settings-form [name=email]').value=state.settings.contact.email||''; $('#settings-form [name=instagram]').value=state.settings.contact.instagram||''; $('#settings-form [name=accent]').value=state.settings.store.accent||'#80704f';
  $('#logo-preview').src=state.settings.store.logo||'/images/fallback.svg';
  $('#save-state').classList.toggle('clean',state.dirty===false); $('#save-state').innerHTML=state.dirty===false?'<i></i>Up to date':'<i></i>Local changes';
}
function navigate(view) { document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${view}`)); document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view)); $('#page-title').textContent=({overview:'Overview',products:'Products',categories:'Categories',settings:'Store settings'})[view]||'Overview'; window.scrollTo(0,0); }
function openProduct(p) {
  const form=$('#product-form'); form.reset(); form.elements.id.value=p?.id||''; editingImages=[...(p?.images||[])];
  $('#product-dialog-title').textContent=p?'Edit product':'Add product'; $('#product-ref').textContent=p?`Permanent reference · ${p.id}`:`Next reference · ${state.nextId}`;
  for(const key of ['name','nameAr','category','categoryAr','description','descriptionAr','price','status']) if(p?.[key]!==undefined)form.elements[key].value=p[key];
  form.elements.keywords.value=(p?.keywords||[]).join(', '); form.elements.visible.checked=p?.visible!==false; $('#image-files').value=''; $('#product-message').textContent=''; $('#preview-box').hidden=true;
  renderImagePreview(); $('#product-dialog').showModal(); setTimeout(()=>form.elements.name.focus(),50);
}
function renderImagePreview(files=[...$('#image-files').files]) { const area=$('#image-preview'); const existing=editingImages.map((url,index)=>`<div class="image-tile"><img src="${esc(url)}" alt="Current product image"><button type="button" data-remove-image="${index}" aria-label="Remove image ${index+1}">×</button></div>`).join(''); const pending=files.map(file=>`<img src="${URL.createObjectURL(file)}" alt="Selected image preview">`).join(''); area.innerHTML=existing+pending; }
const fileToData = file => new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read image'));reader.onload=()=>resolve({type:file.type,data:String(reader.result).split(',')[1]});reader.readAsDataURL(file)});
async function saveProduct() {
  const form=$('#product-form'); if(!form.reportValidity())return;
  const button=$('#save-product'); button.disabled=true; button.textContent='Saving…'; $('#product-message').textContent='';
  try {
    const d=new FormData(form), categoryName=d.get('category'), category=state.categories.find(c=>c.name===categoryName);
    const files=[...$('#image-files').files];
    const payload={ id:d.get('id')||undefined, name:d.get('name'),nameAr:d.get('nameAr'),category:categoryName,categoryAr:d.get('categoryAr')||category?.nameAr||'',description:d.get('description'),descriptionAr:d.get('descriptionAr'),keywords:String(d.get('keywords')).split(',').map(x=>x.trim()).filter(Boolean),price:d.get('price')||undefined,status:d.get('status'),visible:form.elements.visible.checked,images:editingImages,uploads:await Promise.all(files.map(fileToData)) };
    const result=await api('/api/product',payload); $('#product-dialog').close(); await getState(); notify(`Saved product ${result.product.id} locally`);
  } catch(error) { $('#product-message').textContent=error.message; }
  finally { button.disabled=false; button.textContent='Save product'; }
}
function ask(title,copy,actionLabel,action) { $('#confirm-title').textContent=title;$('#confirm-copy').textContent=copy;$('#confirm-action').textContent=actionLabel;confirmation=action;$('#confirm-dialog').showModal(); }
document.addEventListener('click',async event=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.dataset.view){navigate(button.dataset.view);return;}
  if(button.dataset.action==='add'){openProduct();return;}
  if(button.dataset.edit){openProduct(state.products.find(p=>p.id===button.dataset.edit));return;}
  if(button.dataset.removeImage!==undefined){editingImages.splice(Number(button.dataset.removeImage),1);renderImagePreview();return;}
  if(button.dataset.toggle){const p=state.products.find(x=>x.id===button.dataset.toggle);try{await api('/api/product',{...p,visible:p.visible===false});await getState();notify(p.visible===false?'Product restored':'Product hidden from storefront');}catch(e){notify(e.message)}return;}
  if(button.dataset.delete){const p=state.products.find(x=>x.id===button.dataset.delete);ask(`Delete ${p.name}?`,'The product images will be removed. Its reference number will remain reserved permanently.','Delete product',async()=>{await api('/api/delete',{id:p.id});await getState();notify('Product deleted');});return;}
  if(button.id==='add-category'){const name=prompt('Category name in English');if(name===null)return;const nameAr=prompt('Category name in Arabic');if(nameAr===null)return;try{await api('/api/category',{action:'add',category:{name,nameAr}});await getState();notify('Category added');}catch(e){notify(e.message)}return;}
  if(button.dataset.categoryEdit!==undefined){const c=state.categories[Number(button.dataset.categoryEdit)];const name=prompt('Edit English name',c.name);if(name===null)return;const nameAr=prompt('Edit Arabic name',c.nameAr);if(nameAr===null)return;try{await api('/api/category',{action:'rename',index:Number(button.dataset.categoryEdit),category:{name,nameAr}});await getState();notify('Category renamed');}catch(e){notify(e.message)}return;}
  if(button.dataset.categoryDelete!==undefined){const c=state.categories[Number(button.dataset.categoryDelete)];ask(`Delete ${c.name}?`,'Categories with assigned products must be reassigned before they can be deleted.','Delete category',async()=>{await api('/api/category',{action:'delete',index:Number(button.dataset.categoryDelete)});await getState();notify('Category deleted');});return;}
  if(button.id==='confirm-action'){try{await confirmation?.();$('#confirm-dialog').close();}catch(e){notify(e.message)}return;}
  if(button.matches('[data-close]')){button.closest('dialog').close();return;}
  if(button.id==='preview-product'){const f=$('#product-form');if(!f.reportValidity())return;const name=esc(f.elements.name.value),nameAr=esc(f.elements.nameAr.value),desc=esc(f.elements.description.value),category=esc(f.elements.category.value);$('#preview-box').innerHTML=`<span class="eyebrow">STOREFRONT PREVIEW · REF ${esc(f.elements.id.value||state.nextId)}</span><h3>${name}</h3><p dir="rtl">${nameAr}</p><p>${category} · ${esc(f.elements.status.selectedOptions[0].text)}</p><p>${desc}</p>`;$('#preview-box').hidden=false;return;}
  if(button.id==='save-product'){await saveProduct();return;}
  if(button.id==='publish'||button.hasAttribute('data-publish')){const changes=state.changes?.length?state.changes.slice(0,8).join('\n'):'Catalog files ready to stage';const extra=state.changes?.length>8?`\n…and ${state.changes.length-8} more changed files`:'';ask('Review before publishing',`${changes}${extra}\n\nThis commits local project changes and pushes the current branch to origin. That push starts the GitHub Pages deployment workflow.`,'Publish to GitHub',async()=>{const publishButton=$('#publish');publishButton.disabled=true;publishButton.textContent='Publishing…';try{const result=await api('/api/publish',{});await getState();notify(result.message||'Changes pushed to GitHub');}catch(e){notify(e.message)}finally{publishButton.disabled=false;publishButton.innerHTML='<span>↑</span> Publish to GitHub';}});return;}
});
$('#image-files').addEventListener('change',e=>renderImagePreview([...e.target.files]));
$('#product-form select[name=category]').addEventListener('change',e=>{const selected=e.target.selectedOptions[0];if(selected)$('#product-form').elements.categoryAr.value=selected.dataset.ar||'';});
$('#product-search').addEventListener('input',render);$('#product-filter').addEventListener('change',render);
$('#settings-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type=submit]');button.disabled=true;$('#settings-message').textContent='';try{let logo=state.settings.store.logo;const file=$('#logo-file').files[0];if(file)logo=(await api('/api/logo',{image:await fileToData(file)})).logo;const settings={store:{name:form.elements.name.value,tagline:form.elements.tagline.value,logo,accent:form.elements.accent.value},contact:{whatsapp:form.elements.whatsapp.value,email:form.elements.email.value,instagram:form.elements.instagram.value},categories:state.categories};await api('/api/settings',settings);await getState();$('#settings-message').textContent='Settings saved locally.';notify('Store settings saved locally');}catch(e){$('#settings-message').textContent=e.message;}finally{button.disabled=false;}});
document.addEventListener('keydown',event=>{if(event.key==='Escape')return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();navigate('products');$('#product-search').focus();}});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.view)));
getState().catch(error=>notify(error.message));
