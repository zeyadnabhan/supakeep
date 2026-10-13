import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';
import { SETUP_SQL, CLEANUP_SQL, projectRef, dashboardUrl, validateUrl, validateKey, validateInt, nextRun, localDayNum, ping } from './lib.js';

const PORT = Number(process.env.PORT || 3000);
const TZ = process.env.TZ_NAME || 'UTC';
const CHECK_MINUTES = Math.max(1, Number(process.env.CHECK_MINUTES) || 5);
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const DB_PATH = process.env.DB_PATH || 'data/supakeep.db';
const LOG_RETENTION_DAYS = 90;
const DAY = 86400000;

if (PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD must be set and at least 8 characters.');
  process.exit(1);
}

// ---------- database ----------
fs.mkdirSync(DB_PATH.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    interval_days INTEGER NOT NULL,
    times_per_day INTEGER NOT NULL,
    anchor_day INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_run_at INTEGER,
    last_success_at INTEGER,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ran_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    code INTEGER,
    ms INTEGER,
    message TEXT
  );
  CREATE INDEX IF NOT EXISTS logs_project ON logs(project_id, ran_at);
  CREATE INDEX IF NOT EXISTS logs_ran_at ON logs(ran_at);
  CREATE INDEX IF NOT EXISTS projects_due ON projects(next_run_at);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const getProject = db.prepare('SELECT * FROM projects WHERE id = ?');
// times_per_day column = runs per period (spread over interval_days); name kept to avoid a migration.
const scheduleOf = p => ({ intervalDays: p.interval_days, times: p.times_per_day, anchorDay: p.anchor_day });

// Recompute upcoming runs on startup (picks up schedule-rule or timezone changes).
// Only healthy projects: failed ones keep their retry time, overdue ones stay due.
for (const p of db.prepare("SELECT * FROM projects WHERE status = 'active' AND next_run_at > ?").all(Date.now())) {
  db.prepare('UPDATE projects SET next_run_at = ? WHERE id = ?').run(nextRun(Date.now(), scheduleOf(p), TZ), p.id);
}
const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => v == null
  ? db.prepare('DELETE FROM settings WHERE key = ?').run(k)
  : db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));

const RETRY_OPTIONS = [15, 30, 60, 120, 180, 360, 720]; // minutes
const retryMinutes = () => Number(getSetting('retry_minutes')) || 60;
const retryLabel = m => m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`;

// ---------- telegram ----------
const TELEGRAM_API = process.env.TELEGRAM_API || 'https://api.telegram.org'; // overridable for local testing
const PUBLIC_URL = process.env.DOMAIN && !process.env.DOMAIN.includes('example.com') ? `https://${process.env.DOMAIN}` : '';

