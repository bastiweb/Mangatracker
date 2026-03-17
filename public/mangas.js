const searchInput = document.getElementById("search");
const sortSelect = document.getElementById("sort");
const genreFilter = document.getElementById("genre-filter");
const tableBody = document.getElementById("table-body");
const emptyState = document.getElementById("empty-state");
const count = document.getElementById("count");
const message = document.getElementById("message");
const template = document.getElementById("manga-row-template");
const reviewModal = document.getElementById("review-modal");
const reviewTitle = document.getElementById("review-title");
const reviewStars = Array.from(document.querySelectorAll("#review-stars .star-button"));
const reviewHint = document.getElementById("review-hint");
const reviewText = document.getElementById("review-text");
const reviewSaveBtn = document.getElementById("review-save");
const reviewClearBtn = document.getElementById("review-clear");
const reviewCancelBtn = document.getElementById("review-cancel");
const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);
const getLocale = () => {
      const lang = window.MangaI18n && window.MangaI18n.getLang ? window.MangaI18n.getLang() : "de";
      return lang === "en" ? "en" : "de";
    
};
const state = {
      mangas: [],  search: "",  sort: "updated_desc",  genre: "all"
};
let activeReviewManga = null;
let selectedReviewRating = 0;
let hoverReviewRating = 0;
function setMessage(text, isError = false) {
      message.textContent = text;
      message.style.color = isError ? "var(--danger)" : "var(--muted)";
    
}
function countLabel(value) {
      const label = value === 1 ? t("count_entry_singular") : t("count_entry_plural");
      return `${value} ${label}`;
    
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
      return isBookEntry(entry) ? t("label_book") : t("label_manga");
    
}
function normalizeGenre(value) {
      return String(value || "").trim();
    
}
function joinArray(value) {
      return Array.isArray(value) ? value.join(" ") : "";
    
}
function toSearchText(manga) {
      return [    manga.title,    manga.author_name,    manga.notes,    manga.status,    mediaTypeLabel(manga),    joinArray(manga.genres),    joinArray(manga.moods),    joinArray(manga.content_warnings),    manga.user_review  ]    .filter(Boolean)    .join(" ")    .toLowerCase();
    
}
function sortMangas(mangas, mode) {
      const clone = [...mangas];
      const locale = getLocale();
      clone.sort((a, b) => {
            if (mode === "title_asc") {
                  return a.title.localeCompare(b.title, locale);
                    
    }
        if (mode === "title_desc") {
                  return b.title.localeCompare(a.title, locale);
                    
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
      const options = ["all", ...Array.from(genres).sort((a, b) => a.localeCompare(b, getLocale()))];
      genreFilter.innerHTML = "";
      options.forEach((value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value === "all" ? t("genre_all") : value;
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
            return t("rating_label_count", {
             value: rounded, count     
    });
            
  }
    return t("rating_label", {
         value: rounded   
  });
    
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
            parts.push(t("year_label", {
             value: releaseYear     
    }));
            
  }
    if (Number.isInteger(pages) && pages > 0) {
            parts.push(t("pages_label", {
             value: pages     
    }));
            
  }
    return parts.join(" · ");
    
}
function formatUserRating(value) {
      const rating = Number(value);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            return "";
            
  }
    return "★".repeat(rating) + "☆".repeat(5 - rating);
    
}
function buildUserReviewLine(manga) {
      const stars = formatUserRating(manga.user_rating);
      const reviewText = String(manga.user_review || "").trim();
      if (stars && reviewText) {
            return t("my_rating_review", {
             stars, review: reviewText     
    });
            
  }
    if (stars) {
            return t("my_rating", {
             stars     
    });
            
  }
    if (reviewText) {
            return t("my_review", {
             review: reviewText     
    });
            
  }
    return "";
    
}
function updateReviewStars() {
      const displayRating = hoverReviewRating || selectedReviewRating;
      reviewStars.forEach((button) => {
            const rating = Number(button.dataset.rating);
            const isActive = rating <= displayRating;
            button.classList.toggle("active", isActive);
            button.setAttribute("aria-pressed", isActive ? "true" : "false");
            
  });
      if (reviewHint) {
            reviewHint.textContent = displayRating      ? t("review_selected", {
             value: displayRating     
    })      : t("review_select_hint");
            
  }
    if (reviewClearBtn) {
            const hasContent = selectedReviewRating > 0 || (reviewText && reviewText.value.trim());
            reviewClearBtn.hidden = !hasContent;
            
  }
  
}
function openReviewModal(manga) {
      activeReviewManga = manga;
      selectedReviewRating = Number(manga.user_rating) || 0;
      hoverReviewRating = 0;
      if (reviewTitle) {
            reviewTitle.textContent = t("review_title_with", {
             title: manga.title     
    });
            
  }
    if (reviewText) {
            reviewText.value = manga.user_review || "";
            
  }
    updateReviewStars();
      if (reviewModal) {
            reviewModal.hidden = false;
            
  }
  
}
function closeReviewModal() {
      activeReviewManga = null;
      selectedReviewRating = 0;
      hoverReviewRating = 0;
      if (reviewModal) {
            reviewModal.hidden = true;
            
  }
  
}
async function saveUserReview(mangaId, rating, review) {
      const response = await fetch(`/api/manga/${mangaId}/review`, {
            method: "PATCH",    headers: {
             "Content-Type": "application/json"     
    },    body: JSON.stringify({
                  userRating: rating,      userReview: review        
    })    
  });
      const data = await response.json().catch(() => ({
          
  }));
      if (!response.ok) {
            throw new Error(data.error || t("msg_review_save_failed"));
            
  }
    setMessage(t("msg_review_saved"));
      await fetchMangas();
    
}
function renderChipGroup(container, label, items, extraClass = "") {
      const values = Array.isArray(items)    ? items.map((entry) => normalizeGenre(entry)).filter(Boolean)    : [];
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
      renderChipGroup(container, t("label_genres"), manga.genres);
      renderChipGroup(container, t("label_moods"), manga.moods);
      renderChipGroup(container, t("label_warnings"), manga.content_warnings, "warning");
      container.hidden = container.childElementCount === 0;
    
}
function filteredAndSortedMangas() {
      const searchTerm = state.search.trim().toLowerCase();
      const filteredBySearch = searchTerm    ? state.mangas.filter((manga) => toSearchText(manga).includes(searchTerm))    : state.mangas;
      const activeGenre = state.genre;
      const filteredByGenre =    activeGenre && activeGenre !== "all"      ? filteredBySearch.filter((manga) => {
                  if (!Array.isArray(manga.genres)) {
                        return false;
                          
    }
              return manga.genres.some(            (genre) => normalizeGenre(genre).toLowerCase() === activeGenre.toLowerCase()          );
                  
  })      : filteredBySearch;
      return sortMangas(filteredByGenre, state.sort);
    
}
async function fetchMangas() {
      const response = await fetch("/api/manga");
      const data = await response.json().catch(() => ({
          
  }));
      if (!response.ok) {
            throw new Error(data.error || t("msg_list_load_failed"));
            
  }
    state.mangas = Array.isArray(data) ? data : [];
      updateGenreOptions();
      render();
    
}
async function removeManga(id, title) {
      if (!confirm(t("confirm_delete", {
         title: `"${title}"`   
  }))) {
            return;
            
  }
    const response = await fetch(`/api/manga/${id}`, {
         method: "DELETE"   
  });
      const data = await response.json().catch(() => ({
          
  }));
      if (!response.ok && response.status !== 204) {
            throw new Error(data.error || t("msg_delete_failed"));
            
  }
    setMessage(t("msg_deleted"));
      await fetchMangas();
    
}
async function saveMissingVolumes(mangaId, missingVolumes) {
      const response = await fetch(`/api/manga/${mangaId}/missing-volumes`, {
            method: "PATCH",    headers: {
             "Content-Type": "application/json"     
    },    body: JSON.stringify({
             missingVolumes     
    })    
  });
      const data = await response.json().catch(() => ({
          
  }));
      if (!response.ok) {
            throw new Error(data.error || t("msg_missing_save_failed"));
            
  }
    setMessage(t("msg_missing_saved"));
      await fetchMangas();
    
}
function createMissingEditor(manga) {
      const container = document.createElement("div");
      container.className = "missing-editor";
      if (isBookEntry(manga)) {
            container.innerHTML = `<p class=\"muted\">${t("missing_only_manga")}</p>`;
            return container;
            
  }
    if (manga.total_volumes === null) {
            container.innerHTML = `<p class=\"muted\">${t("missing_no_total")}</p>`;
            return container;
            
  }
    if (manga.total_volumes <= 0 || manga.owned_volumes >= manga.total_volumes) {
            container.innerHTML = `<p class=\"muted\">${t("missing_complete")}</p>`;
            return container;
            
  }
    const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = t("missing_choose");
      details.appendChild(summary);
      const grid = document.createElement("div");
      grid.className = "missing-grid";
      const selected = new Set(Array.isArray(manga.missing_volumes) ? manga.missing_volumes : []);
      for (let volume = 1;
     volume <= manga.total_volumes;
     volume += 1) {
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
      saveBtn.textContent = t("btn_save");
      saveBtn.addEventListener("click", async () => {
            const checkboxes = Array.from(grid.querySelectorAll("input[type='checkbox']"));
            const values = checkboxes      .filter((entry) => entry.checked)      .map((entry) => Number(entry.value))      .filter((entry) => Number.isInteger(entry) && entry > 0);
            try {
                  await saveMissingVolumes(manga.id, values);
                    
    }
     catch (error) {
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
            const reviewLine = row.querySelector(".review-line");
            const mediaType = row.querySelector(".media-type");
            const authorLine = row.querySelector(".author-line");
            const volumes = row.querySelector(".volumes");
            const missingLine = row.querySelector(".missing-line");
            const metaLine = row.querySelector(".meta-line");
            const chipRow = row.querySelector(".chip-row");
            const reviewBtn = row.querySelector('[data-action="review"]');
            const deleteBtn = row.querySelector('[data-action="delete"]');
            const editLink = row.querySelector('[data-action="edit"]');
            const editorTarget = row.querySelector("[data-editor]");
            title.textContent = manga.title;
            badge.textContent = manga.status;
            note.textContent = manga.notes || "";
            if (reviewLine) {
                  const reviewText = buildUserReviewLine(manga);
                  reviewLine.textContent = reviewText;
                  reviewLine.hidden = !reviewText;
                    
    }
        if (metaLine) {
                  const metaText = buildMetaLine(manga);
                  metaLine.textContent = metaText;
                  metaLine.hidden = !metaText;
                    
    }
        renderChips(chipRow, manga);
            mediaType.textContent = mediaTypeLabel(manga);
            authorLine.textContent = manga.author_name || "-";
            const totalLabel = !isBook && manga.total_volumes !== null ? ` / ${manga.total_volumes}` : "";
volumes.textContent = isBook ? t("label_book_single") : `${manga.owned_volumes}${totalLabel}`;
            const isCompleteSeries = !isBook && manga.total_volumes !== null && manga.owned_volumes >= manga.total_volumes;
            missingLine.textContent =      !isBook && Array.isArray(manga.missing_volumes) && manga.missing_volumes.length > 0 && !isCompleteSeries        ? manga.missing_volumes.join(", ")        : "-";
            cover.src = manga.cover_url || placeholderCover(manga.title);
            cover.alt = manga.cover_url      ? t("cover_alt", {
             title: manga.title     
    })      : t("cover_alt_placeholder", {
             title: manga.title     
    });
            if (reviewBtn) {
                  reviewBtn.textContent = t("btn_review");
            }
            if (editLink) {
                  editLink.textContent = t("btn_edit");
            }
            if (deleteBtn) {
                  deleteBtn.textContent = t("btn_delete");
            }
            reviewBtn.addEventListener("click", () => {
                  openReviewModal(manga);
                    
    });
            deleteBtn.addEventListener("click", async () => {
                  try {
                        await removeManga(manga.id, manga.title);
                            
      }
       catch (error) {
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
reviewStars.forEach((button) => {
      button.addEventListener("click", () => {
            const rating = Number(button.dataset.rating);
            selectedReviewRating = rating;
            hoverReviewRating = 0;
            updateReviewStars();
            
  });
      button.addEventListener("mouseenter", () => {
            const rating = Number(button.dataset.rating);
            hoverReviewRating = rating;
            updateReviewStars();
            
  });
    
});
reviewCancelBtn?.addEventListener("click", () => {
      closeReviewModal();
    
});
reviewText?.addEventListener("input", () => {
      updateReviewStars();
    
});
reviewModal?.addEventListener("click", (event) => {
      if (event.target === reviewModal) {
            closeReviewModal();
            
  }
  
});
document.getElementById("review-stars")?.addEventListener("mouseleave", () => {
      hoverReviewRating = 0;
      updateReviewStars();
    
});
reviewSaveBtn?.addEventListener("click", async () => {
      if (!activeReviewManga) {
            closeReviewModal();
            return;
            
  }
    if (!Number.isInteger(selectedReviewRating) || selectedReviewRating < 1 || selectedReviewRating > 5) {
            setMessage(t("review_select_hint"), true);
            return;
            
  }
    try {
            await saveUserReview(activeReviewManga.id, selectedReviewRating, reviewText.value.trim());
            closeReviewModal();
            
  }
   catch (error) {
            setMessage(error.message, true);
            
  }
  
});
reviewClearBtn?.addEventListener("click", async () => {
      if (!activeReviewManga) {
            closeReviewModal();
            return;
            
  }
    try {
            await saveUserReview(activeReviewManga.id, null, "");
            closeReviewModal();
            
  }
   catch (error) {
            setMessage(error.message, true);
            
  }
  
});
if (reviewModal) {
      reviewModal.hidden = true;
    
}
window.addEventListener("manga-i18n:change", () => {
      updateGenreOptions();
      render();
      if (reviewModal && !reviewModal.hidden && activeReviewManga && reviewTitle) {
            reviewTitle.textContent = t("review_title_with", { title: activeReviewManga.title });
            updateReviewStars();
      }
});
MangaTheme.init();
(async () => {
      try {
            await fetchMangas();
            setMessage(t("msg_ready"));
            
  }
   catch (error) {
            setMessage(error.message, true);
            
  }
  
})();
