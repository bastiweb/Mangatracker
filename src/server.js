const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3003;
const ALLOWED_STATUS = ["Geplant", "Sammle", "Pausiert", "Abgeschlossen"];
const ALLOWED_MEDIA_TYPES = ["manga", "book"];
const ALLOWED_ROLES = ["user", "admin"];
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 200;
const USERNAME_MAX_LENGTH = 40;
const USERNAME_MIN_LENGTH = 3;
const SESSION_COOKIE = "manga_tracker_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_CLEANUP_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 15;
const LOGIN_RATE_LIMIT_CLEANUP_MS = 5 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ENTRIES = 10000;
const EMERGENCY_RESET_KEY = String(process.env.EMERGENCY_RESET_KEY || "").trim();
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";
const CSRF_TRUSTED_ORIGINS = String(process.env.CSRF_TRUSTED_ORIGINS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const BACKUP_ENABLED = String(process.env.BACKUP_ENABLED || "false").toLowerCase() === "true";
const BACKUP_INTERVAL_MINUTES = parseEnvPositiveInt(process.env.BACKUP_INTERVAL_MINUTES, 24 * 60);
const BACKUP_RETENTION_DAYS = parseEnvPositiveInt(process.env.BACKUP_RETENTION_DAYS, 14);
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(__dirname, "..", "backups");
const BACKUP_FILE_PREFIX = "manga-db-backup";
const HARDCOVER_TOKEN_KEY = "hardcover_api_token";
const REGISTRATION_SETTING_KEY = "allow_registration";
const HARDCOVER_ENDPOINT = "https://api.hardcover.app/v1/graphql";
const MANGA_SORT_SQL = {
  updated_desc: "m.updated_at DESC, m.id DESC",
  title_asc: "m.title COLLATE NOCASE ASC, m.id ASC",
  title_desc: "m.title COLLATE NOCASE DESC, m.id DESC",
  owned_desc: "m.owned_volumes DESC, m.id DESC",
  owned_asc: "m.owned_volumes ASC, m.id ASC"
};
const ADMIN_USER_SORT_SQL = {
  created_asc: "users.created_at ASC, users.id ASC",
  created_desc: "users.created_at DESC, users.id DESC",
  email_asc: "users.email COLLATE NOCASE ASC, users.id ASC",
  email_desc: "users.email COLLATE NOCASE DESC, users.id DESC",
  entries_desc: "entries_count DESC, users.id DESC",
  sessions_desc: "session_count DESC, users.id DESC",
  last_login_desc: "last_session_at DESC, users.id DESC"
};
const loginRateLimitState = new Map();
let lastRateLimitCleanupAt = 0;
let lastSessionCleanupAt = 0;
let backupInProgress = false;
let backupIntervalHandle = null;

function parseEnvPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

app.set("trust proxy", TRUST_PROXY ? 1 : false);
app.use(express.json());
app.use(
  express.text({
    type: ["text/*", "application/csv", "text/csv"],
    limit: "5mb"
  })
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "");
  const isSecureRequest = req.secure || forwardedProto.toLowerCase().includes("https");
  if (isSecureRequest) {
    // Enforce HTTPS after first secure response.
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  if (!req.path.startsWith("/api/")) {
    // Keep CSP strict for scripts and forms. Styles allow inline because UI updates color dynamically.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; form-action 'self'"
    );
  }

  return next();
});
app.use((req, res, next) => {
  const requestId = createRequestId();
  const startedAt = process.hrtime.bigint();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    if (!req.path.startsWith("/api/")) {
      return;
    }
    if (req.path === "/api/health") {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const userId = req.user && req.user.id ? req.user.id : "anonymous";

    // Keep API access logs compact and machine-parsable for troubleshooting.
    console.log(
      `[api] request_id=${requestId} method=${req.method} path=${req.path} status=${res.statusCode} duration_ms=${durationMs.toFixed(
        1
      )} user_id=${userId}`
    );
  });

  return next();
});
app.use(async (req, res, next) => {
  if (req.path === "/admin.html") {
    try {
      const user = await getSessionUser(req);
      if (!user) {
        return res.redirect("/login");
      }
      if (user.role !== "admin") {
        return res.redirect("/");
      }
    } catch (error) {
      console.error(error);
      return res.status(500).send("Auth check failed.");
    }
  }
  return next();
});
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));
app.use(requireSameOriginForWrites);
app.use((req, res, next) => {
  if (
    req.path.startsWith("/api/auth/") ||
    req.path.startsWith("/api/admin/") ||
    req.path.startsWith("/api/settings/")
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  return next();
});

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}
function parseOptionalInt(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  return parseNonNegativeInt(value);
}

function parseOptionalFloat(value, maxValue = null) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  if (maxValue !== null && parsed > maxValue) {
    return null;
  }

  return Math.round(parsed * 100) / 100;
}

function parseBoundedPositiveInt(value, fallback, minValue, maxValue) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  if (parsed < minValue) {
    return minValue;
  }
  if (parsed > maxValue) {
    return maxValue;
  }
  return parsed;
}

function hasQueryValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeSortMode(rawSort) {
  const sort = sanitizeText(String(rawSort || ""), 40);
  if (Object.prototype.hasOwnProperty.call(MANGA_SORT_SQL, sort)) {
    return sort;
  }
  return "updated_desc";
}

function normalizeAdminUserSortMode(rawSort) {
  const sort = sanitizeText(String(rawSort || ""), 40);
  if (Object.prototype.hasOwnProperty.call(ADMIN_USER_SORT_SQL, sort)) {
    return sort;
  }
  return "created_asc";
}

function normalizeGenreFilter(rawGenre) {
  if (!rawGenre || rawGenre === "all") {
    return "";
  }
  return sanitizeText(String(rawGenre || ""), 80);
}

function buildFtsQuery(rawInput) {
  const input = sanitizeText(String(rawInput || ""), 200).toLowerCase();
  if (!input) {
    return "";
  }

  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/["']/g, "").trim())
    .map((term) => term.replace(/[^\p{L}\p{N}._\-]+/gu, ""))
    .filter((term) => term.length >= 2)
    .slice(0, 8);

  if (terms.length === 0) {
    return "";
  }

  // Prefix queries keep the search responsive while still matching incomplete inputs.
  return terms.map((term) => `"${term}"*`).join(" AND ");
}

function createRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString("hex");
}

function sanitizeTextArray(value, maxItems = 12, maxLength = 60) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => sanitizeText(String(entry || ""), maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseId(id) {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function sanitizeText(value, maxLength = 1000) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function sanitizeCoverUrl(value) {
  const sanitized = sanitizeText(value, 600);
  if (!sanitized) {
    return "";
  }

  try {
    const parsed = new URL(sanitized);
    // Only allow http(s) image sources to avoid scriptable URL schemes.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "";
    }
    return parsed.toString().slice(0, 600);
  } catch {
    return "";
  }
}

function normalizeMissingVolumes(value, totalVolumes) {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Set();
  for (const entry of value) {
    const parsed = Number(entry);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      continue;
    }

    if (totalVolumes !== null && parsed > totalVolumes) {
      continue;
    }

    unique.add(parsed);
  }

  return Array.from(unique).sort((a, b) => a - b);
}

function parseMissingVolumesFromDb(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
function parseTextArrayFromDb(value, maxItems = 12) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => sanitizeText(String(entry || ""), 80))
      .filter(Boolean)
      .slice(0, maxItems);
  } catch {
    return [];
  }
}
function sanitizeEmail(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase().slice(0, 200);
}

function sanitizeUsername(value, maxLength = USERNAME_MAX_LENGTH) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function validateUsername(username) {
  // Keep this policy aligned with frontend validation and DB migration.
  if (!username) {
    return "Bitte einen Benutzernamen angeben.";
  }

  if (username.length < USERNAME_MIN_LENGTH) {
    return `Benutzername muss mindestens ${USERNAME_MIN_LENGTH} Zeichen haben.`;
  }

  if (username.includes("@")) {
    return "Benutzername darf kein @ enthalten.";
  }

  if (!/^[a-zA-Z0-9._\- ]+$/.test(username)) {
    return "Benutzername enthält ungültige Zeichen.";
  }

  return null;
}

function parseCookies(header) {
  if (!header) {
    return {};
  }

  return header.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) {
      return acc;
    }

    const rawValue = rest.join("=");
    try {
      acc[key] = decodeURIComponent(rawValue);
    } catch {
      // Fallback to raw cookie value when decoding fails.
      acc[key] = rawValue;
    }
    return acc;
  }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || "";
}

function getClientAddress(req) {
  // req.ip already respects app.set("trust proxy", ...).
  return sanitizeText(String(req.ip || req.socket?.remoteAddress || "unknown"), 120);
}

function getRateLimitKey(req, identifier = "") {
  // Key by IP + identifier to avoid blocking unrelated accounts on one network.
  const ip = getClientAddress(req).toLowerCase();
  const normalizedIdentifier = sanitizeText(String(identifier || ""), 140).toLowerCase();
  if (!normalizedIdentifier) {
    return ip;
  }

  return `${ip}|${normalizedIdentifier}`;
}