async function tg(method, body = {}, token = getSetting('tg_token')) {
  if (!token) throw new Error('Telegram bot token is not set.');
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram: ${data.description || `HTTP ${res.status}`}`);
  return data.result;
}

// Fire-and-forget; never throws.
async function notify(text) {
  const chatId = getSetting('tg_chat_id');
  if (!chatId) return;
  try { await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }); }
  catch (e) { console.error('telegram notify failed:', e.message); }
}

// ---------- scheduler ----------
const running = new Set(); // project ids with a ping in flight (manual + scheduled never overlap)

async function runProject(p) {
  if (running.has(p.id)) return { ok: false, busy: true, message: 'A check is already running for this project.' };
  running.add(p.id);
  try { return await runProjectNow(p); } finally { running.delete(p.id); }
}

async function runProjectNow(p) {
  const now = Date.now();
  const r = await ping(p.url, p.api_key);
  db.prepare('INSERT INTO logs (project_id, ran_at, ok, code, ms, message) VALUES (?, ?, ?, ?, ?, ?)')
    .run(p.id, now, r.ok ? 1 : 0, r.code, r.ms, r.message);

  let status = r.ok ? 'active' : (p.status === 'pending' ? 'pending' : 'failed');
  let next = null;
  if (status !== 'pending') {
    next = nextRun(now, scheduleOf(p), TZ);
    if (!r.ok) next = Math.min(next, now + retryMinutes() * 60000); // retry sooner, unless the schedule is already sooner
  }
  // `AND status = ?`: if the project was paused/edited while the ping was in flight, don't overwrite that.
  const { changes } = db.prepare(`UPDATE projects SET status = ?, last_run_at = ?, next_run_at = ?,
      last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END
    WHERE id = ? AND status = ?`)
    .run(status, now, next, r.ok ? 1 : 0, now, p.id, p.status);
  if (!changes) return r;

  // Notify on state changes only, not on every hourly retry.
  const link = PUBLIC_URL ? `\n${PUBLIC_URL}/projects/${p.id}` : '';
  if (!r.ok && p.status === 'active') {
    await notify(`🔴 <b>${esc(p.name)}</b> failed\n${esc(r.message)}\nNext retry: ${fmt(next)}\nOpen in Supabase: ${dashboardUrl(p.url)}${link}`);
  } else if (r.ok && p.status === 'failed') {
    await notify(`🟢 <b>${esc(p.name)}</b> is working again${link}`);
  }
  return r;
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = db.prepare("SELECT * FROM projects WHERE status IN ('active', 'failed') AND next_run_at <= ?").all(Date.now());
    // note: sequential, fine for a personal list; run in parallel batches if you ever have hundreds
    for (const p of due) await runProject(p);
    db.prepare('DELETE FROM logs WHERE ran_at < ?').run(Date.now() - LOG_RETENTION_DAYS * DAY);
    // note: bound both maps. Without this, an IP-rotating attacker grows failures
    // forever and the container has no memory limit, so it would OOM the host.
    for (const [ip, f] of failures) if (f.until < Date.now()) failures.delete(ip);
    for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
  } catch (e) {
    console.error('tick failed:', e);
  } finally {
    ticking = false;
  }
}

// ---------- auth ----------
const sessions = new Map(); // token -> expiresAt (in memory: restart = log in again)
const failures = new Map(); // ip -> { count, until }
const SESSION_MS = 7 * DAY;
const pwHash = crypto.createHash('sha256').update(PASSWORD).digest();
const sessionToken = req => /(?:^|;\s*)sk_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];

function isAuthed(req) {
  const token = sessionToken(req);
  const exp = token && sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function clientIp(req) {
  // App is only reachable through a reverse proxy. Use the LAST X-Forwarded-For entry:
  // it is the one our proxy added; earlier entries can be forged by the client.
  return (req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || req.socket.remoteAddress;
}

function cookie(value, maxAge) {
  return `sk_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${COOKIE_SECURE ? '; Secure' : ''}`;
}

// ---------- rendering ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const fmt = ts => ts ? dateFmt.format(ts) : '—';
const ago = ms => ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m ago` : ms < DAY ? `${Math.round(ms / 3600000)}h ago` : `${Math.floor(ms / DAY)}d ago`;
// Supabase pauses free projects after 7 days without activity: warn at 4 days, danger at 6.
function lastSuccess(p) {
  if (!p.last_success_at) return '—';
  const age = Date.now() - p.last_success_at;
  const level = p.status === 'pending' ? '' : age > 6 * DAY ? 'age-danger' : age > 4 * DAY ? 'age-warn' : '';
  const tip = level ? ' title="Supabase pauses free projects after 7 days without activity"' : '';
  return `<span class="${level}"${tip}>${fmt(p.last_success_at)} <span class="ago">· ${ago(age)}</span></span>`;
}
const mask = k => `${k.slice(0, 6)}…${k.slice(-4)}`;
const badge = s => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const schedule = p => {
  const period = p.interval_days === 1 ? 'day' : `${p.interval_days} days`;
  if (p.times_per_day === 1) return `Once every ${period}`;
  const minutes = Math.round(p.interval_days * 1440 / p.times_per_day);
  const every = minutes % 1440 === 0 ? `${minutes / 1440}d`
    : [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)}h`, minutes % 60 && `${minutes % 60}m`].filter(Boolean).join(' ');
  return `${p.times_per_day}× every ${period} (every ${every})`;
};
const options = sel => [1, 2, 3, 4, 5, 6].map(n => `<option value="${n}"${n === sel ? ' selected' : ''}>${n}</option>`).join('');

const icon = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
};

const FOOTER = '<footer>SupaKeep</footer>';

function layout(title, body, { authed = true, msg = '', nav = 'home' } = {}) {
  const flash = msg ? `<div class="flash">${esc(msg)}</div>` : '';
  const on = name => name === nav ? ' class="on"' : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#171717">
<title>${esc(title)} | SupaKeep</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Source+Code+Pro:wght@400;500&display=swap">
<link rel="stylesheet" href="/style.css?v=${ASSET_V}"><script src="/app.js?v=${ASSET_V}" defer></script></head>
<body>${authed ? `<div class="app">
<aside class="rail">
<a class="rail-logo" href="/" aria-label="SupaKeep home"><img src="/logo.svg" alt="" width="24" height="24"></a>
<nav><a href="/"${on('home')}>${icon(ICONS.home)}<span>Dashboard</span></a>
<a href="/logs"${on('logs')}>${icon(ICONS.logs)}<span>Logs</span></a>
<a href="/settings"${on('settings')}>${icon(ICONS.settings)}<span>Settings</span></a></nav>
<form method="post" action="/logout"><button class="rail-item">${icon(ICONS.logout)}<span>Log out</span></button></form>
</aside>
<div class="shell">
<header class="topbar"><a href="/"><img class="topbar-logo" src="/logo.svg" alt="" width="20" height="20">SupaKeep</a><span class="sep">/</span><span class="current">${esc(title)}</span></header>
<main>${flash}${body}</main>
${FOOTER}
</div></div>`
  : `<main class="auth"><div class="auth-box">
<a class="auth-logo" href="/"><img src="/logo.svg" alt="" width="28" height="28"><span>SupaKeep</span></a>
${body.replace('<!--flash-->', flash)}</div>${FOOTER}</main>`}</body></html>`;
}

