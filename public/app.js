const form = document.getElementById("manga-form");
const formTitle = document.getElementById("form-title");
const message = document.getElementById("message");
const list = document.getElementById("list");
const count = document.getElementById("count");
const cancelBtn = document.getElementById("cancel-btn");
const template = document.getElementById("item-template");

const fields = {
  id: document.getElementById("manga-id"),
  title: document.getElementById("title"),
  ownedVolumes: document.getElementById("ownedVolumes"),
  totalVolumes: document.getElementById("totalVolumes"),
  status: document.getElementById("status"),
  notes: document.getElementById("notes")
};

let mangas = [];

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "#b42318" : "#586069";
}

function countLabel(value) {
  return `${value} ${value === 1 ? "Eintrag" : "Einträge"}`;
}

function resetForm() {
  fields.id.value = "";
  form.reset();
  fields.ownedVolumes.value = "0";
  fields.status.value = "Sammle";
  formTitle.textContent = "Neuen Manga hinzufügen";
  cancelBtn.hidden = true;
}

async function fetchMangas() {
  const response = await fetch("/api/manga");
  if (!response.ok) {
    throw new Error("Manga-Liste konnte nicht geladen werden.");
  }

  mangas = await response.json();
  render();
}

function render() {
  list.innerHTML = "";

  if (mangas.length === 0) {
    list.innerHTML = "<p>Noch keine Mangas vorhanden.</p>";
    count.textContent = countLabel(0);
    return;
  }

  count.textContent = countLabel(mangas.length);

  mangas.forEach((manga) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector(".item-title").textContent = manga.title;
    node.querySelector(".badge").textContent = manga.status;
    node.querySelector(".volumes").textContent = `Bände: ${manga.owned_volumes}${manga.total_volumes !== null ? ` / ${manga.total_volumes}` : ""}`;
    node.querySelector(".notes").textContent = manga.notes || "Keine Notizen";

    const editBtn = node.querySelector('[data-action="edit"]');
    const deleteBtn = node.querySelector('[data-action="delete"]');

    editBtn.addEventListener("click", () => startEdit(manga.id));
    deleteBtn.addEventListener("click", async () => {
      try {
        await removeManga(manga.id, manga.title);
      } catch (error) {
        setMessage(error.message, true);
      }
    });

    list.appendChild(node);
  });
}

function startEdit(id) {
  const manga = mangas.find((entry) => entry.id === id);
  if (!manga) {
    return;
  }

  fields.id.value = String(manga.id);
  fields.title.value = manga.title;
  fields.ownedVolumes.value = manga.owned_volumes;
  fields.totalVolumes.value = manga.total_volumes ?? "";
  fields.status.value = manga.status;
  fields.notes.value = manga.notes || "";

  formTitle.textContent = `Manga bearbeiten: ${manga.title}`;
  cancelBtn.hidden = false;
  setMessage("Bearbeitungsmodus aktiv.");
}

async function removeManga(id, title) {
  if (!confirm(`"${title}" wirklich löschen?`)) {
    return;
  }

  const response = await fetch(`/api/manga/${id}`, { method: "DELETE" });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Löschen fehlgeschlagen.");
  }

  setMessage("Manga gelöscht.");
  await fetchMangas();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const payload = {
    title: fields.title.value,
    ownedVolumes: fields.ownedVolumes.value,
    totalVolumes: fields.totalVolumes.value,
    status: fields.status.value,
    notes: fields.notes.value
  };

  const editingId = fields.id.value;
  const endpoint = editingId ? `/api/manga/${editingId}` : "/api/manga";
  const method = editingId ? "PUT" : "POST";

  try {
    const response = await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Speichern fehlgeschlagen.");
    }

    setMessage(editingId ? "Manga aktualisiert." : "Manga gespeichert.");
    resetForm();
    await fetchMangas();
  } catch (error) {
    setMessage(error.message, true);
  }
});

cancelBtn.addEventListener("click", () => {
  resetForm();
  setMessage("Bearbeitung abgebrochen.");
});

(async () => {
  try {
    await fetchMangas();
    setMessage("Bereit.");
  } catch (error) {
    setMessage(error.message, true);
  }
})();
