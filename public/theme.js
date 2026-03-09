(function initializeThemeModule() {
  const THEME_KEY = "manga_tracker_theme";

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
      button.textContent = theme === "dark" ? "Lightmode" : "Darkmode";
      button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    }
  }

  function init(buttonId = "theme-toggle") {
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
  }

  window.MangaTheme = {
    init
  };
})();
