const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3-multiple-ciphers");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "manga.db");
const DB_ENCRYPTION_KEY = String(process.env.DB_ENCRYPTION_KEY || "");
const MANGA_FTS_TABLE = "mangas_fts";

let db;
const USERNAME_MAX_LENGTH = 40;

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
    },
    prepare(sql) {
      return raw.prepare(sql);
    },
    transaction(fn) {
      return raw.transaction(fn);
    }
  };
}

function normalizeUsername(value, maxLength = USERNAME_MAX_LENGTH) {
  if (typeof value !== "string") {
    return "";
  }

  // Keep username migration in sync with runtime validation rules.
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/@/g, "")
    .replace(/[^a-zA-Z0-9._\- ]+/g, "")
    .slice(0, maxLength);
}

function deriveUsernameFromEmail(email, maxLength = USERNAME_MAX_LENGTH) {
  if (typeof email !== "string") {
    return "";
  }

  const normalizedEmail = email.trim();
  const atIndex = normalizedEmail.indexOf("@");
  const base = atIndex > 0 ? normalizedEmail.slice(0, atIndex) : normalizedEmail;
  return normalizeUsername(base, maxLength);
}

function allocateUniqueUsername(base, usedKeys, maxLength = USERNAME_MAX_LENGTH) {
  let normalizedBase = normalizeUsername(base, maxLength);
  if (!normalizedBase) {
    normalizedBase = "user";
  }

  let candidate = normalizedBase;
  let suffix = 1;

  while (usedKeys.has(candidate.toLowerCase())) {
    const suffixText = `-${suffix}`;
    const baseLength = Math.max(1, maxLength - suffixText.length);
    candidate = `${normalizedBase.slice(0, baseLength)}${suffixText}`;
    suffix += 1;
  }

  usedKeys.add(candidate.toLowerCase());
  return candidate;
}