function projectForm(p, action, submit) {
  return `<form method="post" action="${action}" class="card form">
<label>Project Name (optional)<input name="name" maxlength="100" placeholder="Defaults to the project ref from the URL" value="${esc(p.name)}"></label>
<label>Project URL<input name="url" required placeholder="https://abcdefghijklmnopqrst.supabase.co" value="${esc(p.url)}"></label>
<label>Anon / Publishable Key<input name="api_key" ${p.id ? 'placeholder="Leave empty to keep current key"' : 'required'} autocomplete="off" spellcheck="false"></label>
<div class="row">
<label>Every how many days<select name="interval_days">${options(p.interval_days ?? 1)}</select></label>
<label>How many times in that period<select name="times_per_day">${options(p.times_per_day ?? 1)}</select></label>
</div>
<p class="muted">Runs are spread evenly across the whole period, starting at midnight (${esc(TZ)}). Example: every 2 days, 4 times = every 12 hours. Supabase pauses projects after 7 days of inactivity, so the maximum is 6 days.</p>
<button class="primary">${submit}</button></form>`;
}

function readForm(f, existing) {
  const url = validateUrl(f.get('url'));
  const name = f.get('name')?.trim() || projectRef(url);
  if (name.length > 100) throw new Error('Project name is too long (max 100 characters).');
  const rawKey = f.get('api_key')?.trim();
  return {
    name,
    url,
    api_key: existing && !rawKey ? existing.api_key : validateKey(rawKey),
    interval_days: validateInt(f.get('interval_days'), 1, 6, 'Days'),
    times_per_day: validateInt(f.get('times_per_day'), 1, 6, 'Times'),
  };
}

// Values to re-fill a form after a validation error. The key is never echoed back.
const refill = f => ({ name: f.get('name'), url: f.get('url'), interval_days: Number(f.get('interval_days')), times_per_day: Number(f.get('times_per_day')) });

// Check counts come from the logs table, so clearing logs (or the 90-day cleanup) resets them too.
const checkCounts = (projectId = null) => db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(1 - ok), 0) AS failed
  FROM logs WHERE ? IS NULL OR project_id = ?`).get(projectId, projectId);

// ---------- pages ----------
function dashboard() {
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
  const count = s => projects.filter(p => p.status === s).length;
  const checks = checkCounts();
  const stats = [['Total Projects', projects.length], ['Active Projects', count('active')], ['Failed Projects', count('failed')],
    ['Successful Checks', checks.ok], ['Failed Checks', checks.failed]]
    .map(([l, v]) => `<div class="card stat"><span class="muted">${l}</span><strong>${v}</strong></div>`).join('');
  const rows = projects.map(p => `<tr><td class="title"><a href="/projects/${p.id}">${esc(p.name)}</a></td><td data-label="Status">${badge(p.status)}</td>
<td data-label="Last success">${lastSuccess(p)}</td><td data-label="Next check">${fmt(p.next_run_at)}</td></tr>`).join('');
  return `<h1>Dashboard</h1><div class="stats">${stats}</div>
<div class="card"><div class="head"><h2>Projects</h2><a class="btn primary" href="/projects/new">Add Project</a></div>
${projects.length ? `<div class="scroll"><table><thead><tr><th>Name</th><th>Status</th><th>Last success</th><th>Next check</th></tr></thead><tbody>${rows}</tbody></table></div>`
  : '<p class="muted">No projects yet.</p>'}</div>`;
}

const extLink = (href, label, cls = '') => `<a class="btn ${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>`;
const sqlEditorBtn = (p, cls) => extLink(dashboardUrl(p.url, '/sql/new'), 'Open SQL Editor', cls);

