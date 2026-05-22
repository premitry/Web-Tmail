// ==================== PARCIV TMAIL - Cloudflare Worker ====================
const DEFAULT_SETTINGS = {
  app_name: 'Parciv Tmail',
  app_tagline: 'Privacy first temporary email',
  logo_url: 'https://i.ibb.co.com/1tNtxMjH/image.png',
  favicon_url: 'https://i.ibb.co.com/1tNtxMjH/image.png',
  primary_color: '#14b8a6',
  accent_color: '#0d9488',
  bg_color: '#0a0d14',
  panel_color: '#11161f',
  text_color: '#e7ecf3',
  default_theme: 'dark',
  default_language: 'id',
  admin_username: 'admin',
  admin_password_hash: '',
  delete_after_days: '7',
  one_time_inbox_minutes: '10',
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
  api_domain: 'api.domain.com',
  telegram_url: '',
  show_api_button: '1',
  show_telegram_button: '1',
  show_theme_toggle: '1',
  show_how_it_works: '1',
  footer_text: 'Privacy first temporary email service.'
};


const WORDS_A = ['swift','silent','nova','river','lunar','pixel','alpha','green','happy','soft','blue','orbit','silver','maple','clear','tiny','brave','fresh','urban','prime','mango','cedar','bright','calm','ocean','cloud','terra','quick','neon','frost'];
const WORDS_B = ['byte','fox','leaf','bird','note','box','star','desk','line','wave','mint','hub','post','loop','nest','path','room','light','drop','mail','flow','peak','dock','moon','code'];

// ==================== EXPORT ====================
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      await ensureAdminPassword(env);
      if (url.pathname.startsWith('/api/v1/')) return apiRouter(request, env);
      if (url.pathname.startsWith('/api/')) return webApiRouter(request, env);
      if (url.pathname.startsWith('/admin')) return adminRouter(request, env);
      if (url.pathname.startsWith('/inbox/')) return htmlResponse(await renderInboxPage(env, url));
      return htmlResponse(await renderHomePage(env));
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


