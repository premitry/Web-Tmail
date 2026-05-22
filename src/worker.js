
const DEFAULT_SETTINGS = {
  app_name: 'Parciv Tmail',
  logo_url: 'https://i.ibb.co.com/1tNtxMjH/image.png',
  favicon_url: 'https://i.ibb.co.com/1tNtxMjH/image.png',
  primary_color: '#14b8a6',
  accent_color: '#8b5cf6',
  default_language: 'id',
  admin_username: 'admin',
  admin_password_hash: '',
  delete_after_days: '7',
  emergency_cleanup_enabled: '1',
  storage_warning_percent: '80',
  storage_danger_percent: '95',
  attachments_enabled: '0',
  turnstile_enabled: '0',
  turnstile_site_key: '',
  turnstile_secret_key: '',
  otp_detector_enabled: '1',
  captcha_on_generate: '0',
  forbidden_username_enabled: '1',
  forbidden_usernames: 'admin,support,noreply,owner,billing,api,security,abuse,postmaster',
  custom_min_length: '4',
  custom_max_length: '32',
  auto_refresh_seconds: '5',
  cookie_notice_enabled: '0',
  sound_enabled: '0',
  web_domain: 'domain.com',
  api_domain: 'api.domain.com'
};

const WORDS_A = ['nova','river','lunar','mika','sky','pixel','alpha','green','happy','soft','blue','swift','orbit','silver','maple','clear','tiny','brave','fresh','urban','daily','prime','mango','cedar','bright','calm','ocean','cloud','terra','quick'];
const WORDS_B = ['mail','fox','leaf','bird','note','box','star','desk','line','wave','mint','hub','post','loop','nest','path','room','light','drop','byte','flow','peak','dock','moon','code'];

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      await ensureAdminPassword(env);
      if (url.pathname.startsWith('/api/v1/')) return apiRouter(request, env);
      if (url.pathname.startsWith('/api/')) return webApiRouter(request, env);
      if (url.pathname.startsWith('/admin')) return adminRouter(request, env);
      return htmlResponse(await renderApp(env));
    } catch (err) {
      return json({ error: 'server_error', message: String(err?.message || err) }, 500);
    }
  },
  async email(message, env, ctx) {
    ctx.waitUntil(handleIncomingEmail(message, env));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  }
};

async function ensureAdminPassword(env) {
  const s = await getSettings(env);
  if (!s.admin_password_hash) {
    await setSetting(env, 'admin_password_hash', await sha256('admin'));
  }
}

