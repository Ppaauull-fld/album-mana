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

export function initSectionJumpButton(opts = {}) {
  const sectionsEl = opts.sectionsEl;
  if (!sectionsEl || !document.body) return null;

  const downIconSrc = opts.downIconSrc || "../assets/img/icons/Arrow%20down.svg";
  const upIconSrc = opts.upIconSrc || "../assets/img/icons/Arrow%20up.svg";
  const threshold = Number(opts.threshold || 120);
  const btnId = opts.id || "pageSectionJumpBtn";

  let btn = document.getElementById(btnId);
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = btnId;
    btn.className = "iconbtn page-jump-btn";
    btn.innerHTML = `
      <img class="icon-img" src="${downIconSrc}" alt="" aria-hidden="true" decoding="async" />
      <span class="sr-only">Aller aux sections</span>
    `.trim();
    document.body.appendChild(btn);
  }

  const icon = btn.querySelector(".icon-img");
  const sr = btn.querySelector(".sr-only");

  let direction = "down";
  let rafId = 0;
  let ro = null;
  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function targetSectionsY() {
    const r = sectionsEl.getBoundingClientRect();
    return Math.max(0, Math.round(window.scrollY + r.top - 10));
  }

  function setDirection(next) {
    if (next === direction) return;
    direction = next;

    const isUp = direction === "up";
    if (icon) icon.src = isUp ? upIconSrc : downIconSrc;

    const label = isUp ? "Aller en haut de la page" : "Aller aux sections";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("data-direction", direction);
    if (sr) sr.textContent = label;
  }

  function syncButton() {
    if (!sectionsEl.isConnected || !btn.isConnected) return;

    const blocked =
      document.documentElement.classList.contains("noscroll") ||
      document.body.classList.contains("noscroll");
    if (blocked) {
      btn.classList.remove("is-visible");
      return;
    }

    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (maxScroll < 20) {
      btn.classList.remove("is-visible");
      return;
    }

    const showUp = window.scrollY + threshold >= targetSectionsY();
    setDirection(showUp ? "up" : "down");
    btn.classList.add("is-visible");
  }

  function scheduleSync() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      syncButton();
    });
  }

  btn.addEventListener("click", () => {
    const top = direction === "up" ? 0 : targetSectionsY();
    window.scrollTo({
      top,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  });

  window.addEventListener("scroll", scheduleSync, { passive: true });
  window.addEventListener("resize", scheduleSync, { passive: true });

  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(scheduleSync);
    ro.observe(document.body);
    ro.observe(sectionsEl);
  }

  scheduleSync();

  return () => {
    window.removeEventListener("scroll", scheduleSync);
    window.removeEventListener("resize", scheduleSync);
    if (ro) ro.disconnect();
  };
}

export function initPullToRefreshGuard() {
  const isCoarsePointer =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  if (!isCoarsePointer || !("ontouchstart" in window)) return;
  if (document.documentElement.dataset.pullToRefreshGuard === "1") return;
  document.documentElement.dataset.pullToRefreshGuard = "1";

  let touchStartY = 0;

  function canScrollableParentConsume(target, deltaY) {
    let el = target instanceof Element ? target : null;

    while (el && el !== document.body && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const canScrollY =
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        el.scrollHeight > el.clientHeight + 1;

      if (canScrollY) {
        if (deltaY > 0 && el.scrollTop > 0) return true;
        if (deltaY < 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }

      el = el.parentElement;
    }

    return false;
  }

  document.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 1) return;

      if (
        document.documentElement.classList.contains("noscroll") ||
        document.body.classList.contains("noscroll")
      ) {
        return;
      }

      const currentY = e.touches[0].clientY;
      const deltaY = currentY - touchStartY;
      if (Math.abs(deltaY) < 6) return;
      if (canScrollableParentConsume(e.target, deltaY)) return;

      const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const atTop = scrollTop <= 0;
      const atBottom = scrollTop >= maxScroll - 1;

      if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        e.preventDefault();
      }
    },
    { passive: false }
  );
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
