import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";
import { setBtnLoading } from "../ui.js";

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PHOTOS_COL = "photos";
const SECTIONS_COL = "photoSections";
const UNASSIGNED = "__unassigned__"; // bucket logique (pas une section Firestore)

const LONG_PRESS_MS = 260; // mobile: évite drag involontaire pendant scroll
const DRAG_START_PX = 8; // seuil mouvement pour démarrer (desktop)

// Layout (sections)
const GRID_COLS = 12;

// Largeur aimantée: 1/3, 2/3, plein écran
const SPAN_PRESETS = [4, 8, 12];

// Hauteurs aimantées (px)
const HEIGHT_PRESETS = [260, 360, 480, 620];
const MIN_HEIGHT = HEIGHT_PRESETS[0];
const MAX_HEIGHT = HEIGHT_PRESETS[HEIGHT_PRESETS.length - 1];

// Masonry (doit matcher le CSS)
const MASONRY_ROW = 10; // grid-auto-rows: 10px;
const FALLBACK_GAP = 18; // gap: 18px;

const GALLERY_LAYOUT_KEY = "albumMana_galleryLayout_v1";
let galleryLayout = { colSpan: 12, heightPx: null };
try {
  const saved = JSON.parse(localStorage.getItem(GALLERY_LAYOUT_KEY) || "null");
  if (saved && typeof saved === "object")
    galleryLayout = { ...galleryLayout, ...saved };
} catch {}

const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
const arrangeBtn = document.getElementById("arrangeBtn");
const showBtn = document.getElementById("startSlideshowBtn");

// Upload UI
const uploadModal = document.getElementById("uploadModal");
const uploadPreviewGrid = document.getElementById("uploadPreviewGrid");
const uploadStartBtn = document.getElementById("uploadStartBtn");
const uploadCancelBtn = document.getElementById("uploadCancelBtn");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadProgressText = document.getElementById("uploadProgressText");
const uploadProgressDetail = document.getElementById("uploadProgressDetail");
const uploadCount = document.getElementById("uploadCount");

// Viewer UI
const viewer = document.getElementById("photoViewer");
const viewerImg = document.getElementById("viewerImg");
const viewerTitle = document.getElementById("viewerTitle");
const viewerDownload = document.getElementById("viewerDownload");
const viewerDelete = document.getElementById("viewerDelete");
const viewerClose = document.getElementById("viewerClose");
const viewerRotate = document.getElementById("viewerRotate");

// Slideshow UI
const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");
const togglePlayBtn = document.getElementById("togglePlay");
const togglePlayIcon = document.getElementById("togglePlayIcon");
const closeShowBtn = document.getElementById("closeShow");
const nextSlideBtn = document.getElementById("nextSlide");
const prevSlideBtn = document.getElementById("prevSlide");

let photos = []; // docs photos
let sections = []; // docs sections

let queue = [];
let idx = 0;
let playing = true;
let timer = null;

let pending = []; // upload queue
let currentViewed = null;

// Arrange state
let arranging = false;

// Drag photos
let drag = null;
/*
drag = {
  id,
  pointerId,
  pointerType,
  startX, startY,
  lastX, lastY,
  pressTimer,
  started,
  srcGrid, srcSectionId,
  ghostEl,
  placeholderEl,
  offsetX, offsetY,
}
*/

let autoScrollRaf = null;

// Drag sections
let sectionDrag = null;
/*
sectionDrag = {
  id,
  pointerId,
  startX,startY,lastX,lastY,
  started,
  ghostEl,
  placeholderEl,
  offsetX,offsetY,
}
*/

let autoScrollSectionRaf = null;

