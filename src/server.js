const express = require("express");
const path = require("path");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_STATUS = ["Geplant", "Sammle", "Pausiert", "Abgeschlossen"];
const HARDCOVER_TOKEN_KEY = "hardcover_api_token";
const HARDCOVER_ENDPOINT = "https://api.hardcover.app/v1/graphql";

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

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

function normalizeMangaRow(row) {
  return {
    ...row,
    author_name: row.author_name || "",
    cover_url: row.cover_url || "",
    hardcover_book_id: row.hardcover_book_id || "",
    missing_volumes: parseMissingVolumesFromDb(row.missing_volumes)
  };
}

function validatePayload(payload) {
  const title = sanitizeText(payload.title, 120);
  const status = sanitizeText(payload.status || "Sammle", 40);
  const notes = sanitizeText(payload.notes || "", 600);
  const authorName = sanitizeText(payload.authorName || "", 200);
  const coverUrl = sanitizeText(payload.coverUrl || "", 600);
  const hardcoverBookId = sanitizeText(payload.hardcoverBookId || "", 80);

  const ownedVolumes = parseNonNegativeInt(payload.ownedVolumes);
  if (ownedVolumes === null) {
    return { error: "Owned Volumes muss eine positive ganze Zahl (inkl. 0) sein." };
  }

  let totalVolumes = null;
  const totalRaw = payload.totalVolumes;
  if (totalRaw !== "" && totalRaw !== null && totalRaw !== undefined) {
    totalVolumes = parseNonNegativeInt(totalRaw);
    if (totalVolumes === null) {
      return { error: "Total Volumes muss eine positive ganze Zahl sein." };
    }
  }

  if (!title) {
    return { error: "Titel darf nicht leer sein." };
  }

  if (!ALLOWED_STATUS.includes(status)) {
    return { error: "Ungültiger Status." };
  }

  if (totalVolumes !== null && totalVolumes < ownedVolumes) {
    return { error: "Total Volumes darf nicht kleiner als Owned Volumes sein." };
  }

  const missingVolumes = normalizeMissingVolumes(payload.missingVolumes || [], totalVolumes);

  return {
    value: {
      title,
      status,
      notes,
      authorName,
      coverUrl,
      hardcoverBookId,
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

function buildTokenPreview(token) {
  if (!token) {
    return "";
  }

  if (token.length <= 8) {
    return "********";
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
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

  return {
    id,
    title,
    authorNames,
    imageUrl: sanitizeText(imageUrl, 600)
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

app.get("/api/settings/hardcover-token", async (_req, res) => {
  try {
    const token = await getSetting(HARDCOVER_TOKEN_KEY);
    return res.json({ hasToken: Boolean(token), tokenPreview: buildTokenPreview(token) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Settings konnten nicht geladen werden." });
  }
});

app.put("/api/settings/hardcover-token", async (req, res) => {
  const token = sanitizeText(req.body?.token || "", 4000);

  try {
    await setSetting(HARDCOVER_TOKEN_KEY, token || null);
    return res.json({ hasToken: Boolean(token), tokenPreview: buildTokenPreview(token) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Token konnte nicht gespeichert werden." });
  }
});

app.get("/api/hardcover/search", async (req, res) => {
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

app.get("/api/manga", async (_req, res) => {
  try {
    const db = await initDb();
    const mangas = await db.all("SELECT * FROM mangas ORDER BY updated_at DESC, id DESC");
    res.json(mangas.map(normalizeMangaRow));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fehler beim Laden der Manga-Liste." });
  }
});

app.get("/api/manga/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const manga = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    return res.json(normalizeMangaRow(manga));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Laden des Manga-Eintrags." });
  }
});
app.post("/api/manga", async (req, res) => {
  const validation = validatePayload(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const db = await initDb();
    const {
      title,
      totalVolumes,
      ownedVolumes,
      status,
      notes,
      authorName,
      coverUrl,
      hardcoverBookId,
      missingVolumes
    } = validation.value;

    const result = await db.run(
      `
      INSERT INTO mangas (
        title,
        total_volumes,
        owned_volumes,
        status,
        notes,
        author_name,
        cover_url,
        hardcover_book_id,
        missing_volumes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        title,
        totalVolumes,
        ownedVolumes,
        status,
        notes || null,
        authorName || null,
        coverUrl || null,
        hardcoverBookId || null,
        JSON.stringify(missingVolumes)
      ]
    );

    const created = await db.get("SELECT * FROM mangas WHERE id = ?", [result.lastID]);
    return res.status(201).json(normalizeMangaRow(created));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Erstellen des Manga-Eintrags." });
  }
});

app.put("/api/manga/:id", async (req, res) => {
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
    const {
      title,
      totalVolumes,
      ownedVolumes,
      status,
      notes,
      authorName,
      coverUrl,
      hardcoverBookId,
      missingVolumes
    } = validation.value;

    const result = await db.run(
      `
      UPDATE mangas
      SET title = ?,
          total_volumes = ?,
          owned_volumes = ?,
          status = ?,
          notes = ?,
          author_name = ?,
          cover_url = ?,
          hardcover_book_id = ?,
          missing_volumes = ?
      WHERE id = ?
      `,
      [
        title,
        totalVolumes,
        ownedVolumes,
        status,
        notes || null,
        authorName || null,
        coverUrl || null,
        hardcoverBookId || null,
        JSON.stringify(missingVolumes),
        id
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

app.patch("/api/manga/:id/volumes", async (req, res) => {
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
    const manga = await db.get(
      "SELECT id, owned_volumes, total_volumes, status FROM mangas WHERE id = ?",
      [id]
    );

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const updatedOwnedVolumes = manga.owned_volumes + amount;

    if (manga.total_volumes !== null && updatedOwnedVolumes > manga.total_volumes) {
      return res.status(400).json({
        error: `Maximal ${manga.total_volumes} Bände möglich. Bitte Gesamtzahl oder Anzahl anpassen.`
      });
    }

    let nextStatus = manga.status;
    if (manga.total_volumes !== null && updatedOwnedVolumes === manga.total_volumes) {
      nextStatus = "Abgeschlossen";
    }

    await db.run("UPDATE mangas SET owned_volumes = ?, status = ? WHERE id = ?", [
      updatedOwnedVolumes,
      nextStatus,
      id
    ]);

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(normalizeMangaRow(updated));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Hinzufügen neuer Bände." });
  }
});

app.patch("/api/manga/:id/missing-volumes", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const manga = await db.get("SELECT id, total_volumes FROM mangas WHERE id = ?", [id]);

    if (!manga) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const missingVolumes = normalizeMissingVolumes(req.body?.missingVolumes || [], manga.total_volumes);

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

app.delete("/api/manga/:id", async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const result = await db.run("DELETE FROM mangas WHERE id = ?", [id]);

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
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/mangas", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "mangas.html"));
});

app.get("/settings", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "settings.html"));
});

app.get("*", (req, res) => {
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























