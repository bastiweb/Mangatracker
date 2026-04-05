const message = document.getElementById("message");
const registrationToggle = document.getElementById("registration-toggle");
const refreshUsersBtn = document.getElementById("refresh-users");
const userTableBody = document.getElementById("user-table-body");
const usersEmpty = document.getElementById("users-empty");
const usersMessage = document.getElementById("users-message");
const userSearch = document.getElementById("user-search");
const roleFilter = document.getElementById("role-filter");
const userSort = document.getElementById("user-sort");
const userStats = document.getElementById("user-stats");
const resetForm = document.getElementById("password-reset-form");
const resetUserSelect = document.getElementById("reset-user");
const resetPasswordInput = document.getElementById("reset-password");
const resetPasswordConfirmInput = document.getElementById("reset-password-confirm");
const modalOverlay = document.getElementById("modal-overlay");
const modalText = document.getElementById("modal-text");
const modalConfirm = document.getElementById("modal-confirm");
const modalCancel = document.getElementById("modal-cancel");

const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);

let currentUser = null;
let pendingReset = null;
let cachedUsers = [];
const state = {
  search: "",
  role: "all",
  sort: "created_asc",
  users: [],
  totalUsers: 0
};
let userQueryTimer = null;

if (modalOverlay) {
  modalOverlay.hidden = true;
}

