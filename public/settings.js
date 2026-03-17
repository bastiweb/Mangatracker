const form = document.getElementById("token-form");
const tokenInput = document.getElementById("token");
const clearBtn = document.getElementById("clear-token-btn");
const tokenStatus = document.getElementById("token-status");
const message = document.getElementById("message");
const adminPanel = document.getElementById("admin-panel");
const registrationToggle = document.getElementById("registration-toggle");
const refreshUsersBtn = document.getElementById("refresh-users");
const userTableBody = document.getElementById("user-table-body");
const usersEmpty = document.getElementById("users-empty");
const usersMessage = document.getElementById("users-message");
const resetForm = document.getElementById("password-reset-form");
const resetUserSelect = document.getElementById("reset-user");
const resetPasswordInput = document.getElementById("reset-password");
const resetPasswordConfirmInput = document.getElementById("reset-password-confirm");
const modalOverlay = document.getElementById("modal-overlay");
const modalText = document.getElementById("modal-text");
const modalConfirm = document.getElementById("modal-confirm");
const modalCancel = document.getElementById("modal-cancel");

let currentUser = null;
let pendingReset = null;

if (modalOverlay) {
  modalOverlay.hidden = true;
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setTokenFormEnabled(enabled) {
  form.querySelectorAll("input, button").forEach((element) => {
    element.disabled = !enabled;
  });
}

function setStatus(payload) {
  if (!payload?.hasToken) {
    tokenStatus.textContent = "Aktuell ist kein Token hinterlegt.";
    return;
  }

  tokenStatus.textContent = `Token gespeichert (${payload.tokenPreview || "verfügbar"}).`;
}

async function loadTokenStatus() {
  const response = await fetch("/api/settings/hardcover-token");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Settings konnten nicht geladen werden.");
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
    throw new Error(data.error || "Token konnte nicht gespeichert werden.");
  }

  setStatus(data);
}

async function loadCurrentUser() {
  const response = await fetch("/api/auth/me");
  if (!response.ok) {
    return null;
  }

  const data = await response.json().catch(() => ({}));
  return data.user || null;
}

function setUsersMessage(text, isError = false) {
  usersMessage.textContent = text;
  usersMessage.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

async function loadRegistrationSetting() {
  const response = await fetch("/api/admin/registration");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Registrierung konnte nicht geladen werden.");
  }

  registrationToggle.checked = Boolean(data.allowRegistration);
}

async function saveRegistrationSetting(value) {
  const response = await fetch("/api/admin/registration", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowRegistration: value })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Registrierung konnte nicht gespeichert werden.");
  }

  registrationToggle.checked = Boolean(data.allowRegistration);
}

