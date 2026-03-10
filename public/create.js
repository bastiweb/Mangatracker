const form = document.getElementById("manga-form");
const formTitle = document.getElementById("form-title");
const message = document.getElementById("message");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const hardcoverQuery = document.getElementById("hardcover-query");
const hardcoverSearchBtn = document.getElementById("hardcover-search-btn");
const hardcoverResults = document.getElementById("hardcover-results");
const selectedHardcover = document.getElementById("selected-hardcover");
const clearHardcoverBtn = document.getElementById("clear-hardcover-btn");
const volumeFields = document.getElementById("volume-fields");

const fields = {
  id: document.getElementById("manga-id"),
  title: document.getElementById("title"),
  isBook: document.getElementById("isBook"),
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
const AUTO_SEARCH_DELAY_MS = 500;
const AUTO_SEARCH_MIN_CHARS = 3;


const state = {
  editingId: null,
  selectedHardcover: null,
  missingVolumes: [],
  autoFillQueryFromTitle: true,
  autoSearchTimer: null,
  lastAutoQuery: ""
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

function getMediaType() {
  return fields.isBook.checked ? "book" : "manga";
}

function updateFormTitle() {
  const mediaLabel = getMediaType() === "book" ? "Buch" : "Manga-Serie";
  const titleValue = fields.title.value.trim();

  if (state.editingId === null) {
    formTitle.textContent = getMediaType() === "book" ? "Neues Buch anlegen" : "Neue Manga-Serie anlegen";
    return;
  }

  formTitle.textContent = `${mediaLabel} bearbeiten: ${titleValue || "Eintrag"}`;
}

function applyMediaTypeUi() {
  const isBook = getMediaType() === "book";

  if (volumeFields) {
    volumeFields.hidden = isBook;
  }

  if (isBook) {
    fields.ownedVolumes.value = "1";
    fields.totalVolumes.value = "1";
    state.missingVolumes = [];
  } else if (!fields.ownedVolumes.value) {
    fields.ownedVolumes.value = "0";
  }

  updateStatusForCompletion();
  updateFormTitle();
}

function updateStatusForCompletion() {
  if (getMediaType() === "book") {
    fields.status.value = "Abgeschlossen";
    return;
  }

  const owned = Number(fields.ownedVolumes.value);
  const total = Number(fields.totalVolumes.value);

  if (Number.isInteger(owned) && Number.isInteger(total) && total > 0 && owned === total) {
    fields.status.value = "Abgeschlossen";
  }
}

function scheduleAutoSearch() {
  if (!state.autoFillQueryFromTitle) {
    return;
  }

  const query = fields.title.value.trim();
  if (query.length < AUTO_SEARCH_MIN_CHARS) {
    return;
  }

  if (query === state.lastAutoQuery) {
    return;
  }

  if (state.autoSearchTimer) {
    window.clearTimeout(state.autoSearchTimer);
  }

  state.autoSearchTimer = window.setTimeout(() => {
    state.lastAutoQuery = query;
    runHardcoverSearch(query, { silent: true });
  }, AUTO_SEARCH_DELAY_MS);
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
    const seriesTitle = (entry.seriesTitle || "").trim();
    const showSeries = seriesTitle && seriesTitle !== entry.title;
    const displayTitle = seriesTitle || entry.title;
    const seriesTotal = Number.isInteger(entry.seriesTotal) ? entry.seriesTotal : null;

    const node = document.createElement("article");
    node.className = "hardcover-result";
    node.innerHTML = `
      ${getCoverMarkup(entry.imageUrl, entry.title)}
      <div>
        <h4>${escapeHtml(entry.title)}</h4>
        ${showSeries ? `<p class="muted">Serie: ${escapeHtml(seriesTitle)}</p>` : ""}
        <p>${escapeHtml(authorName || "Autor unbekannt")}</p>
      </div>
      <div class="actions">
        <button type="button">Auswählen</button>
      </div>
    `;

    node.querySelector("button").addEventListener("click", () => {
      fields.title.value = displayTitle;
      state.autoFillQueryFromTitle = true;
      syncHardcoverQueryFromTitle(true);
      updateFormTitle();

      if (
        getMediaType() === "manga" &&
        seriesTotal &&
        (!fields.totalVolumes.value || Number(fields.totalVolumes.value) === 0)
      ) {
        fields.totalVolumes.value = String(seriesTotal);
      }

      state.selectedHardcover = {
        id: entry.id,
        title: displayTitle,
        seriesTitle,
        authorName,
        imageUrl: entry.imageUrl || "",
        seriesTotal,
        rating: entry.rating ?? null,
        ratingsCount: entry.ratingsCount ?? null,
        pages: entry.pages ?? null,
        releaseYear: entry.releaseYear ?? null,
        genres: Array.isArray(entry.genres) ? entry.genres : [],
        moods: Array.isArray(entry.moods) ? entry.moods : [],
        contentWarnings: Array.isArray(entry.contentWarnings) ? entry.contentWarnings : []
      };
      updateSelectedHardcoverView();
      updateStatusForCompletion();
      setMessage("Hardcover-Verknüpfung übernommen.");
    });

    hardcoverResults.appendChild(node);
  });
}

