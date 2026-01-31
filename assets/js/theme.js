(() => {
  const STORAGE_KEY = "album-mana-theme";

  // Base URL pour construire des chemins d’icônes indépendants de la page (index vs /pages)
  const script = document.currentScript;
  const scriptUrl = script ? new URL(script.src) : new URL(window.location.href);
  const iconsBase = new URL("../img/icons/", scriptUrl); // .../assets/img/icons/

  const sunIcon = new URL("sun.svg", iconsBase).href;
  const moonIcon = new URL("moon.svg", iconsBase).href;

  function getInitialTheme() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;

    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;

    // Swap logo selon thème (si l'image a les data-attrs)
    document.querySelectorAll("img[data-logo-light][data-logo-dark]").forEach(img => {
      img.src = theme === "dark" ? img.dataset.logoDark : img.dataset.logoLight;
    });

    // Met à jour le bouton si présent sur la page
    const btn = document.getElementById("themeToggle");
    if (!btn) return;

    const isDark = theme === "dark";
    btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    btn.setAttribute("aria-label", isDark ? "Passer au thème clair" : "Passer au thème sombre");
    btn.title = isDark ? "Thème clair" : "Thème sombre";

    const icon = btn.querySelector("img");
    if (icon) icon.src = isDark ? sunIcon : moonIcon;
  }

  function setTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
  }

  // Applique tout de suite
  applyTheme(getInitialTheme());

  // Click toggle (delegation)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("#themeToggle");
    if (!btn) return;

    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    setTheme(current === "dark" ? "light" : "dark");
  });
})();