function cleanupLoginRateLimitState(now = Date.now()) {
  if (now - lastRateLimitCleanupAt < LOGIN_RATE_LIMIT_CLEANUP_MS) {
    return;
  }
  lastRateLimitCleanupAt = now;

  for (const [key, entry] of loginRateLimitState.entries()) {
    const blocked = entry.blockedUntil && entry.blockedUntil > now;
    const windowActive = now - entry.windowStartedAt <= LOGIN_WINDOW_MS;
    if (!blocked && !windowActive) {
      loginRateLimitState.delete(key);
    }
  }

  if (loginRateLimitState.size <= LOGIN_RATE_LIMIT_MAX_ENTRIES) {
    return;
  }

  for (const key of loginRateLimitState.keys()) {
    loginRateLimitState.delete(key);
    if (loginRateLimitState.size <= LOGIN_RATE_LIMIT_MAX_ENTRIES) {
      break;
    }
  }
}

function getLoginRateLimitStatus(req, identifier = "") {
  cleanupLoginRateLimitState();
  const key = getRateLimitKey(req, identifier);
  const now = Date.now();
  const entry = loginRateLimitState.get(key);

  if (!entry) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (entry.blockedUntil && entry.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000)
    };
  }

  if (entry.blockedUntil && entry.blockedUntil <= now) {
    loginRateLimitState.set(key, {
      windowStartedAt: now,
      failures: 0,
      blockedUntil: null
    });
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (now - entry.windowStartedAt > LOGIN_WINDOW_MS) {
    loginRateLimitState.delete(key);
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

function recordLoginFailure(req, identifier = "") {
  cleanupLoginRateLimitState();
  const key = getRateLimitKey(req, identifier);
  const now = Date.now();
  const entry = loginRateLimitState.get(key);

  if (!entry || now - entry.windowStartedAt > LOGIN_WINDOW_MS) {
    loginRateLimitState.set(key, {
      windowStartedAt: now,
      failures: 1,
      blockedUntil: null
    });
    return;
  }

  entry.failures += 1;
  if (entry.failures >= LOGIN_MAX_ATTEMPTS) {
    entry.blockedUntil = now + LOGIN_BLOCK_MS;
  }
  loginRateLimitState.set(key, entry);
}

function clearLoginFailures(req, identifier = "") {
  const key = getRateLimitKey(req, identifier);
  loginRateLimitState.delete(key);
}

function normalizeOrigin(value) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return "";
  }
}

function getRequestOrigin(req) {
  const origin = sanitizeText(String(req.headers.origin || ""), 300);
  if (origin) {
    return normalizeOrigin(origin);
  }

  const referer = sanitizeText(String(req.headers.referer || ""), 600);
  if (referer) {
    return normalizeOrigin(referer);
  }

  return "";
}

function getExpectedOrigin(req) {
  const forwardedProto = sanitizeText(String(req.headers["x-forwarded-proto"] || ""), 40);
  const proto = forwardedProto ? forwardedProto.split(",")[0].trim().toLowerCase() : req.secure ? "https" : "http";
  const forwardedHost = sanitizeText(String(req.headers["x-forwarded-host"] || ""), 220);
  const host = (forwardedHost ? forwardedHost.split(",")[0].trim() : sanitizeText(String(req.headers.host || ""), 220)).toLowerCase();

  if (!host) {
    return "";
  }

  return normalizeOrigin(`${proto}://${host}`);
}

function isTrustedOrigin(origin, expectedOrigin) {
  if (!origin) {
    return false;
  }

  if (expectedOrigin && origin === expectedOrigin) {
    return true;
  }

  return CSRF_TRUSTED_ORIGINS.includes(origin);
}

function requireSameOriginForWrites(req, res, next) {
  if (!req.path.startsWith("/api/")) {
    return next();
  }

  const method = String(req.method || "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }

  const origin = getRequestOrigin(req);
  const expectedOrigin = getExpectedOrigin(req);

  // Reject cross-site write requests to reduce CSRF risk for cookie-based auth.
  if (!isTrustedOrigin(origin, expectedOrigin)) {
    return res.status(403).json({ error: "CSRF protection: invalid request origin." });
  }

  return next();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isValidEmergencyResetKey(candidate) {
  if (!EMERGENCY_RESET_KEY) {
    return false;
  }

  const expected = crypto.createHash("sha256").update(EMERGENCY_RESET_KEY).digest();
  const actual = crypto
    .createHash("sha256")
    .update(String(candidate || "").trim())
    .digest();
  return crypto.timingSafeEqual(expected, actual);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function parsePasswordHash(storedHash) {
  if (!storedHash) {
    return null;
  }

  if (storedHash.includes("$")) {
    const [scheme, saltHex, hashHex] = storedHash.split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) {
      return null;
    }

    return { scheme, saltHex, hashHex, legacy: false };
  }

  if (storedHash.startsWith("scrypt")) {
    const legacy = storedHash.slice("scrypt".length);
    const saltHex = legacy.slice(0, 32);
    const hashHex = legacy.slice(32);
    if (saltHex.length !== 32 || hashHex.length !== 128) {
      return null;
    }

    return { scheme: "scrypt", saltHex, hashHex, legacy: true };
  }

  return null;
}

function verifyPassword(password, storedHash) {
  const parsed = parsePasswordHash(storedHash);
  if (!parsed) {
    return { ok: false, legacy: false };
  }

  const hash = crypto.scryptSync(password, Buffer.from(parsed.saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(parsed.hashHex, "hex");

  if (expected.length !== hash.length) {
    return { ok: false, legacy: parsed.legacy };
  }

  return { ok: crypto.timingSafeEqual(expected, hash), legacy: parsed.legacy };
}

function sanitizeUser(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    role: row.role,
    username: row.username || ""
  };
}

function buildSessionCookieOptions(req) {
  const forwardedProto = sanitizeText(String(req.headers["x-forwarded-proto"] || ""), 40)
    .split(",")[0]
    .trim()
    .toLowerCase();
  const isSecure = req.secure || forwardedProto === "https";

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/"
  };
}

async function cleanupExpiredSessions(db, nowSeconds) {
  const nowMs = Date.now();
  if (nowMs - lastSessionCleanupAt < SESSION_CLEANUP_MS) {
    return;
  }

  lastSessionCleanupAt = nowMs;
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", [nowSeconds]);
}

async function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }

  const db = await initDb();
  const tokenHash = hashToken(token);
  const now = Math.floor(Date.now() / 1000);
  await cleanupExpiredSessions(db, now);

  const row = await db.get(
    "SELECT sessions.user_id, sessions.expires_at, users.email, users.role, users.username FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    [tokenHash, now]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    username: row.username || ""
  };
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: "Bitte erneut einloggen." });
    }

    req.user = user;
    return next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Authentifizierung fehlgeschlagen." });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: "Bitte erneut einloggen." });
    }

    if (user.role !== "admin") {
      return res.status(403).json({ error: "Keine Berechtigung." });
    }

    req.user = user;
    return next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Authentifizierung fehlgeschlagen." });
  }
}

async function fetchMangaForUser(db, id, user) {
  return db.get("SELECT * FROM mangas WHERE id = ? AND user_id = ?", [id, user.id]);
}
function normalizeMangaRow(row) {
  const mediaType = row.media_type === "book" ? "book" : "manga";

  return {
    ...row,
    media_type: mediaType,
    author_name: row.author_name || "",
    cover_url: sanitizeCoverUrl(row.cover_url || ""),
    hardcover_book_id: row.hardcover_book_id || "",
    missing_volumes: mediaType === "book" ? [] : parseMissingVolumesFromDb(row.missing_volumes),
    genres: parseTextArrayFromDb(row.genres),
    moods: parseTextArrayFromDb(row.moods, 10),
    content_warnings: parseTextArrayFromDb(row.content_warnings, 10),
    rating: row.rating ?? null,
    ratings_count: row.ratings_count ?? null,
    pages: row.pages ?? null,
    release_year: row.release_year ?? null,
    user_rating: row.user_rating ?? null,
    user_review: row.user_review ?? ""
  };
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  let stringValue = String(value);
  if (/^[\t\r ]*[=+\-@]/.test(stringValue)) {
    // Prevent CSV formula injection in spreadsheet tools.
    stringValue = `'${stringValue}`;
  }

  if (stringValue.includes("\"") || stringValue.includes(",") || stringValue.includes("\n") || stringValue.includes("\r")) {
    return `"${stringValue.replace(/"/g, "\"\"")}"`;
  }

  return stringValue;
}

function joinCsvArray(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }

  return value.join(" | ");
}

function parseCsv(content) {
  if (typeof content !== "string") {
    return [];
  }

  const text = content.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === "\"") {
        if (text[i + 1] === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entries) => entries.some((entry) => String(entry || "").trim() !== ""));
}