async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key,value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows.results || []) out[r.key] = r.value;
  return out;
}
async function setSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, String(value ?? '')).run();
}
async function logActivity(env, type, title, description='') {
  await env.DB.prepare('INSERT INTO activities(type,title,description) VALUES(?,?,?)').bind(type,title,description).run();
}
function json(data, status=200, headers={}) { return new Response(JSON.stringify(data), { status, headers: { 'content-type':'application/json; charset=utf-8', ...headers } }); }
function htmlResponse(html, status=200) { return new Response(html, { status, headers: { 'content-type':'text/html; charset=utf-8' } }); }
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
async function sha256(text) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function token(len=32) { const a = new Uint8Array(len); crypto.getRandomValues(a); return [...a].map(x=>(x%36).toString(36)).join(''); }
function maskEmail(email='') { const [u,d] = email.split('@'); if (!u || !d) return email; return `${u.slice(0,3)}***@${d}`; }
function validUsername(u, settings) { const min = Number(settings.custom_min_length || 4), max = Number(settings.custom_max_length || 32); return new RegExp(`^[a-z0-9._-]{${min},${max}}$`).test(u); }
function readableUsername() { const a = WORDS_A[Math.floor(Math.random()*WORDS_A.length)]; const b = WORDS_B[Math.floor(Math.random()*WORDS_B.length)]; const n = Math.floor(Math.random()*90)+10; return Math.random() > .5 ? `${a}${b}${n}` : `${a}.${b}${n}`; }
async function pickDomain(env) { const r = await env.DB.prepare('SELECT domain FROM domains WHERE active=1 ORDER BY RANDOM() LIMIT 1').first(); return r?.domain || (await getSettings(env)).web_domain; }
async function verifyTurnstile(request, env, settings, tokenValue) {
  if (settings.turnstile_enabled !== '1' || settings.captcha_on_generate !== '1') return true;
  if (!tokenValue || !settings.turnstile_secret_key) return false;
  const form = new FormData();
  form.append('secret', settings.turnstile_secret_key); form.append('response', tokenValue);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method:'POST', body:form });
  const data = await res.json();
  return !!data.success;
}
async function createInbox(env, username, domain) {
  const t = token(40);
  const email = `${username}@${domain}`;
  await env.DB.prepare('INSERT INTO inboxes(email,username,domain,token) VALUES(?,?,?,?)').bind(email,username,domain,t).run();
  return { email, token: t };
}
async function webApiRouter(request, env) {
  const url = new URL(request.url); const settings = await getSettings(env);
  if (url.pathname === '/api/config') {
    const domains = await env.DB.prepare('SELECT domain FROM domains WHERE active=1 ORDER BY domain').all();
    return json({ appName:settings.app_name, logoUrl:settings.logo_url, faviconUrl:settings.favicon_url, primaryColor:settings.primary_color, accentColor:settings.accent_color, lang:settings.default_language, domains: domains.results?.map(d=>d.domain)||[], autoRefreshSeconds:Number(settings.auto_refresh_seconds||5), turnstileEnabled: settings.turnstile_enabled==='1' && settings.captcha_on_generate==='1', turnstileSiteKey: settings.turnstile_site_key });
  }
  if (url.pathname === '/api/create' && request.method === 'POST') {
    const body = await readJson(request);
    if (!await verifyTurnstile(request, env, settings, body.turnstileToken)) return json({ error:'captcha_failed' }, 403);
    const domain = body.domain && (await isDomainActive(env, body.domain)) ? body.domain : await pickDomain(env);
    let username = String(body.username || '').toLowerCase().trim();
    if (!username) username = readableUsername();
    if (!validUsername(username, settings)) return json({ error:'invalid_username', message:`Username must be ${settings.custom_min_length}-${settings.custom_max_length} chars: a-z, 0-9, dot, underscore, dash.` }, 400);
    if (settings.forbidden_username_enabled === '1' && settings.forbidden_usernames.split(',').map(x=>x.trim()).includes(username)) return json({ error:'reserved_username' }, 400);
    try { const inbox = await createInbox(env, username, domain); await logActivity(env,'inbox','Inbox created',maskEmail(inbox.email)); return json(inbox); }
    catch { return json({ error:'email_taken' }, 409); }
  }
  if (url.pathname === '/api/inbox' && request.method === 'GET') {
    const tokenValue = url.searchParams.get('token') || '';
    const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE token=?').bind(tokenValue).first();
    if (!inbox) return json({ error:'not_found' }, 404);
    await env.DB.prepare('UPDATE inboxes SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?').bind(inbox.id).run();
    const messages = await env.DB.prepare('SELECT id,sender,recipient,subject,text_body,html_body,otp,has_attachment,size_bytes,created_at FROM messages WHERE inbox_id=? ORDER BY id DESC LIMIT 50').bind(inbox.id).all();
    return json({ email: inbox.email, token: inbox.token, messages: messages.results || [] });
  }
  return json({ error:'not_found' }, 404);
}
async function isDomainActive(env, domain) { const r = await env.DB.prepare('SELECT 1 FROM domains WHERE domain=? AND active=1').bind(domain).first(); return !!r; }