// Resize sections
let sectionResize = null;
/*
sectionResize = {
  id,
  pointerId,
  startX,startY,
  startW,startH,
  colW,
  gap,
}
*/

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function nearestPreset(value, presets) {
  let best = presets[0];
  let bestD = Infinity;
  for (const p of presets) {
    const d = Math.abs(value - p);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function clampRotation(deg) {
  const allowed = [0, 90, 180, 270];
  return allowed.includes(deg) ? deg : 0;
}

function applyRotation(el, deg) {
  const rot = clampRotation(deg || 0);
  el.style.transform = `rotate(${rot}deg)`;
  el.style.transformOrigin = "center center";
}

function applyRotationThumb(imgEl, deg) {
  const rot = clampRotation(deg || 0);
  imgEl.style.transform = `rotate(${rot}deg)`;
  imgEl.style.transformOrigin = "center center";
  if (rot === 90 || rot === 270) {
    imgEl.style.objectFit = "contain";
    imgEl.style.background = "#000";
  } else {
    imgEl.style.objectFit = "";
    imgEl.style.background = "";
  }
}

function getWrapGap() {
  try {
    if (!sectionsWrap) return FALLBACK_GAP;
    const cs = getComputedStyle(sectionsWrap);
    const g =
      parseFloat(cs.gap || cs.rowGap || cs.columnGap || `${FALLBACK_GAP}`) ||
      FALLBACK_GAP;
    return g;
  } catch {
    return FALLBACK_GAP;
  }
}

function updateMasonryRows(cardEl, forcedHeightPx = null) {
  if (!cardEl) return;

  const gap = getWrapGap();

  if (typeof forcedHeightPx === "number" && !Number.isNaN(forcedHeightPx)) {
    const rows = Math.ceil((forcedHeightPx + gap) / MASONRY_ROW);
    cardEl.style.setProperty("--rows", String(Math.max(1, rows)));
    return;
  }

  requestAnimationFrame(() => {
    const h = cardEl.getBoundingClientRect().height || 0;
    const rows = Math.ceil((h + gap) / MASONRY_ROW);
    cardEl.style.setProperty("--rows", String(Math.max(1, rows)));
  });
}

/* ---------------------------
   Grouping + render
---------------------------- */

function groupPhotos() {
  const grouped = new Map();
  grouped.set(UNASSIGNED, []);
  for (const s of sections) grouped.set(s.id, []);

  for (const p of photos) {
    const sid = p.sectionId;
    if (!sid || !grouped.has(sid)) grouped.get(UNASSIGNED).push(p);
    else grouped.get(sid).push(p);
  }

  for (const arr of grouped.values()) {
    arr.sort((a, b) => {
  const ao = typeof a.order === "number" ? a.order : (a.createdAt ?? 0);
  const bo = typeof b.order === "number" ? b.order : (b.createdAt ?? 0);
  return ao - bo;
});

  }

  return grouped;
}

function renderPhotoCard(p) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card card-btn";
  card.title = "Ouvrir";

  card.dataset.id = p.id;

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = p.thumbUrl || p.url;
  img.alt = "photo";
  if (p.rotation) applyRotationThumb(img, p.rotation);

  card.appendChild(img);

  card.addEventListener("click", () => {
    if (arranging) return;
    openViewer(p);
  });

  return card;
}

function getSectionLayout(id) {
  if (id === UNASSIGNED) return galleryLayout;

  const s = sections.find((x) => x.id === id);
  return {
    colSpan: typeof s?.colSpan === "number" ? s.colSpan : 12,
    heightPx: typeof s?.heightPx === "number" ? s.heightPx : null,
  };
}

function normalizeSectionLayout(lay) {
  const span = nearestPreset(
    clamp(lay?.colSpan ?? 12, 1, GRID_COLS),
    SPAN_PRESETS
  );
  const rawH = typeof lay?.heightPx === "number" ? lay.heightPx : null;

  let h = null;
  if (rawH != null) {
    const clamped = clamp(rawH, MIN_HEIGHT, MAX_HEIGHT);
    h = nearestPreset(clamped, HEIGHT_PRESETS);
  }

  return { colSpan: span, heightPx: h };
}

function applySectionLayout(cardEl, id) {
  const lay = normalizeSectionLayout(getSectionLayout(id));
  cardEl.style.setProperty("--span", String(lay.colSpan));

  if (lay.heightPx && typeof lay.heightPx === "number") {
    cardEl.style.setProperty("--h", `${Math.round(lay.heightPx)}px`);
  } else {
    cardEl.style.setProperty("--h", "auto");
  }

  updateMasonryRows(cardEl, lay.heightPx ?? null);
}

function renderSectionCard({ id, title, editable, hideTitle }, items) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.sectionCardId = id;

  applySectionLayout(card, id);

  if (hideTitle) card.classList.add("no-title");

  const head = document.createElement("div");
  head.className = "section-head";

  const move = document.createElement("button");
  move.type = "button";
  move.className = "section-move";
  move.title = "Déplacer la section";
  move.textContent = "⋮⋮";
  move.dataset.sectionMove = "1";

  const t = document.createElement("div");
  t.className = "section-title";
  t.textContent = title || "";

  if (editable) {
    t.contentEditable = "true";
    t.spellcheck = false;
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        t.blur();
      }
    });
    t.addEventListener("blur", async () => {
      const newTitle = (t.textContent || "").trim();
      if (!newTitle) return;
      try {
        await updateDoc(doc(db, SECTIONS_COL, id), { title: newTitle });
      } catch (e) {
        alert("Impossible de renommer la section.");
        console.error(e);
      }
    });
  }

  head.appendChild(move);
  head.appendChild(t);

  // Expand / collapse (double-clic sur le header hors titre éditable)
  head.addEventListener("dblclick", (e) => {
    if (e.target?.closest?.('.section-title[contenteditable="true"]')) return;
    card.classList.toggle("is-expanded");
    updateMasonryRows(card, null);
  });

  const grid = document.createElement("div");
  grid.className = "section-grid";
  grid.dataset.sectionId = id;

  for (const p of items) grid.appendChild(renderPhotoCard(p));

  const resize = document.createElement("div");
  resize.className = "section-resize";
  resize.dataset.sectionResize = "1";

  card.appendChild(head);
  card.appendChild(grid);
  card.appendChild(resize);

  return card;
}

function renderAll() {
  if (!sectionsWrap) return;

  const grouped = groupPhotos();
  sectionsWrap.innerHTML = "";

  sectionsWrap.appendChild(
    renderSectionCard(
      { id: UNASSIGNED, title: "", editable: false, hideTitle: true },
      grouped.get(UNASSIGNED) || []
    )
  );

  for (const s of sections) {
    sectionsWrap.appendChild(
      renderSectionCard(
        {
          id: s.id,
          title: s.title || "Section",
          editable: true,
          hideTitle: false,
        },
        grouped.get(s.id) || []
      )
    );
  }

  // recalc masonry pour tout ce qui est en "auto"
  requestAnimationFrame(() => {
    const all = [...sectionsWrap.querySelectorAll(".section-card")];
    for (const el of all) updateMasonryRows(el, null);
  });
}

/* ---------------------------
   Arrange mode (ON/OFF)
---------------------------- */

