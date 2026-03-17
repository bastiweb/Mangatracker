const form = document.getElementById("register-form");
const message = document.getElementById("message");
const roleField = document.getElementById("role-field");
const roleSelect = document.getElementById("role");
const emailInput = document.getElementById("email");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const passwordConfirmInput = document.getElementById("passwordConfirm");

const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);

let registrationMode = "unknown";

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setFormEnabled(enabled) {
  if (!form) {
    return;
  }

  form.querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = !enabled;
  });
}

async function resolveRegistrationMode() {
  try {
    const response = await fetch("/api/auth/bootstrap");
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.allowRegistration) {
        registrationMode = "first";
        roleField.hidden = true;
        setFormEnabled(true);
        return;
      }
    }
  } catch {
    // ignore
  }

  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) {
      throw new Error("unauthorized");
    }

    const data = await response.json().catch(() => ({}));
    if (data.user && data.user.role === "admin") {
      registrationMode = "admin";
      roleField.hidden = false;
      setFormEnabled(true);
      return;
    }
  } catch {
    // ignore
  }

  registrationMode = "blocked";
  roleField.hidden = true;
  setFormEnabled(false);
  setMessage(t("msg_register_blocked"), true);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (registrationMode === "blocked") {
    setMessage(t("msg_register_blocked"), true);
    return;
  }

  setMessage(t("msg_register_progress"), false);

  if (passwordInput.value !== passwordConfirmInput.value) {
    setMessage(t("msg_password_mismatch"), true);
    return;
  }

  if (!usernameInput.value.trim()) {
    setMessage(t("msg_username_required"), true);
    return;
  }

  const payload = {
    email: emailInput.value,
    username: usernameInput.value.trim(),
    password: passwordInput.value
  };

  if (!roleField.hidden) {
    payload.role = roleSelect.value;
  }

  try {
    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_register_failed"));
    }

    if (registrationMode === "admin") {
      setMessage(t("msg_user_created"));
      form.reset();
      if (roleSelect) {
        roleSelect.value = "user";
      }
      return;
    }

    window.location.href = "/";
  } catch (error) {
    setMessage(error.message, true);
  }
});

resolveRegistrationMode();
MangaTheme.init();
