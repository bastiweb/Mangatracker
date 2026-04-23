# Manga Tracker

Web app to manage your manga series and books with an SQLite database, Hardcover integration, search/sort/filter, and Docker setup.

## Pages

- `/` Overview with search, sorting, genre filter, and missing volumes
- `/create` Create/edit manga series and books
- `/settings` Settings (profile, Hardcover token for admins, import/export)
- `/admin` Admin user management (roles, registration toggle, password reset)
- `/login` Login
- `/forgot-password` Emergency admin password reset (when enabled)
- `/register` Registration (first setup or admin-only)

## Features

- Create, edit, and delete manga series and books
- Choose media type (manga series or book)
- Search in overview (title, author, notes, status)
- Server-side full-text search (SQLite FTS5) for scalable overview filtering
- Sorting (last updated, title, owned volumes)
- Genre filter in overview
- Mark missing volumes explicitly (per volume)
- Hardcover search with author + cover selection
- Hardcover API token stored in the database
- Ratings (1–5 stars) + optional written review
- CSV export/import for your library
- Dark mode toggle
- Language toggle (German/English)
- Multi-user login (admin/user) with sessions
- Usernames shown in the navigation and editable in Settings
- Login via email or username
- Optional emergency password reset for locked-out admin accounts (via secret env key)
- Username rules: min. 3 chars, no `@`, allowed `a-z A-Z 0-9 . _ -` and spaces
- Admin page with user management (roles, registration toggle, password reset, force logout)
- CSRF protection for write API requests via strict same-origin checks
- Security headers (CSP, HSTS, nosniff, frame deny) and no-store caching for auth/admin/settings APIs
- `X-Request-Id` response header for easier API error tracing in logs
- Password reset invalidates active sessions for the target user
- Automatic encrypted DB backups with retention cleanup (configurable via env vars)
- Persistent admin audit log for role/registration/password/token/backup actions

## Hardcover API

The app uses the following server-side settings:

- Endpoint: `https://api.hardcover.app/v1/graphql`
- Headers:
  - `content-type: application/json`
  - `authorization: <API token from Settings>`

Searches are performed by manga/book title and return up to 5 matches to choose from.

## Security-related env vars

- `DB_ENCRYPTION_KEY` (required): encryption key for the SQLite database
- `TRUST_PROXY` (`true`/`false`, default `false`): enable when running behind reverse proxy (e.g. Caddy)
- `CSRF_TRUSTED_ORIGINS` (optional): comma-separated additional allowed origins for write API requests
- `BACKUP_ENABLED` (`true`/`false`, default `false` in app, `true` in docker-compose): enables scheduled DB backups
- `BACKUP_INTERVAL_MINUTES` (default `1440`): backup interval in minutes
- `BACKUP_RETENTION_DAYS` (default `14`): deletes older backups automatically
- `BACKUP_DIR` (default `/backups` in docker-compose): backup target directory
- `EMERGENCY_RESET_KEY` (optional): enables `/forgot-password` + `/api/auth/emergency-password-reset` for admin password recovery

## Admin password recovery

### Option A (web): emergency reset page

If `EMERGENCY_RESET_KEY` is set, you can use:

- `/forgot-password` UI
- `POST /api/auth/emergency-password-reset`

This only resets **admin** accounts and invalidates active sessions for that account.

### Option B (offline): update/create admin via script

If web reset is not available, use the local script:

```bash
docker compose exec manga-tracker node scripts/upsert-admin-user.js <email> <username> <password>
```

This works even when no admin can log in.

## Local requirements

- Node.js 20+
- npm

## Tests

Run the integration test suite:

```bash
npm run test:integration
```

The tests start a temporary server instance with an encrypted test database and validate auth, roles, reviews, import/export, and user isolation.

## Run locally

```bash
npm install
npm start
```

The app will be available at [http://localhost:3003](http://localhost:3003).
HTTPS is only available via the Docker setup with Caddy.

## Docker build & run

Before the first start, create a local env file:

```bash
cp .env.example .env
```

Then set a strong `DB_ENCRYPTION_KEY` in `.env`.

```bash
docker compose up --build -d
```

The app is available via Caddy at [https://localhost](https://localhost).

## Local HTTPS (Caddy)

The Docker setup includes a Caddy reverse proxy with local TLS. To make your browser trust `https://localhost`, import the Caddy root certificate once.

### 1) Export the Caddy root certificate

```bash
docker cp manga-tracker-caddy:/data/caddy/pki/authorities/local/root.crt .\caddy-root.crt
```

### 2) Install the certificate as trusted (Windows)

PowerShell as Administrator:

```powershell
Import-Certificate -FilePath .\caddy-root.crt -CertStoreLocation Cert:\LocalMachine\Root
```

After that, `https://localhost` should work without certificate warnings.

### 3) Optional: enable `mangatracker.local`

If you want to use `https://mangatracker.local`, add it to your hosts file:

```
127.0.0.1 mangatracker.local
```

File: `C:\Windows\System32\drivers\etc\hosts` (open your editor as Administrator).

### Data persistence

`docker-compose.yml` defines a volume (`manga_data`) so data and settings (including tokens) persist across restarts.
Scheduled backup files are written to `./backups` on the host.

## Backup and restore

### Automatic backup

Backups are created automatically by the app (when `BACKUP_ENABLED=true`).

- Interval: `BACKUP_INTERVAL_MINUTES`
- Retention: `BACKUP_RETENTION_DAYS`
- Directory: `BACKUP_DIR` (in Docker mapped to `./backups`)

### Manual backup (admin API)

```bash
POST /api/admin/backups/run
```

### Restore plan (Windows / PowerShell)

Use the included restore script:

```powershell
.\scripts\restore-from-backup.ps1 -BackupFile .\backups\manga-db-backup-YYYY-MM-DDTHH-mm-ss-sssZ.db
```

What it does:

1. Stops `manga-tracker` and `caddy`
2. Creates a pre-restore copy of the current DB in `data/`
3. Restores the selected backup into `data/manga.db`
4. Starts the stack again (unless `-NoStart` is used)

After restore, verify:

```bash
docker compose ps
```

and open [https://localhost](https://localhost).

## CI quality and security gates

The GitHub workflow runs before Docker publishing:

- Integration tests (`npm run test:integration`)
- Dependency audit (`npm audit --omit=dev --audit-level=high`)
- Trivy filesystem scan (`HIGH`/`CRITICAL`)
- SBOM generation (CycloneDX artifact)

## API endpoints

- `GET /api/health`
- `GET /api/auth/bootstrap`
- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/emergency-password-reset`
- `POST /api/auth/logout`
- `POST /api/auth/register`
- `GET /api/manga` (supports `q`, `sort`, `genre`, optional `page`, `pageSize`)
- `GET /api/manga/genres`
- `GET /api/manga/:id`
- `POST /api/manga`
- `PUT /api/manga/:id`
- `PATCH /api/manga/:id/volumes`
- `PATCH /api/manga/:id/missing-volumes`
- `PATCH /api/manga/:id/review`
- `DELETE /api/manga/:id`
- `GET /api/settings/hardcover-token`
- `PUT /api/settings/hardcover-token`
- `PUT /api/settings/profile`
- `GET /api/admin/audit`
- `GET /api/admin/backups`
- `POST /api/admin/backups/run`
- `GET /api/admin/users` (supports `q`, `role`, `sort`, optional `page`, `pageSize`)
- `GET /api/hardcover/search?query=<search>`
- `GET /api/export/csv`
- `POST /api/import/csv`
- `POST /api/import/csv/preview`
