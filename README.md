# Manga Tracker

Eine einfache Web-App, um vorhandene Manga-Serien zu tracken. Die Daten werden in einer SQLite-Datenbank gespeichert.

## Funktionen

- Manga-Einträge anlegen
- Einträge bearbeiten
- Einträge löschen
- Status setzen (`Geplant`, `Sammle`, `Pausiert`, `Abgeschlossen`)
- Speicherung in SQLite (`data/manga.db` lokal oder `/data/manga.db` im Docker-Container)

## Voraussetzungen (lokal)

- Node.js 20+
- npm

## Lokal starten

```bash
npm install
npm start
```

Danach ist die App unter [http://localhost:3000](http://localhost:3000) erreichbar.

## Docker Build & Run

```bash
docker compose up --build -d
```

Dann läuft die App unter [http://localhost:3000](http://localhost:3000).

### Datenpersistenz

In `docker-compose.yml` ist ein Volume (`manga_data`) eingerichtet. Dadurch bleiben deine Daten auch nach einem Container-Neustart erhalten.

## Docker Image veröffentlichen (Docker Hub)

Beispiel mit Docker-Hub-User `DEIN_USER` und Image `manga-tracker`:

```bash
docker build -t DEIN_USER/manga-tracker:1.0.0 .
docker tag DEIN_USER/manga-tracker:1.0.0 DEIN_USER/manga-tracker:latest
docker login
docker push DEIN_USER/manga-tracker:1.0.0
docker push DEIN_USER/manga-tracker:latest
```

Danach kann das Image so gestartet werden:

```bash
docker run -d -p 3000:3000 -e DB_FILE=/data/manga.db -v manga_data:/data DEIN_USER/manga-tracker:latest
```

## API-Endpunkte

- `GET /api/manga` - Alle Einträge abrufen
- `POST /api/manga` - Eintrag erstellen
- `PUT /api/manga/:id` - Eintrag aktualisieren
- `DELETE /api/manga/:id` - Eintrag löschen
- `GET /api/health` - Healthcheck
