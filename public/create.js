const form = document.getElementById("manga-form");
const formTitle = document.getElementById("form-title");
const message = document.getElementById("message");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const hardcoverQuery = document.getElementById("hardcover-query");
const hardcoverSearchBtn = document.getElementById("hardcover-search-btn");
const hardcoverResults = document.getElementById("hardcover-results");
const selectedHardcover = document.getElementById("selected-hardcover");
const clearHardcoverBtn = document.getElementById("clear-hardcover-btn");

const fields = {
  id: document.getElementById("manga-id"),
  title: document.getElementById("title"),
  ownedVolumes: document.getElementById("ownedVolumes"),
  totalVolumes: document.getElementById("totalVolumes"),
  status: document.getElementById("status"),
  notes: document.getElementById("notes")
};

const NOISE_TITLE_KEYWORDS = [
  "notebook",
  "journal",
  "planner",
  "workbook",
  "activity book",
  "coloring",
  "sketchbook",
  "composition",
  "log book"
];

const state = {
  editingId: null,
  selectedHardcover: null,
  missingVolumes: [],
  autoFillQueryFromTitle: true
};

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getCoverMarkup(url, alt) {
  if (!url) {
    return "";
  }

  const safeUrl = escapeHtml(url);
  const safeAlt = escapeHtml(alt);
  return `<img src="${safeUrl}" alt="${safeAlt}" loading="lazy" />`;
}

function normalizeString(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function toTokens(value) {
  return normalizeString(value)
    .split(/[^a-z0-9]+/)
    .filter((entry) => entry.length > 1);
}

function scoreHardcoverResult(entry, query) {
  const title = normalizeString(entry.title);
  const queryNormalized = normalizeString(query);
  const queryTokens = toTokens(query);
  const hasImage = Boolean(entry.imageUrl);

  let score = 0;

  if (queryNormalized && title.includes(queryNormalized)) {
    score += 30;
  }

  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 6;
    }
  }

  if (/\b(vol\.?|volume|band)\s*\d+\b|\b#\d+\b/i.test(entry.title || "")) {
    score += 14;
  }

  if (Array.isArray(entry.authorNames) && entry.authorNames.length > 0) {
    score += 4;
  }

  score += hasImage ? 12 : -12;

  for (const noise of NOISE_TITLE_KEYWORDS) {
    if (title.includes(noise)) {
      score -= 40;
    }
  }

  return score;
}

function prepareHardcoverResults(results, query) {
  const ranked = (Array.isArray(results) ? results : [])
    .map((entry) => ({
      ...entry,
      _score: scoreHardcoverResult(entry, query),
      _hasImage: Boolean(entry.imageUrl)
    }))
    .sort((a, b) => b._score - a._score);

  const withImage = ranked.filter((entry) => entry._hasImage);
  const filtered = withImage.length >= 2 ? ranked.filter((entry) => entry._hasImage || entry._score >= 18) : ranked;

  return filtered.slice(0, 5).map(({ _score, _hasImage, ...entry }) => entry);
}

function syncHardcoverQueryFromTitle(force = false) {
  const title = fields.title.value.trim();

  if (force || state.autoFillQueryFromTitle || !hardcoverQuery.value.trim()) {
    hardcoverQuery.value = title;
  }
}

function updateSelectedHardcoverView() {
  if (!state.selectedHardcover) {
    selectedHardcover.className = "selected-hardcover empty";
    selectedHardcover.innerHTML = "Noch keine Hardcover-Verknüpfung ausgewählt.";
    return;
  }

  const selected = state.selectedHardcover;
  selectedHardcover.className = "selected-hardcover";
  selectedHardcover.innerHTML = `
    ${getCoverMarkup(selected.imageUrl, selected.title)}
    <div>
      <strong>${escapeHtml(selected.title)}</strong>
      <p class="muted">Autor: ${escapeHtml(selected.authorName || "Unbekannt")}</p>
      <p class="muted">Hardcover-ID: ${escapeHtml(selected.id)}</p>
    </div>
  `;
}

function renderHardcoverResults(results) {
  hardcoverResults.innerHTML = "";

  if (!results.length) {
    hardcoverResults.innerHTML = "<p class=\"muted\">Keine passenden Treffer gefunden.</p>";
    return;
  }

  results.forEach((entry) => {
    const authorName = Array.isArray(entry.authorNames) ? entry.authorNames.join(", ") : "";
    const node = document.createElement("article");
    node.className = "hardcover-result";
    node.innerHTML = `
      ${getCoverMarkup(entry.imageUrl, entry.title)}
      <div>
        <h4>${escapeHtml(entry.title)}</h4>
        <p>${escapeHtml(authorName || "Autor unbekannt")}</p>
      </div>
      <div class="actions">
        <button type="button">Auswählen</button>
      </div>
    `;

    node.querySelector("button").addEventListener("click", () => {
      state.selectedHardcover = {
        id: entry.id,
        title: entry.title,
        authorName,
        imageUrl: entry.imageUrl || ""
      };
      updateSelectedHardcoverView();
      setMessage("Hardcover-Verknüpfung übernommen.");
    });

    hardcoverResults.appendChild(node);
  });
}

