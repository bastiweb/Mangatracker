const form = document.getElementById("login-form");
const message = document.getElementById("message");
const registerHint = document.getElementById("register-hint");

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
  setMessage("Login...", false);

  const payload = {
    email: form.email.value,
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
      throw new Error(data.error || "Login fehlgeschlagen.");
    }

    window.location.href = "/";
  } catch (error) {
    setMessage(error.message, true);
  }
});

checkBootstrap();
MangaTheme.init();
