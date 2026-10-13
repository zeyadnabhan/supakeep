// Pure helpers: validation, scheduling, Supabase ping. No I/O except fetch.

export const SETUP_SQL = `create table if not exists public.supakeep (
  id bigint generated always as identity primary key,
  pinged_at timestamptz not null default now()
);
alter table public.supakeep enable row level security;
revoke all on public.supakeep from anon, authenticated;

create or replace function public.supakeep_ping()
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.supakeep where true;
  insert into public.supakeep default values;
  return now();
end $$;

revoke all on function public.supakeep_ping() from public;
grant execute on function public.supakeep_ping() to anon;`;

export const CLEANUP_SQL = `drop function if exists public.supakeep_ping();
drop table if exists public.supakeep;`;

// "https://abc...xyz.supabase.co" -> "abc...xyz"
export const projectRef = url => new URL(url).hostname.split('.')[0];
export const dashboardUrl = (url, path = '') => `https://supabase.com/dashboard/project/${projectRef(url)}${path}`;

// Returns normalized URL or throws.
export function validateUrl(input) {
  const url = String(input || '').trim().replace(/\/+$/, '').toLowerCase();
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) {
    throw new Error('Project URL must look like https://<project-ref>.supabase.co');
  }
  return url;
}

// Accepts only public keys (anon JWT or sb_publishable_). Throws otherwise.
export function validateKey(input) {
  const key = String(input || '').trim();
  if (key.startsWith('sb_secret_')) throw new Error('This is a SECRET key. Use the publishable / anon key instead.');
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return key;
  const parts = key.split('.');
  if (parts.length === 3) {
    let role;
    try { role = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role; } catch {}
    if (role === 'anon') return key;
    if (role === 'service_role') throw new Error('This is the SERVICE_ROLE key. Use the anon key instead.');
  }
  throw new Error('Invalid key. Paste the anon or publishable key.');
}

export function validateInt(input, min, max, label) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return n;
}

// Offset (ms) of timeZone from UTC at instant ts.
function tzOffset(ts, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(ts).map(x => [x.type, Number(x.value)])
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

// UTC timestamp of a local wall-clock time. dayNum = days since epoch (local calendar).
function localToUtc(dayNum, minutes, timeZone) {
  const guess = dayNum * 86400000 + minutes * 60000;
  const ts = guess - tzOffset(guess, timeZone);
  return guess - tzOffset(ts, timeZone); // second pass handles DST edges
}

export function localDayNum(ts, timeZone) {
  return Math.floor((ts + tzOffset(ts, timeZone)) / 86400000);
}

// Next run strictly after `now`. Time is split into periods of `intervalDays` days
// (starting at local midnight of `anchorDay`), and `times` runs are spread evenly across
// each whole period. E.g. 2 days × 4 times = every 12 hours.
export function nextRun(now, { intervalDays, times, anchorDay }, timeZone) {
  const today = localDayNum(now, timeZone);
  const periodStart = today - (((today - anchorDay) % intervalDays) + intervalDays) % intervalDays;
  const step = intervalDays * 1440 / times; // minutes between runs
  for (const start of [periodStart, periodStart + intervalDays]) {
    for (let i = 0; i < times; i++) {
      const offset = Math.round(i * step);
      const ts = localToUtc(start + Math.floor(offset / 1440), offset % 1440, timeZone);
      if (ts > now) return ts;
    }
  }
  throw new Error('unreachable: no next run found');
}

// Calls supakeep_ping() on the user's project. Never throws.
export async function ping(url, key) {
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`; // legacy JWT keys only
  const started = Date.now();
  try {
    const res = await fetch(`${url}/rest/v1/rpc/supakeep_ping`, {
      method: 'POST', headers, body: '{}', redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, code: res.status, message: 'OK', ms };
    const body = (await res.text()).slice(0, 200);
    const message =
      res.status === 401 || res.status === 403 ? 'Key invalid or rotated. Update the key.' :
      res.status === 404 ? 'supakeep_ping() not found. Run the setup SQL.' :
      res.status >= 500 ? `Project unreachable or paused (${res.status}).` :
      `HTTP ${res.status}: ${body}`;
    return { ok: false, code: res.status, message, ms };
  } catch (e) {
    return { ok: false, code: null, message: `Network error: ${e.name === 'TimeoutError' ? 'timeout' : e.message}. Project may be paused.`, ms: Date.now() - started };
  }
}