// ==================== UTILS ====================
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
async function logActivity(env, type, title, description = '') {
  await env.DB.prepare('INSERT INTO activities(type,title,description) VALUES(?,?,?)').bind(type, title, description).run();
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
async function readJson(request) { try { return await request.json(); } catch { return {}; } }
async function sha256(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function token(len = 32) {
  const a = new Uint8Array(len); crypto.getRandomValues(a);
  return [...a].map(x => (x % 36).toString(36)).join('');
}
function maskEmail(email = '') {
  const [u, d] = email.split('@');
  if (!u || !d) return email;
  return u.slice(0, 3) + '***@' + d;
}
function validUsername(u, settings) {
  const min = Number(settings.custom_min_length || 4);
  const max = Number(settings.custom_max_length || 32);
  return new RegExp(`^[a-z0-9._-]{${min},${max}}$`).test(u);
}
function readableUsername() {
  const a = WORDS_A[Math.floor(Math.random() * WORDS_A.length)];
  const b = WORDS_B[Math.floor(Math.random() * WORDS_B.length)];
  const n = Math.floor(Math.random() * 900) + 100;
  return `${a}${b}${n}`;
}
async function pickDomain(env) {
  const r = await env.DB.prepare('SELECT domain FROM domains WHERE active=1 ORDER BY RANDOM() LIMIT 1').first();
  return r?.domain || (await getSettings(env)).web_domain;
}


async function verifyTurnstile(request, env, settings, tokenValue) {
  if (settings.turnstile_enabled !== '1' || settings.captcha_on_generate !== '1') return true;
  if (!tokenValue || !settings.turnstile_secret_key) return false;
  const form = new FormData();
  form.append('secret', settings.turnstile_secret_key);
  form.append('response', tokenValue);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json();
  return !!data.success;
}
async function createInbox(env, username, domain, oneTime = false) {
  const t = token(40);
  const email = `${username}@${domain}`;
  const settings = await getSettings(env);
  const expires = oneTime ? `datetime('now','+${settings.one_time_inbox_minutes || 10} minutes')` : null;
  if (oneTime) {
    await env.DB.prepare(`INSERT INTO inboxes(email,username,domain,token,one_time,expires_at) VALUES(?,?,?,?,1,datetime('now','+${Number(settings.one_time_inbox_minutes)||10} minutes'))`).bind(email, username, domain, t).run();
  } else {
    await env.DB.prepare('INSERT INTO inboxes(email,username,domain,token,one_time) VALUES(?,?,?,?,0)').bind(email, username, domain, t).run();
  }
  return { email, token: t, oneTime };
}
async function isDomainActive(env, domain) {
  const r = await env.DB.prepare('SELECT 1 FROM domains WHERE domain=? AND active=1').bind(domain).first();
  return !!r;
}

// ==================== WEB API ====================
async function webApiRouter(request, env) {
  const url = new URL(request.url);
  const settings = await getSettings(env);

  if (url.pathname === '/api/config') {
    const domains = await env.DB.prepare('SELECT domain FROM domains WHERE active=1 ORDER BY domain').all();
    return json({
      appName: settings.app_name, appTagline: settings.app_tagline,
      logoUrl: settings.logo_url, faviconUrl: settings.favicon_url,
      primaryColor: settings.primary_color, accentColor: settings.accent_color,
      bgColor: settings.bg_color, panelColor: settings.panel_color, textColor: settings.text_color,
      defaultTheme: settings.default_theme, lang: settings.default_language,
      domains: (domains.results || []).map(d => d.domain),
      autoRefreshSeconds: Number(settings.auto_refresh_seconds || 5),
      turnstileEnabled: settings.turnstile_enabled === '1' && settings.captcha_on_generate === '1',
      turnstileSiteKey: settings.turnstile_site_key,
      telegramUrl: settings.telegram_url,
      showApiButton: settings.show_api_button === '1',
      showTelegramButton: settings.show_telegram_button === '1',
      showThemeToggle: settings.show_theme_toggle === '1',
      showHowItWorks: settings.show_how_it_works === '1',
      footerText: settings.footer_text
    });
  }


  if (url.pathname === '/api/create' && request.method === 'POST') {
    const body = await readJson(request);
    if (!await verifyTurnstile(request, env, settings, body.turnstileToken)) return json({ error: 'captcha_failed' }, 403);
    const domain = body.domain && (await isDomainActive(env, body.domain)) ? body.domain : await pickDomain(env);
    let username = String(body.username || '').toLowerCase().trim();
    if (!username) username = readableUsername();
    if (!validUsername(username, settings)) return json({ error: 'invalid_username', message: `Username must be ${settings.custom_min_length}-${settings.custom_max_length} chars: a-z, 0-9, dot, underscore, dash.` }, 400);
    if (settings.forbidden_username_enabled === '1' && settings.forbidden_usernames.split(',').map(x => x.trim()).includes(username)) return json({ error: 'reserved_username' }, 400);
    try {
      const inbox = await createInbox(env, username, domain, !!body.oneTime);
      await logActivity(env, 'inbox', 'Inbox created', maskEmail(inbox.email));
      return json(inbox);
    } catch { return json({ error: 'email_taken' }, 409); }
  }

  if (url.pathname === '/api/inbox' && request.method === 'GET') {
    const tokenValue = url.searchParams.get('token') || '';
    const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE token=?').bind(tokenValue).first();
    if (!inbox) return json({ error: 'not_found' }, 404);
    await env.DB.prepare('UPDATE inboxes SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?').bind(inbox.id).run();
    const messages = await env.DB.prepare('SELECT id,sender,recipient,subject,text_body,html_body,otp,has_attachment,size_bytes,created_at FROM messages WHERE inbox_id=? ORDER BY id DESC LIMIT 50').bind(inbox.id).all();
    return json({ email: inbox.email, token: inbox.token, oneTime: !!inbox.one_time, expiresAt: inbox.expires_at, messages: messages.results || [] });
  }

  if (url.pathname === '/api/lock' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body.token || !body.pin) return json({ error: 'missing_params' }, 400);
    const pinHash = await sha256(body.pin);
    await env.DB.prepare('UPDATE inboxes SET pin_hash=? WHERE token=?').bind(pinHash, body.token).run();
    return json({ ok: true });
  }

  if (url.pathname === '/api/unlock' && request.method === 'POST') {
    const body = await readJson(request);
    const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE token=?').bind(body.token || '').first();
    if (!inbox) return json({ error: 'not_found' }, 404);
    if (!inbox.pin_hash) return json({ ok: true });
    if (await sha256(body.pin || '') !== inbox.pin_hash) return json({ error: 'wrong_pin' }, 403);
    return json({ ok: true });
  }

  return json({ error: 'not_found' }, 404);
}


// ==================== PUBLIC API v1 ====================
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
  const auth = await requireApiKey(request, env);
  if (!auth) return json({ error: 'unauthorized', message: 'Valid API key required.' }, 403);
  const url = new URL(request.url);
  const settings = await getSettings(env);

  if (url.pathname === '/api/v1/inboxes' && request.method === 'POST') {
    const body = await readJson(request);
    const domain = body.domain && await isDomainActive(env, body.domain) ? body.domain : await pickDomain(env);
    let username = String(body.username || readableUsername()).toLowerCase().trim();
    if (!validUsername(username, settings)) return json({ error: 'invalid_username' }, 400);
    try { return json(await createInbox(env, username, domain)); } catch { return json({ error: 'email_taken' }, 409); }
  }
  const m = url.pathname.match(/^\/api\/v1\/inboxes\/([^/]+)(?:\/(messages|otp))?$/);
  if (m && request.method === 'GET') {
    const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE token=?').bind(m[1]).first();
    if (!inbox) return json({ error: 'not_found' }, 404);
    const messages = await env.DB.prepare('SELECT id,sender,recipient,subject,text_body,otp,created_at FROM messages WHERE inbox_id=? ORDER BY id DESC LIMIT 50').bind(inbox.id).all();
    if (m[2] === 'otp') return json({ email: inbox.email, otp: messages.results?.find(x => x.otp)?.otp || null });
    return json({ email: inbox.email, token: inbox.token, messages: messages.results || [] });
  }
  if (m && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM inboxes WHERE token=?').bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}


// ==================== ADMIN ====================
async function adminAuth(request, env) {
  const settings = await getSettings(env);
  const cookie = request.headers.get('cookie') || '';
  const sess = cookie.match(/pt_admin=([^;]+)/)?.[1];
  if (sess && sess === await sha256(settings.admin_username + ':' + settings.admin_password_hash)) return true;
  return false;
}
async function adminRouter(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/admin/login' && request.method === 'POST') {
    const body = await readJson(request);
    const s = await getSettings(env);
    if (body.username === s.admin_username && await sha256(body.password || '') === s.admin_password_hash) {
      const v = await sha256(s.admin_username + ':' + s.admin_password_hash);
      return json({ ok: true }, 200, { 'set-cookie': `pt_admin=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` });
    }
    return json({ error: 'invalid_login' }, 403);
  }
  if (url.pathname === '/admin/logout') return json({ ok: true }, 200, { 'set-cookie': 'pt_admin=; Path=/; Max-Age=0' });
  if (!await adminAuth(request, env)) return htmlResponse(renderAdminLogin());
  if (url.pathname === '/admin/data') return json(await adminData(env));
  if (url.pathname === '/admin/settings' && request.method === 'POST') {
    const body = await readJson(request);
    const allowed = Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'admin_password_hash');
    for (const k of allowed) if (body[k] !== undefined) await setSetting(env, k, body[k]);
    await logActivity(env, 'settings', 'Settings updated', 'Admin changed system settings');
    return json({ ok: true });
  }
  if (url.pathname === '/admin/account' && request.method === 'POST') {
    const b = await readJson(request);
    if (b.username) await setSetting(env, 'admin_username', b.username);
    if (b.password) await setSetting(env, 'admin_password_hash', await sha256(b.password));
    await logActivity(env, 'security', 'Admin account updated', 'Username/password changed');
    return json({ ok: true });
  }
  if (url.pathname === '/admin/domain' && request.method === 'POST') { const b = await readJson(request); await env.DB.prepare('INSERT OR IGNORE INTO domains(domain,active) VALUES(?,1)').bind(b.domain).run(); return json({ ok: true }); }
  if (url.pathname === '/admin/domain' && request.method === 'PATCH') { const b = await readJson(request); await env.DB.prepare('UPDATE domains SET active=? WHERE id=?').bind(b.active ? 1 : 0, b.id).run(); return json({ ok: true }); }
  if (url.pathname === '/admin/domain' && request.method === 'DELETE') { const b = await readJson(request); await env.DB.prepare('DELETE FROM domains WHERE id=?').bind(b.id).run(); return json({ ok: true }); }
  if (url.pathname === '/admin/apikey' && request.method === 'POST') { const b = await readJson(request); const k = 'pcv_live_' + token(34); await env.DB.prepare('INSERT INTO api_keys(name,key_hash,key_preview) VALUES(?,?,?)').bind(b.name || 'API Key', await sha256(k), k.slice(0, 14) + '...').run(); return json({ key: k }); }
  if (url.pathname === '/admin/apikey' && request.method === 'DELETE') { const b = await readJson(request); await env.DB.prepare('DELETE FROM api_keys WHERE id=?').bind(b.id).run(); return json({ ok: true }); }
  if (url.pathname === '/admin/cleanup' && request.method === 'POST') return json(await runCleanup(env));
  return htmlResponse(await renderAdminPage(env));
}


