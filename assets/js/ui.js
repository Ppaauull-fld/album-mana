/* assets/js/ui.js */

export function setActiveNav(current) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("data-nav") === current);
  });
}

/**
 * Met un bouton en état "loading" sans emoji.
 * Utilise la classe CSS .spinner.
 *
 * setBtnLoading(btn, true, { label: "Envoi…" })
 * setBtnLoading(btn, false)
 */
export function setBtnLoading(btn, isLoading, opts = {}) {
  if (!btn) return;

  const label = typeof opts.label === "string" ? opts.label : "";

  if (isLoading) {
    // Sauvegarde état initial (une seule fois)
    if (!btn.dataset._oldHtml) btn.dataset._oldHtml = btn.innerHTML;
    if (!btn.dataset._oldDisabled) btn.dataset._oldDisabled = String(!!btn.disabled);

    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");

    // Texte accessible (screen readers)
    const srText = label || "Chargement";

    // Si label vide => spinner seul visuellement, mais on garde un texte SR
    btn.innerHTML = `
      <span class="spinner" aria-hidden="true"></span>
      ${label ? `<span>${escapeHtml(label)}</span>` : `<span class="sr-only">${escapeHtml(srText)}</span>`}
    `.trim();
  } else {
    btn.removeAttribute("aria-busy");

    // restore HTML
    const old = btn.dataset._oldHtml;
    if (old != null) {
      btn.innerHTML = old;
      delete btn.dataset._oldHtml;
    }

    // restore disabled
    const oldDisabled = btn.dataset._oldDisabled;
    if (oldDisabled != null) {
      btn.disabled = oldDisabled === "true";
      delete btn.dataset._oldDisabled;
    } else {
      btn.disabled = false;
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