function buildUserRow(user) {
  const row = document.createElement("tr");
  row.dataset.userId = String(user.id);

  const emailCell = document.createElement("td");
  emailCell.textContent = user.email;
  row.appendChild(emailCell);

  const roleCell = document.createElement("td");
  const roleSelect = document.createElement("select");
  roleSelect.innerHTML = `
    <option value="user">Nutzer</option>
    <option value="admin">Admin</option>
  `;
  roleSelect.value = user.role;
  const isSelf = currentUser && Number(currentUser.id) === Number(user.id);
  if (isSelf) {
    roleSelect.disabled = true;
  }
  roleCell.appendChild(roleSelect);
  row.appendChild(roleCell);

  const createdCell = document.createElement("td");
  createdCell.textContent = formatDate(user.created_at);
  row.appendChild(createdCell);

  const actionCell = document.createElement("td");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "secondary";
  saveBtn.textContent = "Rolle speichern";
  if (isSelf) {
    saveBtn.disabled = true;
    saveBtn.title = "Du kannst dir selbst keine Rechte entziehen.";
  }
  actionCell.appendChild(saveBtn);
  row.appendChild(actionCell);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    setUsersMessage("Rolle wird gespeichert...");

    try {
      const response = await fetch(`/api/admin/users/${user.id}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleSelect.value })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Rolle konnte nicht gespeichert werden.");
      }

      setUsersMessage("Rolle aktualisiert.");
      roleSelect.value = data.user?.role || roleSelect.value;
    } catch (error) {
      setUsersMessage(error.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  return row;
}

async function loadUsers() {
  const response = await fetch("/api/admin/users");
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Nutzer konnten nicht geladen werden.");
  }

  const users = Array.isArray(data.users) ? data.users : [];
  userTableBody.innerHTML = "";
  usersEmpty.hidden = users.length > 0;

  users.forEach((user) => {
    userTableBody.appendChild(buildUserRow(user));
  });

  if (resetUserSelect) {
    resetUserSelect.innerHTML = "";
    users.forEach((user) => {
      const option = document.createElement("option");
      option.value = String(user.id);
      option.textContent = `${user.email} (${user.role})`;
      resetUserSelect.appendChild(option);
    });
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await saveToken(tokenInput.value.trim());
    tokenInput.value = "";
    setMessage("Token gespeichert.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearBtn.addEventListener("click", async () => {
  try {
    await saveToken("");
    tokenInput.value = "";
    setMessage("Token entfernt.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

registrationToggle?.addEventListener("change", async () => {
  try {
    setUsersMessage("Registrierung wird gespeichert...");
    await saveRegistrationSetting(registrationToggle.checked);
    setUsersMessage("Registrierungseinstellung gespeichert.");
  } catch (error) {
    registrationToggle.checked = !registrationToggle.checked;
    setUsersMessage(error.message, true);
  }
});

refreshUsersBtn?.addEventListener("click", async () => {
  try {
    setUsersMessage("Nutzer werden geladen...");
    await loadUsers();
    setUsersMessage("Bereit.");
  } catch (error) {
    setUsersMessage(error.message, true);
  }
});

function closeModal() {
  if (!modalOverlay) {
    return;
  }

  modalOverlay.hidden = true;
  pendingReset = null;
}

resetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (resetPasswordInput.value !== resetPasswordConfirmInput.value) {
    setUsersMessage("Passwörter stimmen nicht überein.", true);
    return;
  }

  const selectedOption = resetUserSelect.options[resetUserSelect.selectedIndex];
  const targetLabel = selectedOption ? selectedOption.textContent : "den ausgewählten Nutzer";

  pendingReset = {
    userId: resetUserSelect.value,
    password: resetPasswordInput.value
  };

  if (modalText) {
    modalText.textContent = `Passwort für ${targetLabel} setzen?`;
  }

  if (modalOverlay) {
    modalOverlay.hidden = false;
  }
});

modalCancel?.addEventListener("click", () => {
  closeModal();
});

modalOverlay?.addEventListener("click", (event) => {
  if (event.target === modalOverlay) {
    closeModal();
  }
});

modalConfirm?.addEventListener("click", async () => {
  if (!pendingReset) {
    closeModal();
    return;
  }

  setUsersMessage("Passwort wird gespeichert...");

  try {
    const response = await fetch(`/api/admin/users/${pendingReset.userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pendingReset.password })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Passwort konnte nicht gespeichert werden.");
    }

    resetForm.reset();
    setUsersMessage("Passwort aktualisiert.");
    closeModal();
  } catch (error) {
    setUsersMessage(error.message, true);
    closeModal();
  }
});

MangaTheme.init();

(async () => {
  try {
    currentUser = await loadCurrentUser();

    if (!currentUser || currentUser.role !== "admin") {
      adminPanel.hidden = true;
      closeModal();
      setTokenFormEnabled(false);
      setMessage("Nur Admins können die Settings bearbeiten.", true);
      return;
    }

    adminPanel.hidden = false;
    setTokenFormEnabled(true);
    await loadTokenStatus();
    await loadRegistrationSetting();
    await loadUsers();
    setMessage("Bereit.");
    setUsersMessage("Bereit.");
  } catch (error) {
    setMessage(error.message, true);
    setUsersMessage(error.message, true);
  }
})();