async function runHardcoverSearch() {
  syncHardcoverQueryFromTitle();

  const query = (hardcoverQuery.value || fields.title.value).trim();
  if (!query) {
    setMessage("Bitte Titel oder Suchbegriff eingeben.", true);
    return;
  }

  hardcoverQuery.value = query;
  hardcoverSearchBtn.disabled = true;
  setMessage("Suche Hardcover...", false);

  try {
    const response = await fetch(`/api/hardcover/search?query=${encodeURIComponent(query)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const detailMessage =
        data?.details?.errors?.[0]?.message ||
        data?.details?.message ||
        (typeof data?.details?.raw === "string" ? data.details.raw.slice(0, 140) : "");

      throw new Error(
        detailMessage
          ? `${data.error || "Hardcover-Suche fehlgeschlagen."} (${detailMessage})`
          : data.error || "Hardcover-Suche fehlgeschlagen."
      );
    }

    const preparedResults = prepareHardcoverResults(Array.isArray(data.results) ? data.results : [], query);
    renderHardcoverResults(preparedResults);
    setMessage("Hardcover-Ergebnisse geladen.");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    hardcoverSearchBtn.disabled = false;
  }
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  fields.ownedVolumes.value = "0";
  fields.status.value = "Sammle";
  formTitle.textContent = "Neue Manga-Serie anlegen";
  state.editingId = null;
  state.selectedHardcover = null;
  state.missingVolumes = [];
  state.autoFillQueryFromTitle = true;
  cancelEditBtn.hidden = true;
  hardcoverResults.innerHTML = "";
  syncHardcoverQueryFromTitle(true);
  updateSelectedHardcoverView();
}

function fillFormFromManga(manga) {
  state.editingId = manga.id;
  fields.id.value = String(manga.id);
  fields.title.value = manga.title;
  fields.ownedVolumes.value = manga.owned_volumes;
  fields.totalVolumes.value = manga.total_volumes ?? "";
  fields.status.value = manga.status;
  fields.notes.value = manga.notes || "";
  state.missingVolumes = Array.isArray(manga.missing_volumes) ? manga.missing_volumes : [];

  if (manga.author_name || manga.cover_url || manga.hardcover_book_id) {
    state.selectedHardcover = {
      id: manga.hardcover_book_id || "",
      title: manga.title,
      authorName: manga.author_name || "",
      imageUrl: manga.cover_url || ""
    };
  } else {
    state.selectedHardcover = null;
  }

  state.autoFillQueryFromTitle = true;
  syncHardcoverQueryFromTitle(true);

  formTitle.textContent = `Serie bearbeiten: ${manga.title}`;
  cancelEditBtn.hidden = false;
  updateSelectedHardcoverView();
}

async function loadEditModeIfRequested() {
  const params = new URLSearchParams(window.location.search);
  const editIdRaw = params.get("edit");
  if (!editIdRaw) {
    syncHardcoverQueryFromTitle(true);
    updateSelectedHardcoverView();
    return;
  }

  const editId = Number(editIdRaw);
  if (!Number.isInteger(editId) || editId <= 0) {
    syncHardcoverQueryFromTitle(true);
    updateSelectedHardcoverView();
    return;
  }

  try {
    const response = await fetch(`/api/manga/${editId}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Serie konnte nicht geladen werden.");
    }

    fillFormFromManga(data);
    setMessage("Bearbeitungsmodus aktiv.");
  } catch (error) {
    syncHardcoverQueryFromTitle(true);
    updateSelectedHardcoverView();
    setMessage(error.message, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    title: fields.title.value,
    ownedVolumes: fields.ownedVolumes.value,
    totalVolumes: fields.totalVolumes.value,
    status: fields.status.value,
    notes: fields.notes.value,
    authorName: state.selectedHardcover?.authorName || "",
    coverUrl: state.selectedHardcover?.imageUrl || "",
    hardcoverBookId: state.selectedHardcover?.id || "",
    missingVolumes: state.missingVolumes
  };

  const isEdit = state.editingId !== null;
  const endpoint = isEdit ? `/api/manga/${state.editingId}` : "/api/manga";
  const method = isEdit ? "PUT" : "POST";

  try {
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Speichern fehlgeschlagen.");
    }

    if (isEdit) {
      setMessage("Serie aktualisiert. Weiterleitung zur Übersicht...");
      window.setTimeout(() => {
        window.location.href = "/mangas";
      }, 450);
      return;
    }

    resetForm();
    setMessage("Serie gespeichert.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

hardcoverSearchBtn.addEventListener("click", runHardcoverSearch);

hardcoverQuery.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runHardcoverSearch();
  }
});

hardcoverQuery.addEventListener("input", () => {
  const query = hardcoverQuery.value.trim();
  const title = fields.title.value.trim();
  state.autoFillQueryFromTitle = query === "" || query === title;
});

fields.title.addEventListener("input", () => {
  syncHardcoverQueryFromTitle();
});

clearHardcoverBtn.addEventListener("click", () => {
  state.selectedHardcover = null;
  updateSelectedHardcoverView();
  setMessage("Hardcover-Verknüpfung entfernt.");
});

cancelEditBtn.addEventListener("click", () => {
  window.location.href = "/";
});

MangaTheme.init();
loadEditModeIfRequested();
