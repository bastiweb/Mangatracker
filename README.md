# Manga Tracker

Web app to manage your manga series and books with an SQLite database, Hardcover integration, search/sort/filter, and Docker setup.

## Pages

- `/` Overview with search, sorting, genre filter, and missing volumes
- `/create` Create/edit manga series and books
- `/settings` Settings (profile, Hardcover token for admins, import/export)
- `/admin` Admin user management (roles, registration toggle, password reset)
- `/login` Login
- `/register` Registration (first setup or admin-only)

## Features

- Create, edit, and delete manga series and books
- Choose media type (manga series or book)
- Search in overview (title, author, notes, status)
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
- Admin page with user management (roles, registration toggle, password reset, force logout)

## Hardcover API

The app uses the following server-side settings:

- Endpoint: `https://api.hardcover.app/v1/graphql`
- Headers:
  - `content-type: application/json`
  - `authorization: <API token from Settings>`

Searches are performed by manga/book title and return up to 5 matches to choose from.

## Local requirements

- Node.js 20+
- npm

## Run locally

```bash
npm install
npm start
```

The app will be available at [http://localhost:3003](http://localhost:3003).
HTTPS is only available via the Docker setup with Caddy.

## Docker build & run

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

## Publish Docker image (Docker Hub)

Example with Docker Hub user `YOUR_USER` and image `manga-tracker`:

```bash
docker build -t YOUR_USER/manga-tracker:1.0.0 .
docker tag YOUR_USER/manga-tracker:1.0.0 YOUR_USER/manga-tracker:latest
docker login
docker push YOUR_USER/manga-tracker:1.0.0
docker push YOUR_USER/manga-tracker:latest
```

Run the published image:

```bash
docker run -d -p 3003:3003 -e DB_FILE=/data/manga.db -v manga_data:/data YOUR_USER/manga-tracker:latest
```

Note: The image alone serves HTTP on port `3003`. Use `docker-compose.yml` with Caddy for HTTPS.

## API endpoints

- `GET /api/health`
- `GET /api/auth/bootstrap`
- `GET /api/auth/me`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/register`
- `GET /api/manga`
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
- `GET /api/hardcover/search?query=<search>`
- `GET /api/export/csv`
- `POST /api/import/csv`
- `POST /api/import/csv/preview`
