(function initializeThemeModule() {
  const THEME_KEY = "manga_tracker_theme";

  function t(key) {
    if (window.MangaI18n && typeof window.MangaI18n.t === "function") {
      return window.MangaI18n.t(key);
    }

    if (key === "theme_light") {
      return "Lightmode";
    }

    if (key === "theme_dark") {
      return "Darkmode";
    }

    return key;
  }

  function getInitialTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme, button) {
    document.documentElement.setAttribute("data-theme", theme);

    if (button) {
      button.textContent = theme === "dark" ? t("theme_light") : t("theme_dark");
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    }
  }

  let initialized = false;

  function init(buttonId = "theme-toggle") {
    if (initialized) {
      return;
    }
    initialized = true;
    const button = document.getElementById(buttonId);
    const initialTheme = getInitialTheme();

    applyTheme(initialTheme, button);

    if (!button) {
      return;
    }

    button.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next, button);
    });

    window.addEventListener("manga-i18n:change", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      applyTheme(current, button);
    });
  }

  window.MangaTheme = {
    init
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init());
  } else {
    init();
  }
})();