async function requireApiKey(request, env) {
  const h = request.headers.get('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) return null;
  const hash = await sha256(key);
  const row = await env.DB.prepare('SELECT id FROM api_keys WHERE key_hash=?').bind(hash).first();
  if (!row) return null;
  await env.DB.prepare('UPDATE api_keys SET last_used_at=CURRENT_TIMESTAMP WHERE id=?').bind(row.id).run();
  return row;
}
async function apiRouter(request, env) {
  const auth = await requireApiKey(request, env); if (!auth) return json({ error:'unauthorized', message:'Valid API key required.' }, 403);
  const url = new URL(request.url); const settings = await getSettings(env);
  if (url.pathname === '/api/v1/inboxes' && request.method === 'POST') {
    const body = await readJson(request); const domain = body.domain && await isDomainActive(env, body.domain) ? body.domain : await pickDomain(env);
    let username = String(body.username || readableUsername()).toLowerCase().trim();
    if (!validUsername(username, settings)) return json({ error:'invalid_username' }, 400);
    try { return json(await createInbox(env, username, domain)); } catch { return json({ error:'email_taken' }, 409); }
  }
  const m = url.pathname.match(/^\/api\/v1\/inboxes\/([^/]+)(?:\/(messages|otp))?$/);
  if (m && request.method === 'GET') {
    const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE token=?').bind(m[1]).first(); if (!inbox) return json({ error:'not_found' }, 404);
    const messages = await env.DB.prepare('SELECT id,sender,recipient,subject,text_body,otp,created_at FROM messages WHERE inbox_id=? ORDER BY id DESC LIMIT 50').bind(inbox.id).all();
    if (m[2] === 'otp') return json({ email: inbox.email, otp: messages.results?.find(x=>x.otp)?.otp || null });
    return json({ email: inbox.email, token: inbox.token, messages: messages.results || [] });
  }
  if (m && request.method === 'DELETE') { await env.DB.prepare('DELETE FROM inboxes WHERE token=?').bind(m[1]).run(); return json({ ok:true }); }
  return json({ error:'not_found' }, 404);
}

async function adminAuth(request, env) {
  const settings = await getSettings(env); const cookie = request.headers.get('cookie') || '';
  const sess = cookie.match(/pt_admin=([^;]+)/)?.[1];
  if (sess && sess === await sha256(settings.admin_username + ':' + settings.admin_password_hash)) return true;
  return false;
}
async function adminRouter(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/admin/login' && request.method === 'POST') {
    const body = await readJson(request); const s = await getSettings(env);
    if (body.username === s.admin_username && await sha256(body.password || '') === s.admin_password_hash) {
      const v = await sha256(s.admin_username + ':' + s.admin_password_hash);
      return json({ ok:true }, 200, { 'set-cookie': `pt_admin=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` });
    }
    return json({ error:'invalid_login' }, 403);
  }
  if (url.pathname === '/admin/logout') return json({ ok:true }, 200, { 'set-cookie':'pt_admin=; Path=/; Max-Age=0' });
  if (!await adminAuth(request, env)) return htmlResponse(renderAdminLogin(), 200);
  if (url.pathname === '/admin/data') return json(await adminData(env));
  if (url.pathname === '/admin/settings' && request.method === 'POST') {
    const body = await readJson(request);
    const allowed = Object.keys(DEFAULT_SETTINGS).filter(k => !['admin_password_hash'].includes(k));
    for (const k of allowed) if (body[k] !== undefined) await setSetting(env,k,body[k]);
    await logActivity(env,'settings','Settings updated','Admin changed system settings');
    return json({ ok:true });
  }
  if (url.pathname === '/admin/account' && request.method === 'POST') {
    const b = await readJson(request); if (b.username) await setSetting(env,'admin_username',b.username); if (b.password) await setSetting(env,'admin_password_hash',await sha256(b.password));
    await logActivity(env,'security','Admin account updated','Username/password changed'); return json({ ok:true });
  }
  if (url.pathname === '/admin/domain' && request.method === 'POST') { const b=await readJson(request); await env.DB.prepare('INSERT OR IGNORE INTO domains(domain,active) VALUES(?,1)').bind(b.domain).run(); return json({ok:true}); }
  if (url.pathname === '/admin/domain' && request.method === 'PATCH') { const b=await readJson(request); await env.DB.prepare('UPDATE domains SET active=? WHERE id=?').bind(b.active?1:0,b.id).run(); return json({ok:true}); }
  if (url.pathname === '/admin/domain' && request.method === 'DELETE') { const b=await readJson(request); await env.DB.prepare('DELETE FROM domains WHERE id=?').bind(b.id).run(); return json({ok:true}); }
  if (url.pathname === '/admin/apikey' && request.method === 'POST') { const b=await readJson(request); const k='pcv_live_'+token(34); await env.DB.prepare('INSERT INTO api_keys(name,key_hash,key_preview) VALUES(?,?,?)').bind(b.name||'API Key', await sha256(k), k.slice(0,14)+'...').run(); return json({ key:k }); }
  if (url.pathname === '/admin/apikey' && request.method === 'DELETE') { const b=await readJson(request); await env.DB.prepare('DELETE FROM api_keys WHERE id=?').bind(b.id).run(); return json({ok:true}); }
  if (url.pathname === '/admin/cleanup' && request.method === 'POST') return json(await runCleanup(env));
  return htmlResponse(await renderAdmin(env));
}
async function adminData(env) {
  const [s, domains, keys, acts, inboxCount, msgCount, todayCount] = await Promise.all([
    getSettings(env), env.DB.prepare('SELECT * FROM domains ORDER BY domain').all(), env.DB.prepare('SELECT id,name,key_preview,created_at,last_used_at FROM api_keys ORDER BY id DESC').all(), env.DB.prepare('SELECT * FROM activities ORDER BY id DESC LIMIT 30').all(), env.DB.prepare('SELECT COUNT(*) c FROM inboxes').first(), env.DB.prepare('SELECT COUNT(*) c FROM messages').first(), env.DB.prepare("SELECT COUNT(*) c FROM messages WHERE created_at >= datetime('now','-1 day')").first()
  ]);
  return { settings:s, domains:domains.results||[], apiKeys:keys.results||[], activities:acts.results||[], stats:{ inboxes:inboxCount.c, messages:msgCount.c, today:todayCount.c } };
}