async function adminData(env) {
  const [s, domains, keys, acts, inboxCount, msgCount, todayCount] = await Promise.all([
    getSettings(env),
    env.DB.prepare('SELECT * FROM domains ORDER BY domain').all(),
    env.DB.prepare('SELECT id,name,key_preview,created_at,last_used_at FROM api_keys ORDER BY id DESC').all(),
    env.DB.prepare('SELECT * FROM activities ORDER BY id DESC LIMIT 30').all(),
    env.DB.prepare('SELECT COUNT(*) c FROM inboxes').first(),
    env.DB.prepare('SELECT COUNT(*) c FROM messages').first(),
    env.DB.prepare("SELECT COUNT(*) c FROM messages WHERE created_at >= datetime('now','-1 day')").first()
  ]);
  return { settings: s, domains: domains.results || [], apiKeys: keys.results || [], activities: acts.results || [], stats: { inboxes: inboxCount.c, messages: msgCount.c, today: todayCount.c } };
}

// ==================== EMAIL HANDLER ====================
async function handleIncomingEmail(message, env) {
  const to = message.to.toLowerCase();
  const inbox = await env.DB.prepare('SELECT * FROM inboxes WHERE email=?').bind(to).first();
  if (!inbox) return;
  const raw = await new Response(message.raw).text();
  const subject = raw.match(/^Subject:\s*(.*)$/mi)?.[1]?.trim() || '(no subject)';
  const from = raw.match(/^From:\s*(.*)$/mi)?.[1]?.trim() || message.from || '';
  const text = stripHeaders(raw).slice(0, 60000);
  const settings = await getSettings(env);
  const otp = settings.otp_detector_enabled === '1' ? extractOtp(subject + '\n' + text) : null;
  await env.DB.prepare('INSERT INTO messages(inbox_id,message_uid,sender,recipient,subject,text_body,otp,size_bytes) VALUES(?,?,?,?,?,?,?,?)').bind(inbox.id, token(24), from, to, subject, text, otp, raw.length).run();
  await env.DB.prepare('UPDATE inboxes SET message_count=message_count+1,last_seen_at=CURRENT_TIMESTAMP WHERE id=?').bind(inbox.id).run();
  await logActivity(env, 'mail', 'Message received', `${maskEmail(to)}${otp ? ' - OTP detected' : ''}`);
}
function stripHeaders(raw) {
  const idx = raw.indexOf('\r\n\r\n');
  if (idx >= 0) return raw.slice(idx + 4);
  const idx2 = raw.indexOf('\n\n');
  return idx2 >= 0 ? raw.slice(idx2 + 2) : raw;
}
function extractOtp(text) {
  if (!/(otp|code|kode|verification|verifikasi|security|login|passcode)/i.test(text)) return null;
  return text.match(/\b\d{4,8}\b/)?.[0] || null;
}
async function runCleanup(env) {
  const s = await getSettings(env);
  const days = Math.max(1, Number(s.delete_after_days || 7));
  const r = await env.DB.prepare("DELETE FROM messages WHERE created_at < datetime('now', ?)").bind(`-${days} days`).run();
  await env.DB.prepare("DELETE FROM inboxes WHERE id NOT IN (SELECT DISTINCT inbox_id FROM messages) AND created_at < datetime('now', ?)").bind(`-${days} days`).run();
  // cleanup one-time expired inboxes
  await env.DB.prepare("DELETE FROM inboxes WHERE one_time=1 AND expires_at < datetime('now')").run();
  await logActivity(env, 'cleanup', 'Cleanup completed', `Removed expired messages older than ${days} day(s)`);
  return { ok: true, deleteAfterDays: days, changes: r.meta?.changes || 0 };
}


// ==================== FRONTEND PAGES ====================
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function renderHomePage(env) {
  const s = await getSettings(env);
  const domains = await env.DB.prepare('SELECT domain FROM domains WHERE active=1 ORDER BY domain').all();
  const domainList = (domains.results || []).map(d => d.domain);
  return `<!DOCTYPE html><html lang="${s.default_language}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(s.app_name)}</title>
<link rel="icon" href="${escHtml(s.favicon_url)}">
<style>${getCSS(s)}</style>
</head><body>
<header class="header">
  <a href="/" class="logo"><img src="${escHtml(s.logo_url)}" alt="logo"><span class="logo-name">${escHtml(s.app_name).replace(/(\.\w+)$/, '<span class="logo-accent">$1</span>')}</span></a>
  <nav class="header-nav">
    ${s.show_api_button === '1' ? '<a href="/admin" class="nav-btn">&lt;/&gt; API</a>' : ''}
    ${s.show_telegram_button === '1' && s.telegram_url ? '<a href="' + escHtml(s.telegram_url) + '" class="nav-btn tg-btn" target="_blank"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.66-.54.82-1.09.51l-3.02-2.22-1.46 1.4c-.16.16-.3.3-.61.3l.22-3.06 5.56-5.02c.24-.22-.05-.34-.38-.13l-6.87 4.33-2.96-.92c-.64-.2-.66-.64.14-.95l11.58-4.46c.53-.2 1 .13.82.94z"/></svg></a>' : ''}
    <span class="nav-sep">|</span>
    ${s.show_theme_toggle === '1' ? '<button class="nav-btn theme-toggle" onclick="toggleTheme()" title="Toggle theme"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>' : ''}
  </nav>
</header>
<main class="main-container">
  <section class="hero">
    <div class="hero-features">
      <div class="feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="var(--pri)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> Instant address generation</div>
      <div class="feature"><svg width="16" height="16" viewBox="0 0 24 24" fill="var(--pri)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> No signup required</div>
    </div>
  </section>
  <section class="create-section">
    <div class="create-card">
      <div class="create-header">
        <h2 class="create-title">Create your inbox</h2>
        <div class="envelope-icon"><svg width="80" height="60" viewBox="0 0 80 60" fill="none"><rect x="5" y="10" width="70" height="45" rx="6" stroke="var(--pri)" stroke-width="2" fill="var(--panel)"/><path d="M5 15l35 22 35-22" stroke="var(--pri)" stroke-width="2" fill="none"/><rect x="20" y="22" width="30" height="3" rx="1" fill="#334155"/><rect x="20" y="28" width="25" height="3" rx="1" fill="#334155"/><rect x="20" y="34" width="20" height="3" rx="1" fill="#334155"/></svg></div>
      </div>
      <label class="field-label">Address name</label>
      <div class="input-row">
        <input type="text" id="username" class="input" placeholder="swiftbyte908">
        <button class="icon-btn" onclick="randomName()" title="Random"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pri)" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg></button>
      </div>
      <label class="field-label">Domain</label>
      <div class="select-wrap">
        <select id="domain" class="input">${domainList.map(d => `<option value="${escHtml(d)}">@${escHtml(d)}</option>`).join('')}</select>
        <svg class="select-arrow" width="14" height="14" viewBox="0 0 24 24" fill="var(--pri)"><path d="M7 10l5 5 5-5z"/></svg>
      </div>
      <label class="field-label">Your temporary email</label>
      <div class="input-row">
        <input type="text" id="preview-email" class="input" readonly placeholder="swiftbyte908@${domainList[0] || 'domain.com'}">
        <button class="icon-btn" onclick="copyEmail()" title="Copy"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pri)" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
      </div>
      <p class="ready-text"><svg width="14" height="14" viewBox="0 0 24 24" fill="var(--pri)"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2z"/></svg> Ready. Copy this address or open your inbox.</p>
      <button class="btn-primary full-width" onclick="openInbox()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12l-10 7V5l10 7z"/><rect x="2" y="5" width="8" height="14" rx="1"/></svg> Open Inbox</button>
      <button class="btn-accent full-width" onclick="createOneTime()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> One-time Inbox</button>
    </div>
  </section>
  ${s.show_how_it_works === '1' ? '<section class="how-section"><h2 class="section-title">How it works</h2><div class="how-grid"><div class="how-card"><div class="how-num">1</div><h3>Generate</h3><p>Get a random or custom temporary email address instantly.</p></div><div class="how-card"><div class="how-num">2</div><h3>Receive</h3><p>Use it anywhere. Emails arrive in real-time.</p></div><div class="how-card"><div class="how-num">3</div><h3>Done</h3><p>Auto-cleanup after expiry. No trace left.</p></div></div></section>' : ''}
</main>
<footer class="footer"><p>${escHtml(s.footer_text)}</p></footer>
<script>${getHomeJS(s)}</script>
</body></html>`;
}


