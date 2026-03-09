const form = document.getElementById("token-form");
const tokenInput = document.getElementById("token");
const clearBtn = document.getElementById("clear-token-btn");
const tokenStatus = document.getElementById("token-status");
const message = document.getElementById("message");

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
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

MangaTheme.init();

(async () => {
  try {
    await loadTokenStatus();
    setMessage("Bereit.");
  } catch (error) {
    setMessage(error.message, true);
  }
})();
