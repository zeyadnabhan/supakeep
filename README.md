# SupaKeep

A small self-hosted tool that records activity in your Supabase projects on a schedule, so
free-tier projects are not paused for inactivity.

- One Node.js app (`node:http` and `node:sqlite`) with a single dependency: `qrcode`, used to
  draw the Telegram QR codes.
- The database is a single SQLite file.
- Login with one password.
- Scheduling: every 1–6 days, 1–6 times spread evenly across that period starting at midnight
  (for example: every 2 days × 4 times = once every 12 hours).

## Installation

SupaKeep is one small Node.js process that needs a writable folder for its SQLite file. Pick
whichever setup matches your machine; they all use the same `.env` (see
[Configuration](#configuration-env)).

### Option 1: Docker with automatic HTTPS (a server with a domain)

Use this on a fresh Linux server where ports 80 and 443 are free.

1. Point your domain (A record) at the server's IP and open ports 80 and 443.
2. Clone the repository on the server, then:

```bash
cp .env.example .env
nano .env          # set DOMAIN and ADMIN_PASSWORD
docker compose up -d --build
```

3. Open `https://your-domain` and log in with the password.

The bundled Caddy obtains and renews the HTTPS certificate on its own.

### Option 2: Docker behind your own reverse proxy

Use this when ports 80/443 already belong to your own Nginx, Caddy, Traefik, a tunnel, etc.

Remove the `caddy` service (and the `caddy_data` / `caddy_config` volumes) from
`docker-compose.yml`, and publish the app on localhost by adding this to the `app` service:

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

Then proxy your domain to `127.0.0.1:3000` and serve it over HTTPS. If your proxy runs in Docker
too, skip `ports` and attach `app` to the proxy's network instead, targeting `app:3000`.

### Option 3: Without Docker (Node.js 22.13+)

Works on Linux, macOS and Windows.

```bash
npm ci --omit=dev
cp .env.example .env   # set ADMIN_PASSWORD
npm start              # listens on port 3000
```

The database is created at `data/supakeep.db`; set `DB_PATH` to move it and `PORT` to change the
port. Keep the process running with whatever you already use (systemd, pm2, a Windows service)
and put it behind an HTTPS reverse proxy for anything reachable from the internet.

### Option 4: No domain (home network, localhost, a quick try)

Run Option 2 or 3 without a proxy and open `http://<host>:3000` directly. Browsers drop `Secure`
cookies over plain HTTP, so login only works if you set `COOKIE_SECURE=false` in `.env`. Leave
`DOMAIN` as it is; it is only used for links in Telegram notifications. Do not expose this setup
to the internet.

### Other platforms

Any host that can run a container (or Node.js 22.13+) with a **persistent** disk works: mount the
disk at `/app/data` in the container, set `ADMIN_PASSWORD`, and route HTTPS to port 3000. A
platform that wipes the filesystem on every deploy will lose your projects.

### Updating

```bash
git pull
docker compose up -d --build
```

Data lives in a volume named `supakeep_data`, so it survives updates.

### Backup

```bash
docker compose cp app:/app/data/supakeep.db ./backup.db
```

## Adding a project

1. **Add Project**: the name, the URL (`https://xxxx.supabase.co`) and the **anon / publishable
   key** (Supabase → Project Settings → API Keys). A `service_role` or `secret` key is rejected.
   The name is optional: left empty, the project ref from the URL is used.
2. A SQL snippet is shown. Copy it, click **Open SQL Editor** (it opens your project directly),
   paste it and click Run.
3. Click **Verify**. On success the project becomes `active` and scheduling starts.

The SQL snippet creates:

- a `supakeep` table with a `pinged_at` column;
- a `supakeep_ping()` function that deletes the old row and inserts a new one;
- permissions so that the table itself is closed to the anon key and only the function may be
  called.

If a project fails, its page explains why and offers the fix: edit the key, open the SQL Editor,
or open the project in Supabase to restore it.

**Pause / Resume:** stop scheduling a project temporarily without deleting it (for example after
upgrading it to Pro). After Resume, the first check happens within minutes.

When you delete a project, an optional SQL snippet is shown that removes the `supakeep` table and
function from your Supabase project.

## Telegram notifications

From **Settings**:

1. Scan the **@BotFather** QR code, send `/newbot` and copy the token.
2. Paste the token and save.
3. Scan your bot's QR code, press **Start**, then click **Connect**.

You get a notification when a project fails (the first time only, not on every retry) and when it
recovers. If `DOMAIN` is set, the notification includes a link to the project.

## Error messages

| Message | Fix |
|---|---|
| Key invalid or rotated | The key changed. Update it from Edit. |
| supakeep_ping() not found | The SQL snippet was not run. Run it. |
| Network error / unreachable or paused | The project may have been paused. Restore it from the Supabase dashboard. |

A failed attempt is retried after the interval chosen in **Settings → Failure retry** (default:
one hour).

On the dashboard, the **Last success** date turns yellow 4 days after the last success and red
after 6 (Supabase pauses after 7).

The **Logs** page can be filtered by project and result; **Clear logs** deletes what the current
filter shows. Logs are removed automatically after 90 days.

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `DOMAIN` | — | Your domain |
| `ADMIN_PASSWORD` | — | Login password (at least 8 characters) |
| `TZ_NAME` | `UTC` | IANA timezone used for run times |
| `CHECK_MINUTES` | `5` | How often the scheduler checks for due projects |
| `COOKIE_SECURE` | `true` | Set to `false` only when serving over plain HTTP |
| `PORT` | `3000` | Port the app listens on |
| `DB_PATH` | `data/supakeep.db` | Location of the SQLite file |

## Development

```bash
npm install
cp .env.example .env   # set ADMIN_PASSWORD and uncomment COOKIE_SECURE=false
npm start              # http://localhost:3000
npm test
```

## License

[MIT](LICENSE)

> SupaKeep is not affiliated with Supabase.