function ensureArrangeLabelSpan() {
  if (!arrangeBtn) return null;

  let label = arrangeBtn.querySelector("[data-arrange-label]");
  if (label) return label;

  label = document.createElement("span");
  label.setAttribute("data-arrange-label", "");

  // récupère les textes existants (si le bouton n’avait pas de span)
  const textNodes = [...arrangeBtn.childNodes].filter(
    (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim()
  );

  if (textNodes.length) {
    label.textContent = textNodes.map((n) => n.textContent).join(" ").trim();
    for (const n of textNodes) n.remove();
  } else {
    label.textContent = "";
  }

  arrangeBtn.appendChild(label);
  return label;
}

function setArranging(on) {
  arranging = !!on;

  document.body.classList.add("page");
  document.body.classList.toggle("arranging", arranging);

  if (arrangeBtn) {
    arrangeBtn.classList.toggle("primary", arranging);
    const label = ensureArrangeLabelSpan();
    if (label) label.textContent = arranging ? "Terminer" : "Arranger";
  }

  if (!arranging) {
    cancelDrag();
    cancelSectionDrag();
    cancelSectionResize();
  }
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* ---------------------------
   FLIP animation helper (photos)
---------------------------- */

function getRects(container) {
  const map = new Map();
  const items = [...container.querySelectorAll(".card-btn")];
  for (const el of items) map.set(el, el.getBoundingClientRect());
  return map;
}

function animateFLIP(container, before) {
  if (!container || !before) return;

  const items = [...container.querySelectorAll(".card-btn")];
  for (const el of items) {
    const first = before.get(el);
    if (!first) continue;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx === 0 && dy === 0) continue;

    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.style.transition = "transform 0s";
    requestAnimationFrame(() => {
      el.style.transition = "transform 180ms ease";
      el.style.transform = "";
      el.addEventListener(
        "transitionend",
        () => {
          el.style.transition = "";
        },
        { once: true }
      );
    });
  }
}

/* ---------------------------
   Drag PHOTOS (Pointer Events)
---------------------------- */

function stopAutoScroll() {
  if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
  autoScrollRaf = null;
}

function startAutoScroll() {
  if (autoScrollRaf) return;

  const step = () => {
    if (!drag || !drag.started) {
      stopAutoScroll();
      return;
    }

    const edge = 90;
    const maxSpeed = 22;
    const W = window.innerWidth;
    const H = window.innerHeight;

    const x = drag.lastX;
    const y = drag.lastY;

    let vx = 0;
    let vy = 0;

    if (y < edge) vy = -maxSpeed * (1 - y / edge);
    else if (y > H - edge) vy = maxSpeed * (1 - (H - y) / edge);

    if (x < edge) vx = -maxSpeed * (1 - x / edge);
    else if (x > W - edge) vx = maxSpeed * (1 - (W - x) / edge);

    if (vx || vy) {
      window.scrollBy(vx, vy);

      const grid = gridFromPoint(drag.lastX, drag.lastY) || drag.srcGrid;
      if (grid && drag.placeholderEl) {
        if (drag.placeholderEl.parentElement !== grid) {
          grid.appendChild(drag.placeholderEl);
        }
        placePlaceholder(
          grid,
          drag.placeholderEl,
          drag.lastX,
          drag.lastY,
          drag.id
        );
      }
    }

    autoScrollRaf = requestAnimationFrame(step);
  };

  autoScrollRaf = requestAnimationFrame(step);
}

function cancelDrag() {
  if (!drag) return;

  try {
    if (drag.pressTimer) clearTimeout(drag.pressTimer);
  } catch {}
  stopAutoScroll();

  if (drag.ghostEl) drag.ghostEl.remove();
  if (drag.placeholderEl) drag.placeholderEl.remove();

  const original = sectionsWrap?.querySelector(`.card-btn[data-id="${drag.id}"]`);
  if (original) original.classList.remove("dragging");

  document.body.classList.remove("drag-active");

  drag = null;
}

function createPlaceholderFromCard(cardEl) {
  const ph = document.createElement("div");
  ph.className = "drop-placeholder";

  const rect = cardEl.getBoundingClientRect();
  if (rect.width) ph.style.width = `${rect.width}px`;
  if (rect.height) ph.style.height = `${rect.height}px`;

  return ph;
}

function createGhostFromCard(cardEl) {
  const rect = cardEl.getBoundingClientRect();
  const ghost = cardEl.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.zIndex = 9999;
  ghost.style.pointerEvents = "none";
  ghost.style.transform = "scale(0.94)";
  ghost.style.boxShadow = "0 24px 70px rgba(0,0,0,.22)";
  ghost.style.borderRadius = "18px";
  return ghost;
}

function gridFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.(".section-grid") || null;
}

function placePlaceholder(gridEl, placeholderEl, x, y, draggedId) {
  const cards = [...gridEl.querySelectorAll(".card-btn")].filter(
    (c) => c.dataset.id !== draggedId && !c.classList.contains("dragging")
  );

  if (!cards.length) {
    if (placeholderEl.parentElement !== gridEl) gridEl.appendChild(placeholderEl);
    else if (gridEl.lastChild !== placeholderEl) gridEl.appendChild(placeholderEl);
    return;
  }

  const items = cards
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        r,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        rowTol: Math.max(12, r.height * 0.35),
      };
    })
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);

  let beforeEl = null;
  for (const it of items) {
    const sameRow = Math.abs(y - it.cy) <= it.rowTol;
    if (y < it.cy || (sameRow && x < it.cx)) {
      beforeEl = it.el;
      break;
    }
  }

  const beforeRects = getRects(gridEl);

  if (!beforeEl) gridEl.appendChild(placeholderEl);
  else gridEl.insertBefore(placeholderEl, beforeEl);

  animateFLIP(gridEl, beforeRects);
}

function onPointerDown(e) {
  if (!arranging) return;
  if (sectionDrag || sectionResize) return;

  const cardEl = e.target.closest?.(".card-btn");
  if (!cardEl) return;

  if ((e.pointerType || "mouse") !== "touch") {
    e.preventDefault();
  }

  const id = cardEl.dataset.id;
  const srcGrid = cardEl.closest(".section-grid");
  if (!srcGrid) return;

  const rect = cardEl.getBoundingClientRect();

  drag = {
    id,
    pointerId: e.pointerId,
    pointerType: e.pointerType || "mouse",
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    pressTimer: null,
    started: false,
    srcGrid,
    srcSectionId: srcGrid.dataset.sectionId || UNASSIGNED,
    ghostEl: null,
    placeholderEl: null,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };

  try {
    cardEl.setPointerCapture(e.pointerId);
  } catch {}

  if (drag.pointerType === "touch") {
    drag.pressTimer = setTimeout(() => {
      if (!drag) return;
      startDrag(cardEl);
    }, LONG_PRESS_MS);
  }
}