function parseCsvList(value, maxLength = 60) {
  if (!value) {
    return [];
  }

  return String(value)
    .split("|")
    .map((entry) => sanitizeText(entry, maxLength))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCsvNumbers(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split("|")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function buildImportKey(title, mediaType) {
  return `${String(mediaType || "").toLowerCase()}::${String(title || "").trim().toLowerCase()}`;
}

function validateReviewPayload(payload) {
  const ratingRaw = payload?.userRating;
  const review = sanitizeText(payload?.userReview || "", 1200);

  if (ratingRaw === null || ratingRaw === undefined || ratingRaw === "") {
    return { value: { userRating: null, userReview: review || "" } };
  }

  const rating = Number(ratingRaw);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { error: "Bewertung muss zwischen 1 und 5 liegen." };
  }

  return { value: { userRating: rating, userReview: review || "" } };
}

function validatePayload(payload) {
  const title = sanitizeText(payload.title, 120);
  const status = sanitizeText(payload.status || "Sammle", 40);
  const notes = sanitizeText(payload.notes || "", 600);
  const authorName = sanitizeText(payload.authorName || "", 200);
  const coverUrl = sanitizeCoverUrl(payload.coverUrl || "");
  const hardcoverBookId = sanitizeText(payload.hardcoverBookId || "", 80);
  const genres = sanitizeTextArray(payload.genres, 14, 60);
  const moods = sanitizeTextArray(payload.moods, 10, 40);
  const contentWarnings = sanitizeTextArray(payload.contentWarnings, 10, 60);
  const rating = parseOptionalFloat(payload.rating, 5);
  const ratingsCount = parseOptionalInt(payload.ratingsCount);
  const pages = parseOptionalInt(payload.pages);
  const releaseYear = parseOptionalInt(payload.releaseYear);

  const rawMediaType = sanitizeText(payload.mediaType || "manga", 20).toLowerCase();
  if (!ALLOWED_MEDIA_TYPES.includes(rawMediaType)) {
    return { error: "Ungültiger Typ. Bitte Manga oder Buch wählen." };
  }

  let ownedVolumes = 1;
  let totalVolumes = 1;
  let missingVolumes = [];

  if (rawMediaType === "manga") {
    ownedVolumes = parseNonNegativeInt(payload.ownedVolumes);
    if (ownedVolumes === null) {
      return { error: "Owned Volumes muss eine positive ganze Zahl (inkl. 0) sein." };
    }

    totalVolumes = null;
    const totalRaw = payload.totalVolumes;
    if (totalRaw !== "" && totalRaw !== null && totalRaw !== undefined) {
      totalVolumes = parseNonNegativeInt(totalRaw);
      if (totalVolumes === null) {
        return { error: "Total Volumes muss eine positive ganze Zahl sein." };
      }
    }

    if (totalVolumes !== null && totalVolumes < ownedVolumes) {
      return { error: "Total Volumes darf nicht kleiner als Owned Volumes sein." };
    }

    missingVolumes = normalizeMissingVolumes(payload.missingVolumes || [], totalVolumes);

    if (totalVolumes !== null && ownedVolumes >= totalVolumes && missingVolumes.length > 0) {
      return { error: "Serie ist vollständig. Fehlende Bände können nicht gesetzt werden." };
    }
  }

  if (!title) {
    return { error: "Titel darf nicht leer sein." };
  }

  if (!ALLOWED_STATUS.includes(status)) {
    return { error: "Ungültiger Status." };
  }

  return {
    value: {
      title,
      status,
      notes,
      mediaType: rawMediaType,
      authorName,
      coverUrl,
      hardcoverBookId,
      genres,
      moods,
      contentWarnings,
      rating,
      ratingsCount,
      pages,
      releaseYear,
      ownedVolumes,
      totalVolumes,
      missingVolumes
    }
  };
}

async function getSetting(key) {
  const db = await initDb();
  const row = await db.get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  const db = await initDb();

  if (!value) {
    await db.run("DELETE FROM settings WHERE key = ?", [key]);
    return;
  }

  await db.run(
    `
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    [key, value]
  );
}

async function getRegistrationSetting() {
  const value = await getSetting(REGISTRATION_SETTING_KEY);
  if (value === null || value === undefined || value === "") {
    return true;
  }

  return String(value).toLowerCase() === "true";
}

async function setRegistrationSetting(allowRegistration) {
  const normalized = allowRegistration ? "true" : "false";
  await setSetting(REGISTRATION_SETTING_KEY, normalized);
}

function buildTokenPreview(token) {
  if (!token) {
    return "";
  }

  if (token.length <= 8) {
    return "********";
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function toIsoFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function escapeSqliteString(value) {
  return String(value || "").replaceAll("'", "''");
}

function isBackupFileName(fileName) {
  return (
    typeof fileName === "string" &&
    fileName.startsWith(`${BACKUP_FILE_PREFIX}-`) &&
    fileName.endsWith(".db")
  );
}

async function ensureBackupDirectory() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
}

async function listBackupFiles(limit = 30) {
  await ensureBackupDirectory();
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && isBackupFileName(entry.name))
    .map((entry) => entry.name);

  const detailed = await Promise.all(
    files.map(async (name) => {
      const filePath = path.join(BACKUP_DIR, name);
      const stats = await fs.promises.stat(filePath);
      return {
        name,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString()
      };
    })
  );

  return detailed
    .sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

async function pruneOldBackups() {
  const backups = await listBackupFiles(5000);
  const retentionMs = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const threshold = Date.now() - retentionMs;
  let removed = 0;

  for (const backup of backups) {
    const modifiedAtMs = new Date(backup.modifiedAt).getTime();
    if (Number.isFinite(modifiedAtMs) && modifiedAtMs < threshold) {
      await fs.promises.unlink(path.join(BACKUP_DIR, backup.name));
      removed += 1;
    }
  }

  return removed;
}

function parseAuditDetails(details) {
  if (!details) {
    return null;
  }

  try {
    return JSON.parse(details);
  } catch {
    return details;
  }
}

async function writeAdminAuditLog(db, entry) {
  const actorUserId = Number(entry?.actorUserId);
  const action = sanitizeText(String(entry?.action || ""), 120);
  const targetType = sanitizeText(String(entry?.targetType || ""), 80) || null;
  const targetId = sanitizeText(String(entry?.targetId || ""), 120) || null;

  if (!Number.isInteger(actorUserId) || actorUserId <= 0 || !action) {
    return;
  }

  let detailsValue = null;
  if (entry?.details !== undefined && entry?.details !== null) {
    if (typeof entry.details === "string") {
      detailsValue = sanitizeText(entry.details, 4000) || null;
    } else {
      try {
        detailsValue = JSON.stringify(entry.details).slice(0, 4000);
      } catch {
        detailsValue = sanitizeText(String(entry.details), 4000) || null;
      }
    }
  }

  await db.run(
    `
      INSERT INTO admin_audit_log (actor_user_id, action, target_type, target_id, details)
      VALUES (?, ?, ?, ?, ?)
    `,
    [actorUserId, action, targetType, targetId, detailsValue]
  );
}

async function safeAdminAuditLog(db, entry) {
  try {
    await writeAdminAuditLog(db, entry);
  } catch (error) {
    console.error("[audit] failed to write admin log:", error);
  }
}

async function runDatabaseBackup({ reason = "scheduled", actorUserId = null } = {}) {
  if (backupInProgress) {
    return { ok: false, skipped: true, error: "Backup already running." };
  }

  backupInProgress = true;

  try {
    await ensureBackupDirectory();
    const db = await initDb();
    const timestamp = toIsoFileTimestamp();
    const tmpPath = path.join(BACKUP_DIR, `${BACKUP_FILE_PREFIX}-${timestamp}.tmp.db`);
    const finalPath = path.join(BACKUP_DIR, `${BACKUP_FILE_PREFIX}-${timestamp}.db`);
    const sqlitePath = tmpPath.replace(/\\/g, "/");

    // VACUUM INTO creates a consistent SQLite snapshot while app writes continue.
    await db.exec(`VACUUM INTO '${escapeSqliteString(sqlitePath)}'`);
    await fs.promises.rename(tmpPath, finalPath);

    const stats = await fs.promises.stat(finalPath);
    const removed = await pruneOldBackups();

    if (actorUserId) {
      await safeAdminAuditLog(db, {
        actorUserId,
        action: "admin.backup.run",
        targetType: "backup",
        targetId: path.basename(finalPath),
        details: { reason, sizeBytes: stats.size, removedOldFiles: removed }
      });
    }

    console.log(
      `[backup] created ${finalPath} (${stats.size} bytes), reason=${reason}, removedOld=${removed}`
    );

    return {
      ok: true,
      file: path.basename(finalPath),
      sizeBytes: stats.size,
      removedOldFiles: removed
    };
  } catch (error) {
    console.error(`[backup] failed (${reason}):`, error);
    return { ok: false, skipped: false, error: error.message || "Backup failed." };
  } finally {
    backupInProgress = false;
  }
}

function startBackupScheduler() {
  if (!BACKUP_ENABLED) {
    console.log("[backup] scheduler disabled.");
    return;
  }

  const intervalMs = BACKUP_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[backup] scheduler enabled: interval=${BACKUP_INTERVAL_MINUTES}m retention=${BACKUP_RETENTION_DAYS}d dir=${BACKUP_DIR}`
  );

  // Run once shortly after startup, then continue on interval.
  setTimeout(() => {
    runDatabaseBackup({ reason: "startup" }).catch((error) => {
      console.error("[backup] startup run failed:", error);
    });
  }, 30 * 1000);

  backupIntervalHandle = setInterval(() => {
    runDatabaseBackup({ reason: "scheduled" }).catch((error) => {
      console.error("[backup] scheduled run failed:", error);
    });
  }, intervalMs);

  if (typeof backupIntervalHandle?.unref === "function") {
    backupIntervalHandle.unref();
  }
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function normalizeSnippet(value) {
  if (!value) {
    return "";
  }

  const noTags = stripHtmlTags(value);
  const decoded = decodeHtmlEntities(noTags);
  return sanitizeText(decoded, 200);
}

function extractSeriesSnippet(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  const highlight = item.highlight;
  if (highlight && highlight.series_names) {
    const seriesNode = Array.isArray(highlight.series_names)
      ? highlight.series_names[0]
      : highlight.series_names;
    const snippet =
      typeof seriesNode === "string" ? seriesNode : typeof seriesNode?.snippet === "string" ? seriesNode.snippet : "";
    return normalizeSnippet(snippet);
  }

  const highlights = Array.isArray(item.highlights) ? item.highlights : [];
  const match = highlights.find((entry) => entry?.field === "series_names");
  if (match) {
    const snippet =
      typeof match.snippet === "string"
        ? match.snippet
        : Array.isArray(match.snippets)
          ? match.snippets[0]
          : "";
    return normalizeSnippet(snippet);
  }

  const directSeries = item?.document?.series_names || item?.series_names;
  if (typeof directSeries === "string") {
    return sanitizeText(directSeries, 200);
  }

  if (Array.isArray(directSeries) && directSeries.length > 0) {
    return sanitizeText(directSeries[0], 200);
  }

  return "";
}

function parseHardcoverResult(raw, index) {
  const item = typeof raw === "string" ? JSON.parse(raw) : raw;
  const documentNode = item?.document && typeof item.document === "object" ? item.document : item;

  const fallbackTitle = `Ergebnis ${index + 1}`;
  const title =
    sanitizeText(
      documentNode?.title ||
        documentNode?.book?.title ||
        item?.title ||
        item?.book?.title ||
        documentNode?.name ||
        item?.name ||
        fallbackTitle,
      200
    ) || fallbackTitle;

  let authorNames =
    documentNode?.author_names ||
    documentNode?.book?.author_names ||
    item?.author_names ||
    item?.book?.author_names ||
    documentNode?.authors ||
    item?.authors;

  if (typeof authorNames === "string") {
    authorNames = authorNames
      .split(",")
      .map((entry) => sanitizeText(entry, 120))
      .filter(Boolean);
  } else if (Array.isArray(authorNames)) {
    authorNames = authorNames
      .map((entry) => {
        if (typeof entry === "string") {
          return sanitizeText(entry, 120);
        }

        if (entry && typeof entry === "object") {
          return sanitizeText(entry.name || entry.author?.name || "", 120);
        }

        return "";
      })
      .filter(Boolean);
  } else {
    authorNames = [];
  }

  const imageUrl =
    documentNode?.image?.url ||
    documentNode?.book?.image?.url ||
    item?.image?.url ||
    item?.book?.image?.url ||
    documentNode?.image_url ||
    item?.image_url ||
    documentNode?.cover_url ||
    item?.cover_url ||
    documentNode?.coverImageUrl ||
    item?.coverImageUrl ||
    "";

  const id = String(
    documentNode?.id ||
      item?.id ||
      documentNode?.book_id ||
      item?.book_id ||
      documentNode?.book?.id ||
      item?.book?.id ||
      `search-${index + 1}`
  );

  const seriesTitle = extractSeriesSnippet(item);
  const seriesTotalRaw =
    documentNode?.featured_series?.series?.primary_books_count ??
    documentNode?.featured_series?.series?.books_count ??
    documentNode?.book?.featured_series?.series?.primary_books_count ??
    documentNode?.book?.featured_series?.series?.books_count ??
    item?.featured_series?.series?.primary_books_count ??
    item?.featured_series?.series?.books_count;
  const seriesTotal = parseOptionalInt(seriesTotalRaw);
  const rating = parseOptionalFloat(documentNode?.rating ?? item?.rating ?? documentNode?.book?.rating, 5);
  const ratingsCount = parseOptionalInt(
    documentNode?.ratings_count ?? item?.ratings_count ?? documentNode?.book?.ratings_count
  );
  const pages = parseOptionalInt(documentNode?.pages ?? item?.pages ?? documentNode?.book?.pages);
  const releaseYear = parseOptionalInt(
    documentNode?.release_year ?? item?.release_year ?? documentNode?.book?.release_year
  );
  const genres = sanitizeTextArray(documentNode?.genres ?? item?.genres ?? documentNode?.book?.genres, 12, 50);
  const moods = sanitizeTextArray(documentNode?.moods ?? item?.moods ?? documentNode?.book?.moods, 8, 40);
  const contentWarnings = sanitizeTextArray(
    documentNode?.content_warnings ?? item?.content_warnings ?? documentNode?.book?.content_warnings,
    10,
    60
  );

  return {
    id,
    title,
    seriesTitle,
    seriesTotal: seriesTotal && seriesTotal > 0 ? seriesTotal : null,
    authorNames,
    imageUrl: sanitizeCoverUrl(imageUrl),
    rating,
    ratingsCount,
    pages,
    releaseYear,
    genres,
    moods,
    contentWarnings
  };
}


function parseApiErrorMessage(payload) {
  if (!payload) {
    return "";
  }

  const graphqlMessage = payload?.errors?.[0]?.message;
  if (graphqlMessage) {
    return String(graphqlMessage);
  }

  const genericMessage = payload?.message || payload?.error;
  if (genericMessage) {
    return String(genericMessage);
  }

  if (typeof payload?.raw === "string") {
    return payload.raw.slice(0, 180);
  }

  return "";
}

function normalizeHardcoverToken(rawToken) {
  let token = String(rawToken || "").trim();
  token = token.replace(/^['\"]+|['\"]+$/g, "");
  token = token.replace(/[\u200B-\u200D\uFEFF]/g, "");
  token = token.replace(/^authorization\s*:\s*/i, "").trim();

  // Strip only explicit auth prefixes with whitespace, not token contents.
  if (/^(Bearer|Token)\s+/i.test(token)) {
    token = token.replace(/^(Bearer|Token)\s+/i, "").trim();
  }

  return token;
}

function getHardcoverTokenCandidates(rawToken) {
  const normalized = normalizeHardcoverToken(rawToken);
  const candidates = new Set();

  if (normalized) {
    candidates.add(normalized);
    candidates.add(normalized.replace(/\s+/g, ""));
  }

  return Array.from(candidates).filter(Boolean);
}

async function requestHardcoverSearch(query, token) {
  const tokenCandidates = getHardcoverTokenCandidates(token);
  if (tokenCandidates.length === 0) {
    return {
      ok: false,
      status: 401,
      payload: { message: "Leerer oder ungültiger Token." }
    };
  }

  const graphqlQueryWithVariables = `
    query BooksByBookname($bookName: String!) {
      search(
        query: $bookName,
        query_type: "Book",
        per_page: 5,
        page: 1
      ) {
        results
      }
    }
  `;

  const requestBody = {
    query: graphqlQueryWithVariables,
    variables: {
      bookName: query
    },
    operationName: "BooksByBookname"
  };

  let lastAttempt = {
    ok: false,
    status: 0,
    payload: null
  };

  for (const candidate of tokenCandidates) {
    const response = await fetch(HARDCOVER_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: candidate
      },
      body: JSON.stringify(requestBody)
    });

    const rawText = await response.text();
    let payload = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { raw: rawText };
      }
    }

    const hasGraphQlErrors = Array.isArray(payload?.errors) && payload.errors.length > 0;
    if (response.ok && !hasGraphQlErrors) {
      return {
        ok: true,
        status: response.status,
        payload
      };
    }

    lastAttempt = {
      ok: false,
      status: response.status,
      payload
    };
  }

  return lastAttempt;
}
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/bootstrap", async (_req, res) => {
  try {
    const db = await initDb();
    const row = await db.get("SELECT COUNT(*) AS count FROM users");
    const hasUsers = (row?.count || 0) > 0;
    const allowRegistration = !hasUsers || (await getRegistrationSetting());
    return res.json({
      hasUsers,
      allowRegistration,
      emergencyResetEnabled: Boolean(EMERGENCY_RESET_KEY)
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Auth-Status konnte nicht geladen werden." });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

app.post("/api/auth/login", async (req, res) => {
  const rawIdentifier = String(req.body?.identifier ?? req.body?.email ?? "");
  const identifier = rawIdentifier.trim();
  const password = String(req.body?.password || "");

  const rateLimitIdentifier = identifier || "unknown";
  const limitStatus = getLoginRateLimitStatus(req, rateLimitIdentifier);
  if (limitStatus.blocked) {
    res.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
    return res.status(429).json({
      error: `Zu viele Login-Versuche. Bitte in ${limitStatus.retryAfterSeconds} Sekunden erneut versuchen.`
    });
  }

  if (!identifier || !password) {
    return res.status(400).json({ error: "Bitte E-Mail oder Benutzernamen sowie Passwort angeben." });
  }

  try {
    const db = await initDb();
    let user = null;

    if (identifier.includes("@")) {
      const email = sanitizeEmail(identifier);
      user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    } else {
      const username = sanitizeUsername(identifier);
      if (!username) {
        return res.status(400).json({ error: "Bitte E-Mail oder Benutzernamen angeben." });
      }
      user = await db.get("SELECT * FROM users WHERE username = ? COLLATE NOCASE", [username]);
    }

    const verification = user ? verifyPassword(password, user.password_hash) : { ok: false, legacy: false };

    if (!user || !verification.ok) {
      recordLoginFailure(req, rateLimitIdentifier);
      return res.status(401).json({ error: "Login fehlgeschlagen." });
    }

    if (verification.legacy) {
      const upgradedHash = hashPassword(password);
      await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [upgradedHash, user.id]);
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

    await db.run(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [user.id, tokenHash, expiresAt]
    );

    clearLoginFailures(req, rateLimitIdentifier);
    res.cookie(SESSION_COOKIE, token, buildSessionCookieOptions(req));
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Login fehlgeschlagen." });
  }
});

app.post("/api/auth/emergency-password-reset", async (req, res) => {
  if (!EMERGENCY_RESET_KEY) {
    return res.status(503).json({
      error: "Notfall-Reset ist nicht konfiguriert. Bitte EMERGENCY_RESET_KEY setzen."
    });
  }

  const rawIdentifier = String(req.body?.identifier ?? req.body?.email ?? "");
  const identifier = rawIdentifier.trim();
  const newPassword = String(req.body?.newPassword ?? req.body?.password ?? "");
  const resetKey = String(req.body?.resetKey || "").trim();

  const rateLimitIdentifier = `emergency-reset:${identifier || "unknown"}`;
  const limitStatus = getLoginRateLimitStatus(req, rateLimitIdentifier);
  if (limitStatus.blocked) {
    res.setHeader("Retry-After", String(limitStatus.retryAfterSeconds));
    return res.status(429).json({
      error: `Zu viele Versuche. Bitte in ${limitStatus.retryAfterSeconds} Sekunden erneut versuchen.`
    });
  }

  if (!identifier || !newPassword || !resetKey) {
    return res.status(400).json({
      error: "Bitte E-Mail/Benutzernamen, neuen Passwortwert und Reset-Key angeben."
    });
  }

  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({
      error: `Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen haben.`
    });
  }
  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    return res.status(400).json({
      error: `Passwort darf maximal ${PASSWORD_MAX_LENGTH} Zeichen haben.`
    });
  }

  if (!isValidEmergencyResetKey(resetKey)) {
    recordLoginFailure(req, rateLimitIdentifier);
    return res.status(401).json({ error: "Reset-Key ungültig." });
  }

  try {
    const db = await initDb();
    let user = null;

    if (identifier.includes("@")) {
      const email = sanitizeEmail(identifier);
      user = await db.get("SELECT id, email, username, role FROM users WHERE email = ?", [email]);
    } else {
      const username = sanitizeUsername(identifier);
      if (!username) {
        return res.status(400).json({ error: "Bitte E-Mail oder Benutzernamen angeben." });
      }
      user = await db.get("SELECT id, email, username, role FROM users WHERE username = ? COLLATE NOCASE", [
        username
      ]);
    }

    if (!user || user.role !== "admin") {
      recordLoginFailure(req, rateLimitIdentifier);
      return res.status(404).json({ error: "Admin-Konto nicht gefunden." });
    }

    const passwordHash = hashPassword(newPassword);
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
    await db.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);

    clearLoginFailures(req, rateLimitIdentifier);
    console.warn(
      `[security] emergency admin password reset executed for user_id=${user.id} email=${user.email}`
    );
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Notfall-Reset fehlgeschlagen." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      const db = await initDb();
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    }

    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Logout fehlgeschlagen." });
  }
});

