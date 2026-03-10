const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "manga.db");

let db;

async function ensureColumn(table, name, definition) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  const exists = columns.some((column) => column.name === name);

  if (!exists) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function initDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database
  });

  await db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS mangas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      total_volumes INTEGER,
      owned_volumes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Sammle',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (owned_volumes >= 0),
      CHECK (total_volumes IS NULL OR total_volumes >= 0),
      CHECK (status IN ('Geplant', 'Sammle', 'Pausiert', 'Abgeschlossen'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TRIGGER IF NOT EXISTS set_updated_at
    AFTER UPDATE ON mangas
    FOR EACH ROW
    BEGIN
      UPDATE mangas
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = OLD.id;
    END;
  `);

  await ensureColumn("mangas", "author_name", "author_name TEXT");
  await ensureColumn("mangas", "cover_url", "cover_url TEXT");
  await ensureColumn("mangas", "hardcover_book_id", "hardcover_book_id TEXT");
  await ensureColumn("mangas", "missing_volumes", "missing_volumes TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("mangas", "media_type", "media_type TEXT NOT NULL DEFAULT 'manga'");
  await ensureColumn("mangas", "genres", "genres TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("mangas", "moods", "moods TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("mangas", "content_warnings", "content_warnings TEXT NOT NULL DEFAULT '[]'");
  await ensureColumn("mangas", "rating", "rating REAL");
  await ensureColumn("mangas", "ratings_count", "ratings_count INTEGER");
  await ensureColumn("mangas", "pages", "pages INTEGER");
  await ensureColumn("mangas", "release_year", "release_year INTEGER");

  await db.run("UPDATE mangas SET media_type = LOWER(TRIM(media_type)) WHERE media_type IS NOT NULL");
  await db.run(
    "UPDATE mangas SET media_type = 'manga' WHERE media_type IS NULL OR TRIM(media_type) = '' OR media_type NOT IN ('manga', 'book')"
  );
  await db.run(
    "UPDATE mangas SET owned_volumes = 1, total_volumes = 1, missing_volumes = '[]' WHERE media_type = 'book'"
  );
  await db.run(
    "UPDATE mangas SET genres = '[]' WHERE genres IS NULL OR TRIM(genres) = ''"
  );
  await db.run(
    "UPDATE mangas SET moods = '[]' WHERE moods IS NULL OR TRIM(moods) = ''"
  );
  await db.run(
    "UPDATE mangas SET content_warnings = '[]' WHERE content_warnings IS NULL OR TRIM(content_warnings) = ''"
  );

  await db.run(
    "UPDATE mangas SET missing_volumes = '[]' WHERE missing_volumes IS NULL OR TRIM(missing_volumes) = ''"
  );

  return db;
}

module.exports = {
  initDb
};