function startDrag(cardEl) {
  if (!drag || drag.started) return;

  drag.started = true;

  if (drag.pressTimer) {
    clearTimeout(drag.pressTimer);
    drag.pressTimer = null;
  }

  drag.placeholderEl = createPlaceholderFromCard(cardEl);
  drag.ghostEl = createGhostFromCard(cardEl);

  document.body.appendChild(drag.ghostEl);

  const beforeRects = getRects(drag.srcGrid);
  cardEl.classList.add("dragging");

  drag.srcGrid.insertBefore(drag.placeholderEl, cardEl);
  animateFLIP(drag.srcGrid, beforeRects);

  placePlaceholder(drag.srcGrid, drag.placeholderEl, drag.lastX, drag.lastY, drag.id);

  document.body.classList.add("drag-active");
  startAutoScroll();
}

function onPointerMove(e) {
  if (!drag) return;
  if (e.pointerId !== drag.pointerId) return;

  drag.lastX = e.clientX;
  drag.lastY = e.clientY;

  if (!drag.started && drag.pointerType === "touch") {
    const dx = drag.lastX - drag.startX;
    const dy = drag.lastY - drag.startY;
    if (Math.hypot(dx, dy) > 10) {
      if (drag.pressTimer) clearTimeout(drag.pressTimer);
      drag.pressTimer = null;
    }
    return;
  }

  if (!drag.started && drag.pointerType !== "touch") {
    const dx = drag.lastX - drag.startX;
    const dy = drag.lastY - drag.startY;
    if (Math.hypot(dx, dy) >= DRAG_START_PX) {
      const cardEl = sectionsWrap?.querySelector(`.card-btn[data-id="${drag.id}"]`);
      if (cardEl) startDrag(cardEl);
    } else return;
  }

  if (!drag.started) return;

  const x = drag.lastX - drag.offsetX;
  const y = drag.lastY - drag.offsetY;
  drag.ghostEl.style.left = `${x}px`;
  drag.ghostEl.style.top = `${y}px`;

  startAutoScroll();

  const grid = gridFromPoint(drag.lastX, drag.lastY) || drag.srcGrid;
  if (!grid) return;

  const oldParent = drag.placeholderEl.parentElement;
  if (oldParent !== grid) {
    const beforeOld = oldParent ? getRects(oldParent) : null;
    const beforeNew = getRects(grid);

    grid.appendChild(drag.placeholderEl);

    animateFLIP(oldParent, beforeOld);
    animateFLIP(grid, beforeNew);
  }

  placePlaceholder(grid, drag.placeholderEl, drag.lastX, drag.lastY, drag.id);
}

async function finalizeDrop(state) {
  if (!state || !state.started) return;

  const placeholder = state.placeholderEl;
  const targetGrid = placeholder?.parentElement?.closest?.(".section-grid");
  if (!targetGrid) return;

  const targetSectionId = targetGrid.dataset.sectionId || UNASSIGNED;
  const newSectionValue = targetSectionId === UNASSIGNED ? null : targetSectionId;

  let dropIndex = 0;
  for (const child of [...targetGrid.children]) {
    if (child === placeholder) break;
    if (
      child.classList?.contains("card-btn") &&
      !child.classList.contains("dragging")
    ) {
      dropIndex++;
    }
  }

  const grouped = groupPhotos();
  const targetList = (grouped.get(targetSectionId) || []).filter(
    (p) => p.id !== state.id
  );

  const prev = dropIndex > 0 ? targetList[dropIndex - 1] : null;
  const next = dropIndex < targetList.length ? targetList[dropIndex] : null;

  const prevOrder =
    prev && typeof prev.order === "number" ? prev.order : prev?.createdAt ?? 0;
  const nextOrder =
    next && typeof next.order === "number"
      ? next.order
      : next?.createdAt ?? prevOrder + 1000;

  let newOrder;

  if (!prev && !next) newOrder = Date.now();
  else if (!prev && next) newOrder = nextOrder - 1000;
  else if (prev && !next) newOrder = prevOrder + 1000;
  else newOrder = (prevOrder + nextOrder) / 2;

  if (prev && next && Math.abs(nextOrder - prevOrder) < 0.000001) {
    try {
      const renorm = (grouped.get(targetSectionId) || []).filter(
        (p) => p.id !== state.id
      );
      renorm.splice(dropIndex, 0, { id: state.id, createdAt: Date.now(), order: 0 });

      const base = Date.now();
      for (let i = 0; i < renorm.length; i++) {
        const pid = renorm[i].id;
        const ord = base + i * 1000;
        await updateDoc(doc(db, PHOTOS_COL, pid), { order: ord });
      }

      await updateDoc(doc(db, PHOTOS_COL, state.id), { sectionId: newSectionValue });
      return;
    } catch (e) {
      console.error("Renormalisation order failed", e);
    }
  }

  await updateDoc(doc(db, PHOTOS_COL, state.id), {
    sectionId: newSectionValue,
    order: newOrder,
  });
}