// What to do about the latest failure, based on its HTTP code.
function failureHint(p, code) {
  if (code === 401 || code === 403) return { text: 'The key was rejected. Update it with <b>Edit Project</b>.', action: `<a class="btn primary" href="/projects/${p.id}/edit">Edit Project</a>` };
  if (code === 404) return { text: 'The <code>supakeep_ping()</code> function is missing. Run the setup SQL again.', action: sqlEditorBtn(p, 'primary') };
  return { text: 'The project may be paused. Open it in Supabase and click <b>Restore project</b>. SupaKeep keeps retrying automatically.', action: extLink(dashboardUrl(p.url), 'Open in Supabase', 'primary') };
}

function details(p) {
  const logs = db.prepare('SELECT * FROM logs WHERE project_id = ? ORDER BY ran_at DESC LIMIT 100').all(p.id);
  const setup = p.status === 'pending' ? `<div class="card setup"><h2>Finish setup</h2>
<ol><li>Copy the SQL below.</li><li>Click <b>Open SQL Editor</b>, paste it, and click <b>Run</b>.</li><li>Come back and click <b>Verify</b>.</li></ol>
<div class="code"><button type="button" class="copy" data-copy="sql">Copy</button><pre id="sql">${esc(SETUP_SQL)}</pre></div>
<div class="actions">${sqlEditorBtn(p)}<form method="post" action="/projects/${p.id}/run"><button class="primary" data-busy="Verifying…">Verify</button></form></div></div>` : '';
  const paused = p.status === 'paused' ? `<div class="card paused-note"><div class="head"><h2>Paused</h2>
<form method="post" action="/projects/${p.id}/resume"><button class="primary">Resume</button></form></div>
<p class="muted">No checks will run until you resume. If this is a free-tier project, Supabase may pause it after 7 days without activity.</p></div>` : '';
  const last = p.status === 'failed' ? logs[0] : null;
  const hint = last && !last.ok && failureHint(p, last.code);
  const alert = hint ? `<div class="card alert"><div class="head"><h2>Last check failed</h2>${hint.action}</div>
<p>${esc(last.message)}</p><p class="muted">${hint.text}</p></div>` : '';
  const checks = checkCounts(p.id);
  const info = [['Status', badge(p.status)], ['Schedule', esc(schedule(p))], ['Last activity', fmt(p.last_run_at)],
    ['Last success', lastSuccess(p)], ['Next activity', fmt(p.next_run_at)], ['Total checks', checks.total],
    ['Successful checks', checks.ok], ['Failed checks', checks.failed],
    ['URL', `<code class="plain">${esc(p.url)}</code>`, 'wide'], ['Key', `<code class="plain">${esc(mask(p.api_key))}</code>`]]
    .map(([l, v, cls = '']) => `<div class="${cls}"><span class="muted">${l}</span><div>${v}</div></div>`).join('');
  const rows = logs.map(l => `<tr><td class="title">${fmt(l.ran_at)}</td><td data-label="Result">${badge(l.ok ? 'success' : 'failed')}</td>
<td data-label="HTTP">${l.code ?? '—'}</td><td data-label="Duration">${l.ms ?? '—'} ms</td><td class="msg" data-label="Message">${esc(l.message)}</td></tr>`).join('');
  return `<div class="head"><h1>${esc(p.name)}</h1><div class="actions">
${['active', 'failed'].includes(p.status) ? `<form method="post" action="/projects/${p.id}/run"><button data-busy="Running…">Run Now</button></form>
<form method="post" action="/projects/${p.id}/pause"><button>Pause</button></form>` : ''}${extLink(dashboardUrl(p.url), 'Supabase')}
<a class="btn" href="/projects/${p.id}/edit">Edit Project</a>
<a class="btn danger" href="/projects/${p.id}/delete">Delete Project</a>
</div></div>${paused}${alert}${setup}
<div class="card grid">${info}</div>
<div class="card"><div class="head"><h2>Activity</h2><a class="btn" href="/logs?project=${p.id}">View all logs</a></div>${logs.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Result</th><th>HTTP</th><th>Duration</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></div>`
  : '<p class="muted">No activity yet.</p>'}</div>`;
}

function deletePage(p) {
  return `<h1>Delete ${esc(p.name)}</h1>
