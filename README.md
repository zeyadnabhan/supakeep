# SupaKeep

A small self-hosted tool that records activity in your Supabase projects on a schedule, so
free-tier projects are not paused for inactivity.

- One Node.js app (`node:http` and `node:sqlite`) with a single dependency: `qrcode`, used to
  draw the Telegram QR codes.
- The database is a single SQLite file.
- Login with one password.
- Scheduling: every 1–6 days, 1–6 times spread evenly across that period starting at midnight
  (for example: every 2 days × 4 times = once every 12 hours).

## Deploy on a server (Linux + Docker)

1. Point your domain (A record) at the server's IP and open ports 80 and 443.
2. Clone the repository on the server, then:

```bash
cp .env.example .env
nano .env          # set DOMAIN and ADMIN_PASSWORD
docker compose up -d --build
```

3. Open `https://your-domain` and log in with the password.

Caddy obtains the HTTPS certificate on its own.

### Already running a reverse proxy?

If ports 80/443 are taken by your own Nginx, Caddy or Traefik, remove the `caddy` service from
`docker-compose.yml`, publish the app on `127.0.0.1:3000` (add `ports: ["127.0.0.1:3000:3000"]`
to the `app` service), and proxy your domain to it. Serve it over HTTPS: the session cookie is
`Secure` by default.

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

## Run locally (Node 22.13+)

```bash
npm install
cp .env.example .env   # set ADMIN_PASSWORD and uncomment COOKIE_SECURE=false
npm start              # http://localhost:3000
npm test
```

## License

[MIT](LICENSE)

> SupaKeep is not affiliated with Supabase.