function onPointerUp(e) {
  if (!drag) return;
  if (e.pointerId !== drag.pointerId) return;

  const wasStarted = drag.started;

  const state = {
    id: drag.id,
    started: drag.started,
    placeholderEl: drag.placeholderEl,
  };

  const draggedId = drag.id;
  const ghost = drag.ghostEl;
  const placeholder = drag.placeholderEl;

  if (drag.pressTimer) clearTimeout(drag.pressTimer);

  drag = null;

  stopAutoScroll();
  document.body.classList.remove("drag-active");

  if (ghost) ghost.remove();

  const original = sectionsWrap?.querySelector(`.card-btn[data-id="${draggedId}"]`);
  if (original) original.classList.remove("dragging");

  if (!wasStarted) return;

  if (placeholder && placeholder.parentElement) {
    finalizeDrop(state)
      .catch((err) => {
        console.error(err);
        alert("Impossible de déplacer la photo.");
      })
      .finally(() => {
        try {
          placeholder.remove();
        } catch {}
      });
  }
}

/* ---------------------------
   Drag SECTIONS + auto-scroll
---------------------------- */

function stopAutoScrollSection() {
  if (autoScrollSectionRaf) cancelAnimationFrame(autoScrollSectionRaf);
  autoScrollSectionRaf = null;
}

function startAutoScrollSection() {
  if (autoScrollSectionRaf) return;

  const step = () => {
    if (!sectionDrag || !sectionDrag.started) {
      stopAutoScrollSection();
      return;
    }

    const edge = 90;
    const maxSpeed = 22;
    const W = window.innerWidth;
    const H = window.innerHeight;

    const x = sectionDrag.lastX;
    const y = sectionDrag.lastY;

    let vx = 0;
    let vy = 0;

    if (y < edge) vy = -maxSpeed * (1 - y / edge);
    else if (y > H - edge) vy = maxSpeed * (1 - (H - y) / edge);

    if (x < edge) vx = -maxSpeed * (1 - x / edge);
    else if (x > W - edge) vx = maxSpeed * (1 - (W - x) / edge);

    if (vx || vy) {
      window.scrollBy(vx, vy);
      if (sectionDrag?.placeholderEl) {
        placeSectionPlaceholder(
          sectionsWrap,
          sectionDrag.placeholderEl,
          sectionDrag.lastX,
          sectionDrag.lastY,
          sectionDrag.id
        );
      }
    }

    autoScrollSectionRaf = requestAnimationFrame(step);
  };

  autoScrollSectionRaf = requestAnimationFrame(step);
}

function cancelSectionDrag() {
  if (!sectionDrag) return;

  stopAutoScrollSection();

  if (sectionDrag.ghostEl) sectionDrag.ghostEl.remove();
  if (sectionDrag.placeholderEl) sectionDrag.placeholderEl.remove();

  const original = sectionsWrap?.querySelector(
    `.section-card[data-section-card-id="${sectionDrag.id}"]`
  );
  if (original) {
    original.style.opacity = "";
    original.style.pointerEvents = "";
  }

  document.body.classList.remove("drag-active");
  sectionDrag = null;
}

function createSectionPlaceholder(sectionEl) {
  const ph = document.createElement("div");
  ph.className = "section-placeholder";

  const span = sectionEl.style.getPropertyValue("--span") || "12";
  const h = sectionEl.style.getPropertyValue("--h") || "auto";
  const rows = sectionEl.style.getPropertyValue("--rows") || "";

  ph.style.setProperty("--span", span);
  ph.style.setProperty("--h", h);

  if (rows) {
    ph.style.setProperty("--rows", rows);
  } else {
    const gap = getWrapGap();
    const r = sectionEl.getBoundingClientRect();
    const calcRows = Math.ceil((r.height + gap) / MASONRY_ROW);
    ph.style.setProperty("--rows", String(Math.max(1, calcRows)));
  }

  const r = sectionEl.getBoundingClientRect();
  ph.style.minHeight = `${Math.max(120, Math.round(r.height))}px`;

  return ph;
}

function createSectionGhost(sectionEl) {
  const rect = sectionEl.getBoundingClientRect();
  const ghost = sectionEl.cloneNode(true);
  ghost.classList.add("section-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  return ghost;
}

function placeSectionPlaceholder(wrap, placeholderEl, x, y, draggedId) {
  const cards = [...wrap.querySelectorAll(".section-card")].filter(
    (c) => c.dataset.sectionCardId !== draggedId
  );

  if (!cards.length) {
    wrap.appendChild(placeholderEl);
    return;
  }

  const items = cards
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        r,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        rowTol: Math.max(18, r.height * 0.35),
      };
    })
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);

  let beforeEl = null;
  for (const it of items) {
    const sameRow = Math.abs(y - it.cy) <= it.rowTol;
    if (y < it.cy || (sameRow && x < it.cx)) {
      beforeEl = it.el;
      break;
    }
  }

  if (!beforeEl) wrap.appendChild(placeholderEl);
  else wrap.insertBefore(placeholderEl, beforeEl);
}

function onSectionPointerDown(e) {
  if (!arranging) return;
  if (drag || sectionResize) return;

  const handle = e.target?.closest?.('[data-section-move="1"]');
  if (!handle) return;

  const sectionEl = handle.closest(".section-card");
  if (!sectionEl) return;

  e.preventDefault();

  const id = sectionEl.dataset.sectionCardId;
  const rect = sectionEl.getBoundingClientRect();

  sectionDrag = {
    id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    started: false,
    ghostEl: null,
    placeholderEl: null,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };

  try {
    handle.setPointerCapture(e.pointerId);
  } catch {}
}

function startSectionDrag(sectionEl) {
  if (!sectionDrag || sectionDrag.started) return;
  sectionDrag.started = true;

  sectionDrag.placeholderEl = createSectionPlaceholder(sectionEl);
  sectionDrag.ghostEl = createSectionGhost(sectionEl);
  document.body.appendChild(sectionDrag.ghostEl);

  sectionEl.style.opacity = "0";
  sectionEl.style.pointerEvents = "none";

  sectionEl.parentElement.insertBefore(sectionDrag.placeholderEl, sectionEl);

  document.body.classList.add("drag-active");
  startAutoScrollSection();
}