async function renderInboxPage(env, url) {
  const s = await getSettings(env);
  const pathToken = url.pathname.replace('/inbox/', '');
  return `<!DOCTYPE html><html lang="${s.default_language}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inbox - ${escHtml(s.app_name)}</title>
<link rel="icon" href="${escHtml(s.favicon_url)}">
<style>${getCSS(s)}</style>
</head><body>
<header class="header">
  <a href="/" class="logo"><img src="${escHtml(s.logo_url)}" alt="logo"><span class="logo-name">${escHtml(s.app_name)}</span></a>
  <nav class="header-nav">
    ${s.show_api_button === '1' ? '<a href="/admin" class="nav-btn">&lt;/&gt; API</a>' : ''}
    ${s.show_telegram_button === '1' && s.telegram_url ? '<a href="' + escHtml(s.telegram_url) + '" class="nav-btn tg-btn" target="_blank"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.94 8.13l-1.97 9.28c-.15.66-.54.82-1.09.51l-3.02-2.22-1.46 1.4c-.16.16-.3.3-.61.3l.22-3.06 5.56-5.02c.24-.22-.05-.34-.38-.13l-6.87 4.33-2.96-.92c-.64-.2-.66-.64.14-.95l11.58-4.46c.53-.2 1 .13.82.94z"/></svg></a>' : ''}
    <span class="nav-sep">|</span>
    ${s.show_theme_toggle === '1' ? '<button class="nav-btn theme-toggle" onclick="toggleTheme()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>' : ''}
  </nav>
</header>
<main class="main-container">
  <div class="inbox-header">
    <span class="badge-permanent">Permanent Inbox</span>
    <span class="badge-infinite"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Infinite</span>
  </div>
  <div class="inbox-email-row">
    <span id="inbox-email" class="inbox-email-text">Loading...</span>
    <button class="icon-btn" onclick="copyInboxEmail()" title="Copy"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pri)" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
    <button class="icon-btn" onclick="refreshInbox()" title="Refresh"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pri)" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg></button>
  </div>
  <div id="messages-area" class="messages-area">
    <div class="empty-state">
      <svg width="120" height="100" viewBox="0 0 120 100" fill="none">
        <rect x="20" y="20" width="80" height="60" rx="8" stroke="#4b5563" stroke-width="2" fill="#1f2937"/>
        <path d="M20 30l40 25 40-25" stroke="#4b5563" stroke-width="2"/>
        <circle cx="85" cy="65" r="18" fill="var(--panel)" stroke="var(--pri)" stroke-width="2"/>
        <path d="M85 58v14M78 65h14" stroke="var(--pri)" stroke-width="2" stroke-linecap="round" opacity="0"/>
        <circle cx="85" cy="65" r="6" fill="none" stroke="var(--pri)" stroke-width="2"/>
        <path d="M89 69l4 4" stroke="var(--pri)" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <h2>No emails yet</h2>
      <p>Emails sent to <strong id="empty-email">...</strong> will appear here automatically.</p>
    </div>
  </div>
  <div id="msg-viewer" class="msg-viewer hide"></div>
  <button class="btn-lock full-width" onclick="lockInbox()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg> Lock Inbox</button>
</main>
<script>
const INBOX_TOKEN='${escHtml(pathToken)}';
${getInboxJS(s)}
</script>
</body></html>`;
}