app.post("/api/auth/register", async (req, res) => {
  const email = sanitizeEmail(req.body?.email || "");
  const username = sanitizeUsername(req.body?.username || "");
  const password = String(req.body?.password || "");
  const desiredRole = String(req.body?.role || "").toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Bitte eine gültige E-Mail angeben." });
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen haben.` });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return res.status(400).json({ error: `Passwort darf maximal ${PASSWORD_MAX_LENGTH} Zeichen haben.` });
  }

  const usernameValidationError = validateUsername(username);
  if (usernameValidationError) {
    return res.status(400).json({ error: usernameValidationError });
  }

  try {
    const db = await initDb();
    const stats = await db.get("SELECT COUNT(*) AS count FROM users");
    const hasUsers = (stats?.count || 0) > 0;
    const allowRegistration = await getRegistrationSetting();
    const existing = await db.get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(409).json({ error: "Diese E-Mail ist bereits registriert." });
    }
    const usernameExists = await db.get("SELECT id FROM users WHERE username = ? COLLATE NOCASE", [username]);
    if (usernameExists) {
      return res.status(409).json({ error: "Benutzername ist bereits vergeben." });
    }

    let role = "user";
    let creator = null;

    if (!hasUsers) {
      role = "admin";
    } else {
      creator = await getSessionUser(req);
      if (creator && creator.role === "admin") {
        if (ALLOWED_ROLES.includes(desiredRole)) {
          role = desiredRole;
        }
      } else {
        if (!allowRegistration) {
          return res.status(403).json({ error: "Registrierung ist deaktiviert." });
        }
        role = "user";
      }
    }

    const passwordHash = hashPassword(password);
    const result = await db.run(
      "INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)",
      [email, username, passwordHash, role]
    );

    const created = await db.get("SELECT id, email, username, role FROM users WHERE id = ?", [result.lastID]);

    if (creator && creator.role === "admin") {
      await safeAdminAuditLog(db, {
        actorUserId: creator.id,
        action: "admin.user.created",
        targetType: "user",
        targetId: String(created.id),
        details: {
          email: created.email,
          username: created.username,
          role: created.role
        }
      });
    }

    if (!hasUsers) {
      await db.run("UPDATE mangas SET user_id = ? WHERE user_id IS NULL", [created.id]);

      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

      await db.run(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
        [created.id, tokenHash, expiresAt]
      );

      res.cookie(SESSION_COOKIE, token, buildSessionCookieOptions(req));
    }

    return res.status(201).json({ user: sanitizeUser(created) });
  } catch (error) {
    const dbMessage = String(error?.message || "");
    if (dbMessage.includes("UNIQUE")) {
      if (dbMessage.includes("users.username") || dbMessage.includes("idx_users_username_nocase")) {
        return res.status(409).json({ error: "Benutzername ist bereits vergeben." });
      }
      return res.status(409).json({ error: "Diese E-Mail ist bereits registriert." });
    }

    console.error(error);
    return res.status(500).json({ error: "Registrierung fehlgeschlagen." });
  }
});

app.get("/api/settings/hardcover-token", requireAdmin, async (_req, res) => {
  try {
    const token = await getSetting(HARDCOVER_TOKEN_KEY);
    return res.json({ hasToken: Boolean(token), tokenPreview: buildTokenPreview(token) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Settings konnten nicht geladen werden." });
  }
});

app.put("/api/settings/hardcover-token", requireAdmin, async (req, res) => {
  const token = sanitizeText(req.body?.token || "", 4000);

  try {
    await setSetting(HARDCOVER_TOKEN_KEY, token || null);
    const db = await initDb();
    await safeAdminAuditLog(db, {
      actorUserId: req.user.id,
      action: token ? "settings.hardcover_token.updated" : "settings.hardcover_token.cleared",
      targetType: "settings",
      targetId: HARDCOVER_TOKEN_KEY,
      details: {
        hasToken: Boolean(token),
        tokenPreview: buildTokenPreview(token)
      }
    });
    return res.json({ hasToken: Boolean(token), tokenPreview: buildTokenPreview(token) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Token konnte nicht gespeichert werden." });
  }
});

app.put("/api/settings/profile", requireAuth, async (req, res) => {
  const username = sanitizeUsername(req.body?.username || "");

  const usernameValidationError = validateUsername(username);
  if (usernameValidationError) {
    return res.status(400).json({ error: usernameValidationError });
  }

  try {
    const db = await initDb();
    const existing = await db.get("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?", [
      username,
      req.user.id
    ]);
    if (existing) {
      return res.status(409).json({ error: "Benutzername ist bereits vergeben." });
    }
    await db.run("UPDATE users SET username = ? WHERE id = ?", [username, req.user.id]);
    const updated = await db.get("SELECT id, email, username, role FROM users WHERE id = ?", [req.user.id]);
    return res.json({ user: sanitizeUser(updated) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Profil konnte nicht gespeichert werden." });
  }
});

app.get("/api/admin/registration", requireAdmin, async (_req, res) => {
  try {
    const allowRegistration = await getRegistrationSetting();
    return res.json({ allowRegistration });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Registrierungseinstellung konnte nicht geladen werden." });
  }
});

app.put("/api/admin/registration", requireAdmin, async (req, res) => {
  const rawValue = req.body?.allowRegistration;
  const allowRegistration =
    rawValue === true ||
    rawValue === "true" ||
    rawValue === 1 ||
    rawValue === "1";

  try {
    await setRegistrationSetting(allowRegistration);
    const db = await initDb();
    await safeAdminAuditLog(db, {
      actorUserId: req.user.id,
      action: "admin.registration.updated",
      targetType: "settings",
      targetId: REGISTRATION_SETTING_KEY,
      details: { allowRegistration }
    });
    return res.json({ allowRegistration });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Registrierungseinstellung konnte nicht gespeichert werden." });
  }
});

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  const searchQuery = sanitizeText(_req.query.q ?? _req.query.search ?? "", 120);
  const roleFilter = sanitizeText(_req.query.role || "", 20).toLowerCase();
  const sortMode = normalizeAdminUserSortMode(_req.query.sort);
  const orderSql = ADMIN_USER_SORT_SQL[sortMode];
  const hasPagination =
    hasQueryValue(_req.query.page) || hasQueryValue(_req.query.pageSize);
  const page = parseBoundedPositiveInt(_req.query.page, 1, 1, 1000000);
  const pageSize = parseBoundedPositiveInt(_req.query.pageSize, 50, 1, 500);
  const offset = (page - 1) * pageSize;

  try {
    const db = await initDb();
    const whereParts = [];
    const whereParams = [];

    if (ALLOWED_ROLES.includes(roleFilter)) {
      whereParts.push("users.role = ?");
      whereParams.push(roleFilter);
    }

    if (searchQuery) {
      whereParts.push(
        "(users.email LIKE ? COLLATE NOCASE OR users.username LIKE ? COLLATE NOCASE)"
      );
      const likeValue = `%${searchQuery}%`;
      whereParams.push(likeValue, likeValue);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

    const baseSelectSql = `
      SELECT
        users.id,
        users.email,
        users.username,
        users.role,
        users.created_at,
        COALESCE(manga_stats.entries_count, 0) AS entries_count,
        COALESCE(session_stats.session_count, 0) AS session_count,
        session_stats.last_session_at
      FROM users
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS entries_count
        FROM mangas
        GROUP BY user_id
      ) AS manga_stats ON manga_stats.user_id = users.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS session_count, MAX(created_at) AS last_session_at
        FROM sessions
        GROUP BY user_id
      ) AS session_stats ON session_stats.user_id = users.id
      ${whereSql}
    `;

    const countRow = await db.get(
      `
        SELECT COUNT(*) AS count
        FROM users
        ${whereSql}
      `,
      whereParams
    );
    const total = Number(countRow?.count || 0);

    let usersQuery = `
      ${baseSelectSql}
      ORDER BY ${orderSql}
    `;
    const usersParams = [...whereParams];

    if (hasPagination) {
      usersQuery += `
        LIMIT ?
        OFFSET ?
      `;
      usersParams.push(pageSize, offset);
    }

    const users = await db.all(usersQuery, usersParams);
    return res.json({
      users,
      total,
      page,
      pageSize,
      hasMore: hasPagination ? offset + users.length < total : false
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nutzer konnten nicht geladen werden." });
  }
});

app.delete("/api/admin/users/:id/sessions", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige Nutzer-ID." });
  }

  if (req.user && req.user.id === id) {
    return res.status(400).json({ error: "Du kannst dich nicht selbst abmelden." });
  }

  try {
    const db = await initDb();
    const result = await db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
    await safeAdminAuditLog(db, {
      actorUserId: req.user.id,
      action: "admin.user.sessions_cleared",
      targetType: "user",
      targetId: String(id),
      details: { clearedSessions: result.changes || 0 }
    });
    return res.json({ cleared: result.changes || 0 });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Sessions konnten nicht beendet werden." });
  }
});

app.put("/api/admin/users/:id/role", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige Nutzer-ID." });
  }

  const role = String(req.body?.role || "").toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ error: "Ungültige Rolle." });
  }

  try {
    const db = await initDb();
    const user = await db.get("SELECT id, email, role FROM users WHERE id = ?", [id]);

    if (!user) {
      return res.status(404).json({ error: "Nutzer nicht gefunden." });
    }

    if (req.user && req.user.id === user.id && role !== "admin") {
      return res.status(400).json({ error: "Du kannst dir selbst keine Rechte entziehen." });
    }

    if (user.role === "admin" && role !== "admin") {
      const adminCount = await db.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
      if ((adminCount?.count || 0) <= 1) {
        return res.status(400).json({ error: "Mindestens ein Admin muss erhalten bleiben." });
      }
    }

    await db.run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
    await safeAdminAuditLog(db, {
      actorUserId: req.user.id,
      action: "admin.user.role_changed",
      targetType: "user",
      targetId: String(id),
      details: {
        email: user.email,
        oldRole: user.role,
        newRole: role
      }
    });
    const updated = await db.get("SELECT id, email, role, created_at FROM users WHERE id = ?", [id]);
    return res.json({ user: updated });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Rolle konnte nicht aktualisiert werden." });
  }
});

app.put("/api/admin/users/:id/password", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige Nutzer-ID." });
  }

  const password = String(req.body?.password || "");
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return res
      .status(400)
      .json({ error: `Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen haben.` });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return res
      .status(400)
      .json({ error: `Passwort darf maximal ${PASSWORD_MAX_LENGTH} Zeichen haben.` });
  }

  try {
    const db = await initDb();
    const user = await db.get("SELECT id FROM users WHERE id = ?", [id]);

    if (!user) {
      return res.status(404).json({ error: "Nutzer nicht gefunden." });
    }

    const passwordHash = hashPassword(password);
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
    // Force re-login on all active devices after admin reset.
    await db.run("DELETE FROM sessions WHERE user_id = ?", [id]);
    await safeAdminAuditLog(db, {
      actorUserId: req.user.id,
      action: "admin.user.password_reset",
      targetType: "user",
      targetId: String(id),
      details: { sessionsCleared: true }
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Passwort konnte nicht gespeichert werden." });
  }
});

app.get("/api/admin/audit", requireAdmin, async (req, res) => {
  const requestedLimit = parsePositiveInt(req.query.limit);
  const limit = requestedLimit === null ? 100 : Math.min(requestedLimit, 300);

  try {
    const db = await initDb();
    const rows = await db.all(
      `
        SELECT
          admin_audit_log.id,
          admin_audit_log.action,
          admin_audit_log.target_type,
          admin_audit_log.target_id,
          admin_audit_log.details,
          admin_audit_log.created_at,
          users.id AS actor_id,
          users.email AS actor_email,
          users.username AS actor_username
        FROM admin_audit_log
        LEFT JOIN users ON users.id = admin_audit_log.actor_user_id
        ORDER BY admin_audit_log.created_at DESC, admin_audit_log.id DESC
        LIMIT ?
      `,
      [limit]
    );

    const entries = rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type || "",
      targetId: row.target_id || "",
      details: parseAuditDetails(row.details),
      createdAt: row.created_at,
      actor: {
        id: row.actor_id || null,
        email: row.actor_email || "",
        username: row.actor_username || ""
      }
    }));

    return res.json({ entries });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Audit-Log konnte nicht geladen werden." });
  }
});

app.get("/api/admin/backups", requireAdmin, async (req, res) => {
  const requestedLimit = parsePositiveInt(req.query.limit);
  const limit = requestedLimit === null ? 30 : Math.min(requestedLimit, 200);

  try {
    const files = await listBackupFiles(limit);
    return res.json({
      enabled: BACKUP_ENABLED,
      directory: BACKUP_DIR,
      intervalMinutes: BACKUP_INTERVAL_MINUTES,
      retentionDays: BACKUP_RETENTION_DAYS,
      files
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Backup-Liste konnte nicht geladen werden." });
  }
});

app.post("/api/admin/backups/run", requireAdmin, async (req, res) => {
  try {
    const result = await runDatabaseBackup({
      reason: "manual-api",
      actorUserId: req.user.id
    });

    if (!result.ok) {
      const statusCode = result.skipped ? 409 : 500;
      return res.status(statusCode).json({ error: result.error || "Backup fehlgeschlagen." });
    }

    return res.json({
      ok: true,
      file: result.file,
      sizeBytes: result.sizeBytes,
      removedOldFiles: result.removedOldFiles
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Backup fehlgeschlagen." });
  }
});

app.get("/api/export/csv", requireAuth, async (req, res) => {
  try {
    const db = await initDb();
    const rows = await db.all("SELECT * FROM mangas WHERE user_id = ? ORDER BY updated_at DESC, id DESC", [
      req.user.id
    ]);

    const normalized = rows.map(normalizeMangaRow);
    const headers = [
      "title",
      "media_type",
      "status",
      "owned_volumes",
      "total_volumes",
      "missing_volumes",
      "cover_url",
      "hardcover_book_id",
      "author_name",
      "notes",
      "genres",
      "moods",
      "content_warnings",
      "rating",
      "ratings_count",
      "pages",
      "release_year",
      "user_rating",
      "user_review",
      "created_at",
      "updated_at"
    ];

    const lines = [headers.join(",")];

    normalized.forEach((manga) => {
      const values = [
        manga.title,
        manga.media_type,
        manga.status,
        manga.owned_volumes,
        manga.total_volumes ?? "",
        joinCsvArray(manga.missing_volumes),
        manga.cover_url || "",
        manga.hardcover_book_id || "",
        manga.author_name,
        manga.notes,
        joinCsvArray(manga.genres),
        joinCsvArray(manga.moods),
        joinCsvArray(manga.content_warnings),
        manga.rating ?? "",
        manga.ratings_count ?? "",
        manga.pages ?? "",
        manga.release_year ?? "",
        manga.user_rating ?? "",
        manga.user_review ?? "",
        manga.created_at || "",
        manga.updated_at || ""
      ];

      lines.push(values.map(toCsvValue).join(","));
    });

    const csv = `\uFEFF${lines.join("\n")}`;
    const dateStamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="manga-export-${dateStamp}.csv"`);
    return res.send(csv);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "CSV-Export fehlgeschlagen." });
  }
});

