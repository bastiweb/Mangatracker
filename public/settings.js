const form = document.getElementById("token-form");
const tokenInput = document.getElementById("token");
const clearBtn = document.getElementById("clear-token-btn");
const tokenStatus = document.getElementById("token-status");
const message = document.getElementById("message");
const profileForm = document.getElementById("profile-form");
const profileUsernameInput = document.getElementById("profile-username");
const profileMessage = document.getElementById("profile-message");
const exportBtn = document.getElementById("export-csv-btn");
const exportMessage = document.getElementById("export-message");
const importBtn = document.getElementById("import-csv-btn");
const previewBtn = document.getElementById("preview-csv-btn");
const importFileInput = document.getElementById("import-file");
const importMessage = document.getElementById("import-message");

const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);
const usernamePattern = /^[a-zA-Z0-9._\- ]+$/;

let cachedTokenPayload = null;

function setMessage(text, isError = false) {
  if (!message) {
    return;
  }
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setProfileMessage(text, isError = false) {
  if (!profileMessage) {
    return;
  }

  profileMessage.textContent = text;
  profileMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setExportMessage(text, isError = false) {
  if (!exportMessage) {
    return;
  }

  exportMessage.textContent = text;
  exportMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setImportMessage(text, isError = false) {
  if (!importMessage) {
    return;
  }

  importMessage.textContent = text;
  importMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function validateUsernameInput(rawValue) {
  // Mirror backend username policy for immediate user feedback.
  const username = String(rawValue || "").trim();
  if (!username) {
    return t("msg_username_required");
  }
  if (username.length < 3) {
    return t("msg_username_too_short");
  }
  if (username.includes("@")) {
    return t("msg_username_no_at");
  }
  if (!usernamePattern.test(username)) {
    return t("msg_username_invalid_chars");
  }
  return "";
}

function setTokenFormEnabled(enabled) {
  if (!form) {
    return;
  }
  form.querySelectorAll("input, button").forEach((element) => {
    element.disabled = !enabled;
  });
}

function setStatus(payload) {
  cachedTokenPayload = payload;
  if (!tokenStatus) {
    return;
  }
  if (!payload?.hasToken) {
    tokenStatus.textContent = t("msg_token_missing");
    return;
  }

  tokenStatus.textContent = t("msg_token_status", {
    preview: payload.tokenPreview || t("msg_token_available")
  });
}

async function loadTokenStatus() {
  const response = await fetch("/api/settings/hardcover-token");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || t("msg_settings_load_failed"));
    error.status = response.status;
    throw error;
  }

  setStatus(data);
}

async function saveToken(token) {
  const response = await fetch("/api/settings/hardcover-token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || t("msg_token_save_failed"));
  }

  setStatus(data);
}

async function saveProfile(username) {
  const response = await fetch("/api/settings/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || t("msg_profile_save_failed"));
  }

  return data.user;
}

async function loadCurrentUser() {
  if (window.MangaAuthUser) {
    return window.MangaAuthUser;
  }
  const response = await fetch("/api/auth/me");
  if (!response.ok) {
    return null;
  }
  const data = await response.json().catch(() => ({}));
  return data.user || null;
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await saveToken(tokenInput.value.trim());
    tokenInput.value = "";
    setMessage(t("msg_token_saved"));
  } catch (error) {
    setMessage(error.message, true);
  }
});

profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const username = profileUsernameInput?.value.trim() || "";
  const usernameError = validateUsernameInput(username);
  if (usernameError) {
    setProfileMessage(usernameError, true);
    return;
  }

  try {
    const updated = await saveProfile(username);
    window.MangaAuthUser = updated;
    if (profileUsernameInput) {
      profileUsernameInput.value = updated.username || username;
    }
    const userLabel = document.getElementById("user-email");
    if (userLabel) {
      userLabel.textContent = updated.username || updated.email || "";
    }
    setProfileMessage(t("msg_profile_saved"));
  } catch (error) {
    setProfileMessage(error.message, true);
  }
});

clearBtn?.addEventListener("click", async () => {
  try {
    await saveToken("");
    tokenInput.value = "";
    setMessage(t("msg_token_removed"));
  } catch (error) {
    setMessage(error.message, true);
  }
});

exportBtn?.addEventListener("click", async () => {
  try {
    setExportMessage(t("msg_export_building"));
    const response = await fetch("/api/export/csv");
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || t("msg_export_failed"));
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `manga-export-${date}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    setExportMessage(t("msg_export_ready"));
  } catch (error) {
    setExportMessage(error.message, true);
  }
});

importBtn?.addEventListener("click", async () => {
  if (!importFileInput || !importFileInput.files || importFileInput.files.length === 0) {
    setImportMessage(t("msg_import_select_file"), true);
    return;
  }

  const file = importFileInput.files[0];
  setImportMessage(t("msg_import_running"));

  try {
    const csvText = await file.text();
    const response = await fetch("/api/import/csv", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csvText
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_import_failed"));
    }

    const imported = data.imported ?? 0;
    const skipped = data.skipped ?? 0;
    let info = t("msg_import_done", { imported, skipped });
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      info += ` ${t("msg_preview_errors", { errors: data.errors.join(" | ") })}`;
    }
    setImportMessage(info, skipped > 0);
    importFileInput.value = "";
  } catch (error) {
    setImportMessage(error.message, true);
  }
});

previewBtn?.addEventListener("click", async () => {
  if (!importFileInput || !importFileInput.files || importFileInput.files.length === 0) {
    setImportMessage(t("msg_import_select_file"), true);
    return;
  }

  const file = importFileInput.files[0];
  setImportMessage(t("msg_preview_running"));

  try {
    const csvText = await file.text();
    const response = await fetch("/api/import/csv/preview", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csvText
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_preview_failed"));
    }

    const total = data.total ?? 0;
    const newCount = data.newCount ?? 0;
    const duplicateCount = data.duplicateCount ?? 0;
    let info = t("msg_preview_result", { total, newCount, duplicateCount });
    if (Array.isArray(data.duplicates) && data.duplicates.length > 0) {
      info += ` ${t("msg_preview_examples", { examples: data.duplicates.join(" | ") })}`;
    }
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      info += ` ${t("msg_preview_errors", { errors: data.errors.join(" | ") })}`;
    }
    setImportMessage(info, duplicateCount > 0);
  } catch (error) {
    setImportMessage(error.message, true);
  }
});

window.addEventListener("manga-i18n:change", () => {
  if (cachedTokenPayload) {
    setStatus(cachedTokenPayload);
  }
});

if (window.MangaTheme && typeof window.MangaTheme.init === "function") {
  window.MangaTheme.init();
}

(async () => {
  try {
    const currentUser = await loadCurrentUser();
    const isAdmin = currentUser && currentUser.role === "admin";

    if (currentUser && profileUsernameInput) {
      profileUsernameInput.value = currentUser.username || "";
    }
    setProfileMessage(t("msg_ready"));

    if (!isAdmin) {
      setTokenFormEnabled(false);
      setMessage(t("msg_admin_only"), true);
      if (tokenStatus) {
        tokenStatus.textContent = t("msg_admin_only");
      }
    } else {
      setTokenFormEnabled(true);
      await loadTokenStatus();
      setMessage(t("msg_ready"));
    }

    setExportMessage(t("msg_ready"));
    setImportMessage(t("msg_ready"));
  } catch (error) {
    setMessage(error.message, true);
    setExportMessage(error.message, true);
    setImportMessage(error.message, true);
    setProfileMessage(error.message, true);
  }
})();