function onSectionPointerMove(e) {
  if (!sectionDrag) return;
  if (e.pointerId !== sectionDrag.pointerId) return;

  sectionDrag.lastX = e.clientX;
  sectionDrag.lastY = e.clientY;

  if (!sectionDrag.started) {
    const dx = sectionDrag.lastX - sectionDrag.startX;
    const dy = sectionDrag.lastY - sectionDrag.startY;
    if (Math.hypot(dx, dy) < 6) return;

    const sectionEl = sectionsWrap?.querySelector(
      `.section-card[data-section-card-id="${sectionDrag.id}"]`
    );
    if (sectionEl) startSectionDrag(sectionEl);
  }

  if (!sectionDrag.started) return;

  const x = sectionDrag.lastX - sectionDrag.offsetX;
  const y = sectionDrag.lastY - sectionDrag.offsetY;
  sectionDrag.ghostEl.style.left = `${x}px`;
  sectionDrag.ghostEl.style.top = `${y}px`;

  startAutoScrollSection();
  placeSectionPlaceholder(
    sectionsWrap,
    sectionDrag.placeholderEl,
    sectionDrag.lastX,
    sectionDrag.lastY,
    sectionDrag.id
  );
}

async function finalizeSectionDrop(wrap) {
  if (!wrap) return;

  const all = [...wrap.querySelectorAll(".section-card")];

  const base = Date.now();
  let i = 0;

  for (const el of all) {
    const sid = el.dataset.sectionCardId;
    if (!sid || sid === UNASSIGNED) continue;

    const ord = base + i * 1000;
    i++;

    await updateDoc(doc(db, SECTIONS_COL, sid), { order: ord });
  }
}

function onSectionPointerUp(e) {
  if (!sectionDrag) return;
  if (e.pointerId !== sectionDrag.pointerId) return;

  const wasStarted = sectionDrag.started;

  const id = sectionDrag.id;
  const ghost = sectionDrag.ghostEl;
  const placeholder = sectionDrag.placeholderEl;

  sectionDrag = null;

  stopAutoScrollSection();
  document.body.classList.remove("drag-active");

  if (ghost) ghost.remove();

  const original = sectionsWrap?.querySelector(
    `.section-card[data-section-card-id="${id}"]`
  );

  if (original) {
    original.style.opacity = "";
    original.style.pointerEvents = "";
  }

  if (!wasStarted) return;

  if (placeholder && placeholder.parentElement) {
    const wrap = placeholder.parentElement;

    if (original) {
      wrap.insertBefore(original, placeholder);
      original.style.opacity = "";
      original.style.pointerEvents = "";
      updateMasonryRows(original, null);
    }

    try {
      placeholder.remove();
    } catch {}

    finalizeSectionDrop(wrap).catch((err) => {
      console.error(err);
      alert("Impossible de déplacer la section.");
    });
  }
}

/* ---------------------------
   Resize SECTIONS (aimanté)
---------------------------- */

function cancelSectionResize() {
  if (!sectionResize) return;
  document.body.classList.remove("drag-active");
  sectionResize = null;
}

function computeGridMetrics() {
  const cs = getComputedStyle(sectionsWrap);
  const gap = parseFloat(cs.gap || cs.columnGap || "18") || 18;
  const wrapRect = sectionsWrap.getBoundingClientRect();

  const totalGap = gap * (GRID_COLS - 1);
  const colW = (wrapRect.width - totalGap) / GRID_COLS;

  return { gap, colW };
}

async function persistSectionLayout(id, colSpan, heightPx) {
  const normalized = normalizeSectionLayout({ colSpan, heightPx });

  if (id === UNASSIGNED) {
    galleryLayout.colSpan = normalized.colSpan;
    galleryLayout.heightPx = normalized.heightPx;
    try {
      localStorage.setItem(GALLERY_LAYOUT_KEY, JSON.stringify(galleryLayout));
    } catch {}
    return;
  }

  await updateDoc(doc(db, SECTIONS_COL, id), {
    colSpan: normalized.colSpan,
    heightPx: normalized.heightPx,
  });
}

function onSectionResizeDown(e) {
  if (!arranging) return;
  if (drag || sectionDrag) return;

  const handle = e.target?.closest?.('[data-section-resize="1"]');
  if (!handle) return;

  const sectionEl = handle.closest(".section-card");
  if (!sectionEl) return;

  e.preventDefault();

  const id = sectionEl.dataset.sectionCardId;
  const r = sectionEl.getBoundingClientRect();
  const { gap, colW } = computeGridMetrics();

  sectionResize = {
    id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    startW: r.width,
    startH: r.height,
    gap,
    colW,
  };

  try {
    handle.setPointerCapture(e.pointerId);
  } catch {}
  document.body.classList.add("drag-active");
}

function onSectionResizeMove(e) {
  if (!sectionResize) return;
  if (e.pointerId !== sectionResize.pointerId) return;

  const sectionEl = sectionsWrap?.querySelector(
    `.section-card[data-section-card-id="${sectionResize.id}"]`
  );
  if (!sectionEl) return;

  const dx = e.clientX - sectionResize.startX;
  const dy = e.clientY - sectionResize.startY;

  const newW = Math.max(220, sectionResize.startW + dx);
  const newH = clamp(sectionResize.startH + dy, MIN_HEIGHT, MAX_HEIGHT);

  const colUnit = sectionResize.colW + sectionResize.gap;
  const approxSpan = clamp(
    Math.round((newW + sectionResize.gap) / colUnit),
    1,
    GRID_COLS
  );
  const span = nearestPreset(approxSpan, SPAN_PRESETS);
  const hSnap = nearestPreset(newH, HEIGHT_PRESETS);

  sectionEl.style.setProperty("--span", String(span));
  sectionEl.style.setProperty("--h", `${Math.round(hSnap)}px`);
  updateMasonryRows(sectionEl, hSnap);
}

