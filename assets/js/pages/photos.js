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
  getDocs,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PHOTOS_COL = "photos";
const SECTIONS_COL = "photoSections";
const UNASSIGNED = "__unassigned__";

const LONG_PRESS_MS = 260;
const DRAG_START_PX = 8;

const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
const arrangeBtn = document.getElementById("arrangeBtn");
const showBtn = document.getElementById("startSlideshowBtn");

const uploadModal = document.getElementById("uploadModal");
const uploadPreviewGrid = document.getElementById("uploadPreviewGrid");
const uploadStartBtn = document.getElementById("uploadStartBtn");
const uploadCancelBtn = document.getElementById("uploadCancelBtn");
const uploadProgressBar = document.getElementById("uploadProgressBar");
const uploadProgressText = document.getElementById("uploadProgressText");
const uploadProgressDetail = document.getElementById("uploadProgressDetail");
const uploadCount = document.getElementById("uploadCount");

const viewer = document.getElementById("photoViewer");
const viewerImg = document.getElementById("viewerImg");
const viewerTitle = document.getElementById("viewerTitle");
const viewerDownload = document.getElementById("viewerDownload");
const viewerDelete = document.getElementById("viewerDelete");
const viewerClose = document.getElementById("viewerClose");
const viewerRotate = document.getElementById("viewerRotate");

const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");
const togglePlayBtn = document.getElementById("togglePlay");
const togglePlayIcon = document.getElementById("togglePlayIcon");
const closeShowBtn = document.getElementById("closeShow");
const nextSlideBtn = document.getElementById("nextSlide");
const prevSlideBtn = document.getElementById("prevSlide");
const shuffleBtn = document.getElementById("shuffleBtn");

let photos = [];
let sections = [];

let queue = [];
let idx = 0;
let playing = true;
let timer = null;

let useShuffle = false;
let baseQueue = [];
let shuffledQueue = [];

let pending = [];
let currentViewed = null;

let arranging = false;

// Drag photos
let drag = null;
let autoScrollRaf = null;

// Drag sections
let sectionDrag = null;
let autoScrollSectionRaf = null;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function clampRotation(deg) {
  const allowed = [0, 90, 180, 270];
  return allowed.includes(deg) ? deg : 0;
}

function applyRotation(el, deg) {
  if (!el) return;
  const rot = clampRotation(deg || 0);
  el.style.transform = `rotate(${rot}deg)`;
  el.style.transformOrigin = "center center";
}

function applyRotationThumb(imgEl, deg) {
  if (!imgEl) return;
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

/* -------------------- UI Modal helpers -------------------- */

function getUiModalEls() {
  const modal = document.getElementById("uiModal");
  return {
    modal,
    title: document.getElementById("uiModalTitle"),
    msg: document.getElementById("uiModalMessage"),
    ok: document.getElementById("uiModalOk"),
    cancel: document.getElementById("uiModalCancel"),
    fieldWrap: document.getElementById("uiModalFieldWrap"),
    input: document.getElementById("uiModalInput"),
  };
}

function openUiModal() {
  const { modal } = getUiModalEls();
  if (!modal) return;
  modal.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeUiModal() {
  const { modal } = getUiModalEls();
  if (!modal) return;
  modal.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function uiConfirm(message, opts = {}) {
  const { modal, title, msg, ok, cancel, fieldWrap } = getUiModalEls();
  if (!modal || !title || !msg || !ok || !cancel || !fieldWrap) {
    return Promise.resolve(window.confirm(message || ""));
  }

  title.textContent = opts.title || "Confirmation";
  msg.textContent = message || "";
  fieldWrap.style.display = "none";

  ok.textContent = opts.okText || "OK";
  cancel.textContent = opts.cancelText || "Annuler";
  ok.classList.toggle("danger", !!opts.danger);

  openUiModal();

  return new Promise((resolve) => {
    const cleanup = () => {
      ok.classList.remove("danger");
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      closeUiModal();
    };

    const onOk = () => {
      cleanup();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onBackdrop = (e) => {
      if (e.target?.closest?.('[data-close="1"]')) onCancel();
    };
    const onKey = (e) => {
      if (modal.getAttribute("aria-hidden") !== "false") return;
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onOk();
    };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKey);
  });
}

function uiPrompt(message, opts = {}) {
  const { modal, title, msg, ok, cancel, fieldWrap, input } = getUiModalEls();
  if (!modal || !title || !msg || !ok || !cancel || !fieldWrap || !input) {
    const v = window.prompt(message || "", opts.defaultValue || "");
    return Promise.resolve(v ? v.trim() : null);
  }

  title.textContent = opts.title || "Saisie";
  msg.textContent = message || "";

  fieldWrap.style.display = "";
  input.value = opts.defaultValue || "";
  input.placeholder = opts.placeholder || "";

  ok.textContent = opts.okText || "OK";
  cancel.textContent = opts.cancelText || "Annuler";
  ok.classList.remove("danger");

  openUiModal();
  setTimeout(() => input.focus(), 0);

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      closeUiModal();
    };

    const onOk = () => {
      const v = (input.value || "").trim();
      cleanup();
      resolve(v ? v : null);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onBackdrop = (e) => {
      if (e.target?.dataset?.close === "1") onCancel();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onOk();
    };

    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKey);
  });
}