// ==================== CSS ====================
function getCSS(s) {
  return `
:root{--pri:${s.primary_color};--acc:${s.accent_color};--bg:${s.bg_color};--panel:${s.panel_color};--text:${s.text_color};--muted:#8b99ae;--line:#1e293b;--radius:14px}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
body.light{--bg:#f1f5f9;--panel:#ffffff;--text:#1e293b;--muted:#64748b;--line:#e2e8f0}
a{color:var(--pri);text-decoration:none}
.header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:800}
.logo img{height:32px;border-radius:6px}
.logo-accent{color:var(--pri)}
.header-nav{display:flex;align-items:center;gap:8px}
.nav-btn{padding:6px 12px;border-radius:8px;font-size:13px;font-weight:600;color:var(--muted);border:1px solid var(--line);background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.nav-btn:hover{color:var(--pri);border-color:var(--pri)}
.nav-sep{color:var(--line);margin:0 4px}
.theme-toggle{background:none;border:none;color:var(--muted);cursor:pointer;padding:6px}
.main-container{max-width:640px;margin:0 auto;padding:24px 16px}
.hero{margin-bottom:24px}
.hero-features{display:flex;flex-direction:column;gap:8px}
.feature{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--muted)}
.create-section{margin-bottom:32px}
.create-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px}
.create-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}
.create-title{color:var(--pri);font-size:18px;font-weight:700}
.envelope-icon{opacity:0.8}
.field-label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:14px 0 6px}
.input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;color:var(--text);font-size:15px;outline:none;transition:border-color .2s}
.input:focus{border-color:var(--pri)}
.input-row{display:flex;gap:8px;align-items:center}
.input-row .input{flex:1}
.icon-btn{width:42px;height:42px;display:flex;align-items:center;justify-content:center;background:var(--pri);border:none;border-radius:10px;cursor:pointer;opacity:0.9;transition:opacity .2s}
.icon-btn:hover{opacity:1}
.icon-btn svg{stroke:white}
.select-wrap{position:relative}
.select-wrap select{appearance:none;padding-right:36px}
.select-arrow{position:absolute;right:14px;top:50%;transform:translateY(-50%);pointer-events:none}
.ready-text{font-size:12px;color:var(--muted);margin:12px 0;display:flex;align-items:center;gap:6px}
.btn-primary,.btn-accent,.btn-lock{display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;transition:opacity .2s}
.btn-primary{background:transparent;border:1px solid var(--pri);color:var(--pri)}
.btn-primary:hover{background:var(--pri);color:white}
.btn-accent{background:var(--pri);color:white;margin-top:10px}
.btn-accent:hover{opacity:0.9}
.btn-lock{background:var(--panel);border:1px solid var(--line);color:var(--text);margin-top:20px}
.full-width{width:100%}
.how-section{margin:40px 0}
.section-title{color:var(--pri);font-size:16px;margin-bottom:16px}
.how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.how-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;text-align:center}
.how-num{width:28px;height:28px;border-radius:50%;background:var(--pri);color:white;font-weight:700;font-size:13px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:8px}
.how-card h3{font-size:14px;margin-bottom:4px}
.how-card p{font-size:12px;color:var(--muted)}
.footer{text-align:center;padding:24px;color:var(--muted);font-size:12px;border-top:1px solid var(--line)}
.inbox-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.badge-permanent{background:var(--pri);color:white;padding:4px 12px;border-radius:6px;font-size:13px;font-weight:700}
.badge-infinite{display:flex;align-items:center;gap:4px;background:rgba(20,184,166,0.15);color:var(--pri);padding:4px 12px;border-radius:6px;font-size:13px;font-weight:600}
.inbox-email-row{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:16px}
.inbox-email-text{flex:1;font-size:15px;font-weight:500;word-break:break-all}
.messages-area{min-height:300px}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px 20px;text-align:center;color:var(--muted)}
.empty-state h2{margin:16px 0 8px;color:var(--text);font-size:18px}
.empty-state strong{color:var(--pri)}
.msg-item{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:8px;cursor:pointer;transition:border-color .2s}
.msg-item:hover{border-color:var(--pri)}
.msg-item h4{font-size:14px;margin-bottom:4px}
.msg-item small{color:var(--muted);font-size:12px}
.msg-otp{font-size:22px;font-weight:900;color:var(--pri);margin-top:6px}
.msg-viewer{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px;margin-top:12px}
.msg-viewer pre{white-space:pre-wrap;font-size:13px;color:var(--muted);max-height:400px;overflow:auto}
.hide{display:none}
@media(max-width:600px){.how-grid{grid-template-columns:1fr}.header{padding:10px 14px}.main-container{padding:16px 12px}}
`;
}


// ==================== HOME PAGE JS ====================
function getHomeJS(s) {
  return `
const cfg={autoRefresh:${Number(s.auto_refresh_seconds)||5}};
const $=s=>document.querySelector(s);
function escH(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function toggleTheme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');

function updatePreview(){
  const u=$('#username').value.trim()||'swiftbyte908';
  const d=$('#domain').value;
  $('#preview-email').value=u+'@'+d;
}
$('#username').addEventListener('input',updatePreview);
$('#domain').addEventListener('change',updatePreview);

function randomName(){
  const words_a=${JSON.stringify(WORDS_A)};
  const words_b=${JSON.stringify(WORDS_B)};
  const a=words_a[Math.floor(Math.random()*words_a.length)];
  const b=words_b[Math.floor(Math.random()*words_b.length)];
  const n=Math.floor(Math.random()*900)+100;
  $('#username').value=a+b+n;
  updatePreview();
}

function copyEmail(){
  const v=$('#preview-email').value;
  if(v)navigator.clipboard.writeText(v);
}

async function openInbox(){
  const username=$('#username').value.trim()||null;
  const domain=$('#domain').value;
  const body={domain};
  if(username)body.username=username;
  const r=await fetch('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.token){location.href='/inbox/'+d.token;}
  else{alert(d.message||d.error||'Error creating inbox');}
}

async function createOneTime(){
  const username=$('#username').value.trim()||null;
  const domain=$('#domain').value;
  const body={domain,oneTime:true};
  if(username)body.username=username;
  const r=await fetch('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(d.token){location.href='/inbox/'+d.token;}
  else{alert(d.message||d.error||'Error creating inbox');}
}

randomName();
`;
}


// ==================== INBOX PAGE JS ====================
function getInboxJS(s) {
  return `
const $=s=>document.querySelector(s);
let msgs=[];
function escH(t){return String(t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function toggleTheme(){document.body.classList.toggle('light');localStorage.setItem('theme',document.body.classList.contains('light')?'light':'dark')}
if(localStorage.getItem('theme')==='light')document.body.classList.add('light');

function copyInboxEmail(){
  const e=$('#inbox-email').textContent;
  if(e)navigator.clipboard.writeText(e);
}

async function refreshInbox(){
  const r=await fetch('/api/inbox?token='+INBOX_TOKEN);
  const d=await r.json();
  if(d.error){$('#inbox-email').textContent='Not found';return;}
  $('#inbox-email').textContent=d.email;
  $('#empty-email').textContent=d.email;
  msgs=d.messages||[];
  renderMessages();
}

function renderMessages(){
  if(!msgs.length){
    $('#messages-area').innerHTML='<div class="empty-state"><svg width="120" height="100" viewBox="0 0 120 100" fill="none"><rect x="20" y="20" width="80" height="60" rx="8" stroke="#4b5563" stroke-width="2" fill="#1f2937"/><path d="M20 30l40 25 40-25" stroke="#4b5563" stroke-width="2"/><circle cx="85" cy="65" r="18" fill="var(--panel)" stroke="var(--pri)" stroke-width="2"/><circle cx="85" cy="65" r="6" fill="none" stroke="var(--pri)" stroke-width="2"/><path d="M89 69l4 4" stroke="var(--pri)" stroke-width="2" stroke-linecap="round"/></svg><h2>No emails yet</h2><p>Emails sent to <strong>'+escH($('#inbox-email').textContent)+'</strong> will appear here automatically.</p></div>';
    return;
  }
  $('#messages-area').innerHTML=msgs.map((m,i)=>'<div class="msg-item" onclick="showMsg('+i+')"><h4>'+escH(m.subject)+'</h4><small>'+escH(m.sender)+' &bull; '+escH(m.created_at)+'</small>'+(m.otp?'<div class="msg-otp">OTP: '+escH(m.otp)+'</div>':'')+'</div>').join('');
}

function showMsg(i){
  const m=msgs[i];
  const v=$('#msg-viewer');
  v.classList.remove('hide');
  v.innerHTML='<h3>'+escH(m.subject)+'</h3>'+(m.otp?'<div class="msg-otp">'+escH(m.otp)+' <button onclick="navigator.clipboard.writeText(\\''+m.otp+'\\')">Copy</button></div>':'')+'<p style="color:var(--muted);font-size:12px;margin:8px 0">From: '+escH(m.sender)+'</p><pre>'+escH(m.text_body||'(no text content)')+'</pre>';
}

async function lockInbox(){
  const pin=prompt('Set a PIN to lock this inbox (4-8 digits):');
  if(!pin||pin.length<4)return alert('PIN must be at least 4 characters');
  const r=await fetch('/api/lock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:INBOX_TOKEN,pin})});
  const d=await r.json();
  if(d.ok)alert('Inbox locked! You will need this PIN to access it next time.');
  else alert(d.error||'Failed to lock');
}

refreshInbox();
setInterval(refreshInbox,${Number(s.auto_refresh_seconds)||5}*1000);
`;
}