async function handleIncomingEmail(message, env) {
  const to = message.to.toLowerCase(); const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE email=?').bind(to).first();
  if (!inbox) return;
  const raw = await new Response(message.raw).text();
  const subject = raw.match(/^Subject:\s*(.*)$/mi)?.[1]?.trim() || '(no subject)';
  const from = raw.match(/^From:\s*(.*)$/mi)?.[1]?.trim() || message.from || '';
  const text = stripHeaders(raw).slice(0, 60000);
  const settings = await getSettings(env); const otp = settings.otp_detector_enabled === '1' ? extractOtp(subject + '\n' + text) : null;
  await env.DB.prepare('INSERT INTO messages(inbox_id,message_uid,sender,recipient,subject,text_body,otp,size_bytes) VALUES(?,?,?,?,?,?,?,?)').bind(inbox.id, token(24), from, to, subject, text, otp, raw.length).run();
  await env.DB.prepare('UPDATE inboxes SET message_count=message_count+1,last_seen_at=CURRENT_TIMESTAMP WHERE id=?').bind(inbox.id).run();
  await logActivity(env,'mail','Message received',`${maskEmail(to)}${otp ? ' - OTP detected' : ''}`);
}
function stripHeaders(raw) { const idx = raw.indexOf('\r\n\r\n'); if (idx >= 0) return raw.slice(idx+4); const idx2 = raw.indexOf('\n\n'); return idx2 >= 0 ? raw.slice(idx2+2) : raw; }
function extractOtp(text) { if (!/(otp|code|kode|verification|verifikasi|security|login|passcode)/i.test(text)) return null; return text.match(/\b\d{4,8}\b/)?.[0] || null; }
async function runCleanup(env) {
  const s = await getSettings(env); const days = Math.max(1, Number(s.delete_after_days || 7));
  const r = await env.DB.prepare("DELETE FROM messages WHERE created_at < datetime('now', ?)").bind(`-${days} days`).run();
  await env.DB.prepare("DELETE FROM inboxes WHERE id NOT IN (SELECT DISTINCT inbox_id FROM messages) AND created_at < datetime('now', ?)").bind(`-${days} days`).run();
  await logActivity(env,'cleanup','Cleanup completed',`Removed expired messages older than ${days} day(s)`);
  return { ok:true, deleteAfterDays:days, changes:r.meta?.changes || 0 };
}