/* -------------------- Cloudinary helpers -------------------- */

const CLD_CLOUD = "dpj33zjpk";

function cloudinaryWithTransform(url, transform = "f_auto,q_auto") {
  if (!url || typeof url !== "string") return url;
  if (!url.includes("/upload/")) return url;
  return url.replace("/upload/", `/upload/${transform}/`);
}

function cloudinaryFromPublicId(publicId, transform = "f_auto,q_auto") {
  if (!publicId) return null;
  return `https://res.cloudinary.com/${CLD_CLOUD}/image/upload/${transform}/${publicId}`;
}

function bestThumb(p) {
  return (
    cloudinaryFromPublicId(p.publicId, "f_auto,q_auto,c_fill,w_600,h_600") ||
    cloudinaryWithTransform(
      p.thumbUrl || p.url,
      "f_auto,q_auto,c_fill,w_600,h_600"
    )
  );
}

function bestFull(p) {
  return (
    cloudinaryFromPublicId(p.publicId, "f_auto,q_auto") ||
    cloudinaryWithTransform(p.url, "f_auto,q_auto")
  );
}

/* -------------------- Section fullscreen -------------------- */

let fullscreenSectionId = null;
let sectionBackdropEl = null;

function ensureSectionBackdrop() {
  if (sectionBackdropEl) return sectionBackdropEl;
  sectionBackdropEl = document.createElement("div");
  sectionBackdropEl.className = "section-backdrop";
  sectionBackdropEl.addEventListener("click", exitSectionFullscreen);
  return sectionBackdropEl;
}

function onFullscreenKeydown(e) {
  if (e.key === "Escape") exitSectionFullscreen();
}

function enterSectionFullscreen(sectionId) {
  if (!sectionsWrap) return;

  exitSectionFullscreen();

  const card = sectionsWrap.querySelector(
    `.section-card[data-section-card-id="${sectionId}"]`
  );
  if (!card) return;

  fullscreenSectionId = sectionId;

  document.body.appendChild(card);

  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");

  document.body.appendChild(ensureSectionBackdrop());
  card.classList.add("is-fullscreen");

  const icon = card.querySelector("[data-maximize-icon]");
  if (icon) icon.src = "../assets/img/icons/minimize.svg";

  const btn = card.querySelector(".section-maximize");
  if (btn) btn.title = "Réduire";

  window.addEventListener("keydown", onFullscreenKeydown);
}

