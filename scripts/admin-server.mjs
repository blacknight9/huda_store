import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readState, saveProduct, deleteProduct, saveSettings, saveLogo, manageCategory } from './admin-core.mjs';
import { publishProject } from './publish.mjs';

const root = process.cwd();
const port = Number(process.env.HUDA_ADMIN_PORT || 4179);
const token = randomBytes(32).toString('hex');
const host = `127.0.0.1:${port}`;
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon' };
const server = createServer(async (req, res) => {
  const headers = { 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store', 'Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", 'Cross-Origin-Resource-Policy':'same-origin' };
  const send = (status, body, type='application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type':type }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
  if (req.headers.host !== host) return send(403, { error:'Local admin accepts connections only on its loopback address.' });
  const url = new URL(req.url, `http://${host}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
    try { const html = (await readFile(path.join(root,'admin/index.html'),'utf8')).replace('__HUDA_SESSION__', token); return send(200, html, 'text/html; charset=utf-8'); }
    catch { return send(500, { error:'Admin interface files are missing.' }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/admin/')) {
    const file = path.resolve(root, url.pathname.slice(1));
    if (!file.startsWith(path.join(root,'admin') + path.sep)) return send(404,{error:'Not found'});
    try { const info = await stat(file); if (!info.isFile()) return send(404,{error:'Not found'}); return send(200, await readFile(file), mime[path.extname(file)] || 'application/octet-stream'); }
    catch { return send(404,{error:'Not found'}); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
    const file = path.resolve(root, 'public', `.${url.pathname}`);
    if (!file.startsWith(path.join(root,'public/images') + path.sep)) return send(404,{error:'Not found'});
    try { const body=await readFile(file); const ext=path.extname(file); return send(200,body,ext==='.webp'?'image/webp':ext==='.svg'?'image/svg+xml':'application/octet-stream'); }
    catch { return send(404,{error:'Image not found'}); }
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await readState(root));
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(404,{error:'Not found'});
  if (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') return send(403,{error:'Cross-origin requests are blocked.'});
  const supplied = Buffer.from(String(req.headers['x-huda-session'] || ''));
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401,{error:'Admin session expired. Restart the local admin.'});
  try {
    let raw=''; for await (const chunk of req) { raw += chunk; if (raw.length > 40_000_000) throw new Error('Request is too large'); }
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/api/product') return send(200,{product:await saveProduct(root,body)});
    if (url.pathname === '/api/delete') { await deleteProduct(root,String(body.id)); return send(200,{ok:true}); }
    if (url.pathname === '/api/settings') return send(200,{settings:await saveSettings(root,body)});
    if (url.pathname === '/api/category') return send(200,{categories:await manageCategory(root,body)});
    if (url.pathname === '/api/logo') return send(200,{logo:await saveLogo(root,body.image)});
    if (url.pathname === '/api/publish') return send(200,{ok:true,message:await publishProject(root)});
    return send(404,{error:'Unknown admin action'});
  } catch (error) { return send(400,{error:error.message || 'Request failed.'}); }
});
server.listen(port,'127.0.0.1',()=>{ console.log(`Huda Store local admin: http://${host}/admin`); console.log('Only this computer can connect. Press Ctrl+C to stop.'); });