async function renderApp(env) { const s = await getSettings(env); return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${s.app_name}</title><link rel="icon" href="${s.favicon_url}"><style>${css()}</style></head><body><div id="app"></div><script>${clientJs()}</script></body></html>`; }
function css(){return `:root{--bg:#080b12;--panel:#101624;--muted:#8d99ae;--text:#edf2f7;--line:#1f2937;--pri:#14b8a6;--acc:#8b5cf6}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#102138,#080b12 45%);font-family:Inter,ui-sans-serif,system-ui,Arial;color:var(--text)}button,input,select{font:inherit}button{cursor:pointer;border:0;border-radius:12px;padding:11px 14px;background:linear-gradient(135deg,var(--pri),var(--acc));color:white;font-weight:700}.ghost{background:#172033;color:#dbeafe;border:1px solid #263246}.wrap{max-width:1180px;margin:auto;padding:24px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.brand{display:flex;align-items:center;gap:12px}.brand img{height:42px;max-width:180px;object-fit:contain}.grid{display:grid;grid-template-columns:360px 1fr;gap:18px}.card{background:rgba(16,22,36,.86);border:1px solid #1e293b;border-radius:22px;padding:18px;box-shadow:0 20px 50px #0005}.emailbox{font-size:20px;font-weight:800;word-break:break-all;margin:12px 0}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.input{width:100%;background:#0b1220;border:1px solid #22304a;border-radius:12px;color:white;padding:12px}.hint{color:var(--muted);font-size:13px}.list{display:flex;flex-direction:column;gap:10px}.msg{padding:13px;border:1px solid #243047;border-radius:16px;background:#0b1220}.msg small{color:var(--muted)}.otp{font-size:24px;font-weight:900;color:#5eead4}.viewer{white-space:pre-wrap;color:#cbd5e1;max-height:520px;overflow:auto}.tabs button{background:#111827;border:1px solid #253044}.admin{display:grid;grid-template-columns:240px 1fr;min-height:100vh}.side{background:#080d18;border-right:1px solid #1e293b;padding:18px;position:sticky;top:0;height:100vh}.nav button{display:block;width:100%;margin:7px 0;background:transparent;text-align:left;border:1px solid transparent}.nav button.active{background:#111c2f;border-color:#263854}.adminmain{padding:24px}.table{width:100%;border-collapse:collapse}.table td,.table th{border-bottom:1px solid #243047;padding:10px;text-align:left}.hide{display:none}@media(max-width:800px){.grid,.admin{grid-template-columns:1fr}.side{position:relative;height:auto}.wrap{padding:14px}}`;}
function clientJs(){return `let cfg={},cur=null,sel=null,timer=null;const $=s=>document.querySelector(s);const h=(t)=>String(t||'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));async function j(u,o){let r=await fetch(u,{headers:{'content-type':'application/json'},...o});return r.json()}async function init(){cfg=await j('/api/config');document.documentElement.style.setProperty('--pri',cfg.primaryColor);document.documentElement.style.setProperty('--acc',cfg.accentColor);let recent=JSON.parse(localStorage.pt_recent||'[]');document.querySelector('#app').innerHTML='<div class="wrap"><div class="top"><div class="brand"><img src="'+cfg.logoUrl+'"><b>'+cfg.appName+'</b></div><a class="hint" href="/admin">Admin</a></div><div class="grid"><div class="card"><h2>Temporary inbox</h2><p class="hint">Email otomatis dibersihkan berdasarkan kebijakan sistem.</p><div id="email" class="emailbox">Klik generate</div><div class="row"><button onclick="create()">Generate</button><button class="ghost" onclick="copyEmail()">Copy</button><button class="ghost" onclick="refresh()">Refresh</button></div><hr style="border-color:#22304a"><h3>Custom email</h3><input id="custom" class="input" placeholder="nama-email"><select id="domain" class="input" style="margin-top:8px">'+cfg.domains.map(d=>'<option>'+d+'</option>').join('')+'</select><button style="margin-top:8px" class="ghost" onclick="createCustom()">Apply Custom</button><h3>Recent inbox</h3><div id="recent" class="list">'+recent.map(x=>'<button class="ghost" onclick="openRecent(\\''+x.token+'\\')">'+h(x.email)+'</button>').join('')+'</div></div><div class="card"><div class="row" style="justify-content:space-between"><h2>Inbox</h2><span class="hint">Auto refresh '+cfg.autoRefreshSeconds+'s</span></div><div id="messages" class="list"></div><hr style="border-color:#22304a"><div id="viewer" class="viewer hint">Pilih email untuk membaca.</div></div></div></div>'}function saveRecent(){if(!cur)return;let r=JSON.parse(localStorage.pt_recent||'[]').filter(x=>x.token!==cur.token);r.unshift({email:cur.email,token:cur.token});localStorage.pt_recent=JSON.stringify(r.slice(0,6))}async function create(username){let body={};if(username)body.username=username;body.domain=$('#domain')?.value;let d=await j('/api/create',{method:'POST',body:JSON.stringify(body)});if(d.email){cur=d;saveRecent();$('#email').textContent=d.email;refresh();start()}else alert(d.message||d.error)}function createCustom(){create($('#custom').value.trim())}function openRecent(t){cur={token:t,email:'Loading...'};refresh();start()}function start(){clearInterval(timer);timer=setInterval(refresh,(cfg.autoRefreshSeconds||5)*1000)}async function refresh(){if(!cur)return;let d=await j('/api/inbox?token='+cur.token);if(d.email){cur.email=d.email;$('#email').textContent=d.email;saveRecent();$('#messages').innerHTML=(d.messages||[]).map((m,i)=>'<div class="msg" onclick="showMsg('+i+')"><b>'+h(m.subject)+'</b><br><small>'+h(m.sender)+' • '+h(m.created_at)+'</small>'+(m.otp?'<div class="otp">OTP '+h(m.otp)+'</div>':'')+'</div>').join('')||'<p class="hint">Belum ada email masuk.</p>';window.msgs=d.messages||[]}}function showMsg(i){let m=window.msgs[i];$('#viewer').innerHTML='<h2>'+h(m.subject)+'</h2>'+(m.otp?'<div class="otp">'+h(m.otp)+' <button onclick="navigator.clipboard.writeText(\\''+m.otp+'\\')">Copy OTP</button></div>':'')+'<p class="hint">From: '+h(m.sender)+'</p><pre>'+h(m.text_body||'')+'</pre>'}function copyEmail(){if(cur?.email)navigator.clipboard.writeText(cur.email)}init();`;}
function renderAdminLogin(){return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style></head><body><div class="wrap" style="max-width:420px"><div class="card"><h1>Parciv Admin</h1><p class="hint">Default: admin / admin. Ganti setelah login.</p><input id="u" class="input" placeholder="username" value="admin"><br><br><input id="p" class="input" type="password" placeholder="password" value="admin"><br><br><button onclick="login()">Login</button><p id="e" class="hint"></p></div></div><script>async function login(){let r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,password:p.value})});if(r.ok)location='/admin';else e.textContent='Login gagal'}</script></body></html>`;}
async function renderAdmin(env){return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style></head><body><div id="app"></div><script>${adminJs()}</script></body></html>`;}
function adminJs(){return `let data,tab='Dashboard',sub='Branding';const menus=['Dashboard','Domains','Storage','Security','Features','Appearance Settings','Developer Hub','Activity','System'];async function api(u,o){let r=await fetch(u,{headers:{'content-type':'application/json'},...o});return r.json()}async function load(){data=await api('/admin/data');render()}function render(){document.querySelector('#app').innerHTML='<div class="admin"><aside class="side"><h2>Parciv Tmail</h2><div class="nav">'+menus.map(m=>'<button class="'+(tab==m?'active':'')+'" onclick="tab=\\''+m+'\\';render()">'+m+'</button>').join('')+'</div><button class="ghost" onclick="fetch(\\'/admin/logout\\').then(()=>location.reload())">Logout</button></aside><main class="adminmain">'+page()+'</main></div>'}function page(){let s=data.settings;if(tab==='Dashboard')return '<h1>Dashboard</h1><div class="grid"><div class="card"><h3>Active inboxes</h3><h1>'+data.stats.inboxes+'</h1></div><div class="card"><h3>Total messages</h3><h1>'+data.stats.messages+'</h1></div><div class="card"><h3>Email today</h3><h1>'+data.stats.today+'</h1></div></div><div class="card"><h2>System Health</h2><p>Mail Routing: Active when Email Routing is connected</p><p>Cleanup: '+s.delete_after_days+' day(s)</p></div>';if(tab==='Domains')return '<h1>Domains</h1><div class="card"><input id="d" class="input" placeholder="domain.com"><button onclick="addDomain()">Add</button></div><div class="card"><table class="table"><tr><th>Domain</th><th>Status</th><th>Action</th></tr>'+data.domains.map(d=>'<tr><td>'+d.domain+'</td><td>'+(d.active?'Active':'Off')+'</td><td><button class="ghost" onclick="toggleDomain('+d.id+','+(!d.active)+')">Toggle</button><button class="ghost" onclick="delDomain('+d.id+')">Delete</button></td></tr>').join('')+'</table></div>';if(tab==='Storage')return form('Cleanup & Storage',{delete_after_days:'Delete email after days',emergency_cleanup_enabled:'Emergency Cleanup 1/0',storage_warning_percent:'Warning Percent',storage_danger_percent:'Danger Percent'});if(tab==='Security')return form('Security',{turnstile_enabled:'Turnstile Enabled 1/0',turnstile_site_key:'Turnstile Site Key',turnstile_secret_key:'Turnstile Secret Key',captcha_on_generate:'Captcha on Generate 1/0',forbidden_username_enabled:'Forbidden Username 1/0',forbidden_usernames:'Forbidden Usernames',custom_min_length:'Custom Min Length',custom_max_length:'Custom Max Length'});if(tab==='Features')return form('Features',{otp_detector_enabled:'OTP Detector 1/0',attachments_enabled:'Allow Attachments 1/0',sound_enabled:'Sound Notification 1/0',cookie_notice_enabled:'Cookie Notice 1/0',auto_refresh_seconds:'Auto Refresh Seconds'});if(tab==='Appearance Settings')return appearance();if(tab==='Developer Hub')return '<h1>Developer Hub</h1><div class="card"><p>API Base URL: https://'+s.api_domain+'/api/v1</p><button onclick="newKey()">Generate API Key</button><div id="newkey" class="hint"></div></div><div class="card"><table class="table"><tr><th>Name</th><th>Key</th><th>Created</th><th>Action</th></tr>'+data.apiKeys.map(k=>'<tr><td>'+k.name+'</td><td>'+k.key_preview+'</td><td>'+k.created_at+'</td><td><button class="ghost" onclick="delKey('+k.id+')">Delete</button></td></tr>').join('')+'</table></div>';if(tab==='Activity')return '<h1>Activity Center</h1><div class="card">'+data.activities.map(a=>'<div class="msg"><b>'+a.title+'</b><p>'+a.description+'</p><small>'+a.created_at+'</small></div>').join('')+'</div>';if(tab==='System')return '<h1>System</h1><div class="card"><button onclick="cleanup()">Run Cleanup</button><button class="ghost" onclick="account()">Change Admin Account</button><p class="hint">Worker + D1 + Email Routing. Admin URL: /admin</p></div>';return ''}function form(title,fields){let s=data.settings;return '<h1>'+title+'</h1><div class="card">'+Object.entries(fields).map(([k,l])=>'<label>'+l+'<input class="input" id="'+k+'" value="'+(s[k]||'')+'"></label><br><br>').join('')+'<button onclick="save(['+Object.keys(fields).map(k=>'\\''+k+'\\'').join(',')+'])">Save</button></div>'}function appearance(){let fields=sub==='Branding'?{app_name:'App Name',logo_url:'Logo URL recommended 800x200',favicon_url:'Favicon URL recommended 32x32/64x64',primary_color:'Primary Color',accent_color:'Accent Color'}:sub==='Interface'?{default_language:'Default Language id/en',auto_refresh_seconds:'Auto Refresh Seconds',sound_enabled:'Sound 1/0',cookie_notice_enabled:'Cookie Notice 1/0'}:sub==='Themes'?{primary_color:'Primary Color',accent_color:'Accent Color'}:{default_language:'Default Language',web_domain:'Web Domain',api_domain:'API Domain'};return '<h1>Appearance Settings</h1><div class="tabs">'+['Branding','Interface','Themes','Localization'].map(x=>'<button onclick="sub=\\''+x+'\\';render()">'+x+'</button>').join('')+'</div>'+form(sub,fields)}async function save(keys){let b={};keys.forEach(k=>b[k]=document.getElementById(k).value);await api('/admin/settings',{method:'POST',body:JSON.stringify(b)});await load()}async function addDomain(){await api('/admin/domain',{method:'POST',body:JSON.stringify({domain:d.value})});load()}async function toggleDomain(id,a){await api('/admin/domain',{method:'PATCH',body:JSON.stringify({id,active:a})});load()}async function delDomain(id){await api('/admin/domain',{method:'DELETE',body:JSON.stringify({id})});load()}async function newKey(){let name=prompt('API key name','My App');if(!name)return;let r=await api('/admin/apikey',{method:'POST',body:JSON.stringify({name})});document.getElementById('newkey').textContent='Copy now: '+r.key;load()}async function delKey(id){await api('/admin/apikey',{method:'DELETE',body:JSON.stringify({id})});load()}async function cleanup(){alert(JSON.stringify(await api('/admin/cleanup',{method:'POST'})));load()}async function account(){let username=prompt('New username','admin');let password=prompt('New password');if(password)await api('/admin/account',{method:'POST',body:JSON.stringify({username,password})});alert('Saved, login again after logout.')}load();`;}