function exitSectionFullscreen() {
  if (!sectionsWrap) return;

  if (fullscreenSectionId) {
    const card = document.querySelector(
      `.section-card[data-section-card-id="${fullscreenSectionId}"]`
    );

    if (card) {
      card.classList.remove("is-fullscreen");

      const icon = card.querySelector("[data-maximize-icon]");
      if (icon) icon.src = "../assets/img/icons/maximize.svg";

      const btn = card.querySelector(".section-maximize");
      if (btn) btn.title = "Agrandir";

      sectionsWrap.appendChild(card);
    }
  }

  fullscreenSectionId = null;

  if (sectionBackdropEl && sectionBackdropEl.parentElement) {
    sectionBackdropEl.remove();
  }

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");

  window.removeEventListener("keydown", onFullscreenKeydown);
}

/* -------------------- Data ops -------------------- */

async function deleteSectionAndUnassignPhotos(sectionId) {
  if (!sectionId || sectionId === UNASSIGNED) return;

  const ok = await uiConfirm(
    "Supprimer cette section ? Les photos resteront dans la galerie (non supprimées).",
    { title: "Supprimer la section", danger: true, okText: "Supprimer" }
  );
  if (!ok) return;

  try {
    const q = query(
      collection(db, PHOTOS_COL),
      where("sectionId", "==", sectionId)
    );
    const snap = await getDocs(q);

    let batch = writeBatch(db);
    let count = 0;

    for (const d of snap.docs) {
      batch.update(d.ref, { sectionId: null });
      count++;
      if (count >= 450) {
        await batch.commit();
        batch = writeBatch(db);
        count = 0;
      }
    }
    if (count > 0) await batch.commit();

    await deleteDoc(doc(db, SECTIONS_COL, sectionId));
  } catch (e) {
    console.error(e);
    alert("Impossible de supprimer la section.");
  }
}

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
      const ao = typeof a.order === "number" ? a.order : a.createdAt ?? 0;
      const bo = typeof b.order === "number" ? b.order : b.createdAt ?? 0;
      return ao - bo;
    });
  }

  return grouped;
}

/* -------------------- Rendering -------------------- */

function renderPhotoCard(p) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card card-btn";
  card.title = "Ouvrir";
  card.dataset.id = p.id;

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = bestThumb(p);
  img.alt = "photo";
  if (p.rotation) applyRotationThumb(img, p.rotation);

  card.appendChild(img);

  card.addEventListener("click", () => {
    if (arranging) return;
    openViewer(p);
  });

  return card;
}

function renderSectionCard({ id, title, editable, hideTitle }, items) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.sectionCardId = id;

  if (hideTitle) card.classList.add("no-title");

  const head = document.createElement("div");
  head.className = "section-head";

  const move = document.createElement("button");
  move.type = "button";
  move.className = "section-move";
  move.title = "Changer l'ordre de la section";
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

  const actions = document.createElement("div");
  actions.className = "section-actions";

  const maxBtn = document.createElement("button");
  maxBtn.type = "button";
  maxBtn.className = "iconbtn section-maximize";
  maxBtn.title = "Agrandir";
  maxBtn.dataset.sectionMaximize = "1";
  maxBtn.innerHTML = `
    <img
      class="icon-img"
      data-maximize-icon
      src="../assets/img/icons/maximize.svg"
      alt=""
      aria-hidden="true"
    />
    <span class="sr-only">Agrandir</span>
  `;

  maxBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isFs = card.classList.contains("is-fullscreen");
    if (isFs) exitSectionFullscreen();
    else enterSectionFullscreen(id);
  });
  actions.appendChild(maxBtn);

  if (id !== UNASSIGNED) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "iconbtn danger";
    delBtn.title = "Supprimer la section";
    delBtn.innerHTML = `
      <img class="icon-img" src="../assets/img/icons/delete.svg" alt="" aria-hidden="true" />
      <span class="sr-only">Supprimer</span>
    `;
    delBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSectionAndUnassignPhotos(id);
    });
    actions.appendChild(delBtn);
  }

  head.appendChild(actions);

  const grid = document.createElement("div");
  grid.className = "section-grid";
  grid.dataset.sectionId = id;

  for (const p of items) grid.appendChild(renderPhotoCard(p));

  card.appendChild(head);
  card.appendChild(grid);

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
}