// ==================== ADMIN LOGIN ====================
function renderAdminLogin() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title>
<style>
:root{--pri:#14b8a6;--bg:#0a0d14;--panel:#11161f;--text:#e7ecf3;--line:#1e293b;--muted:#8b99ae}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:Inter,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:32px;width:100%;max-width:400px;margin:20px}
h1{margin-bottom:8px}
.hint{color:var(--muted);font-size:13px;margin-bottom:20px}
.input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;color:var(--text);font-size:15px;margin-bottom:12px}
.btn{width:100%;padding:14px;background:var(--pri);color:white;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer}
.err{color:#ef4444;font-size:13px;margin-top:8px}
</style></head><body>
<div class="card">
<h1>Admin Panel</h1>
<p class="hint">Default: admin / admin</p>
<input id="u" class="input" placeholder="Username" value="admin">
<input id="p" class="input" type="password" placeholder="Password">
<button class="btn" onclick="login()">Login</button>
<p id="e" class="err"></p>
</div>
<script>
async function login(){
  const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u.value,password:p.value})});
  if(r.ok)location='/admin';else document.getElementById('e').textContent='Login failed';
}
document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
</script></body></html>`;
}


// ==================== ADMIN PANEL PAGE ====================
async function renderAdminPage(env) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Panel</title>
<style>
:root{--pri:#14b8a6;--bg:#0a0d14;--panel:#11161f;--text:#e7ecf3;--line:#1e293b;--muted:#8b99ae}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:Inter,-apple-system,sans-serif}
.admin-layout{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.sidebar{background:#080b10;border-right:1px solid var(--line);padding:20px;position:sticky;top:0;height:100vh;overflow-y:auto}
.sidebar h2{font-size:16px;margin-bottom:20px;color:var(--pri)}
.nav-item{display:block;width:100%;padding:10px 12px;margin:4px 0;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--text);font-size:13px;font-weight:500;cursor:pointer;text-align:left}
.nav-item:hover,.nav-item.active{background:var(--panel);border-color:var(--line)}
.main-content{padding:28px}
.main-content h1{margin-bottom:20px;font-size:22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;text-align:center}
.stat-card h3{font-size:12px;color:var(--muted);margin-bottom:4px}
.stat-card .num{font-size:28px;font-weight:800;color:var(--pri)}
.input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font-size:14px;margin-bottom:10px}
.input:focus{border-color:var(--pri);outline:none}
label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}
.btn{padding:10px 18px;background:var(--pri);color:white;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer}
.btn-ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
.btn-danger{background:#dc2626}
.color-row{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.color-picker{width:50px;height:38px;border:none;border-radius:8px;cursor:pointer;background:none;padding:0}
.color-value{font-size:13px;color:var(--muted);font-family:monospace}
table{width:100%;border-collapse:collapse}
th,td{padding:10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:600}
.activity-item{padding:10px 0;border-bottom:1px solid var(--line)}
.activity-item:last-child{border:none}
.activity-title{font-weight:600;font-size:13px}
.activity-desc{color:var(--muted);font-size:12px}
.activity-time{color:var(--muted);font-size:11px}
.toggle{position:relative;width:44px;height:24px;background:var(--line);border-radius:12px;cursor:pointer;transition:background .2s}
.toggle.on{background:var(--pri)}
.toggle::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;background:white;border-radius:50%;transition:transform .2s}
.toggle.on::after{transform:translateX(20px)}
@media(max-width:768px){.admin-layout{grid-template-columns:1fr}.sidebar{position:relative;height:auto;border-right:none;border-bottom:1px solid var(--line)}.stat-grid{grid-template-columns:1fr}}
</style></head><body>
<div id="app"></div>
<script>${getAdminJS()}${getAdminJS2()}${getAdminJS3()}${getAdminJS4()}</script>
</body></html>`;
}


function getAdminJS() {
  return `
let data={},tab='Dashboard';
const menus=['Dashboard','Domains','Appearance','Features','Security','Storage','API Keys','Activity','System'];

async function api(url,opts){
  const r=await fetch(url,{headers:{'content-type':'application/json'},...opts});
  return r.json();
}
async function load(){data=await api('/admin/data');render();}

function render(){
  document.querySelector('#app').innerHTML=\`
<div class="admin-layout">
  <aside class="sidebar">
    <h2>Admin Panel</h2>
    \${menus.map(m=>\`<button class="nav-item \${tab===m?'active':''}" onclick="tab='\${m}';render()">\${m}</button>\`).join('')}
    <br><button class="nav-item" onclick="logout()">Logout</button>
  </aside>
  <main class="main-content">\${page()}</main>
</div>\`;
}

function page(){
  const s=data.settings||{};
  switch(tab){
    case 'Dashboard': return dashboardPage();
    case 'Domains': return domainsPage();
    case 'Appearance': return appearancePage();
    case 'Features': return featuresPage();
    case 'Security': return securityPage();
    case 'Storage': return storagePage();
    case 'API Keys': return apiKeysPage();
    case 'Activity': return activityPage();
    case 'System': return systemPage();
    default: return '';
  }
}

function dashboardPage(){
  const st=data.stats||{};
  return \`<h1>Dashboard</h1>
<div class="stat-grid">
  <div class="stat-card"><h3>Active Inboxes</h3><div class="num">\${st.inboxes||0}</div></div>
  <div class="stat-card"><h3>Total Messages</h3><div class="num">\${st.messages||0}</div></div>
  <div class="stat-card"><h3>Today</h3><div class="num">\${st.today||0}</div></div>
</div>
<div class="card"><h3>System Info</h3><p style="color:var(--muted);font-size:13px">Cleanup: every \${data.settings?.delete_after_days||7} day(s) | Worker + D1 + Email Routing</p></div>\`;
}

function domainsPage(){
  return \`<h1>Domains</h1>
<div class="card">
  <div style="display:flex;gap:8px;margin-bottom:12px">
    <input id="new-domain" class="input" style="margin:0;flex:1" placeholder="example.com">
    <button class="btn" onclick="addDomain()">Add</button>
  </div>
  <table><tr><th>Domain</th><th>Status</th><th>Actions</th></tr>
  \${(data.domains||[]).map(d=>\`<tr><td>\${d.domain}</td><td style="color:\${d.active?'var(--pri)':'#ef4444'}">\${d.active?'Active':'Disabled'}</td><td><button class="btn btn-ghost" onclick="toggleDomain(\${d.id},\${!d.active})">\${d.active?'Disable':'Enable'}</button> <button class="btn btn-danger" onclick="delDomain(\${d.id})">Delete</button></td></tr>\`).join('')}
  </table>
</div>\`;
}
`;
}