<div class="card"><h2>1. Clean up your Supabase project (optional)</h2>
<p class="muted">Removes the <code>supakeep</code> table and <code>supakeep_ping()</code> function that the setup SQL created. Run it before or after deleting here.</p>
<div class="code"><button type="button" class="copy" data-copy="cleanup">Copy</button><pre id="cleanup">${esc(CLEANUP_SQL)}</pre></div>
${sqlEditorBtn(p)}</div>
<div class="card alert"><h2>2. Delete from SupaKeep</h2>
<p class="muted">Stops the schedule and permanently deletes this project and its logs from SupaKeep.</p>
<div class="actions"><form method="post" action="/projects/${p.id}/delete"><button class="danger">Delete Project</button></form>
<a class="btn" href="/projects/${p.id}">Cancel</a></div></div>`;
}

const LOGS_PER_PAGE = 50;

// Shared by the logs page and "Clear logs" so both always target the same rows.
function logFilter(q) {
  const pid = Number(q.get('project')) || 0;
  const result = ['success', 'failed'].includes(q.get('result')) ? q.get('result') : '';
  const where = [], args = [];
  if (pid) { where.push('l.project_id = ?'); args.push(pid); }
  if (result) { where.push('l.ok = ?'); args.push(result === 'success' ? 1 : 0); }
  return { pid, result, args, w: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

function logsPage(q) {
  const projects = db.prepare('SELECT id, name FROM projects ORDER BY name').all();
  const { pid, result, args, w } = logFilter(q);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM logs l ${w}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / LOGS_PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number(q.get('page')) || 1));
  const logs = db.prepare(`SELECT l.*, p.name FROM logs l JOIN projects p ON p.id = l.project_id ${w}
    ORDER BY l.ran_at DESC LIMIT ? OFFSET ?`).all(...args, LOGS_PER_PAGE, (page - 1) * LOGS_PER_PAGE);

  const link = n => `/logs?${new URLSearchParams({ ...(pid && { project: pid }), ...(result && { result }), page: n })}`;
  const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(label)}</option>`;
  const rows = logs.map(l => `<tr><td class="title">${fmt(l.ran_at)}</td><td data-label="Project"><a href="/projects/${l.project_id}">${esc(l.name)}</a></td>
<td data-label="Result">${badge(l.ok ? 'success' : 'failed')}</td><td data-label="HTTP">${l.code ?? '—'}</td><td data-label="Duration">${l.ms ?? '—'} ms</td><td class="msg" data-label="Message">${esc(l.message)}</td></tr>`).join('');

  return `<h1>Logs</h1>
<div class="card"><div class="head">
<form method="get" action="/logs" class="filters">
<select name="project" data-autosubmit aria-label="Project">${opt('', 'All projects', pid || '')}${projects.map(p => opt(p.id, p.name, pid)).join('')}</select>
<select name="result" data-autosubmit aria-label="Result">${opt('', 'All results', result)}${opt('success', 'Success', result)}${opt('failed', 'Failed', result)}</select>
<noscript><button>Filter</button></noscript>
</form><div class="actions"><span class="muted">${total} ${total === 1 ? 'entry' : 'entries'} · kept for ${LOG_RETENTION_DAYS} days</span>
${total ? `<form method="post" action="/logs/clear" data-confirm="Delete ${total} ${pid || result ? 'filtered ' : ''}log ${total === 1 ? 'entry' : 'entries'}? This cannot be undone.">
${pid ? `<input type="hidden" name="project" value="${pid}">` : ''}${result ? `<input type="hidden" name="result" value="${result}">` : ''}
<button class="danger">${pid || result ? 'Clear filtered logs' : 'Clear logs'}</button></form>` : ''}</div></div>
${logs.length ? `<div class="scroll"><table><thead><tr><th>Time</th><th>Project</th><th>Result</th><th>HTTP</th><th>Duration</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="pager"><span class="muted">Page ${page} of ${pages}</span><div class="actions">
${page > 1 ? `<a class="btn" href="${link(page - 1)}">Previous</a>` : ''}${page < pages ? `<a class="btn" href="${link(page + 1)}">Next</a>` : ''}</div></div>`
  : '<p class="muted">No logs match.</p>'}</div>`;
}