app.post("/api/import/csv/preview", requireAuth, async (req, res) => {
  try {
    const csvText = typeof req.body === "string" ? req.body : "";
    if (!csvText.trim()) {
      return res.status(400).json({ error: "CSV-Datei ist leer." });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      return res.status(400).json({ error: "CSV enthält keine Daten." });
    }

    const headerRow = rows[0].map((entry) => String(entry || "").trim().toLowerCase());
    const headerIndex = headerRow.reduce((acc, header, index) => {
      if (header) {
        acc[header] = index;
      }
      return acc;
    }, {});

    if (headerIndex.title === undefined) {
      return res.status(400).json({ error: "CSV benötigt eine Spalte 'title'." });
    }

    const db = await initDb();
    const existingRows = await db.all("SELECT title, media_type FROM mangas WHERE user_id = ?", [req.user.id]);
    const existingKeys = new Set(
      existingRows.map((row) => buildImportKey(row.title, row.media_type || "manga"))
    );
    const seenKeys = new Set();

    let total = 0;
    let newCount = 0;
    let duplicateCount = 0;
    const duplicates = [];
    const errors = [];

    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const getValue = (key) => row[headerIndex[key]] ?? "";

      const title = sanitizeText(getValue("title"), 120);
      if (!title) {
        continue;
      }

      const rawMediaType = sanitizeText(getValue("media_type") || "manga", 20).toLowerCase();
      const mediaType = ALLOWED_MEDIA_TYPES.includes(rawMediaType) ? rawMediaType : "manga";
      const key = buildImportKey(title, mediaType);

      total += 1;

      if (existingKeys.has(key) || seenKeys.has(key)) {
        duplicateCount += 1;
        if (duplicates.length < 5) {
          duplicates.push(`${title} (${mediaType})`);
        }
        continue;
      }

      seenKeys.add(key);
      newCount += 1;
    }

    return res.json({ total, newCount, duplicateCount, duplicates, errors });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "CSV-Prüfung fehlgeschlagen." });
  }
});