function ensureColumn(table, name, definition) {
  const columns = db.all(`PRAGMA table_info(${table})`);
  const exists = columns.some((column) => column.name === name);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function ensureMangaFts() {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${MANGA_FTS_TABLE} USING fts5(
      manga_id UNINDEXED,
      user_id UNINDEXED,
      title,
      author_name,
      notes,
      status,
      media_type,
      genres,
      moods,
      content_warnings,
      user_review,
      tokenize = "unicode61"
    );
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mangas_fts_ai
    AFTER INSERT ON mangas
    BEGIN
      INSERT INTO ${MANGA_FTS_TABLE} (
        rowid,
        manga_id,
        user_id,
        title,
        author_name,
        notes,
        status,
        media_type,
        genres,
        moods,
        content_warnings,
        user_review
      )
      VALUES (
        NEW.id,
        NEW.id,
        COALESCE(NEW.user_id, 0),
        COALESCE(NEW.title, ''),
        COALESCE(NEW.author_name, ''),
        COALESCE(NEW.notes, ''),
        COALESCE(NEW.status, ''),
        COALESCE(NEW.media_type, ''),
        COALESCE(NEW.genres, ''),
        COALESCE(NEW.moods, ''),
        COALESCE(NEW.content_warnings, ''),
        COALESCE(NEW.user_review, '')
      );
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mangas_fts_ad
    AFTER DELETE ON mangas
    BEGIN
      DELETE FROM ${MANGA_FTS_TABLE}
      WHERE rowid = OLD.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mangas_fts_au
    AFTER UPDATE ON mangas
    BEGIN
      DELETE FROM ${MANGA_FTS_TABLE}
      WHERE rowid = OLD.id;

      INSERT INTO ${MANGA_FTS_TABLE} (
        rowid,
        manga_id,
        user_id,
        title,
        author_name,
        notes,
        status,
        media_type,
        genres,
        moods,
        content_warnings,
        user_review
      )
      VALUES (
        NEW.id,
        NEW.id,
        COALESCE(NEW.user_id, 0),
        COALESCE(NEW.title, ''),
        COALESCE(NEW.author_name, ''),
        COALESCE(NEW.notes, ''),
        COALESCE(NEW.status, ''),
        COALESCE(NEW.media_type, ''),
        COALESCE(NEW.genres, ''),
        COALESCE(NEW.moods, ''),
        COALESCE(NEW.content_warnings, ''),
        COALESCE(NEW.user_review, '')
      );
    END;
  `);

  // Keep FTS index synchronized on migrations without forcing full rebuild every startup.
  db.run(
    `DELETE FROM ${MANGA_FTS_TABLE} WHERE rowid NOT IN (SELECT id FROM mangas)`
  );
  db.run(
    `
      INSERT OR REPLACE INTO ${MANGA_FTS_TABLE} (
        rowid,
        manga_id,
        user_id,
        title,
        author_name,
        notes,
        status,
        media_type,
        genres,
        moods,
        content_warnings,
        user_review
      )
      SELECT
        id,
        id,
        COALESCE(user_id, 0),
        COALESCE(title, ''),
        COALESCE(author_name, ''),
        COALESCE(notes, ''),
        COALESCE(status, ''),
        COALESCE(media_type, ''),
        COALESCE(genres, ''),
        COALESCE(moods, ''),
        COALESCE(content_warnings, ''),
        COALESCE(user_review, '')
      FROM mangas
    `
  );
}

async function initDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  db = createDb(DB_FILE);

  db.exec("PRAGMA foreign_keys = ON;");

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mangas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        total_volumes INTEGER,
        owned_volumes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Sammle',
        media_type TEXT NOT NULL DEFAULT 'manga',
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (owned_volumes >= 0),
        CHECK (total_volumes IS NULL OR total_volumes >= 0),
        CHECK (status IN ('Geplant', 'Sammle', 'Pausiert', 'Abgeschlossen')),
        CHECK (media_type IN ('manga', 'book')),
        CHECK (trim(title) <> '')
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        username TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (trim(email) <> ''),
        CHECK (role IN ('user', 'admin'))
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
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);

      CREATE TRIGGER IF NOT EXISTS set_updated_at
      AFTER UPDATE ON mangas
      FOR EACH ROW
      BEGIN
        UPDATE mangas
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = OLD.id;
      END;

    `);

    ensureColumn("mangas", "author_name", "author_name TEXT");
    ensureColumn("mangas", "cover_url", "cover_url TEXT");
    ensureColumn("mangas", "hardcover_book_id", "hardcover_book_id TEXT");
    ensureColumn("mangas", "missing_volumes", "missing_volumes TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("mangas", "media_type", "media_type TEXT NOT NULL DEFAULT 'manga'");
    ensureColumn("mangas", "genres", "genres TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("mangas", "moods", "moods TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("mangas", "content_warnings", "content_warnings TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("mangas", "rating", "rating REAL");
    ensureColumn("mangas", "ratings_count", "ratings_count INTEGER");
    ensureColumn("mangas", "pages", "pages INTEGER");
    ensureColumn("mangas", "release_year", "release_year INTEGER");
    ensureColumn("mangas", "user_rating", "user_rating INTEGER");
    ensureColumn("mangas", "user_review", "user_review TEXT");
    ensureColumn("mangas", "user_id", "user_id INTEGER");
    ensureColumn("users", "username", "username TEXT");
    // Keep overview and import duplicate checks fast on larger user libraries.
    db.exec("CREATE INDEX IF NOT EXISTS idx_mangas_user_updated ON mangas(user_id, updated_at DESC, id DESC)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_mangas_user_media_title ON mangas(user_id, media_type, title)");

    db.run("UPDATE mangas SET media_type = LOWER(TRIM(media_type)) WHERE media_type IS NOT NULL");
    db.run(
      "UPDATE mangas SET media_type = 'manga' WHERE media_type IS NULL OR TRIM(media_type) = '' OR media_type NOT IN ('manga', 'book')"
    );
    db.run("UPDATE mangas SET owned_volumes = 0 WHERE owned_volumes IS NULL OR owned_volumes < 0");
    db.run("UPDATE mangas SET total_volumes = NULL WHERE total_volumes IS NOT NULL AND total_volumes < 0");
    db.run(
      "UPDATE mangas SET total_volumes = owned_volumes WHERE total_volumes IS NOT NULL AND total_volumes < owned_volumes AND media_type = 'manga'"
    );
    db.run(
      "UPDATE mangas SET owned_volumes = 1, total_volumes = 1, missing_volumes = '[]' WHERE media_type = 'book'"
    );
    db.run(
      "UPDATE mangas SET status = CASE LOWER(TRIM(status)) WHEN 'geplant' THEN 'Geplant' WHEN 'sammle' THEN 'Sammle' WHEN 'pausiert' THEN 'Pausiert' WHEN 'abgeschlossen' THEN 'Abgeschlossen' ELSE status END WHERE status IS NOT NULL"
    );
    db.run("UPDATE mangas SET status = 'Sammle' WHERE status IS NULL OR TRIM(status) = '' OR status NOT IN ('Geplant', 'Sammle', 'Pausiert', 'Abgeschlossen')");
    db.run("UPDATE mangas SET genres = '[]' WHERE genres IS NULL OR TRIM(genres) = ''");
    db.run("UPDATE mangas SET moods = '[]' WHERE moods IS NULL OR TRIM(moods) = ''");
    db.run(
      "UPDATE mangas SET content_warnings = '[]' WHERE content_warnings IS NULL OR TRIM(content_warnings) = ''"
    );

    db.run(
      "UPDATE mangas SET missing_volumes = '[]' WHERE missing_volumes IS NULL OR TRIM(missing_volumes) = ''"
    );

    db.run("UPDATE users SET role = LOWER(TRIM(role)) WHERE role IS NOT NULL");
    db.run("UPDATE users SET role = 'user' WHERE role IS NULL OR TRIM(role) = '' OR role NOT IN ('user', 'admin')");
    const users = db.all("SELECT id, email, username FROM users ORDER BY id ASC");
    const usedUsernames = new Set();

    // Normalize and deduplicate existing usernames before creating UNIQUE index.
    for (const user of users) {
      const fromUsername = normalizeUsername(user.username);
      const fromEmail = deriveUsernameFromEmail(user.email);
      const base = fromUsername || fromEmail || `user${user.id}`;
      const unique = allocateUniqueUsername(base, usedUsernames);

      if (user.username !== unique) {
        db.run("UPDATE users SET username = ? WHERE id = ?", [unique, user.id]);
      }
    }

    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)"
    );
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS validate_mangas_before_insert
      BEFORE INSERT ON mangas
      FOR EACH ROW
      WHEN COALESCE(TRIM(NEW.status), '') NOT IN ('Geplant', 'Sammle', 'Pausiert', 'Abgeschlossen')
        OR LOWER(TRIM(COALESCE(NEW.media_type, ''))) NOT IN ('manga', 'book')
        OR COALESCE(NEW.owned_volumes, -1) < 0
        OR (NEW.total_volumes IS NOT NULL AND NEW.total_volumes < 0)
        OR (
          LOWER(TRIM(COALESCE(NEW.media_type, ''))) = 'book'
          AND (COALESCE(NEW.owned_volumes, 0) <> 1 OR COALESCE(NEW.total_volumes, 0) <> 1)
        )
        OR (
          LOWER(TRIM(COALESCE(NEW.media_type, ''))) = 'manga'
          AND NEW.total_volumes IS NOT NULL
          AND NEW.total_volumes < NEW.owned_volumes
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid manga data');
      END;

      CREATE TRIGGER IF NOT EXISTS validate_mangas_before_update
      BEFORE UPDATE OF title, total_volumes, owned_volumes, status, notes, author_name, cover_url, hardcover_book_id, missing_volumes, media_type, genres, moods, content_warnings, rating, ratings_count, pages, release_year, user_rating, user_review, user_id ON mangas
      FOR EACH ROW
      WHEN COALESCE(TRIM(NEW.status), '') NOT IN ('Geplant', 'Sammle', 'Pausiert', 'Abgeschlossen')
        OR LOWER(TRIM(COALESCE(NEW.media_type, ''))) NOT IN ('manga', 'book')
        OR COALESCE(NEW.owned_volumes, -1) < 0
        OR (NEW.total_volumes IS NOT NULL AND NEW.total_volumes < 0)
        OR (
          LOWER(TRIM(COALESCE(NEW.media_type, ''))) = 'book'
          AND (COALESCE(NEW.owned_volumes, 0) <> 1 OR COALESCE(NEW.total_volumes, 0) <> 1)
        )
        OR (
          LOWER(TRIM(COALESCE(NEW.media_type, ''))) = 'manga'
          AND NEW.total_volumes IS NOT NULL
          AND NEW.total_volumes < NEW.owned_volumes
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid manga data');
      END;

      CREATE TRIGGER IF NOT EXISTS validate_users_role_before_insert
      BEFORE INSERT ON users
      FOR EACH ROW
      WHEN LOWER(TRIM(COALESCE(NEW.role, ''))) NOT IN ('user', 'admin')
      BEGIN
        SELECT RAISE(ABORT, 'invalid user role');
      END;

      CREATE TRIGGER IF NOT EXISTS validate_users_role_before_update
      BEFORE UPDATE OF role ON users
      FOR EACH ROW
      WHEN LOWER(TRIM(COALESCE(NEW.role, ''))) NOT IN ('user', 'admin')
      BEGIN
        SELECT RAISE(ABORT, 'invalid user role');
      END;
    `);
    ensureMangaFts();
  });

  migrate();

  return db;
}

module.exports = {
  initDb
};