function setMessage(text, isError = false) {
  if (!message) {
    return;
  }
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setUsersMessage(text, isError = false) {
  if (!usersMessage) {
    return;
  }
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

  const lang = window.MangaI18n && window.MangaI18n.getLang ? window.MangaI18n.getLang() : "de";
  const locale = lang === "en" ? "en-US" : "de-DE";
  return parsed.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

function updateStats(list, totalUsersValue) {
  if (!userStats) {
    return;
  }

  const total = Number(totalUsersValue || 0);
  const shown = list.length;
  const admins = list.filter((user) => user.role === "admin").length;
  const sessions = list.reduce((sum, user) => sum + (user.session_count || 0), 0);
  const entries = list.reduce((sum, user) => sum + (user.entries_count || 0), 0);

  userStats.textContent = t("stats_summary", { shown, total, admins, sessions, entries });
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

function buildUserRow(user) {
  const row = document.createElement("tr");
  row.dataset.userId = String(user.id);

  const emailCell = document.createElement("td");
  emailCell.textContent = user.email;
  row.appendChild(emailCell);

  const usernameCell = document.createElement("td");
  usernameCell.textContent = user.username || "-";
  row.appendChild(usernameCell);

  const roleCell = document.createElement("td");
  const roleSelect = document.createElement("select");
  roleSelect.innerHTML = `
    <option value="user">${t("role_user")}</option>
    <option value="admin">${t("role_admin")}</option>
  `;
  roleSelect.value = user.role;
  const isSelf = currentUser && Number(currentUser.id) === Number(user.id);
  if (isSelf) {
    roleSelect.disabled = true;
  }
  roleCell.appendChild(roleSelect);
  row.appendChild(roleCell);

  const entriesCell = document.createElement("td");
  entriesCell.textContent = String(user.entries_count ?? 0);
  row.appendChild(entriesCell);

  const sessionsCell = document.createElement("td");
  sessionsCell.textContent = String(user.session_count ?? 0);
  row.appendChild(sessionsCell);

  const lastLoginCell = document.createElement("td");
  lastLoginCell.textContent = user.last_session_at ? formatDate(user.last_session_at) : "-";
  row.appendChild(lastLoginCell);

  const createdCell = document.createElement("td");
  createdCell.textContent = formatDate(user.created_at);
  row.appendChild(createdCell);

  const actionCell = document.createElement("td");
  const actionsWrapper = document.createElement("div");
  actionsWrapper.className = "quick-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "secondary";
  saveBtn.textContent = t("btn_role_save");
  if (isSelf) {
    saveBtn.disabled = true;
    saveBtn.title = t("msg_self_demote");
  }
  actionsWrapper.appendChild(saveBtn);

  const logoutBtn = document.createElement("button");
  logoutBtn.type = "button";
  logoutBtn.className = "secondary";
  logoutBtn.textContent = t("btn_force_logout");
  if (isSelf) {
    logoutBtn.disabled = true;
    logoutBtn.title = t("msg_force_logout_self");
  }
  actionsWrapper.appendChild(logoutBtn);

  actionCell.appendChild(actionsWrapper);
  row.appendChild(actionCell);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    setUsersMessage(t("msg_role_saving"));

    try {
      const response = await fetch(`/api/admin/users/${user.id}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleSelect.value })
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || t("msg_role_save_failed"));
      }

      setUsersMessage(t("msg_role_updated"));
      roleSelect.value = data.user?.role || roleSelect.value;
    } catch (error) {
      setUsersMessage(error.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    if (isSelf) {
      setUsersMessage(t("msg_force_logout_self"), true);
      return;
    }
    setUsersMessage(t("msg_sessions_cleared"));
    try {
      const response = await fetch(`/api/admin/users/${user.id}/sessions`, {
        method: "DELETE"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || t("msg_sessions_clear_failed"));
      }
      await loadUsers();
      setUsersMessage(t("msg_sessions_cleared"));
    } catch (error) {
      setUsersMessage(error.message, true);
    }
  });

  return row;
}

function renderUsers(list) {
  if (!userTableBody) {
    return;
  }
  userTableBody.innerHTML = "";
  if (usersEmpty) {
    usersEmpty.hidden = list.length > 0;
  }

  list.forEach((user) => {
    userTableBody.appendChild(buildUserRow(user));
  });

  if (resetUserSelect) {
    resetUserSelect.innerHTML = "";
    state.users.forEach((user) => {
      const option = document.createElement("option");
      option.value = String(user.id);
      const label = user.username ? `${user.username} (${user.email})` : user.email;
      option.textContent = `${label} (${user.role})`;
      resetUserSelect.appendChild(option);
    });
  }

  updateStats(list, state.totalUsers || list.length);
}

async function loadUsers() {
  const params = new URLSearchParams();
  const searchValue = (state.search || "").trim();

  if (searchValue) {
    params.set("q", searchValue);
  }
  if (state.role && state.role !== "all") {
    params.set("role", state.role);
  }
  if (state.sort) {
    params.set("sort", state.sort);
  }

  const query = params.toString();
  const endpoint = query ? `/api/admin/users?${query}` : "/api/admin/users";
  const response = await fetch(endpoint);

  if (response.status === 401) {
    window.location.href = "/login";
    return null;
  }

  if (response.status === 403) {
    window.location.href = "/";
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || t("msg_users_load_failed"));
  }

  const users = Array.isArray(data.users) ? data.users : [];
  cachedUsers = users;
  state.users = users;
  state.totalUsers = Number(data.total ?? users.length);
  renderUsers(users);
  return users;
}

function scheduleUsersReload(delayMs = 250) {
  if (userQueryTimer) {
    clearTimeout(userQueryTimer);
  }

  userQueryTimer = window.setTimeout(async () => {
    try {
      setUsersMessage(t("msg_users_loading"));
      await loadUsers();
      setUsersMessage(t("msg_ready"));
    } catch (error) {
      setUsersMessage(error.message, true);
    }
  }, delayMs);
}

async function loadRegistrationSetting() {
  const response = await fetch("/api/admin/registration");

  if (response.status === 401) {
    window.location.href = "/login";
    return;
  }

  if (response.status === 403) {
    window.location.href = "/";
    return;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || t("msg_registration_load_failed"));
  }

  if (registrationToggle) {
    registrationToggle.checked = Boolean(data.allowRegistration);
  }
}

async function saveRegistrationSetting(value) {
  const response = await fetch("/api/admin/registration", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowRegistration: value })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || t("msg_registration_save_failed"));
  }

  if (registrationToggle) {
    registrationToggle.checked = Boolean(data.allowRegistration);
  }
}

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
    setUsersMessage(t("msg_password_mismatch"), true);
    return;
  }

  if (!resetUserSelect || resetUserSelect.options.length === 0) {
    setUsersMessage(t("msg_selected_user"), true);
    return;
  }

  const selectedOption = resetUserSelect.options[resetUserSelect.selectedIndex];
  const targetLabel = selectedOption ? selectedOption.textContent : t("msg_selected_user");

  pendingReset = {
    userId: resetUserSelect.value,
    password: resetPasswordInput.value
  };

  if (modalText) {
    modalText.textContent = t("msg_reset_confirm", { target: targetLabel });
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

  setUsersMessage(t("msg_password_saving"));

  try {
    const response = await fetch(`/api/admin/users/${pendingReset.userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pendingReset.password })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_password_save_failed"));
    }

    resetForm.reset();
    setUsersMessage(t("msg_password_updated"));
    closeModal();
  } catch (error) {
    setUsersMessage(error.message, true);
    closeModal();
  }
});

registrationToggle?.addEventListener("change", async () => {
  try {
    setUsersMessage(t("msg_registration_saving"));
    await saveRegistrationSetting(registrationToggle.checked);
    setUsersMessage(t("msg_registration_saved"));
  } catch (error) {
    registrationToggle.checked = !registrationToggle.checked;
    setUsersMessage(error.message, true);
  }
});

refreshUsersBtn?.addEventListener("click", async () => {
  try {
    setUsersMessage(t("msg_users_loading"));
    await loadUsers();
    setUsersMessage(t("msg_ready"));
  } catch (error) {
    setUsersMessage(error.message, true);
  }
});

userSearch?.addEventListener("input", () => {
  state.search = userSearch.value;
  scheduleUsersReload();
});

roleFilter?.addEventListener("change", () => {
  state.role = roleFilter.value;
  scheduleUsersReload(0);
});

userSort?.addEventListener("change", () => {
  state.sort = userSort.value;
  scheduleUsersReload(0);
});

window.addEventListener("manga-i18n:change", () => {
  if (cachedUsers.length > 0) {
    renderUsers(state.users);
  }
  if (pendingReset && modalText) {
    const selectedOption = resetUserSelect?.options?.[resetUserSelect.selectedIndex];
    const targetLabel = selectedOption ? selectedOption.textContent : t("msg_selected_user");
    modalText.textContent = t("msg_reset_confirm", { target: targetLabel });
  }
});

if (window.MangaTheme && typeof window.MangaTheme.init === "function") {
  window.MangaTheme.init();
}

(async () => {
  try {
    currentUser = await loadCurrentUser();
    if (userSort) {
      state.sort = userSort.value;
    }
    if (roleFilter) {
      state.role = roleFilter.value;
    }
    if (userSearch) {
      state.search = userSearch.value;
    }
    const users = await loadUsers();
    if (!users) {
      return;
    }
    await loadRegistrationSetting();
    setMessage(t("msg_ready"));
    setUsersMessage(t("msg_ready"));
  } catch (error) {
    setMessage(error.message, true);
    setUsersMessage(error.message, true);
  }
})();