function getAdminJS2() {
  return `
function appearancePage(){
  const s=data.settings||{};
  return \`<h1>Appearance</h1>
<div class="card">
  <h3>Branding</h3>
  <label>App Name</label><input id="app_name" class="input" value="\${s.app_name||''}">
  <label>App Tagline</label><input id="app_tagline" class="input" value="\${s.app_tagline||''}">
  <label>Logo URL</label><input id="logo_url" class="input" value="\${s.logo_url||''}">
  <label>Favicon URL</label><input id="favicon_url" class="input" value="\${s.favicon_url||''}">
  <label>Footer Text</label><input id="footer_text" class="input" value="\${s.footer_text||''}">
</div>
<div class="card">
  <h3>Colors (click to pick)</h3>
  <div class="color-row"><label style="width:120px">Primary</label><input type="color" id="primary_color" class="color-picker" value="\${s.primary_color||'#14b8a6'}"><span class="color-value" id="primary_color_val">\${s.primary_color||'#14b8a6'}</span></div>
  <div class="color-row"><label style="width:120px">Accent</label><input type="color" id="accent_color" class="color-picker" value="\${s.accent_color||'#0d9488'}"><span class="color-value" id="accent_color_val">\${s.accent_color||'#0d9488'}</span></div>
  <div class="color-row"><label style="width:120px">Background</label><input type="color" id="bg_color" class="color-picker" value="\${s.bg_color||'#0a0d14'}"><span class="color-value" id="bg_color_val">\${s.bg_color||'#0a0d14'}</span></div>
  <div class="color-row"><label style="width:120px">Panel</label><input type="color" id="panel_color" class="color-picker" value="\${s.panel_color||'#11161f'}"><span class="color-value" id="panel_color_val">\${s.panel_color||'#11161f'}</span></div>
  <div class="color-row"><label style="width:120px">Text</label><input type="color" id="text_color" class="color-picker" value="\${s.text_color||'#e7ecf3'}"><span class="color-value" id="text_color_val">\${s.text_color||'#e7ecf3'}</span></div>
</div>
<div class="card">
  <h3>Visibility</h3>
  <label>Show API Button</label><div class="toggle \${s.show_api_button==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_show_api_button"></div><br>
  <label>Show Telegram Button</label><div class="toggle \${s.show_telegram_button==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_show_telegram_button"></div><br>
  <label>Show Theme Toggle</label><div class="toggle \${s.show_theme_toggle==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_show_theme_toggle"></div><br>
  <label>Show How It Works</label><div class="toggle \${s.show_how_it_works==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_show_how_it_works"></div><br>
  <label>Telegram URL</label><input id="telegram_url" class="input" value="\${s.telegram_url||''}" placeholder="https://t.me/yourchannel">
</div>
<button class="btn" onclick="saveAppearance()">Save Appearance</button>\`;
}

function featuresPage(){
  const s=data.settings||{};
  return \`<h1>Features</h1>
<div class="card">
  <label>OTP Detector</label><div class="toggle \${s.otp_detector_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_otp_detector_enabled"></div><br>
  <label>Attachments</label><div class="toggle \${s.attachments_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_attachments_enabled"></div><br>
  <label>Sound Notification</label><div class="toggle \${s.sound_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_sound_enabled"></div><br>
  <label>Cookie Notice</label><div class="toggle \${s.cookie_notice_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_cookie_notice_enabled"></div><br>
  <label>Auto Refresh (seconds)</label><input id="auto_refresh_seconds" class="input" type="number" value="\${s.auto_refresh_seconds||5}">
  <label>One-time Inbox Duration (minutes)</label><input id="one_time_inbox_minutes" class="input" type="number" value="\${s.one_time_inbox_minutes||10}">
</div>
<button class="btn" onclick="saveFeatures()">Save Features</button>\`;
}
`;
}


function getAdminJS3() {
  return `
function securityPage(){
  const s=data.settings||{};
  return \`<h1>Security</h1>
<div class="card">
  <label>Turnstile Captcha</label><div class="toggle \${s.turnstile_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_turnstile_enabled"></div><br>
  <label>Captcha on Generate</label><div class="toggle \${s.captcha_on_generate==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_captcha_on_generate"></div><br>
  <label>Turnstile Site Key</label><input id="turnstile_site_key" class="input" value="\${s.turnstile_site_key||''}">
  <label>Turnstile Secret Key</label><input id="turnstile_secret_key" class="input" value="\${s.turnstile_secret_key||''}">
  <label>Forbidden Usernames</label><div class="toggle \${s.forbidden_username_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_forbidden_username_enabled"></div><br>
  <label>Forbidden List (comma separated)</label><input id="forbidden_usernames" class="input" value="\${s.forbidden_usernames||''}">
  <label>Min Username Length</label><input id="custom_min_length" class="input" type="number" value="\${s.custom_min_length||4}">
  <label>Max Username Length</label><input id="custom_max_length" class="input" type="number" value="\${s.custom_max_length||32}">
</div>
<button class="btn" onclick="saveSecurity()">Save Security</button>\`;
}

function storagePage(){
  const s=data.settings||{};
  return \`<h1>Storage & Cleanup</h1>
<div class="card">
  <label>Delete After Days</label><input id="delete_after_days" class="input" type="number" value="\${s.delete_after_days||7}">
  <label>Emergency Cleanup</label><div class="toggle \${s.emergency_cleanup_enabled==='1'?'on':''}" onclick="this.classList.toggle('on')" id="t_emergency_cleanup_enabled"></div><br>
  <label>Warning Percent</label><input id="storage_warning_percent" class="input" type="number" value="\${s.storage_warning_percent||80}">
  <label>Danger Percent</label><input id="storage_danger_percent" class="input" type="number" value="\${s.storage_danger_percent||95}">
</div>
<button class="btn" onclick="saveStorage()">Save Storage</button>\`;
}

function apiKeysPage(){
  return \`<h1>API Keys</h1>
<div class="card">
  <p style="color:var(--muted);font-size:13px;margin-bottom:12px">Base URL: https://\${data.settings?.api_domain||'api.domain.com'}/api/v1</p>
  <button class="btn" onclick="newKey()">Generate New Key</button>
  <div id="newkey" style="color:var(--pri);font-size:13px;margin-top:8px"></div>
</div>
<div class="card">
  <table><tr><th>Name</th><th>Key</th><th>Created</th><th>Action</th></tr>
  \${(data.apiKeys||[]).map(k=>\`<tr><td>\${k.name}</td><td style="font-family:monospace;font-size:12px">\${k.key_preview}</td><td>\${k.created_at}</td><td><button class="btn btn-danger" onclick="delKey(\${k.id})">Delete</button></td></tr>\`).join('')}
  </table>
</div>\`;
}

function activityPage(){
  return \`<h1>Activity</h1>
<div class="card">
  \${(data.activities||[]).map(a=>\`<div class="activity-item"><div class="activity-title">\${a.title}</div><div class="activity-desc">\${a.description||''}</div><div class="activity-time">\${a.created_at}</div></div>\`).join('')||'<p style="color:var(--muted)">No activity yet.</p>'}
</div>\`;
}

function systemPage(){
  const s=data.settings||{};
  return \`<h1>System</h1>
<div class="card">
  <label>Web Domain</label><input id="web_domain" class="input" value="\${s.web_domain||''}">
  <label>API Domain</label><input id="api_domain" class="input" value="\${s.api_domain||''}">
  <label>Default Language</label><input id="default_language" class="input" value="\${s.default_language||'id'}">
  <button class="btn" onclick="saveSystem()" style="margin-top:8px">Save</button>
</div>
<div class="card">
  <h3>Admin Account</h3>
  <button class="btn btn-ghost" onclick="changeAccount()">Change Username/Password</button>
</div>
<div class="card">
  <h3>Manual Cleanup</h3>
  <button class="btn btn-danger" onclick="runCleanup()">Run Cleanup Now</button>
</div>\`;
}
`;
}