/* -------------------- Arrange mode -------------------- */

function ensureArrangeLabelSpan() {
  if (!arrangeBtn) return null;

  let label = arrangeBtn.querySelector("[data-arrange-label]");
  if (label) return label;

  label = document.createElement("span");
  label.setAttribute("data-arrange-label", "");

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

  document.body.classList.toggle("arranging", arranging);

  if (arrangeBtn) {
    arrangeBtn.classList.toggle("primary", arranging);
    arrangeBtn.setAttribute("aria-pressed", arranging ? "true" : "false");

    const label = ensureArrangeLabelSpan();
    if (label) label.textContent = arranging ? "Terminer" : "Arranger";

    const icon = arrangeBtn.querySelector("img.btn-icon");
    if (icon) icon.style.display = arranging ? "none" : "block";
  }

  if (!arranging) {
    cancelDrag();
    cancelSectionDrag();
  }
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* -------------------- FLIP helpers -------------------- */

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

/* -------------------- Drag photos -------------------- */

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

  const original = sectionsWrap?.querySelector(
    `.card-btn[data-id="${drag.id}"]`
  );
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
  if (sectionDrag) return;

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

  placePlaceholder(
    drag.srcGrid,
    drag.placeholderEl,
    drag.lastX,
    drag.lastY,
    drag.id
  );

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
      const cardEl = sectionsWrap?.querySelector(
        `.card-btn[data-id="${drag.id}"]`
      );
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
      renorm.splice(dropIndex, 0, {
        id: state.id,
        createdAt: Date.now(),
        order: 0,
      });

      const base = Date.now();
      for (let i = 0; i < renorm.length; i++) {
        const pid = renorm[i].id;
        const ord = base + i * 1000;
        await updateDoc(doc(db, PHOTOS_COL, pid), { order: ord });
      }

      await updateDoc(doc(db, PHOTOS_COL, state.id), {
        sectionId: newSectionValue,
      });
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

  const original = sectionsWrap?.querySelector(
    `.card-btn[data-id="${draggedId}"]`
  );
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

/* -------------------- Drag sections -------------------- */

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
    const H = window.innerHeight;

    const y = sectionDrag.lastY;

    let vy = 0;
    if (y < edge) vy = -maxSpeed * (1 - y / edge);
    else if (y > H - edge) vy = maxSpeed * (1 - (H - y) / edge);

    if (vy) {
      window.scrollBy(0, vy);
      if (sectionDrag?.placeholderEl) {
        placeSectionPlaceholderVertical(
          sectionsWrap,
          sectionDrag.placeholderEl,
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

  const r = sectionEl.getBoundingClientRect();
  ph.style.height = `${Math.max(120, Math.round(r.height))}px`;

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
  ghost.style.zIndex = 9999;
  ghost.style.pointerEvents = "none";
  ghost.style.boxShadow = "0 24px 70px rgba(0,0,0,.22)";
  ghost.style.borderRadius = "18px";
  return ghost;
}

function placeSectionPlaceholderVertical(wrap, placeholderEl, y, draggedId) {
  if (!wrap) return;

  const galleryEl = wrap.querySelector(
    `.section-card[data-section-card-id="${UNASSIGNED}"]`
  );

  const cards = [...wrap.querySelectorAll(".section-card")].filter((c) => {
    const sid = c.dataset.sectionCardId;
    if (!sid) return false;
    if (sid === UNASSIGNED) return false;
    if (sid === draggedId) return false;
    return true;
  });

  if (!cards.length) {
    if (galleryEl?.nextSibling)
      wrap.insertBefore(placeholderEl, galleryEl.nextSibling);
    else wrap.appendChild(placeholderEl);
    return;
  }

  const items = cards
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, midY: r.top + r.height / 2 };
    })
    .sort((a, b) => a.midY - b.midY);

  let beforeEl = null;
  for (const it of items) {
    if (y < it.midY) {
      beforeEl = it.el;
      break;
    }
  }

  if (!beforeEl) wrap.appendChild(placeholderEl);
  else wrap.insertBefore(placeholderEl, beforeEl);

  // Ne jamais laisser le placeholder avant la galerie
  if (galleryEl && placeholderEl.previousSibling == null) {
    wrap.insertBefore(placeholderEl, galleryEl.nextSibling);
  }
}