async function settingsPage() {
  const token = getSetting('tg_token'), bot = getSetting('tg_bot'), code = getSetting('tg_code');
  const chatId = getSetting('tg_chat_id'), chatName = getSetting('tg_chat_name');
  const qr = async url => `<a class="qr" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(url)}">${await QRCode.toString(url, { type: 'svg', margin: 2, width: 168 })}</a>`;
  const status = chatId ? badge('connected') : token ? badge('pending') : '<span class="badge none">not set</span>';

  const step3 = !token ? '' : chatId
    ? `<p>Notifications go to <b>${esc(chatName)}</b>.</p>
<div class="actions"><form method="post" action="/settings/telegram/test"><button>Send test message</button></form>
<form method="post" action="/settings/telegram/connect-reset"><button>Connect another chat</button></form></div>`
    : `<p class="muted">Scan with your phone (or click the code), press <b>Start</b> in Telegram, then click Connect.</p>
${await qr(`https://t.me/${bot}?start=${code}`)}
<form method="post" action="/settings/telegram/connect"><button class="primary">Connect</button></form>`;

  const retry = retryMinutes();
  return `<h1>Settings</h1>
<div class="card"><h2>Failure retry</h2>
<form method="post" action="/settings/retry" class="form inline">
<label>When a check fails, try again after
<select name="minutes">${RETRY_OPTIONS.map(m => `<option value="${m}"${m === retry ? ' selected' : ''}>${retryLabel(m)}</option>`).join('')}</select></label>
<button class="primary">Save</button></form>
<p class="muted">Retries continue at this interval until the project works again. If the regular schedule comes sooner, it runs first.</p></div>
<div class="card"><div class="head"><h2>Telegram notifications</h2>${status}</div>
<p class="muted">Get a message when a project fails, and when it works again.</p>
<div class="steps">
<div class="step"><h3><span class="num">1</span>Create a bot</h3>
<p class="muted">Scan to open <b>@BotFather</b>, send <code>/newbot</code>, follow the steps, and copy the token it gives you.</p>
${await qr('https://t.me/BotFather')}</div>
<div class="step"><h3><span class="num">2</span>Paste the bot token</h3>
<form method="post" action="/settings/telegram/token" class="form">
<label>Bot Token<input name="token" required autocomplete="off" spellcheck="false" placeholder="${token ? esc(mask(token)) : '123456789:AAH...'}"></label>
<button class="primary">${token ? 'Replace token' : 'Save token'}</button></form>
${token ? `<p class="muted">Bot: <a href="https://t.me/${esc(bot)}" target="_blank" rel="noopener">@${esc(bot)}</a></p>
<form method="post" action="/settings/telegram/remove" data-confirm="Remove the bot and stop notifications?"><button class="danger">Remove bot</button></form>` : ''}</div>
${token ? `<div class="step"><h3><span class="num">3</span>Connect your Telegram</h3>${step3}</div>` : ''}
</div></div>`;
}

async function handleSettings(req, res, path) {
  const back = m => redirect(res, '/settings', m);
  try {
    if (path === '/settings/retry') {
      const minutes = Number((await readBody(req)).get('minutes'));
      if (!RETRY_OPTIONS.includes(minutes)) return back('Invalid retry interval.');
      setSetting('retry_minutes', minutes);
      return back(`Failed checks will retry after ${retryLabel(minutes)}.`);
    }
    if (path === '/settings/telegram/token') {
      const token = (await readBody(req)).get('token')?.trim() || '';
      if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) return back('Invalid bot token format.');
      let me;
      try { me = await tg('getMe', {}, token); } catch { return back('Telegram rejected this token.'); }
      setSetting('tg_token', token);
      setSetting('tg_bot', me.username);
      setSetting('tg_code', crypto.randomBytes(8).toString('hex'));
      setSetting('tg_chat_id', null);
      setSetting('tg_chat_name', null);
      return back(`Bot @${me.username} saved. Now connect your Telegram.`);
    }
    if (path === '/settings/telegram/connect') {
      const code = getSetting('tg_code');
      const updates = await tg('getUpdates', { allowed_updates: ['message'] });
      const hit = updates.findLast(u => u.message?.text === `/start ${code}`);
      if (!hit) return back('No Start message found yet. Open the bot, press Start, then click Connect again.');
      const c = hit.message.chat;
      setSetting('tg_chat_id', c.id);
      setSetting('tg_chat_name', c.username ? `@${c.username}` : [c.first_name, c.last_name].filter(Boolean).join(' ') || String(c.id));
      await tg('getUpdates', { offset: updates.at(-1).update_id + 1, timeout: 0 }); // acknowledge
      await tg('sendMessage', { chat_id: c.id, text: '✅ SupaKeep connected. You will get a message when a project fails.' });
      return back('Telegram connected.');
    }
    if (path === '/settings/telegram/test') {
      await tg('sendMessage', { chat_id: getSetting('tg_chat_id'), text: '🔔 SupaKeep test message. Notifications are working.' });
      return back('Test message sent.');
    }
    if (path === '/settings/telegram/connect-reset') {
      setSetting('tg_chat_id', null);
      setSetting('tg_chat_name', null);
      setSetting('tg_code', crypto.randomBytes(8).toString('hex'));
      return back('Scan the new code to connect another chat.');
    }
    if (path === '/settings/telegram/remove') {
      for (const k of ['tg_token', 'tg_bot', 'tg_code', 'tg_chat_id', 'tg_chat_name']) setSetting(k, null);
      return back('Telegram bot removed.');
    }
  } catch (e) {
    return back(e.message);
  }
  send(res, 404, layout('Not found', '<h1>Not found</h1>'));
}

const loginPage = () => `<h1>Welcome back</h1><p class="muted lead">Sign in to your dashboard</p><!--flash-->
<form method="post" action="/login" class="form">
<label>Password<input type="password" name="password" required autofocus autocomplete="current-password" placeholder="••••••••"></label>
<button class="primary block">Sign In</button></form>`;

// ---------- http ----------
const STATIC = {
  '/style.css': ['text/css; charset=utf-8', fs.readFileSync(new URL('./public/style.css', import.meta.url))],
  '/app.js': ['text/javascript; charset=utf-8', fs.readFileSync(new URL('./public/app.js', import.meta.url))],
  '/logo.svg': ['image/svg+xml', fs.readFileSync(new URL('./public/logo.svg', import.meta.url))],
};

// Cache-busting token: changes whenever a static file changes.
const ASSET_V = crypto.createHash('sha1').update(Buffer.concat(Object.values(STATIC).map(s => s[1]))).digest('hex').slice(0, 8);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', // no-referrer makes browsers send "Origin: null" on form posts
    ...headers,
  });
  res.end(body);
}
const redirect = (res, to, msg, headers = {}) =>
  send(res, 303, '', { Location: msg ? `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}` : to, ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 16384) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  if (req.method === 'HEAD') req.method = 'GET'; // Node already drops the body for HEAD; route it like GET (uptime monitors)
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const msg = url.searchParams.get('msg') || '';

  if (req.method === 'GET' && STATIC[path]) {
    return send(res, 200, STATIC[path][1], { 'Content-Type': STATIC[path][0], 'Cache-Control': 'public, max-age=3600' });
  }
  if (req.method === 'GET' && path === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  // CSRF defense in depth (SameSite=Lax already blocks cross-site POST cookies).
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    let host = null;
    try { host = new URL(origin).host; } catch {} // "null" or garbage -> rejected below
    if (origin && host !== req.headers.host) return send(res, 403, 'Bad origin', { 'Content-Type': 'text/plain' });
  }

  if (path === '/login') {
    if (req.method === 'GET') {
      if (isAuthed(req)) return redirect(res, '/');
      return send(res, 200, layout('Log in', loginPage(), { authed: false, msg }));
    }
    if (req.method === 'POST') {
      const ip = clientIp(req);
      const f = failures.get(ip);
      const locked = f && f.until > Date.now();
      if (locked && f.count >= 5) return redirect(res, '/login', 'Too many attempts. Try again in 15 minutes.');
      const form = await readBody(req);
      const given = crypto.createHash('sha256').update(form.get('password') || '').digest();
      if (!crypto.timingSafeEqual(given, pwHash)) {
        failures.set(ip, { count: locked ? f.count + 1 : 1, until: Date.now() + 15 * 60000 });
        return redirect(res, '/login', 'Wrong password.');
      }
      failures.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_MS);
      return redirect(res, '/', '', { 'Set-Cookie': cookie(token, SESSION_MS / 1000) });
    }
  }

  if (!isAuthed(req)) return redirect(res, '/login');

  if (req.method === 'POST' && path === '/logout') {
    sessions.delete(sessionToken(req));
    return redirect(res, '/login', '', { 'Set-Cookie': cookie('', 0) });
  }

  if (req.method === 'GET' && path === '/') return send(res, 200, layout('Dashboard', dashboard(), { msg }));
  if (req.method === 'GET' && path === '/logs') return send(res, 200, layout('Logs', logsPage(url.searchParams), { msg, nav: 'logs' }));
  if (req.method === 'POST' && path === '/logs/clear') {
    const form = await readBody(req);
    const { pid, result, args, w } = logFilter(form);
    const { changes } = db.prepare(`DELETE FROM logs AS l ${w}`).run(...args);
    const keep = new URLSearchParams({ ...(pid && { project: pid }), ...(result && { result }) });
    return redirect(res, `/logs${keep.size ? `?${keep}` : ''}`, `Deleted ${changes} log ${changes === 1 ? 'entry' : 'entries'}.`);
  }
  if (req.method === 'GET' && path === '/settings') return send(res, 200, layout('Settings', await settingsPage(), { msg, nav: 'settings' }));
  if (req.method === 'POST' && path.startsWith('/settings/')) return handleSettings(req, res, path);

  if (path === '/projects/new') {
    const page = (vals, m) => layout('Add Project', `<h1>Add Project</h1>${projectForm(vals, '/projects/new', 'Add Project')}`, { msg: m });
    if (req.method === 'GET') return send(res, 200, page({}, msg));
    if (req.method === 'POST') {
      const form = await readBody(req);
      let data;
      try { data = readForm(form); } catch (e) { return send(res, 400, page(refill(form), e.message)); }
      // Never reuse the id of a deleted project (old Telegram links would open the new one).
      const id = Math.max(db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM projects').get().n, Number(getSetting('last_project_id')) || 0) + 1;
      setSetting('last_project_id', id);
      db.prepare(`INSERT INTO projects (id, name, url, api_key, interval_days, times_per_day, anchor_day, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, data.name, data.url, data.api_key, data.interval_days, data.times_per_day, localDayNum(Date.now(), TZ), Date.now());
      return redirect(res, `/projects/${id}`, 'Project added. Run the setup SQL, then click Verify.');
    }
  }

  const m = /^\/projects\/(\d+)(?:\/(edit|run|delete|pause|resume))?$/.exec(path);
  const p = m && getProject.get(Number(m[1]));
  if (m && !p) return send(res, 404, layout('Not found', '<h1>Project not found</h1>'));

  if (p && !m[2] && req.method === 'GET') return send(res, 200, layout(p.name, details(p), { msg }));

  if (p && m[2] === 'pause' && req.method === 'POST') {
    if (!['active', 'failed'].includes(p.status)) return redirect(res, `/projects/${p.id}`, 'Only active or failed projects can be paused.');
    db.prepare("UPDATE projects SET status = 'paused', next_run_at = NULL WHERE id = ?").run(p.id);
    return redirect(res, `/projects/${p.id}`, 'Paused. No checks will run until you resume.');
  }
  if (p && m[2] === 'resume' && req.method === 'POST') {
    if (p.status !== 'paused') return redirect(res, `/projects/${p.id}`);
    // Due immediately: the scheduler checks it within CHECK_MINUTES, then the normal schedule continues.
    db.prepare("UPDATE projects SET status = 'active', next_run_at = ? WHERE id = ?").run(Date.now(), p.id);
    return redirect(res, `/projects/${p.id}`, `Resumed. A check will run within ${CHECK_MINUTES} minute${CHECK_MINUTES === 1 ? '' : 's'}.`);
  }

  if (p && m[2] === 'run' && req.method === 'POST') {
    if (p.status === 'paused') return redirect(res, `/projects/${p.id}`, 'This project is paused. Resume it first.');
    if (p.last_run_at && Date.now() - p.last_run_at < 30000) return redirect(res, `/projects/${p.id}`, 'Please wait 30 seconds between runs.');
    const r = await runProject(p);
    return redirect(res, `/projects/${p.id}`, r.ok ? 'Success: the supakeep row was updated.' : r.busy ? r.message : `Failed: ${r.message}`);
  }

  if (p && m[2] === 'edit') {
    const page = (vals, m2) => layout('Edit Project', `<h1>Edit ${esc(p.name)}</h1>${projectForm(vals, `/projects/${p.id}/edit`, 'Save')}`, { msg: m2 });
    if (req.method === 'GET') return send(res, 200, page(p, msg));
    if (req.method === 'POST') {
      const form = await readBody(req);
      let data;
      try { data = readForm(form, p); } catch (e) { return send(res, 400, page({ ...refill(form), id: p.id }, e.message)); }
      const connChanged = data.url !== p.url || data.api_key !== p.api_key;
      const schedChanged = data.interval_days !== p.interval_days || data.times_per_day !== p.times_per_day;
      const status = connChanged ? 'pending' : p.status;
      const anchor = schedChanged ? localDayNum(Date.now(), TZ) : p.anchor_day;
      const next = status === 'pending' || status === 'paused' ? null
        : schedChanged ? nextRun(Date.now(), scheduleOf({ ...data, anchor_day: anchor }), TZ)
        : p.next_run_at;
      db.prepare('UPDATE projects SET name = ?, url = ?, api_key = ?, interval_days = ?, times_per_day = ?, anchor_day = ?, status = ?, next_run_at = ? WHERE id = ?')
        .run(data.name, data.url, data.api_key, data.interval_days, data.times_per_day, anchor, status, next, p.id);
      return redirect(res, `/projects/${p.id}`, connChanged ? 'Connection changed. Click Verify.' : 'Saved.');
    }
  }

  if (p && m[2] === 'delete' && req.method === 'GET') return send(res, 200, layout(`Delete ${p.name}`, deletePage(p)));
  if (p && m[2] === 'delete' && req.method === 'POST') {
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    return redirect(res, '/', 'Project deleted.');
  }

  send(res, 404, layout('Not found', '<h1>Not found</h1>'));
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Internal error', { 'Content-Type': 'text/plain' });
  });
}).listen(PORT, () => console.log(`SupaKeep on :${PORT} (tz ${TZ}, check every ${CHECK_MINUTES}m)`));

tick();
setInterval(tick, CHECK_MINUTES * 60000);
