const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const tableBody = document.getElementById("table-body");
const emptyState = document.getElementById("empty-state");
const count = document.getElementById("count");
const message = document.getElementById("message");
const template = document.getElementById("manga-row-template");

const state = {
  mangas: [],
  search: "",
  sort: "updated_desc"
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

function toSearchText(manga) {
  return [manga.title, manga.author_name, manga.notes, manga.status]
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

function filteredAndSortedMangas() {
  const searchTerm = state.search.trim().toLowerCase();
  const filtered = searchTerm
    ? state.mangas.filter((manga) => toSearchText(manga).includes(searchTerm))
    : state.mangas;

  return sortMangas(filtered, state.sort);
}

function canIncrease(manga, amount) {
  return manga.total_volumes === null || manga.owned_volumes + amount <= manga.total_volumes;
}

async function fetchMangas() {
  const response = await fetch("/api/manga");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Manga-Liste konnte nicht geladen werden.");
  }

  state.mangas = Array.isArray(data) ? data : [];
  render();
}

async function addVolumes(id, amount, title) {
  const response = await fetch(`/api/manga/${id}/volumes`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Bände konnten nicht hinzugefügt werden.");
  }

  const bandLabel = amount === 1 ? "Band" : "Bände";
  setMessage(`${amount} ${bandLabel} zu "${title}" hinzugefügt.`);
  await fetchMangas();
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

  setMessage("Serie gelöscht.");
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

  if (!manga.total_volumes || manga.total_volumes <= 0) {
    container.innerHTML = "<p class=\"muted\">Gesamtzahl fehlt.</p>";
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

    const cover = row.querySelector(".cover");
    const title = row.querySelector(".item-title");
    const badge = row.querySelector(".badge");
    const note = row.querySelector(".cell-note");
    const authorLine = row.querySelector(".author-line");
    const volumes = row.querySelector(".volumes");
    const missingLine = row.querySelector(".missing-line");

    const addOneBtn = row.querySelector('[data-action="add-1"]');
    const addFiveBtn = row.querySelector('[data-action="add-5"]');
    const deleteBtn = row.querySelector('[data-action="delete"]');
    const editLink = row.querySelector('[data-action="edit"]');
    const editorTarget = row.querySelector("[data-editor]");

    title.textContent = manga.title;
    badge.textContent = manga.status;
    note.textContent = manga.notes || "";
    authorLine.textContent = manga.author_name || "-";
    volumes.textContent = `${manga.owned_volumes}${manga.total_volumes !== null ? ` / ${manga.total_volumes}` : ""}`;
    missingLine.textContent =
      Array.isArray(manga.missing_volumes) && manga.missing_volumes.length > 0
        ? manga.missing_volumes.join(", ")
        : "-";

    cover.src = manga.cover_url || placeholderCover(manga.title);
    cover.alt = manga.cover_url ? `Cover von ${manga.title}` : `Platzhalter-Cover ${manga.title}`;

    addOneBtn.disabled = !canIncrease(manga, 1);
    addFiveBtn.disabled = !canIncrease(manga, 5);

    addOneBtn.addEventListener("click", async () => {
      try {
        await addVolumes(manga.id, 1, manga.title);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    addFiveBtn.addEventListener("click", async () => {
      try {
        await addVolumes(manga.id, 5, manga.title);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    deleteBtn.addEventListener("click", async () => {
      try {
        await removeManga(manga.id, manga.title);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    editLink.href = `/?edit=${manga.id}`;
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

MangaTheme.init();

(async () => {
  try {
    await fetchMangas();
    setMessage("Bereit.");
  } catch (error) {
    setMessage(error.message, true);
  }
})();