function onSectionResizeUp(e) {
  if (!sectionResize) return;
  if (e.pointerId !== sectionResize.pointerId) return;

  const id = sectionResize.id;
  sectionResize = null;
  document.body.classList.remove("drag-active");

  const sectionEl = sectionsWrap?.querySelector(
    `.section-card[data-section-card-id="${id}"]`
  );
  if (!sectionEl) return;

  const span =
    parseInt(sectionEl.style.getPropertyValue("--span") || "12", 10) || 12;

  const hRaw = sectionEl.style.getPropertyValue("--h");
  const heightPx = hRaw && hRaw.endsWith("px") ? parseInt(hRaw, 10) : null;

  persistSectionLayout(id, span, heightPx)
    .then(() => updateMasonryRows(sectionEl, heightPx))
    .catch((err) => {
      console.error(err);
      alert("Impossible de sauvegarder la taille de la section.");
    });
}

/* ---------------------------
   Listeners (delegation)
---------------------------- */

sectionsWrap?.addEventListener("pointerdown", onSectionPointerDown, {
  passive: false,
});
sectionsWrap?.addEventListener("pointerdown", onSectionResizeDown, {
  passive: false,
});
sectionsWrap?.addEventListener("pointerdown", onPointerDown, { passive: false });

window.addEventListener("pointermove", onSectionPointerMove, { passive: false });
window.addEventListener("pointermove", onSectionResizeMove, { passive: false });
window.addEventListener("pointermove", onPointerMove, { passive: false });

window.addEventListener("pointerup", onSectionPointerUp);
window.addEventListener("pointerup", onSectionResizeUp);
window.addEventListener("pointerup", onPointerUp);

window.addEventListener("pointercancel", (e) => {
  try {
    onPointerUp(e);
  } catch {}
  try {
    onSectionPointerUp(e);
  } catch {}
  try {
    onSectionResizeUp(e);
  } catch {}
});

/* ---------------------------
   Viewer
---------------------------- */