function onSectionPointerDown(e) {
  if (!arranging) return;
  if (drag) return;

  const handle = e.target?.closest?.('[data-section-move="1"]');
  if (!handle) return;

  const sectionEl = handle.closest(".section-card");
  if (!sectionEl) return;

  const id = sectionEl.dataset.sectionCardId;
  if (!id || id === UNASSIGNED) return;

  e.preventDefault();

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
  placeSectionPlaceholderVertical(
    sectionsWrap,
    sectionDrag.placeholderEl,
    sectionDrag.lastY,
    sectionDrag.id
  );
}

async function finalizeSectionDropAndPersist(wrap) {
  if (!wrap) return;

  const cards = [...wrap.querySelectorAll(".section-card")];

  const orderedIds = cards
    .map((el) => el.dataset.sectionCardId)
    .filter((sid) => sid && sid !== UNASSIGNED);

  const base = Date.now();

  const batch = writeBatch(db);
  for (let i = 0; i < orderedIds.length; i++) {
    const sid = orderedIds[i];
    batch.update(doc(db, SECTIONS_COL, sid), { order: base + i * 1000 });
  }
  await batch.commit();
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
    }

    try {
      placeholder.remove();
    } catch {}

    finalizeSectionDropAndPersist(wrap).catch((err) => {
      console.error(err);
      alert("Impossible de réordonner les sections.");
    });
  }
}

/* -------------------- One single listeners block (no duplicates) -------------------- */

sectionsWrap?.addEventListener("pointerdown", onSectionPointerDown, {
  passive: false,
});
sectionsWrap?.addEventListener("pointerdown", onPointerDown, { passive: false });

window.addEventListener("pointermove", onSectionPointerMove, { passive: false });
window.addEventListener("pointermove", onPointerMove, { passive: false });

window.addEventListener("pointerup", onSectionPointerUp);
window.addEventListener("pointerup", onPointerUp);

window.addEventListener("pointercancel", (e) => {
  try {
    onPointerUp(e);
  } catch {}
  try {
    onSectionPointerUp(e);
  } catch {}
});

/* -------------------- Viewer -------------------- */

