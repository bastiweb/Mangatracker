const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "manga.db");
const DB_ENCRYPTION_KEY = String(process.env.DB_ENCRYPTION_KEY || "");

let db;

function escapePragmaValue(value) {
  return String(value).replace(/'/g, "''");
}

function openEncryptedDatabase(filename, key) {
  const fileExists = fs.existsSync(filename) && fs.statSync(filename).size > 0;
  const escapedKey = escapePragmaValue(key);

  const applyKey = (rawDb) => {
    rawDb.pragma(`key = '${escapedKey}'`);
  };

  const verifyDatabase = (rawDb) => {
    rawDb.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
  };

  let raw = new Database(filename);

  try {
    applyKey(raw);
    verifyDatabase(raw);
    return raw;
  } catch (error) {
    if (!fileExists) {
      raw.close();
      throw error;
    }

    raw.close();

    const plain = new Database(filename);
    try {
      verifyDatabase(plain);
      plain.pragma(`rekey = '${escapedKey}'`);
      plain.close();
    } catch (rekeyError) {
      plain.close();
      throw rekeyError;
    }

    const reopened = new Database(filename);
    applyKey(reopened);
    verifyDatabase(reopened);
    return reopened;
  }
}

function createDb(filename) {
  if (!DB_ENCRYPTION_KEY) {
    throw new Error("DB_ENCRYPTION_KEY fehlt. Die Datenbank muss verschlüsselt betrieben werden.");
  }

  const raw = openEncryptedDatabase(filename, DB_ENCRYPTION_KEY);

  return {
    exec(sql) {
      raw.exec(sql);
    },
    run(sql, params) {
      const stmt = raw.prepare(sql);
      const info = params !== undefined ? stmt.run(params) : stmt.run();

      return {
        changes: info.changes,
        lastID: info.lastInsertRowid ? Number(info.lastInsertRowid) : undefined
      };
    },
    get(sql, params) {
      const stmt = raw.prepare(sql);
      return params !== undefined ? stmt.get(params) : stmt.get();
    },
    all(sql, params) {
      const stmt = raw.prepare(sql);
      return params !== undefined ? stmt.all(params) : stmt.all();
    }
  };
}

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

  db = createDb(DB_FILE);

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

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

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
  await ensureColumn("mangas", "user_rating", "user_rating INTEGER");
  await ensureColumn("mangas", "user_review", "user_review TEXT");
  await ensureColumn("mangas", "user_id", "user_id INTEGER");

  await db.run("UPDATE mangas SET media_type = LOWER(TRIM(media_type)) WHERE media_type IS NOT NULL");
  await db.run(
    "UPDATE mangas SET media_type = 'manga' WHERE media_type IS NULL OR TRIM(media_type) = '' OR media_type NOT IN ('manga', 'book')"
  );
  await db.run(
    "UPDATE mangas SET owned_volumes = 1, total_volumes = 1, missing_volumes = '[]' WHERE media_type = 'book'"
  );
  await db.run("UPDATE mangas SET genres = '[]' WHERE genres IS NULL OR TRIM(genres) = ''");
  await db.run("UPDATE mangas SET moods = '[]' WHERE moods IS NULL OR TRIM(moods) = ''");
  await db.run(
    "UPDATE mangas SET content_warnings = '[]' WHERE content_warnings IS NULL OR TRIM(content_warnings) = ''"
  );

  await db.run(
    "UPDATE mangas SET missing_volumes = '[]' WHERE missing_volumes IS NULL OR TRIM(missing_volumes) = ''"
  );

  await db.run("UPDATE users SET email = LOWER(TRIM(email)) WHERE email IS NOT NULL");

  return db;
}

module.exports = {
  initDb
};
