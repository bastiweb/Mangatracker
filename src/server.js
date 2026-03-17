const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3003;
const ALLOWED_STATUS = ["Geplant", "Sammle", "Pausiert", "Abgeschlossen"];
const ALLOWED_MEDIA_TYPES = ["manga", "book"];
const ALLOWED_ROLES = ["user", "admin"];
const PASSWORD_MIN_LENGTH = 8;
const SESSION_COOKIE = "manga_tracker_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const HARDCOVER_TOKEN_KEY = "hardcover_api_token";
const REGISTRATION_SETTING_KEY = "allow_registration";
const HARDCOVER_ENDPOINT = "https://api.hardcover.app/v1/graphql";

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public"), { index: false }));

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

function parseCookies(header) {
  if (!header) {
    return {};
  }

  return header.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) {
      return acc;
    }

    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE] || "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
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
    role: row.role
  };
}

function buildSessionCookieOptions(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure = req.secure || forwardedProto === "https";

  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/"
  };
}

async function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }

  const db = await initDb();
  const tokenHash = hashToken(token);
  const now = Math.floor(Date.now() / 1000);

  const row = await db.get(
    "SELECT sessions.user_id, sessions.expires_at, users.email, users.role FROM sessions JOIN users ON sessions.user_id = users.id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
    [tokenHash, now]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.user_id,
    email: row.email,
    role: row.role
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
    cover_url: row.cover_url || "",
    hardcover_book_id: row.hardcover_book_id || "",
    missing_volumes: mediaType === "book" ? [] : parseMissingVolumesFromDb(row.missing_volumes),
    genres: parseTextArrayFromDb(row.genres),
    moods: parseTextArrayFromDb(row.moods, 10),
    content_warnings: parseTextArrayFromDb(row.content_warnings, 10),
    rating: row.rating ?? null,
    ratings_count: row.ratings_count ?? null,
    pages: row.pages ?? null,
    release_year: row.release_year ?? null
  };
}

function validatePayload(payload) {
  const title = sanitizeText(payload.title, 120);
  const status = sanitizeText(payload.status || "Sammle", 40);
  const notes = sanitizeText(payload.notes || "", 600);
  const authorName = sanitizeText(payload.authorName || "", 200);
  const coverUrl = sanitizeText(payload.coverUrl || "", 600);
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
    imageUrl: sanitizeText(imageUrl, 600),
    rating,
    ratingsCount,
    pages,
    releaseYear,
    genres,
    moods,
    contentWarnings
  };
}


function escapeGraphQLString(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
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
  const baseTokens = getHardcoverTokenCandidates(token);
  if (baseTokens.length === 0) {
    return {
      ok: false,
      status: 401,
      payload: { message: "Leerer oder ungültiger Token." }
    };
  }

  const graphqlQueryInline = `
    query BooksByBookname {
      search(
        query: "${escapeGraphQLString(query)}",
        query_type: "Book",
        per_page: 5,
        page: 1
      ) {
        results
      }
    }
  `;

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

  const requestBodies = [
    {
      query: graphqlQueryInline,
      variables: {},
      operationName: "BooksByBookname"
    },
    {
      query: graphqlQueryWithVariables,
      variables: {
        bookName: query
      },
      operationName: "BooksByBookname"
    }
  ];

  let lastAttempt = {
    ok: false,
    status: 0,
    payload: null
  };

  for (const baseToken of baseTokens) {
    const authorizationValues = [baseToken, `Bearer ${baseToken}`, `Token ${baseToken}`];

    for (const authorizationValue of authorizationValues) {
      const authHeaders = [
        { authorization: authorizationValue },
        { Authorization: authorizationValue },
        { "x-api-key": baseToken }
      ];

      for (const requestBody of requestBodies) {
        for (const authHeader of authHeaders) {
          const response = await fetch(HARDCOVER_ENDPOINT, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
              ...authHeader
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
      }
    }
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
    return res.json({ hasUsers, allowRegistration });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Auth-Status konnte nicht geladen werden." });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

app.post("/api/auth/login", async (req, res) => {
  const email = sanitizeEmail(req.body?.email || "");
  const password = String(req.body?.password || "");

  if (!email || !password) {
    return res.status(400).json({ error: "Bitte E-Mail und Passwort angeben." });
  }

  try {
    const db = await initDb();
    const user = await db.get("SELECT * FROM users WHERE LOWER(email) = ?", [email]);

    const verification = user ? verifyPassword(password, user.password_hash) : { ok: false, legacy: false };

    if (!user || !verification.ok) {
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

    res.cookie(SESSION_COOKIE, token, buildSessionCookieOptions(req));
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Login fehlgeschlagen." });
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
  const password = String(req.body?.password || "");
  const desiredRole = String(req.body?.role || "").toLowerCase();

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Bitte eine gültige E-Mail angeben." });
  }

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ error: `Passwort muss mindestens ${PASSWORD_MIN_LENGTH} Zeichen haben.` });
  }

  try {
    const db = await initDb();
    const stats = await db.get("SELECT COUNT(*) AS count FROM users");
    const hasUsers = (stats?.count || 0) > 0;
    const allowRegistration = await getRegistrationSetting();
    const existing = await db.get("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
    if (existing) {
      return res.status(409).json({ error: "Diese E-Mail ist bereits registriert." });
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
      "INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)",
      [email, passwordHash, role]
    );

    const created = await db.get("SELECT id, email, role FROM users WHERE id = ?", [result.lastID]);

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
    if (String(error?.message || "").includes("UNIQUE")) {
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
    return res.json({ hasToken: Boolean(token), tokenPreview: buildTokenPreview(token) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Token konnte nicht gespeichert werden." });
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
    return res.json({ allowRegistration });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Registrierungseinstellung konnte nicht gespeichert werden." });
  }
});

app.get("/api/admin/users", requireAdmin, async (_req, res) => {
  try {
    const db = await initDb();
    const users = await db.all("SELECT id, email, role, created_at FROM users ORDER BY created_at ASC");
    return res.json({ users });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Nutzer konnten nicht geladen werden." });
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

  try {
    const db = await initDb();
    const user = await db.get("SELECT id FROM users WHERE id = ?", [id]);

    if (!user) {
      return res.status(404).json({ error: "Nutzer nicht gefunden." });
    }

    const passwordHash = hashPassword(password);
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Passwort konnte nicht gespeichert werden." });
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
  try {
    const db = await initDb();
    const mangas = await db.all("SELECT * FROM mangas WHERE user_id = ? ORDER BY updated_at DESC, id DESC", [
      req.user.id
    ]);
    res.json(mangas.map(normalizeMangaRow));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fehler beim Laden der Manga-Liste." });
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

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
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

  app.listen(PORT, () => {
    console.log(`Manga Tracker läuft auf http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Serverstart fehlgeschlagen:", error);
  process.exit(1);
});








