app.post("/api/import/csv", requireAuth, async (req, res) => {
  try {
    const csvText = typeof req.body === "string" ? req.body : "";
    if (!csvText.trim()) {
      return res.status(400).json({ error: "CSV-Datei ist leer." });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      return res.status(400).json({ error: "CSV enthält keine Daten." });
    }

    const headerRow = rows[0].map((entry) => String(entry || "").trim().toLowerCase());
    const headerIndex = headerRow.reduce((acc, header, index) => {
      if (header) {
        acc[header] = index;
      }
      return acc;
    }, {});

    if (headerIndex.title === undefined) {
      return res.status(400).json({ error: "CSV benötigt eine Spalte 'title'." });
    }

    const db = await initDb();
    const existingRows = await db.all("SELECT title, media_type FROM mangas WHERE user_id = ?", [req.user.id]);
    const existingKeys = new Set(
      existingRows.map((row) => buildImportKey(row.title, row.media_type || "manga"))
    );
    const seenKeys = new Set();

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const insertStatement = db.prepare(`
      INSERT INTO mangas (
        user_id,
        title,
        total_volumes,
        owned_volumes,
        status,
        notes,
        media_type,
        author_name,
        cover_url,
        hardcover_book_id,
        missing_volumes,
        genres,
        moods,
        content_warnings,
        rating,
        ratings_count,
        pages,
        release_year,
        user_rating,
        user_review
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const runImportTransaction = db.transaction(() => {
      for (let i = 1; i < rows.length; i += 1) {
        const row = rows[i];
        const getValue = (key) => row[headerIndex[key]] ?? "";

        const title = sanitizeText(getValue("title"), 120);
        if (!title) {
          skipped += 1;
          continue;
        }

        const rawMediaType = sanitizeText(getValue("media_type") || "manga", 20).toLowerCase();
        const mediaType = ALLOWED_MEDIA_TYPES.includes(rawMediaType) ? rawMediaType : "manga";
        const dedupeKey = buildImportKey(title, mediaType);
        if (existingKeys.has(dedupeKey) || seenKeys.has(dedupeKey)) {
          skipped += 1;
          continue;
        }

        let status = sanitizeText(getValue("status") || "Sammle", 40);
        if (!ALLOWED_STATUS.includes(status)) {
          status = "Sammle";
        }

        let ownedVolumes = parseNonNegativeInt(getValue("owned_volumes"));
        let totalVolumes = parseOptionalInt(getValue("total_volumes"));
        let missingVolumes = parseCsvNumbers(getValue("missing_volumes"));

        if (mediaType === "book") {
          ownedVolumes = 1;
          totalVolumes = 1;
          missingVolumes = [];
        } else {
          if (ownedVolumes === null) {
            ownedVolumes = 0;
          }

          if (totalVolumes !== null && totalVolumes < ownedVolumes) {
            totalVolumes = ownedVolumes;
          }

          missingVolumes = normalizeMissingVolumes(missingVolumes, totalVolumes);
        }

        const authorName = sanitizeText(getValue("author_name"), 200);
        const notes = sanitizeText(getValue("notes"), 600);
        const coverUrl = sanitizeCoverUrl(getValue("cover_url"));
        const hardcoverBookId = sanitizeText(getValue("hardcover_book_id"), 80);
        const genres = parseCsvList(getValue("genres"), 60);
        const moods = parseCsvList(getValue("moods"), 40);
        const contentWarnings = parseCsvList(getValue("content_warnings"), 60);
        const rating = parseOptionalFloat(getValue("rating"), 5);
        const ratingsCount = parseOptionalInt(getValue("ratings_count"));
        const pages = parseOptionalInt(getValue("pages"));
        const releaseYear = parseOptionalInt(getValue("release_year"));
        const userRatingRaw = parseOptionalInt(getValue("user_rating"));
        const userRating =
          userRatingRaw !== null && userRatingRaw >= 1 && userRatingRaw <= 5 ? userRatingRaw : null;
        const userReview = sanitizeText(getValue("user_review"), 1200);

        try {
          insertStatement.run(
            req.user.id,
            title,
            totalVolumes,
            ownedVolumes,
            status,
            notes || null,
            mediaType,
            authorName || null,
            coverUrl || null,
            hardcoverBookId || null,
            JSON.stringify(missingVolumes),
            JSON.stringify(genres),
            JSON.stringify(moods),
            JSON.stringify(contentWarnings),
            rating ?? null,
            ratingsCount ?? null,
            pages ?? null,
            releaseYear ?? null,
            userRating ?? null,
            userReview || null
          );

          imported += 1;
          seenKeys.add(dedupeKey);
        } catch (error) {
          skipped += 1;
          errors.push(`Zeile ${i + 1}: ${error.message || "Import fehlgeschlagen"}`);
        }
      }
    });

    runImportTransaction();

    return res.json({ imported, skipped, errors: errors.slice(0, 10) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "CSV-Import fehlgeschlagen." });
  }
});

app.get("/api/hardcover/search", requireAuth, async (req, res) => {
  const query = sanitizeText(req.query.query || "", 180);
  if (!query) {
    return res.status(400).json({ error: "Bitte einen Suchbegriff angeben." });
  }

  try {
    const token = await getSetting(HARDCOVER_TOKEN_KEY);
    if (!token) {
      return res.status(400).json({ error: "Kein Hardcover API Token in den Settings hinterlegt." });
    }

    const attempt = await requestHardcoverSearch(query, token);

    if (!attempt.ok) {
      const details = attempt.payload || null;
      const detailMessage = parseApiErrorMessage(details);
      const statusCode = attempt.status === 401 || attempt.status === 403 ? 401 : 502;

      return res.status(statusCode).json({
        error: detailMessage
          ? `Hardcover API Fehler: ${detailMessage}`
          : `Hardcover API Fehler (HTTP ${attempt.status || "unbekannt"}).`,
        details
      });
    }

    const payload = attempt.payload || {};
    const rawResults = payload?.data?.search?.results;

    let items = [];
    if (Array.isArray(rawResults)) {
      items = rawResults;
    } else if (typeof rawResults === "string") {
      try {
        const parsed = JSON.parse(rawResults);
        if (Array.isArray(parsed)) {
          items = parsed;
        }
      } catch {
        items = [];
      }
    } else if (rawResults && typeof rawResults === "object") {
      if (Array.isArray(rawResults.results)) {
        items = rawResults.results;
      } else if (Array.isArray(rawResults.hits)) {
        items = rawResults.hits;
      }
    }

    const results = items
      .map((item, index) => {
        try {
          return parseHardcoverResult(item, index);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(0, 5);

    return res.json({ results });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Hardcover-Suche fehlgeschlagen." });
  }
});

app.get("/api/manga", requireAuth, async (req, res) => {
  const sortMode = normalizeSortMode(req.query.sort);
  const orderSql = MANGA_SORT_SQL[sortMode];
  const genreFilter = normalizeGenreFilter(req.query.genre);
  const searchTerm = sanitizeText(req.query.q ?? req.query.search ?? "", 200);
  const ftsQuery = buildFtsQuery(searchTerm);
  const hasPagination =
    hasQueryValue(req.query.page) || hasQueryValue(req.query.pageSize);
  const page = parseBoundedPositiveInt(req.query.page, 1, 1, 1000000);
  const pageSize = parseBoundedPositiveInt(req.query.pageSize, 120, 1, 500);
  const offset = (page - 1) * pageSize;

  try {
    const db = await initDb();
    const params = [req.user.id];
    const filterParams = [req.user.id];

    let sql = `
      SELECT m.*
      FROM mangas AS m
    `;

    if (ftsQuery) {
      sql += `
        JOIN mangas_fts ON mangas_fts.rowid = m.id
      `;
      params.push(req.user.id, ftsQuery);
      filterParams.push(req.user.id, ftsQuery);
    }

    sql += `
      WHERE m.user_id = ?
    `;

    if (ftsQuery) {
      sql += `
        AND mangas_fts.user_id = ?
        AND mangas_fts MATCH ?
      `;
    }

    if (genreFilter) {
      sql += `
        AND json_valid(m.genres)
        AND EXISTS (
          SELECT 1
          FROM json_each(m.genres)
          WHERE LOWER(TRIM(json_each.value)) = LOWER(?)
        )
      `;
      params.push(genreFilter);
      filterParams.push(genreFilter);
    }

    sql += `
      ORDER BY ${orderSql}
    `;

    if (hasPagination) {
      sql += `
        LIMIT ?
        OFFSET ?
      `;
      params.push(pageSize, offset);
    }

    const mangas = await db.all(sql, params);
    const normalized = mangas.map(normalizeMangaRow);

    if (!hasPagination) {
      return res.json(normalized);
    }

    let countSql = `
      SELECT COUNT(*) AS count
      FROM mangas AS m
    `;

    if (ftsQuery) {
      countSql += `
        JOIN mangas_fts ON mangas_fts.rowid = m.id
      `;
    }

    countSql += `
      WHERE m.user_id = ?
    `;

    if (ftsQuery) {
      countSql += `
        AND mangas_fts.user_id = ?
        AND mangas_fts MATCH ?
      `;
    }

    if (genreFilter) {
      countSql += `
        AND json_valid(m.genres)
        AND EXISTS (
          SELECT 1
          FROM json_each(m.genres)
          WHERE LOWER(TRIM(json_each.value)) = LOWER(?)
        )
      `;
    }

    const countRow = await db.get(countSql, filterParams);
    const total = Number(countRow?.count || 0);

    return res.json({
      items: normalized,
      total,
      page,
      pageSize,
      hasMore: offset + normalized.length < total
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Laden der Manga-Liste." });
  }
});

app.get("/api/manga/genres", requireAuth, async (req, res) => {
  try {
    const db = await initDb();
    const rows = await db.all("SELECT genres FROM mangas WHERE user_id = ?", [req.user.id]);
    const genres = new Set();

    rows.forEach((row) => {
      parseTextArrayFromDb(row?.genres).forEach((genre) => {
        const normalized = sanitizeText(String(genre || ""), 80);
        if (normalized) {
          genres.add(normalized);
        }
      });
    });

    return res.json({
      genres: Array.from(genres).sort((a, b) => a.localeCompare(b, "de"))
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Genres konnten nicht geladen werden." });
  }
});

app.get("/api/manga/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const manga = await fetchMangaForUser(db, id, req.user);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    return res.json(normalizeMangaRow(manga));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Laden des Manga-Eintrags." });
  }
});
app.post("/api/manga", requireAuth, async (req, res) => {
  const validation = validatePayload(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const db = await initDb();
    const user = req.user;
    const {
      title,
      totalVolumes,
      ownedVolumes,
      status,
      notes,
      mediaType,
      authorName,
      coverUrl,
      hardcoverBookId,
      missingVolumes,
      genres,
      moods,
      contentWarnings,
      rating,
      ratingsCount,
      pages,
      releaseYear
    } = validation.value;

    const result = await db.run(
      `
      INSERT INTO mangas (
        user_id,
        title,
        total_volumes,
        owned_volumes,
        status,
        notes,
        media_type,
        author_name,
        cover_url,
        hardcover_book_id,
        missing_volumes,
        genres,
        moods,
        content_warnings,
        rating,
        ratings_count,
        pages,
        release_year
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        user.id,
        title,
        totalVolumes,
        ownedVolumes,
        status,
        notes || null,
        mediaType,
        authorName || null,
        coverUrl || null,
        hardcoverBookId || null,
        JSON.stringify(missingVolumes),
        JSON.stringify(genres),
        JSON.stringify(moods),
        JSON.stringify(contentWarnings),
        rating ?? null,
        ratingsCount ?? null,
        pages ?? null,
        releaseYear ?? null
      ]
    );

    const created = await db.get("SELECT * FROM mangas WHERE id = ?", [result.lastID]);
    return res.status(201).json(normalizeMangaRow(created));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Erstellen des Manga-Eintrags." });
  }
});

