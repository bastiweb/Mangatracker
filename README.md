# Manga Tracker

Web-App zum Verwalten deiner Manga-Serien und Bücher mit SQLite-Datenbank, Hardcover-Anbindung, Such-/Sortierübersicht und Docker-Setup.

## Seiten

- `/` Übersicht mit Suche, Sortierung, Quick-Add und fehlenden Bänden
- `/create` Erfassung/Bearbeitung von Manga-Serien und Büchern
- `/settings` Einstellungen für Hardcover API Token

## Funktionen

- Manga-Serien und Bücher anlegen, bearbeiten und löschen
- Medientyp wählen (Manga oder Buch)
- Suchfunktion in der Übersicht (Titel, Autor, Notizen, Status)
- Sortierfunktion (zuletzt geändert, Titel, vorhandene Bände)
- Quick-Add von Bänden (`+1`, `+5`)
- Fehlende Bände explizit markieren (pro Band auswählbar)
- Hardcover-Suche mit Auswahl von Autor + Cover
- Persistente Speicherung des Hardcover API Tokens in der Datenbank
- Darkmode mit manuellem Umschalter

## Hardcover API

Die App nutzt serverseitig folgende Vorgaben:

- Endpoint: `https://api.hardcover.app/v1/graphql`
- Header:
  - `content-type: application/json`
  - `authorization: <API Token aus Settings>`

Die Suche läuft über den Manga-/Buchtitel und liefert bis zu 5 Treffer zur Auswahl.

## Voraussetzungen (lokal)

- Node.js 20+
- npm

## Lokal starten

```bash
npm install
npm start
```

Danach ist die App unter [http://localhost:3003](http://localhost:3003) erreichbar.

## Docker Build & Run

```bash
docker compose up --build -d
```

Dann läuft die App unter [http://localhost:3003](http://localhost:3003).

### Datenpersistenz

In `docker-compose.yml` ist ein Volume (`manga_data`) eingerichtet. Dadurch bleiben Daten und Settings (inkl. Token) nach Neustarts erhalten.

## Docker Image veröffentlichen (Docker Hub)

Beispiel mit Docker-Hub-User `DEIN_USER` und Image `manga-tracker`:

```bash
docker build -t DEIN_USER/manga-tracker:1.0.0 .
docker tag DEIN_USER/manga-tracker:1.0.0 DEIN_USER/manga-tracker:latest
docker login
docker push DEIN_USER/manga-tracker:1.0.0
docker push DEIN_USER/manga-tracker:latest
```

Start vom veröffentlichten Image:

```bash
docker run -d -p 3003:3003 -e DB_FILE=/data/manga.db -v manga_data:/data DEIN_USER/manga-tracker:latest
```

## API-Endpunkte

- `GET /api/health`
- `GET /api/manga`
- `GET /api/manga/:id`
- `POST /api/manga`
- `PUT /api/manga/:id`
- `PATCH /api/manga/:id/volumes`
- `PATCH /api/manga/:id/missing-volumes`
- `DELETE /api/manga/:id`
- `GET /api/settings/hardcover-token`
- `PUT /api/settings/hardcover-token`
- `GET /api/hardcover/search?query=<suchbegriff>`