async function runHardcoverSearch(forcedQuery = "", options = {}) {
  const { silent = false } = options;

  if (forcedQuery) {
    hardcoverQuery.value = forcedQuery;
  } else {
    syncHardcoverQueryFromTitle();
  }

  const query = (hardcoverQuery.value || fields.title.value).trim();
  if (!query) {
    if (!silent) {
      setMessage("Bitte Titel oder Suchbegriff eingeben.", true);
    }
    return;
  }

  hardcoverQuery.value = query;
  hardcoverSearchBtn.disabled = true;
  if (!silent) {
    setMessage("Suche Hardcover...", false);
  }

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
    if (!silent) {
      setMessage("Hardcover-Ergebnisse geladen.");
    }
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    hardcoverSearchBtn.disabled = false;
  }
}

function resetForm() {
  form.reset();
  fields.id.value = "";
  fields.isBook.checked = false;
  fields.ownedVolumes.value = "0";
  fields.totalVolumes.value = "";
  fields.status.value = "Sammle";
  state.editingId = null;
  state.selectedHardcover = null;
  state.missingVolumes = [];
  state.autoFillQueryFromTitle = true;
  state.lastAutoQuery = "";
  if (state.autoSearchTimer) {
    window.clearTimeout(state.autoSearchTimer);
    state.autoSearchTimer = null;
  }
  cancelEditBtn.hidden = true;
  hardcoverResults.innerHTML = "";
  applyMediaTypeUi();
  syncHardcoverQueryFromTitle(true);
  updateSelectedHardcoverView();
}

function fillFormFromManga(manga) {
  const mediaType = manga.media_type === "book" ? "book" : "manga";

  state.editingId = manga.id;
  fields.id.value = String(manga.id);
  fields.title.value = manga.title;
  fields.isBook.checked = mediaType === "book";
  fields.ownedVolumes.value = mediaType === "book" ? 1 : manga.owned_volumes;
  fields.totalVolumes.value = mediaType === "book" ? 1 : manga.total_volumes ?? "";
  fields.status.value = manga.status;
  fields.notes.value = manga.notes || "";
  state.missingVolumes = mediaType === "book" ? [] : Array.isArray(manga.missing_volumes) ? manga.missing_volumes : [];

  if (manga.author_name || manga.cover_url || manga.hardcover_book_id) {
    state.selectedHardcover = {
      id: manga.hardcover_book_id || "",
      title: manga.title,
      authorName: manga.author_name || "",
      imageUrl: manga.cover_url || "",
      seriesTotal: manga.total_volumes ?? null,
      rating: manga.rating ?? null,
      ratingsCount: manga.ratings_count ?? null,
      pages: manga.pages ?? null,
      releaseYear: manga.release_year ?? null,
      genres: Array.isArray(manga.genres) ? manga.genres : [],
      moods: Array.isArray(manga.moods) ? manga.moods : [],
      contentWarnings: Array.isArray(manga.content_warnings) ? manga.content_warnings : []
    };
  } else {
    state.selectedHardcover = null;
  }

  state.autoFillQueryFromTitle = true;
  applyMediaTypeUi();
  syncHardcoverQueryFromTitle(true);

  cancelEditBtn.hidden = false;
  updateSelectedHardcoverView();
}

async function loadEditModeIfRequested() {
  const params = new URLSearchParams(window.location.search);
  const editIdRaw = params.get("edit");
  if (!editIdRaw) {
    applyMediaTypeUi();
    syncHardcoverQueryFromTitle(true);
    updateSelectedHardcoverView();
    return;
  }

  const editId = Number(editIdRaw);
  if (!Number.isInteger(editId) || editId <= 0) {
    applyMediaTypeUi();
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
    applyMediaTypeUi();
    syncHardcoverQueryFromTitle(true);
    updateSelectedHardcoverView();
    setMessage(error.message, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const mediaType = getMediaType();
  const payload = {
    title: fields.title.value,
    mediaType,
    ownedVolumes: mediaType === "book" ? 1 : fields.ownedVolumes.value,
    totalVolumes: mediaType === "book" ? 1 : fields.totalVolumes.value,
    status: fields.status.value,
    notes: fields.notes.value,
    authorName: state.selectedHardcover?.authorName || "",
    coverUrl: state.selectedHardcover?.imageUrl || "",
    hardcoverBookId: state.selectedHardcover?.id || "",
    missingVolumes: mediaType === "book" ? [] : state.missingVolumes,
    genres: state.selectedHardcover?.genres || [],
    moods: state.selectedHardcover?.moods || [],
    contentWarnings: state.selectedHardcover?.contentWarnings || [],
    rating: state.selectedHardcover?.rating ?? null,
    ratingsCount: state.selectedHardcover?.ratingsCount ?? null,
    pages: state.selectedHardcover?.pages ?? null,
    releaseYear: state.selectedHardcover?.releaseYear ?? null
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
      setMessage("Eintrag aktualisiert. Weiterleitung zur Übersicht...");
      window.setTimeout(() => {
        window.location.href = "/";
      }, 450);
      return;
    }

    resetForm();
    setMessage("Eintrag gespeichert.");
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
  updateFormTitle();
  scheduleAutoSearch();
});

fields.isBook.addEventListener("change", () => {
  applyMediaTypeUi();
});

fields.ownedVolumes.addEventListener("input", () => {
  updateStatusForCompletion();
});

fields.totalVolumes.addEventListener("input", () => {
  updateStatusForCompletion();
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