function openViewer(photo) {
  currentViewed = { ...photo };
  if (viewerTitle) viewerTitle.textContent = "Photo";
  if (viewerImg) {
    viewerImg.src = bestFull(photo);
    applyRotation(viewerImg, photo.rotation || 0);
  }

  if (viewerDownload) {
    viewerDownload.href = bestFull(photo);
    viewerDownload.setAttribute("download", `photo-${photo.id}.jpg`);
  }

  viewer?.classList.add("open");
  viewer?.setAttribute("aria-hidden", "false");

  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeViewer() {
  viewer?.classList.remove("open");
  viewer?.setAttribute("aria-hidden", "true");
  currentViewed = null;

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

viewerClose?.addEventListener("click", closeViewer);
viewer?.addEventListener("click", (e) => {
  if (e.target === viewer) closeViewer();
});

viewerDelete?.addEventListener("click", async () => {
  if (!currentViewed) return;
  const ok = await uiConfirm("Supprimer cette photo de la galerie ?", {
    title: "Supprimer la photo",
    danger: true,
    okText: "Supprimer",
    cancelText: "Annuler",
  });
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

/* -------------------- Slideshow (shuffle + ordre galerie) -------------------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getGalleryOrderQueue() {
  const grouped = groupPhotos();
  const out = [];
  out.push(...(grouped.get(UNASSIGNED) || []));
  for (const s of sections) out.push(...(grouped.get(s.id) || []));
  return out;
}

function syncShuffleUI() {
  shuffleBtn?.classList.toggle("active", useShuffle);
  shuffleBtn?.setAttribute("aria-pressed", useShuffle ? "true" : "false");
}

function buildQueue({ keepCurrent = false } = {}) {
  const currentId = keepCurrent && queue[idx] ? queue[idx].id : null;

  baseQueue = getGalleryOrderQueue();
  shuffledQueue = shuffle(baseQueue);

  queue = useShuffle ? shuffledQueue : baseQueue;

  if (!queue.length) {
    idx = 0;
    return;
  }

  if (currentId) {
    const newIndex = queue.findIndex((p) => p.id === currentId);
    idx = newIndex >= 0 ? newIndex : 0;
  } else {
    idx = 0;
  }
}

function rebuildQueuePreserveIndex() {
  const desiredIndex = idx;
  const current = queue[desiredIndex] || null;

  baseQueue = getGalleryOrderQueue();
  if (!baseQueue.length) {
    queue = [];
    idx = 0;
    return;
  }

  const nextQueue = useShuffle ? shuffle(baseQueue) : baseQueue.slice();

  if (!current) {
    queue = nextQueue;
    idx = 0;
    return;
  }

  const currentId = current.id;
  const found = nextQueue.findIndex((p) => p.id === currentId);

  if (found === -1) {
    queue = nextQueue;
    idx = 0;
    return;
  }

  const target = Math.max(0, Math.min(desiredIndex, nextQueue.length - 1));
  const [item] = nextQueue.splice(found, 1);
  nextQueue.splice(target, 0, item);

  queue = nextQueue;
  idx = target;
}


function showSlide() {
  if (!queue.length) return;
  const s = queue[idx];

  if (slideImg) {
    slideImg.src = bestFull(s);
    applyRotation(slideImg, s.rotation || 0);
  }
  if (slideCounter) slideCounter.textContent = `${idx + 1} / ${queue.length}`;
}

function next() {
  if (!queue.length) return;
  idx++;

  if (idx >= queue.length) {
    if (useShuffle) {
      shuffledQueue = shuffle(baseQueue);
      queue = shuffledQueue;
    }
    idx = 0;
  }

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
  const q = getGalleryOrderQueue();
  if (!q.length) {
    alert("Ajoute d'abord quelques photos.");
    return;
  }

  useShuffle = false;
  syncShuffleUI();

  buildQueue();
  slideshow?.classList.add("open");
  playing = true;
  syncPlayIcon();
  showSlide();
  startAuto();
}

function closeShow() {
  slideshow?.classList.remove("open");
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

shuffleBtn?.addEventListener("click", () => {
  useShuffle = !useShuffle;
  syncShuffleUI();

  if (slideshow.classList.contains("open")) {
    rebuildQueuePreserveIndex();
    showSlide();
  }
});


/* -------------------- Upload modal -------------------- */

function openUploadModal() {
  uploadModal?.classList.add("open");
  uploadModal?.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeUploadModal() {
  uploadModal?.classList.remove("open");
  uploadModal?.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function fmtCount() {
  const n = pending.length;
  if (!uploadCount) return;
  uploadCount.textContent =
    n === 0 ? "Aucun fichier" : n === 1 ? "1 fichier" : `${n} fichiers`;
}

function resetProgressUI() {
  if (uploadProgressBar) uploadProgressBar.value = 0;
  if (uploadProgressText) uploadProgressText.textContent = "0 / 0";
  if (uploadProgressDetail) uploadProgressDetail.textContent = "—";
}

function setUploadingState(isUploading) {
  if (addBtn) addBtn.disabled = isUploading;
  if (showBtn) showBtn.disabled = isUploading;
  if (addSectionBtn) addSectionBtn.disabled = isUploading;
  if (arrangeBtn) arrangeBtn.disabled = isUploading;
  if (uploadCancelBtn) uploadCancelBtn.disabled = isUploading;

  if (uploadStartBtn)
    uploadStartBtn.disabled = isUploading || pending.length === 0;

  if (uploadStartBtn) {
    setBtnLoading(uploadStartBtn, isUploading, { label: "Envoi…" });
    if (isUploading) {
      uploadStartBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Envoi…`;
    } else {
      uploadStartBtn.textContent = "Envoyer";
    }
  }
}

function renderPending() {
  if (!uploadPreviewGrid) return;

  uploadPreviewGrid.innerHTML = "";
  fmtCount();

  if (!pending.length) {
    const empty = document.createElement("div");
    empty.className = "upload-empty";
    empty.textContent = "Sélectionne des images pour les prévisualiser ici.";
    uploadPreviewGrid.appendChild(empty);
    if (uploadStartBtn) uploadStartBtn.disabled = true;
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
      try {
        URL.revokeObjectURL(pending[i].url);
      } catch {}
      pending.splice(i, 1);
      renderPending();
      setUploadingState(false);
    });

    item.appendChild(img);
    item.appendChild(meta);
    item.appendChild(remove);
    uploadPreviewGrid.appendChild(item);
  }

  if (uploadStartBtn) uploadStartBtn.disabled = false;
}

addBtn?.addEventListener("click", () => input?.click());

input?.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;

  for (const p of pending) {
    try {
      URL.revokeObjectURL(p.url);
    } catch {}
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
    try {
      URL.revokeObjectURL(p.url);
    } catch {}
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
    const overall = clamp((done + currentRatio) / total, 0, 1);
    if (uploadProgressBar) uploadProgressBar.value = Math.round(overall * 100);
    if (uploadProgressText) uploadProgressText.textContent = `${done} / ${total}`;
    if (uploadProgressDetail)
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
      if (uploadProgressText) uploadProgressText.textContent = `${done} / ${total}`;
      if (uploadProgressDetail) uploadProgressDetail.textContent = `Envoyé : ${file.name}`;
      if (uploadProgressBar) uploadProgressBar.value = Math.round((done / total) * 100);
    }

    for (const p of pending) {
      try {
        URL.revokeObjectURL(p.url);
      } catch {}
    }
    pending = [];

    if (uploadProgressDetail) uploadProgressDetail.textContent = "Terminé.";
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

/* -------------------- Sections create -------------------- */

addSectionBtn?.addEventListener("click", async () => {
  const title = await uiPrompt("Titre de la section ?", {
    title: "Nouvelle section",
    placeholder: "Ex: Avec les petits enfants (exemple au hasard...)",
    okText: "Créer",
  });
  if (!title) return;

  try {
    await addDoc(collection(db, SECTIONS_COL), {
      title: title.trim(),
      order: Date.now(),
    });
  } catch (e) {
    alert("Impossible de créer la section.");
    console.error(e);
  }
});

/* -------------------- Keyboard shortcuts -------------------- */

document.addEventListener("keydown", (e) => {
  if (viewer?.classList.contains("open")) {
    if (e.key === "Escape") closeViewer();
    return;
  }
  if (slideshow?.classList.contains("open")) {
    if (e.key === "Escape") closeShow();
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
    return;
  }
  if (uploadModal?.classList.contains("open")) {
    if (e.key === "Escape" && uploadCancelBtn && !uploadCancelBtn.disabled)
      uploadCancelBtn.click();
  }
});

/* -------------------- Main -------------------- */

async function main() {
  await ensureAnonAuth();

  onSnapshot(
    query(collection(db, SECTIONS_COL), orderBy("order", "asc")),
    (snap) => {
      sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();

      if (slideshow?.classList.contains("open")) {
        buildQueue({ keepCurrent: true });
        showSlide();
      }
    }
  );

  onSnapshot(
    query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")),
    (snap) => {
      photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();

      if (slideshow?.classList.contains("open")) {
        buildQueue({ keepCurrent: true });
        showSlide();
      }
    }
  );
}

main();