app.put("/api/manga/:id", requireAuth, async (req, res) => {
  const validation = validatePayload(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const user = req.user;
    const existing = await fetchMangaForUser(db, id, user);
    if (!existing) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const {
      title,
      totalVolumes,
      ownedVolumes,
      status,
      notes,
      mediaType,
      authorName,
      coverUrl,
      hardcoverBookId,
      missingVolumes,
      genres,
      moods,
      contentWarnings,
      rating,
      ratingsCount,
      pages,
      releaseYear
    } = validation.value;

    const result = await db.run(
      `
      UPDATE mangas
      SET title = ?,
          total_volumes = ?,
          owned_volumes = ?,
          status = ?,
          notes = ?,
          media_type = ?,
          author_name = ?,
          cover_url = ?,
          hardcover_book_id = ?,
          missing_volumes = ?,
          genres = ?,
          moods = ?,
          content_warnings = ?,
          rating = ?,
          ratings_count = ?,
          pages = ?,
          release_year = ?
      WHERE id = ? AND user_id = ?
      `,
      [
        title,
        totalVolumes,
        ownedVolumes,
        status,
        notes || null,
        mediaType,
        authorName || null,
        coverUrl || null,
        hardcoverBookId || null,
        JSON.stringify(missingVolumes),
        JSON.stringify(genres),
        JSON.stringify(moods),
        JSON.stringify(contentWarnings),
        rating ?? null,
        ratingsCount ?? null,
        pages ?? null,
        releaseYear ?? null,
        id,
        user.id
      ]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(normalizeMangaRow(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Aktualisieren des Manga-Eintrags." });
  }
});

app.patch("/api/manga/:id/volumes", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  const amount = parsePositiveInt(req.body?.amount ?? 1);
  if (amount === null) {
    return res.status(400).json({ error: "Amount muss eine positive ganze Zahl sein." });
  }

  try {
    const db = await initDb();
    const manga = await fetchMangaForUser(db, id, req.user);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    if (manga.media_type === "book") {
      return res.status(400).json({ error: "Bände können nur bei Manga erhöht werden." });
    }
    const updatedOwnedVolumes = manga.owned_volumes + amount;

    if (manga.total_volumes !== null && updatedOwnedVolumes > manga.total_volumes) {
      return res.status(400).json({
        error: `Maximal ${manga.total_volumes} Bände möglich. Bitte Gesamtzahl oder Anzahl anpassen.`
      });
    }

    const reachedMaxVolumes =
      manga.total_volumes !== null && updatedOwnedVolumes === manga.total_volumes;

    let nextStatus = manga.status;
    if (reachedMaxVolumes) {
      nextStatus = "Abgeschlossen";
    }

    if (reachedMaxVolumes) {
      await db.run("UPDATE mangas SET owned_volumes = ?, status = ?, missing_volumes = ? WHERE id = ?", [
        updatedOwnedVolumes,
        nextStatus,
        JSON.stringify([]),
        id
      ]);
    } else {
      await db.run("UPDATE mangas SET owned_volumes = ?, status = ? WHERE id = ?", [
        updatedOwnedVolumes,
        nextStatus,
        id
      ]);
    }

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(normalizeMangaRow(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Hinzufügen neuer Bände." });
  }
});

app.patch("/api/manga/:id/missing-volumes", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const manga = await fetchMangaForUser(db, id, req.user);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    if (manga.media_type === "book") {
      return res.status(400).json({ error: "Fehlende Bände können nur bei Manga gesetzt werden." });
    }
    const missingVolumes = normalizeMissingVolumes(req.body?.missingVolumes || [], manga.total_volumes);

    if (
      manga.total_volumes !== null &&
      manga.owned_volumes >= manga.total_volumes &&
      missingVolumes.length > 0
    ) {
      return res
        .status(400)
        .json({ error: "Serie ist vollständig. Fehlende Bände können nicht gesetzt werden." });
    }

    await db.run("UPDATE mangas SET missing_volumes = ? WHERE id = ?", [
      JSON.stringify(missingVolumes),
      id
    ]);

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(normalizeMangaRow(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehlende Bände konnten nicht gespeichert werden." });
  }
});

app.patch("/api/manga/:id/review", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  const validation = validateReviewPayload(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const db = await initDb();
    const manga = await fetchMangaForUser(db, id, req.user);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const { userRating, userReview } = validation.value;
    await db.run("UPDATE mangas SET user_rating = ?, user_review = ? WHERE id = ? AND user_id = ?", [
      userRating,
      userReview || null,
      id,
      req.user.id
    ]);

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(normalizeMangaRow(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Bewertung konnte nicht gespeichert werden." });
  }
});

app.delete("/api/manga/:id", requireAuth, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const existing = await fetchMangaForUser(db, id, req.user);
    if (!existing) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const result = await db.run("DELETE FROM mangas WHERE id = ? AND user_id = ?", [id, req.user.id]);

    if (result.changes === 0) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    return res.status(204).send();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Löschen des Manga-Eintrags." });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "mangas.html"));
});

app.get("/mangas", (_req, res) => {
  res.redirect("/");
});

app.get("/create", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/settings", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "settings.html"));
});

app.get("/admin", async (req, res) => {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.redirect("/login");
    }
    if (user.role !== "admin") {
      return res.redirect("/");
    }
    return res.sendFile(path.join(__dirname, "..", "public", "admin.html"));
  } catch (error) {
    console.error(error);
    return res.status(500).send("Auth check failed.");
  }
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

app.get("/forgot-password", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "forgot-password.html"));
});

app.get("/register", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "register.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API-Route nicht gefunden." });
  }

  return res.redirect("/");
});

async function start() {
  await initDb();
  startBackupScheduler();

  app.listen(PORT, () => {
    console.log(`Manga Tracker läuft auf http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Serverstart fehlgeschlagen:", error);
  process.exit(1);
});








