function openViewer(photo) {
  currentViewed = { ...photo };
  viewerTitle.textContent = "Photo";
  viewerImg.src = photo.url;
  applyRotation(viewerImg, photo.rotation || 0);

  viewerDownload.href = photo.url;
  viewerDownload.setAttribute("download", `photo-${photo.id}.jpg`);

  viewer.classList.add("open");
  viewer.setAttribute("aria-hidden", "false");

  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeViewer() {
  viewer.classList.remove("open");
  viewer.setAttribute("aria-hidden", "true");
  currentViewed = null;

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

viewerClose?.addEventListener("click", closeViewer);
viewer.addEventListener("click", (e) => {
  if (e.target === viewer) closeViewer();
});

viewerDelete?.addEventListener("click", async () => {
  if (!currentViewed) return;
  const ok = confirm("Supprimer cette photo de la galerie ?");
  if (!ok) return;

  try {
    viewerDelete.disabled = true;
    await deleteDoc(doc(db, PHOTOS_COL, currentViewed.id));
    closeViewer();
  } catch (e) {
    alert("Suppression impossible : " + (e?.message || e));
  } finally {
    viewerDelete.disabled = false;
  }
});

viewerRotate?.addEventListener("click", async () => {
  if (!currentViewed) return;

  const cur = clampRotation(currentViewed.rotation || 0);
  const newRot = (cur + 90) % 360;
  currentViewed.rotation = newRot;
  applyRotation(viewerImg, newRot);

  try {
    await updateDoc(doc(db, PHOTOS_COL, currentViewed.id), { rotation: newRot });
  } catch (e) {
    console.error("Rotation non sauvegardée", e);
    alert("Impossible de sauvegarder la rotation.");
  }
});

/* ---------------------------
   Slideshow
---------------------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue() {
  queue = shuffle(photos);
  idx = 0;
}

function showSlide() {
  if (!queue.length) return;
  const s = queue[idx];

  slideImg.src = s.url;
  slideCounter.textContent = `${idx + 1} / ${queue.length}`;
  applyRotation(slideImg, s.rotation || 0);
}

function next() {
  if (!queue.length) return;
  idx++;
  if (idx >= queue.length) buildQueue();
  showSlide();
}

function prev() {
  if (!queue.length) return;
  idx--;
  if (idx < 0) idx = 0;
  showSlide();
}

function startAuto() {
  stopAuto();
  timer = setInterval(() => {
    if (playing) next();
  }, 3500);
}

function stopAuto() {
  if (timer) clearInterval(timer);
  timer = null;
}

function syncPlayIcon() {
  if (!togglePlayIcon) return;
  togglePlayIcon.src = playing
    ? "../assets/img/icons/pause.svg"
    : "../assets/img/icons/play.svg";
}

function openShow() {
  if (!photos.length) {
    alert("Ajoute d'abord quelques photos.");
    return;
  }
  buildQueue();
  slideshow.classList.add("open");
  playing = true;
  syncPlayIcon();
  showSlide();
  startAuto();
}

function closeShow() {
  slideshow.classList.remove("open");
  stopAuto();
}

showBtn?.addEventListener("click", openShow);
closeShowBtn?.addEventListener("click", closeShow);
nextSlideBtn?.addEventListener("click", next);
prevSlideBtn?.addEventListener("click", prev);

togglePlayBtn?.addEventListener("click", () => {
  playing = !playing;
  syncPlayIcon();
}); 

/* ---------------------------
   Upload modal
---------------------------- */

function openUploadModal() {
  uploadModal.classList.add("open");
  uploadModal.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeUploadModal() {
  uploadModal.classList.remove("open");
  uploadModal.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function fmtCount() {
  const n = pending.length;
  uploadCount.textContent =
    n === 0 ? "Aucun fichier" : n === 1 ? "1 fichier" : `${n} fichiers`;
}

function resetProgressUI() {
  uploadProgressBar.value = 0;
  uploadProgressText.textContent = "0 / 0";
  uploadProgressDetail.textContent = "—";
}

function setUploadingState(isUploading) {
  addBtn.disabled = isUploading;
  showBtn.disabled = isUploading;
  addSectionBtn.disabled = isUploading;
  arrangeBtn && (arrangeBtn.disabled = isUploading);
  uploadCancelBtn.disabled = isUploading;

  uploadStartBtn.disabled = isUploading || pending.length === 0;

  setBtnLoading(uploadStartBtn, isUploading, { label: "Envoi…" });
  if (isUploading) {
    uploadStartBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Envoi…`;
  } else {
    uploadStartBtn.textContent = "Envoyer";
  }
}

function renderPending() {
  uploadPreviewGrid.innerHTML = "";
  fmtCount();

  if (!pending.length) {
    const empty = document.createElement("div");
    empty.className = "upload-empty";
    empty.textContent = "Sélectionne des images pour les prévisualiser ici.";
    uploadPreviewGrid.appendChild(empty);
    uploadStartBtn.disabled = true;
    return;
  }

  for (let i = 0; i < pending.length; i++) {
    const { file, url } = pending[i];

    const item = document.createElement("div");
    item.className = "upload-item";

    const img = document.createElement("img");
    img.className = "upload-thumb";
    img.src = url;
    img.alt = file.name;

    const meta = document.createElement("div");
    meta.className = "upload-meta";

    const name = document.createElement("div");
    name.className = "upload-name";
    name.textContent = file.name;

    const info = document.createElement("div");
    info.className = "upload-info";
    info.textContent = `${Math.round(file.size / 1024)} Ko`;

    meta.appendChild(name);
    meta.appendChild(info);

    const remove = document.createElement("button");
    remove.className = "upload-remove";
    remove.type = "button";
    remove.title = "Retirer";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      try { URL.revokeObjectURL(pending[i].url); } catch {}
      pending.splice(i, 1);
      renderPending();
      setUploadingState(false);
    });

    item.appendChild(img);
    item.appendChild(meta);
    item.appendChild(remove);
    uploadPreviewGrid.appendChild(item);
  }

  uploadStartBtn.disabled = false;
}

addBtn?.addEventListener("click", () => input.click());

input?.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;

  for (const p of pending) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }

  pending = files.map((file) => ({ file, url: URL.createObjectURL(file) }));

  resetProgressUI();
  renderPending();
  setUploadingState(false);
  openUploadModal();
});

uploadCancelBtn?.addEventListener("click", () => {
  if (uploadCancelBtn.disabled) return;

  for (const p of pending) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }
  pending = [];
  resetProgressUI();
  closeUploadModal();
});

uploadStartBtn?.addEventListener("click", async () => {
  if (!pending.length) return;

  setUploadingState(true);
  resetProgressUI();

  const total = pending.length;
  let done = 0;

  const updateOverall = (currentRatio, currentName) => {
    const overall = Math.max(0, Math.min(1, (done + currentRatio) / total));
    uploadProgressBar.value = Math.round(overall * 100);
    uploadProgressText.textContent = `${done} / ${total}`;
    uploadProgressDetail.textContent = currentName
      ? `Envoi de ${currentName} — ${Math.round(currentRatio * 100)}%`
      : "—";
  };

  try {
    for (let i = 0; i < pending.length; i++) {
      const { file } = pending[i];

      updateOverall(0, file.name);

      const up = await uploadImage(file, {
        onProgress: (ratio) => updateOverall(ratio, file.name),
      });

      await addDoc(collection(db, PHOTOS_COL), {
        type: "photo",
        createdAt: Date.now(),
        order: Date.now(),
        sectionId: null,

        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl: up.secure_url,
        rotation: 0,
      });

      done++;
      uploadProgressText.textContent = `${done} / ${total}`;
      uploadProgressDetail.textContent = `Envoyé : ${file.name}`;
      uploadProgressBar.value = Math.round((done / total) * 100);
    }

    for (const p of pending) {
      try { URL.revokeObjectURL(p.url); } catch {}
    }
    pending = [];

    uploadProgressDetail.textContent = "Terminé.";
    setTimeout(() => {
      closeUploadModal();
      resetProgressUI();
      setUploadingState(false);
    }, 450);
  } catch (e) {
    setUploadingState(false);
    alert("Erreur upload : " + (e?.message || e));
  }
});

/* ---------------------------
   Sections: création
---------------------------- */

addSectionBtn?.addEventListener("click", async () => {
  const title = prompt("Titre de la section ?");
  if (!title) return;

  try {
    await addDoc(collection(db, SECTIONS_COL), {
      title: title.trim(),
      order: Date.now(),
      colSpan: 12,
      heightPx: null,
    });
  } catch (e) {
    alert("Impossible de créer la section.");
    console.error(e);
  }
});

/* ---------------------------
   Keyboard shortcuts
---------------------------- */

document.addEventListener("keydown", (e) => {
  if (viewer.classList.contains("open")) {
    if (e.key === "Escape") closeViewer();
    return;
  }
  if (slideshow.classList.contains("open")) {
    if (e.key === "Escape") closeShow();
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
    return;
  }
  if (uploadModal.classList.contains("open")) {
    if (e.key === "Escape" && !uploadCancelBtn.disabled) uploadCancelBtn.click();
  }
});

/* ---------------------------
   Main
---------------------------- */

async function main() {
  await ensureAnonAuth();

  onSnapshot(query(collection(db, SECTIONS_COL), orderBy("order", "asc")), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });

  onSnapshot(query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")), (snap) => {
    photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
}

main();
