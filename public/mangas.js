const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const genreFilter = document.getElementById("genre-filter");
const tableBody = document.getElementById("table-body");
const emptyState = document.getElementById("empty-state");
const count = document.getElementById("count");
const message = document.getElementById("message");
const template = document.getElementById("manga-row-template");

const state = {
  mangas: [],
  search: "",
  sort: "updated_desc",
  genre: "all"
};

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function countLabel(value) {
  return `${value} ${value === 1 ? "Eintrag" : "Einträge"}`;
}

function placeholderCover(title) {
  const letter = (title || "?").trim().charAt(0).toUpperCase() || "?";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='320'><rect width='100%' height='100%' fill='#d8dee4'/><text x='50%' y='52%' dominant-baseline='middle' text-anchor='middle' font-size='96' fill='#4b5563' font-family='Arial'>${letter}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function isBookEntry(entry) {
  return entry.media_type === "book";
}

function mediaTypeLabel(entry) {
  return isBookEntry(entry) ? "Buch" : "Manga";
}

function normalizeGenre(value) {
  return String(value || "").trim();
}

function joinArray(value) {
  return Array.isArray(value) ? value.join(" ") : "";
}

function toSearchText(manga) {
  return [
    manga.title,
    manga.author_name,
    manga.notes,
    manga.status,
    mediaTypeLabel(manga),
    joinArray(manga.genres),
    joinArray(manga.moods),
    joinArray(manga.content_warnings)
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sortMangas(mangas, mode) {
  const clone = [...mangas];

  clone.sort((a, b) => {
    if (mode === "title_asc") {
      return a.title.localeCompare(b.title, "de");
    }

    if (mode === "title_desc") {
      return b.title.localeCompare(a.title, "de");
    }

    if (mode === "owned_desc") {
      return b.owned_volumes - a.owned_volumes;
    }

    if (mode === "owned_asc") {
      return a.owned_volumes - b.owned_volumes;
    }

    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return clone;
}

function updateGenreOptions() {
  if (!genreFilter) {
    return;
  }

  const current = state.genre;
  const genres = new Set();

  state.mangas.forEach((manga) => {
    if (!Array.isArray(manga.genres)) {
      return;
    }

    manga.genres.forEach((genre) => {
      const normalized = normalizeGenre(genre);
      if (normalized) {
        genres.add(normalized);
      }
    });
  });

  const options = ["all", ...Array.from(genres).sort((a, b) => a.localeCompare(b, "de"))];

  genreFilter.innerHTML = "";
  options.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "Alle Genres" : value;
    genreFilter.appendChild(option);
  });

  if (!options.includes(current)) {
    state.genre = "all";
  }

  genreFilter.value = state.genre;
}

function formatRating(manga) {
  const ratingValue = Number(manga.rating);
  if (!Number.isFinite(ratingValue) || ratingValue <= 0) {
    return "";
  }

  const rounded = Math.round(ratingValue * 10) / 10;
  const count = Number(manga.ratings_count);

  if (Number.isInteger(count) && count > 0) {
    return `Rating ${rounded} (${count})`;
  }

  return `Rating ${rounded}`;
}

function buildMetaLine(manga) {
  const parts = [];
  const ratingText = formatRating(manga);
  const releaseYear = Number(manga.release_year);
  const pages = Number(manga.pages);

  if (ratingText) {
    parts.push(ratingText);
  }

  if (Number.isInteger(releaseYear) && releaseYear > 0) {
    parts.push(`Jahr ${releaseYear}`);
  }

  if (Number.isInteger(pages) && pages > 0) {
    parts.push(`${pages} Seiten`);
  }

  return parts.join(" · ");
}

function renderChipGroup(container, label, items, extraClass = "") {
  const values = Array.isArray(items)
    ? items.map((entry) => normalizeGenre(entry)).filter(Boolean)
    : [];

  if (values.length === 0) {
    return;
  }

  const group = document.createElement("div");
  group.className = "chip-group";

  const labelNode = document.createElement("span");
  labelNode.className = "chip-label";
  labelNode.textContent = label;
  group.appendChild(labelNode);

  const maxItems = 6;
  values.slice(0, maxItems).forEach((value) => {
    const chip = document.createElement("span");
    chip.className = extraClass ? `chip ${extraClass}` : "chip";
    chip.textContent = value;
    group.appendChild(chip);
  });

  if (values.length > maxItems) {
    const overflow = document.createElement("span");
    overflow.className = extraClass ? `chip ${extraClass}` : "chip";
    overflow.textContent = `+${values.length - maxItems}`;
    group.appendChild(overflow);
  }

  container.appendChild(group);
}

function renderChips(container, manga) {
  if (!container) {
    return;
  }

  container.innerHTML = "";
  renderChipGroup(container, "Genres", manga.genres);
  renderChipGroup(container, "Stimmung", manga.moods);
  renderChipGroup(container, "Warnungen", manga.content_warnings, "warning");
  container.hidden = container.childElementCount === 0;
}

function filteredAndSortedMangas() {
  const searchTerm = state.search.trim().toLowerCase();
  const filteredBySearch = searchTerm
    ? state.mangas.filter((manga) => toSearchText(manga).includes(searchTerm))
    : state.mangas;

  const activeGenre = state.genre;
  const filteredByGenre =
    activeGenre && activeGenre !== "all"
      ? filteredBySearch.filter((manga) => {
          if (!Array.isArray(manga.genres)) {
            return false;
          }

          return manga.genres.some(
            (genre) => normalizeGenre(genre).toLowerCase() === activeGenre.toLowerCase()
          );
        })
      : filteredBySearch;

  return sortMangas(filteredByGenre, state.sort);
}


async function fetchMangas() {
  const response = await fetch("/api/manga");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Liste konnte nicht geladen werden.");
  }

  state.mangas = Array.isArray(data) ? data : [];
  updateGenreOptions();
  render();
}


async function removeManga(id, title) {
  if (!confirm(`"${title}" wirklich löschen?`)) {
    return;
  }

  const response = await fetch(`/api/manga/${id}`, { method: "DELETE" });
  const data = await response.json().catch(() => ({}));

  if (!response.ok && response.status !== 204) {
    throw new Error(data.error || "Löschen fehlgeschlagen.");
  }

  setMessage("Eintrag gelöscht.");
  await fetchMangas();
}

async function saveMissingVolumes(mangaId, missingVolumes) {
  const response = await fetch(`/api/manga/${mangaId}/missing-volumes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ missingVolumes })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Fehlende Bände konnten nicht gespeichert werden.");
  }

  setMessage("Fehlende Bände gespeichert.");
  await fetchMangas();
}

function createMissingEditor(manga) {
  const container = document.createElement("div");
  container.className = "missing-editor";

  if (isBookEntry(manga)) {
    container.innerHTML = '<p class="muted">Nur für Manga verfügbar.</p>';
    return container;
  }

  if (manga.total_volumes === null) {
    container.innerHTML = '<p class="muted">Gesamtzahl fehlt.</p>';
    return container;
  }

  if (manga.total_volumes <= 0 || manga.owned_volumes >= manga.total_volumes) {
    container.innerHTML = '<p class="muted">Serie vollständig. Keine fehlenden Bände auswählbar.</p>';
    return container;
  }

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Fehlende wählen";
  details.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "missing-grid";

  const selected = new Set(Array.isArray(manga.missing_volumes) ? manga.missing_volumes : []);

  for (let volume = 1; volume <= manga.total_volumes; volume += 1) {
    const label = document.createElement("label");
    label.className = "missing-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(volume);
    checkbox.checked = selected.has(volume);

    const text = document.createElement("span");
    text.textContent = `${volume}`;

    label.appendChild(checkbox);
    label.appendChild(text);
    grid.appendChild(label);
  }

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Speichern";

  saveBtn.addEventListener("click", async () => {
    const checkboxes = Array.from(grid.querySelectorAll("input[type='checkbox']"));
    const values = checkboxes
      .filter((entry) => entry.checked)
      .map((entry) => Number(entry.value))
      .filter((entry) => Number.isInteger(entry) && entry > 0);

    try {
      await saveMissingVolumes(manga.id, values);
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  details.appendChild(grid);
  details.appendChild(saveBtn);
  container.appendChild(details);

  return container;
}

function render() {
  const mangas = filteredAndSortedMangas();
  tableBody.innerHTML = "";

  count.textContent = countLabel(mangas.length);
  emptyState.hidden = mangas.length !== 0;

  if (mangas.length === 0) {
    return;
  }

  mangas.forEach((manga) => {
    const row = template.content.firstElementChild.cloneNode(true);
    const isBook = isBookEntry(manga);

    const cover = row.querySelector(".cover");
    const title = row.querySelector(".item-title");
    const badge = row.querySelector(".badge");
    const note = row.querySelector(".cell-note");
    const mediaType = row.querySelector(".media-type");
    const authorLine = row.querySelector(".author-line");
    const volumes = row.querySelector(".volumes");
    const missingLine = row.querySelector(".missing-line");
    const metaLine = row.querySelector(".meta-line");
    const chipRow = row.querySelector(".chip-row");


    const deleteBtn = row.querySelector('[data-action="delete"]');
    const editLink = row.querySelector('[data-action="edit"]');
    const editorTarget = row.querySelector("[data-editor]");

    title.textContent = manga.title;
    badge.textContent = manga.status;
    note.textContent = manga.notes || "";
    if (metaLine) {
      const metaText = buildMetaLine(manga);
      metaLine.textContent = metaText;
      metaLine.hidden = !metaText;
    }
    renderChips(chipRow, manga);
    mediaType.textContent = mediaTypeLabel(manga);
    authorLine.textContent = manga.author_name || "-";
    volumes.textContent = isBook
      ? "Einzelbuch"
      : `${manga.owned_volumes}${manga.total_volumes !== null ? ` / ${manga.total_volumes}` : ""}`;

    const isCompleteSeries = !isBook && manga.total_volumes !== null && manga.owned_volumes >= manga.total_volumes;
    missingLine.textContent =
      !isBook && Array.isArray(manga.missing_volumes) && manga.missing_volumes.length > 0 && !isCompleteSeries
        ? manga.missing_volumes.join(", ")
        : "-";

    cover.src = manga.cover_url || placeholderCover(manga.title);
    cover.alt = manga.cover_url ? `Cover von ${manga.title}` : `Platzhalter-Cover ${manga.title}`;


    deleteBtn.addEventListener("click", async () => {
      try {
        await removeManga(manga.id, manga.title);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    editLink.href = `/create?edit=${manga.id}`;
    editorTarget.replaceWith(createMissingEditor(manga));

    tableBody.appendChild(row);
  });
}

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  render();
});

sortSelect.addEventListener("change", () => {
  state.sort = sortSelect.value;
  render();
});

if (genreFilter) {
  genreFilter.addEventListener("change", () => {
    state.genre = genreFilter.value;
    render();
  });
}

MangaTheme.init();

(async () => {
  try {
    await fetchMangas();
    setMessage("Bereit.");
  } catch (error) {
    setMessage(error.message, true);
  }
})();











