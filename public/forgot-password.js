const form = document.getElementById("forgot-password-form");
const message = document.getElementById("message");

const t = (key, vars) => (window.MangaI18n && window.MangaI18n.t ? window.MangaI18n.t(key, vars) : key);

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setFormEnabled(enabled) {
  if (!form) {
    return;
  }
  form.querySelectorAll("input, button").forEach((element) => {
    element.disabled = !enabled;
  });
}

async function checkEmergencyResetAvailability() {
  try {
    const response = await fetch("/api/auth/bootstrap");
    if (!response.ok) {
      throw new Error(t("msg_emergency_reset_bootstrap_failed"));
    }

    const data = await response.json().catch(() => ({}));
    if (!data.emergencyResetEnabled) {
      setFormEnabled(false);
      setMessage(t("msg_emergency_reset_disabled"), true);
      return false;
    }

    return true;
  } catch (error) {
    setFormEnabled(false);
    setMessage(error.message || t("msg_emergency_reset_bootstrap_failed"), true);
    return false;
  }
}

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const identifier = form.identifier.value.trim();
  const resetKey = form.resetKey.value.trim();
  const newPassword = form.newPassword.value;
  const newPasswordConfirm = form.newPasswordConfirm.value;

  if (newPassword !== newPasswordConfirm) {
    setMessage(t("msg_password_mismatch"), true);
    return;
  }

  setMessage(t("msg_emergency_reset_running"));

  try {
    const response = await fetch("/api/auth/emergency-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier,
        resetKey,
        newPassword
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || t("msg_emergency_reset_failed"));
    }

    form.reset();
    setMessage(t("msg_emergency_reset_success"));
  } catch (error) {
    setMessage(error.message || t("msg_emergency_reset_failed"), true);
  }
});

checkEmergencyResetAvailability();
MangaTheme.init();
