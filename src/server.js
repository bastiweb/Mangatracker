const express = require("express");
const path = require("path");
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_STATUS = ["Geplant", "Sammle", "Pausiert", "Abgeschlossen"];

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function validatePayload(payload) {
  const title = (payload.title || "").trim();
  const status = (payload.status || "Sammle").trim();
  const notes = (payload.notes || "").trim();

  const ownedVolumes = Number(payload.ownedVolumes);
  if (!Number.isInteger(ownedVolumes) || ownedVolumes < 0) {
    return { error: "Owned Volumes muss eine positive ganze Zahl (inkl. 0) sein." };
  }

  let totalVolumes = null;
  const totalRaw = payload.totalVolumes;
  if (totalRaw !== "" && totalRaw !== null && totalRaw !== undefined) {
    totalVolumes = Number(totalRaw);
    if (!Number.isInteger(totalVolumes) || totalVolumes < 0) {
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

  return {
    value: {
      title,
      status,
      notes,
      ownedVolumes,
      totalVolumes
    }
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/manga", async (_req, res) => {
  try {
    const db = await initDb();
    const mangas = await db.all("SELECT * FROM mangas ORDER BY updated_at DESC, id DESC");
    res.json(mangas);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Fehler beim Laden der Manga-Liste." });
  }
});

app.post("/api/manga", async (req, res) => {
  const validation = validatePayload(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const db = await initDb();
    const { title, totalVolumes, ownedVolumes, status, notes } = validation.value;

    const result = await db.run(
      `
      INSERT INTO mangas (title, total_volumes, owned_volumes, status, notes)
      VALUES (?, ?, ?, ?, ?)
      `,
      [title, totalVolumes, ownedVolumes, status, notes || null]
    );

    const created = await db.get("SELECT * FROM mangas WHERE id = ?", [result.lastID]);
    return res.status(201).json(created);
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

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Ungültige ID." });
  }

  try {
    const db = await initDb();
    const { title, totalVolumes, ownedVolumes, status, notes } = validation.value;

    const result = await db.run(
      `
      UPDATE mangas
      SET title = ?, total_volumes = ?, owned_volumes = ?, status = ?, notes = ?
      WHERE id = ?
      `,
      [title, totalVolumes, ownedVolumes, status, notes || null, id]
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: "Manga nicht gefunden." });
    }

    const updated = await db.get("SELECT * FROM mangas WHERE id = ?", [id]);
    return res.json(updated);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Fehler beim Aktualisieren des Manga-Eintrags." });
  }
});

app.delete("/api/manga/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
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

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
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