function getAdminJS4() {
  return `
// Color picker live update
document.addEventListener('input',function(e){
  if(e.target.type==='color'){
    const valEl=document.getElementById(e.target.id+'_val');
    if(valEl)valEl.textContent=e.target.value;
  }
});

function getToggle(id){return document.getElementById(id)?.classList.contains('on')?'1':'0';}

async function saveAppearance(){
  const body={
    app_name:document.getElementById('app_name').value,
    app_tagline:document.getElementById('app_tagline').value,
    logo_url:document.getElementById('logo_url').value,
    favicon_url:document.getElementById('favicon_url').value,
    footer_text:document.getElementById('footer_text').value,
    primary_color:document.getElementById('primary_color').value,
    accent_color:document.getElementById('accent_color').value,
    bg_color:document.getElementById('bg_color').value,
    panel_color:document.getElementById('panel_color').value,
    text_color:document.getElementById('text_color').value,
    show_api_button:getToggle('t_show_api_button'),
    show_telegram_button:getToggle('t_show_telegram_button'),
    show_theme_toggle:getToggle('t_show_theme_toggle'),
    show_how_it_works:getToggle('t_show_how_it_works'),
    telegram_url:document.getElementById('telegram_url').value
  };
  await api('/admin/settings',{method:'POST',body:JSON.stringify(body)});
  alert('Saved!');load();
}

async function saveFeatures(){
  const body={
    otp_detector_enabled:getToggle('t_otp_detector_enabled'),
    attachments_enabled:getToggle('t_attachments_enabled'),
    sound_enabled:getToggle('t_sound_enabled'),
    cookie_notice_enabled:getToggle('t_cookie_notice_enabled'),
    auto_refresh_seconds:document.getElementById('auto_refresh_seconds').value,
    one_time_inbox_minutes:document.getElementById('one_time_inbox_minutes').value
  };
  await api('/admin/settings',{method:'POST',body:JSON.stringify(body)});
  alert('Saved!');load();
}

async function saveSecurity(){
  const body={
    turnstile_enabled:getToggle('t_turnstile_enabled'),
    captcha_on_generate:getToggle('t_captcha_on_generate'),
    turnstile_site_key:document.getElementById('turnstile_site_key').value,
    turnstile_secret_key:document.getElementById('turnstile_secret_key').value,
    forbidden_username_enabled:getToggle('t_forbidden_username_enabled'),
    forbidden_usernames:document.getElementById('forbidden_usernames').value,
    custom_min_length:document.getElementById('custom_min_length').value,
    custom_max_length:document.getElementById('custom_max_length').value
  };
  await api('/admin/settings',{method:'POST',body:JSON.stringify(body)});
  alert('Saved!');load();
}

async function saveStorage(){
  const body={
    delete_after_days:document.getElementById('delete_after_days').value,
    emergency_cleanup_enabled:getToggle('t_emergency_cleanup_enabled'),
    storage_warning_percent:document.getElementById('storage_warning_percent').value,
    storage_danger_percent:document.getElementById('storage_danger_percent').value
  };
  await api('/admin/settings',{method:'POST',body:JSON.stringify(body)});
  alert('Saved!');load();
}

async function saveSystem(){
  const body={
    web_domain:document.getElementById('web_domain').value,
    api_domain:document.getElementById('api_domain').value,
    default_language:document.getElementById('default_language').value
  };
  await api('/admin/settings',{method:'POST',body:JSON.stringify(body)});
  alert('Saved!');load();
}

async function addDomain(){
  const d=document.getElementById('new-domain').value.trim();
  if(!d)return;
  await api('/admin/domain',{method:'POST',body:JSON.stringify({domain:d})});
  load();
}
async function toggleDomain(id,active){await api('/admin/domain',{method:'PATCH',body:JSON.stringify({id,active})});load();}
async function delDomain(id){if(!confirm('Delete?'))return;await api('/admin/domain',{method:'DELETE',body:JSON.stringify({id})});load();}
async function newKey(){
  const name=prompt('API key name:','My App');if(!name)return;
  const r=await api('/admin/apikey',{method:'POST',body:JSON.stringify({name})});
  document.getElementById('newkey').textContent='Key: '+r.key+' (copy now, shown once)';load();
}
async function delKey(id){if(!confirm('Delete key?'))return;await api('/admin/apikey',{method:'DELETE',body:JSON.stringify({id})});load();}
async function runCleanup(){const r=await api('/admin/cleanup',{method:'POST'});alert('Cleanup done. Removed: '+(r.changes||0));load();}
async function changeAccount(){
  const username=prompt('New username:','admin');
  const password=prompt('New password:');
  if(!password)return;
  await api('/admin/account',{method:'POST',body:JSON.stringify({username,password})});
  alert('Saved! Please logout and login again.');
}
function logout(){fetch('/admin/logout').then(()=>location.reload());}

load();
`;
}
