const form = document.getElementById("login-form");
const message = document.getElementById("message");
const registerHint = document.getElementById("register-hint");

const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

async function checkBootstrap() {
  try {
    const response = await fetch("/api/auth/bootstrap");
    if (!response.ok) {
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (data.allowRegistration) {
      registerHint.hidden = false;
    }
  } catch {
    // ignore
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(t("msg_login_progress"), false);

  const payload = {
    identifier: form.identifier.value,
    password: form.password.value
  };

  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_login_failed"));
    }

    window.location.href = "/";
  } catch (error) {
    setMessage(error.message, true);
  }
});

checkBootstrap();
MangaTheme.init();
