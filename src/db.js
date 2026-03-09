const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "manga.db");

let db;

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

    CREATE TRIGGER IF NOT EXISTS set_updated_at
    AFTER UPDATE ON mangas
    FOR EACH ROW
    BEGIN
      UPDATE mangas
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = OLD.id;
    END;
  `);

  return db;
}

module.exports = {
  initDb
};
