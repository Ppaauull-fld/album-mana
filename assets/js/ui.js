/* assets/js/ui.js */

export function setActiveNav(current) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-nav") === current);
  });
}

/**
 * Met un bouton en état "loading" sans emoji.
 * Utilise la classe CSS .spinner (déjà dans ton style.css).
 *
 * setBtnLoading(btn, true, { label: "Envoi…" })
 * setBtnLoading(btn, false)
 */
export function setBtnLoading(btn, isLoading, opts = {}) {
  if (!btn) return;

  const label = typeof opts.label === "string" ? opts.label : "";

  if (isLoading) {
    // sauvegarde le contenu initial
    if (!btn.dataset._oldHtml) btn.dataset._oldHtml = btn.innerHTML;

    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");

    // Si label vide => spinner seul (utile pour icon-only)
    btn.innerHTML = label
      ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(label)}`
      : `<span class="spinner" aria-hidden="true"></span>`;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");

    const old = btn.dataset._oldHtml;
    if (old != null) {
      btn.innerHTML = old;
      delete btn.dataset._oldHtml;
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
