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

const IS_COARSE_POINTER =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;
const LONG_PRESS_MS = IS_COARSE_POINTER ? 320 : 260;
const DRAG_START_PX = IS_COARSE_POINTER ? 10 : 8;

const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
const arrangeBtn = document.getElementById("arrangeBtn");
const gridLayoutBtn = document.getElementById("gridLayoutBtn");
const gridLayoutLabel = document.getElementById("gridLayoutLabel");
const showBtn = document.getElementById("startSlideshowBtn");
const actionsBar = document.querySelector(".actions");

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
const toggleViewerFullscreenBtn = document.getElementById("toggleViewerFullscreen");
const toggleViewerFullscreenIcon = document.getElementById("toggleViewerFullscreenIcon");

const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");
const togglePlayBtn = document.getElementById("togglePlay");
const togglePlayIcon = document.getElementById("togglePlayIcon");
const closeShowBtn = document.getElementById("closeShow");
const nextSlideBtn = document.getElementById("nextSlide");
const prevSlideBtn = document.getElementById("prevSlide");
const shuffleBtn = document.getElementById("shuffleBtn");
const toggleFullscreenBtn = document.getElementById("toggleFullscreen");
const toggleFullscreenIcon = document.getElementById("toggleFullscreenIcon");

const slideshowPicker = document.getElementById("slideshowPicker");
const showPickerList = document.getElementById("showPickerList");
const showPickerSub = document.getElementById("showPickerSub");
const showPickerCancel = document.getElementById("showPickerCancel");
const showPickerSelectAll = document.getElementById("showPickerSelectAll");
const showPickerClear = document.getElementById("showPickerClear");
const showPickerApply = document.getElementById("showPickerApply");

let photos = [];
let sections = [];

let queue = [];
let idx = 0;
let playing = true;
let timer = null;

let useShuffle = false;
let baseQueue = [];

let pending = [];
let currentViewed = null;

let arranging = false;
let selectedPhotoIds = new Set();
let bulkDeleteBtn = null;

// Drag photos
let drag = null;
let autoScrollRaf = null;

// Drag sections
let sectionDrag = null;
let autoScrollSectionRaf = null;
let currentGridCols = 2;
let gridLayoutInitialized = false;
const GRID_CYCLE_ORDER = [2, 3, 4, 1];

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function updateGridMenuUI() {
  if (gridLayoutLabel) gridLayoutLabel.textContent = `Grille ${currentGridCols}`;

  if (gridLayoutBtn) {
    const i = GRID_CYCLE_ORDER.indexOf(currentGridCols);
    const next = i === -1 ? 2 : GRID_CYCLE_ORDER[(i + 1) % GRID_CYCLE_ORDER.length];
    gridLayoutBtn.setAttribute("aria-label", `Passer la grille a ${next} colonnes`);
    gridLayoutBtn.setAttribute("aria-expanded", "false");
  }
}

function applyGridCols(next) {
  const cols = clamp(Number(next) || 2, 1, 4);
  currentGridCols = cols;
  document.body?.setAttribute("data-grid-cols", String(cols));
  updateGridMenuUI();
}

function cycleGridCols() {
  const i = GRID_CYCLE_ORDER.indexOf(currentGridCols);
  const next = i === -1 ? 2 : GRID_CYCLE_ORDER[(i + 1) % GRID_CYCLE_ORDER.length];
  applyGridCols(next);
}

function getDefaultGridCols() {
  return window.matchMedia("(max-width: 740px)").matches ? 2 : 4;
}

function initGridLayout() {
  if (gridLayoutInitialized || !gridLayoutBtn) return;
  gridLayoutInitialized = true;

  applyGridCols(getDefaultGridCols());

  gridLayoutBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cycleGridCols();
  });
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
  const isSelected = selectedPhotoIds.has(p.id);
  card.classList.toggle("is-selected", isSelected);
  card.setAttribute("aria-pressed", isSelected ? "true" : "false");

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

function selectedCount() {
  return selectedPhotoIds.size;
}

function ensureBulkDeleteBtn() {
  if (bulkDeleteBtn) return bulkDeleteBtn;
  if (!actionsBar) return null;

  bulkDeleteBtn = document.createElement("button");
  bulkDeleteBtn.type = "button";
  bulkDeleteBtn.className = "btn danger";
  bulkDeleteBtn.style.display = "none";
  bulkDeleteBtn.addEventListener("click", deleteSelectedPhotos);
  actionsBar.appendChild(bulkDeleteBtn);
  return bulkDeleteBtn;
}

function syncBulkDeleteBtn() {
  const btn = ensureBulkDeleteBtn();
  if (!btn) return;

  const n = selectedCount();
  const visible = arranging && n > 0;

  btn.style.display = visible ? "inline-flex" : "none";
  btn.disabled = !visible;
  btn.textContent = n <= 1 ? "Supprimer la selection" : `Supprimer ${n} photos`;
}

function syncSelectedCardsUi() {
  sectionsWrap?.querySelectorAll(".card-btn[data-id]").forEach((el) => {
    const id = el.dataset.id;
    const selected = !!id && selectedPhotoIds.has(id);
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function setSelectedIds(ids) {
  selectedPhotoIds = new Set(ids || []);
  syncSelectedCardsUi();
  syncBulkDeleteBtn();
}

function togglePhotoSelection(id) {
  if (!id) return;
  const next = new Set(selectedPhotoIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelectedIds(next);
}

function pruneSelectionAgainstData() {
  const available = new Set(photos.map((p) => p.id));
  const next = new Set();
  for (const id of selectedPhotoIds) {
    if (available.has(id)) next.add(id);
  }
  selectedPhotoIds = next;
}

async function deleteSelectedPhotos() {
  const ids = [...selectedPhotoIds];
  if (!ids.length) return;

  const n = ids.length;
  const ok = await uiConfirm(
    n === 1
      ? "Supprimer 1 photo selectionnee de la galerie ?"
      : `Supprimer ${n} photos selectionnees de la galerie ?`,
    {
      title: "Supprimer des photos",
      danger: true,
      okText: n === 1 ? "Supprimer la photo" : `Supprimer ${n} photos`,
      cancelText: "Annuler",
    }
  );
  if (!ok) return;

  const btn = ensureBulkDeleteBtn();
  if (btn) btn.disabled = true;

  try {
    const batch = writeBatch(db);
    for (const id of ids) {
      batch.delete(doc(db, PHOTOS_COL, id));
    }
    await batch.commit();
    setSelectedIds([]);
  } catch (e) {
    console.error(e);
    alert("Suppression multiple impossible.");
  } finally {
    syncBulkDeleteBtn();
  }
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
    <img class="icon-img" data-maximize-icon src="../assets/img/icons/maximize.svg" alt="" aria-hidden="true" />
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
  pruneSelectionAgainstData();

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
        { id: s.id, title: s.title || "Section", editable: true, hideTitle: false },
        grouped.get(s.id) || []
      )
    );
  }

  syncSelectedCardsUi();
  syncBulkDeleteBtn();
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
    setSelectedIds([]);
  }

  syncBulkDeleteBtn();
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
        placePlaceholder(grid, drag.placeholderEl, drag.lastX, drag.lastY, drag.draggedIdsSet);
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

  const draggedIds = [...(drag.draggedIds || [drag.id])];
  for (const id of draggedIds) {
    const original = sectionsWrap?.querySelector(`.card-btn[data-id="${id}"]`);
    if (original) original.classList.remove("dragging");
  }

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

function createGhostFromCard(cardEl, count = 1) {
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

  if (count > 1) {
    const badge = document.createElement("div");
    badge.className = "drag-count-badge";
    badge.textContent = `${count}`;
    ghost.appendChild(badge);
  }

  return ghost;
}

function gridFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.(".section-grid") || null;
}

function placePlaceholder(gridEl, placeholderEl, x, y, draggedIdsSet) {
  const cards = [...gridEl.querySelectorAll(".card-btn")].filter(
    (c) => !draggedIdsSet?.has(c.dataset.id) && !c.classList.contains("dragging")
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

  if ((e.pointerType || "mouse") !== "touch") e.preventDefault();

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
    moved: false,
    draggedIds: [],
    draggedIdsSet: new Set(),
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
  const selectedIdsForDrag =
    selectedPhotoIds.has(drag.id) && selectedPhotoIds.size > 0
      ? [...selectedPhotoIds]
      : [drag.id];
  drag.draggedIds = [...new Set(selectedIdsForDrag)];
  drag.draggedIdsSet = new Set(drag.draggedIds);

  if (!selectedPhotoIds.has(drag.id) || selectedPhotoIds.size <= 1) {
    setSelectedIds(drag.draggedIds);
  }

  if (drag.pressTimer) {
    clearTimeout(drag.pressTimer);
    drag.pressTimer = null;
  }

  drag.placeholderEl = createPlaceholderFromCard(cardEl);
  drag.ghostEl = createGhostFromCard(cardEl, drag.draggedIds.length);

  document.body.appendChild(drag.ghostEl);

  const beforeRects = getRects(drag.srcGrid);
  for (const id of drag.draggedIds) {
    const el = sectionsWrap?.querySelector(`.card-btn[data-id="${id}"]`);
    if (el) el.classList.add("dragging");
  }

  drag.srcGrid.insertBefore(drag.placeholderEl, cardEl);
  animateFLIP(drag.srcGrid, beforeRects);

  placePlaceholder(drag.srcGrid, drag.placeholderEl, drag.lastX, drag.lastY, drag.draggedIdsSet);

  document.body.classList.add("drag-active");
  startAutoScroll();
}

function onPointerMove(e) {
  if (!drag) return;
  if (e.pointerId !== drag.pointerId) return;

  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  if (Math.hypot(drag.lastX - drag.startX, drag.lastY - drag.startY) > 4) {
    drag.moved = true;
  }

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

  placePlaceholder(grid, drag.placeholderEl, drag.lastX, drag.lastY, drag.draggedIdsSet);
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
    if (child.classList?.contains("card-btn") && !child.classList.contains("dragging")) {
      dropIndex++;
    }
  }

  const movedIds = [...(state.draggedIds || [state.id])];
  const movedSet = new Set(movedIds);

  const grouped = groupPhotos();
  const targetList = (grouped.get(targetSectionId) || []).filter((p) => !movedSet.has(p.id));
  const movedList = photos
    .filter((p) => movedSet.has(p.id))
    .sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : a.createdAt ?? 0;
      const bo = typeof b.order === "number" ? b.order : b.createdAt ?? 0;
      return ao - bo;
    });

  const safeIndex = clamp(dropIndex, 0, targetList.length);
  const finalList = [
    ...targetList.slice(0, safeIndex),
    ...movedList,
    ...targetList.slice(safeIndex),
  ];

  const base = Date.now();
  const batch = writeBatch(db);
  for (let i = 0; i < finalList.length; i++) {
    const pid = finalList[i].id;
    batch.update(doc(db, PHOTOS_COL, pid), {
      sectionId: newSectionValue,
      order: base + i * 1000,
    });
  }
  await batch.commit();
}

function onPointerUp(e) {
  if (!drag) return;
  if (e.pointerId !== drag.pointerId) return;

  const wasStarted = drag.started;

  const state = {
    id: drag.id,
    started: drag.started,
    placeholderEl: drag.placeholderEl,
    draggedIds: drag.draggedIds,
    moved: drag.moved,
  };

  const draggedIds = [...(drag.draggedIds || [drag.id])];
  const ghost = drag.ghostEl;
  const placeholder = drag.placeholderEl;

  if (drag.pressTimer) clearTimeout(drag.pressTimer);
  drag = null;

  stopAutoScroll();
  document.body.classList.remove("drag-active");

  if (ghost) ghost.remove();

  for (const id of draggedIds) {
    const original = sectionsWrap?.querySelector(`.card-btn[data-id="${id}"]`);
    if (original) original.classList.remove("dragging");
  }

  if (!wasStarted && !state.moved) {
    togglePhotoSelection(state.id);
  }
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

  const galleryEl = wrap.querySelector(`.section-card[data-section-card-id="${UNASSIGNED}"]`);

  const cards = [...wrap.querySelectorAll(".section-card")].filter((c) => {
    const sid = c.dataset.sectionCardId;
    if (!sid) return false;
    if (sid === UNASSIGNED) return false;
    if (sid === draggedId) return false;
    return true;
  });

  if (!cards.length) {
    if (galleryEl?.nextSibling) wrap.insertBefore(placeholderEl, galleryEl.nextSibling);
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
  placeSectionPlaceholderVertical(sectionsWrap, sectionDrag.placeholderEl, sectionDrag.lastY, sectionDrag.id);
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

  const original = sectionsWrap?.querySelector(`.section-card[data-section-card-id="${id}"]`);
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

sectionsWrap?.addEventListener("pointerdown", onSectionPointerDown, { passive: false });
sectionsWrap?.addEventListener("pointerdown", onPointerDown, { passive: false });

window.addEventListener("pointermove", onSectionPointerMove, { passive: false });
window.addEventListener("pointermove", onPointerMove, { passive: false });

window.addEventListener("pointerup", onSectionPointerUp);
window.addEventListener("pointerup", onPointerUp);

window.addEventListener("pointercancel", (e) => {
  try { onPointerUp(e); } catch {}
  try { onSectionPointerUp(e); } catch {}
});

/* -------------------- Viewer -------------------- */

let viewerPseudoFullscreen = false;
let slideshowPseudoFullscreen = false;

function getFullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestNativeFullscreen(el) {
  if (!el) return false;
  const fn =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.mozRequestFullScreen ||
    el.msRequestFullscreen;
  if (!fn) return false;
  try {
    const out = fn.call(el);
    if (out && typeof out.then === "function") await out;
    if (getFullscreenElement() === el) return true;

    // Certains navigateurs mobiles mettent un court instant a exposer fullscreenElement.
    for (let i = 0; i < 6; i++) {
      await wait(50);
      if (getFullscreenElement() === el) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function exitNativeFullscreen() {
  const fn =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.mozCancelFullScreen ||
    document.msExitFullscreen;
  if (!fn) return false;
  try {
    const out = fn.call(document);
    if (out && typeof out.then === "function") await out;
    return true;
  } catch {
    return false;
  }
}

function isViewerFullscreen() {
  return getFullscreenElement() === viewer || viewerPseudoFullscreen;
}

async function enterViewerFullscreen() {
  if (!viewer) return;
  const ok = await requestNativeFullscreen(viewer);
  viewerPseudoFullscreen = !ok;
  syncViewerFullscreenUI();
}

async function exitViewerFullscreen() {
  if (getFullscreenElement()) {
    await exitNativeFullscreen();
  }
  viewerPseudoFullscreen = false;
  syncViewerFullscreenUI();
}

function syncViewerFullscreenUI() {
  const nativeActive = getFullscreenElement() === viewer;
  if (nativeActive) viewerPseudoFullscreen = false;
  const active = nativeActive || viewerPseudoFullscreen;

  viewer?.classList.toggle("fullscreen", active);
  if (active) viewer?.classList.remove("show-controls");

  if (toggleViewerFullscreenIcon && toggleViewerFullscreenBtn) {
    toggleViewerFullscreenIcon.src = active
      ? "../assets/img/icons/minimize.svg"
      : "../assets/img/icons/maximize.svg";

    const label = active ? "Quitter le plein écran" : "Plein écran";
    toggleViewerFullscreenBtn.title = label;
    toggleViewerFullscreenBtn.setAttribute("aria-label", label);
  }
}

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
  // ✅ Si on ferme le viewer en fullscreen => on quitte d'abord le fullscreen
  if (isViewerFullscreen()) {
    exitViewerFullscreen();
  }

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

toggleViewerFullscreenBtn?.addEventListener("click", () => {
  if (isViewerFullscreen()) exitViewerFullscreen();
  else enterViewerFullscreen();
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

// Auto-hide controls en fullscreen (viewer)
let viewerFsHoverTimer = null;

viewer?.addEventListener("mousemove", (e) => {
  if (!viewer?.classList.contains("fullscreen")) return;

  const inTopZone = e.clientY <= 72;

  if (inTopZone) {
    if (viewer.classList.contains("show-controls")) return;

    if (!viewerFsHoverTimer) {
      viewerFsHoverTimer = setTimeout(() => {
        viewer.classList.add("show-controls");
        viewerFsHoverTimer = null;
      }, 1200);
    }
  } else {
    if (viewerFsHoverTimer) {
      clearTimeout(viewerFsHoverTimer);
      viewerFsHoverTimer = null;
    }
    viewer.classList.remove("show-controls");
  }
});

viewer?.addEventListener("touchstart", () => {
  if (!viewer?.classList.contains("fullscreen")) return;

  if (viewerFsHoverTimer) {
    clearTimeout(viewerFsHoverTimer);
    viewerFsHoverTimer = null;
  }

  viewer.classList.add("show-controls");
  setTimeout(() => {
    if (viewer?.classList.contains("fullscreen")) {
      viewer.classList.remove("show-controls");
    }
  }, 2500);
});

// Un seul fullscreenchange pour viewer + slideshow
function onAnyFullscreenChange() {
  syncViewerFullscreenUI();
  syncFullscreenUI();
}
document.addEventListener("fullscreenchange", onAnyFullscreenChange);
document.addEventListener("webkitfullscreenchange", onAnyFullscreenChange);
document.addEventListener("mozfullscreenchange", onAnyFullscreenChange);
document.addEventListener("MSFullscreenChange", onAnyFullscreenChange);

syncViewerFullscreenUI();

/* -------------------- Slideshow (picker + sections + galerie + shuffle) -------------------- */

let slideshowSelection = {
  includeGallery: true,
  sectionIds: [],
  includeAllSections: true,
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getSlideshowAvailability() {
  const grouped = groupPhotos();

  const galleryPhotos = grouped.get(UNASSIGNED) || [];
  const galleryAvailable = galleryPhotos.length > 0;

  const availableSectionIds = [];
  for (const s of sections) {
    const n = (grouped.get(s.id) || []).length;
    if (n > 0) availableSectionIds.push(s.id);
  }

  const totalSources = (galleryAvailable ? 1 : 0) + availableSectionIds.length;

  return { grouped, galleryAvailable, availableSectionIds, totalSources };
}

function normalizeSelectionToAvailability({ allowAutoPick = false } = {}) {
  const { galleryAvailable, availableSectionIds } = getSlideshowAvailability();

  if (!galleryAvailable) slideshowSelection.includeGallery = false;

  const allowed = new Set(availableSectionIds);

  if (slideshowSelection.includeAllSections) {
    slideshowSelection.sectionIds = [];
  } else {
    slideshowSelection.sectionIds = (slideshowSelection.sectionIds || []).filter((id) =>
      allowed.has(id)
    );
  }

  if (availableSectionIds.length === 0) {
    slideshowSelection.includeAllSections = false;
    slideshowSelection.sectionIds = [];
  }

  if (availableSectionIds.length < 2) {
    slideshowSelection.includeAllSections = false;
  }

  if (allowAutoPick) {
    const hasSomeSections =
      slideshowSelection.includeAllSections ||
      (slideshowSelection.sectionIds || []).length > 0;

    if (availableSectionIds.length > 0 && !hasSomeSections) {
      if (availableSectionIds.length >= 2) {
        slideshowSelection.includeAllSections = true;
        slideshowSelection.sectionIds = [];
      } else {
        slideshowSelection.includeAllSections = false;
        slideshowSelection.sectionIds = [availableSectionIds[0]];
      }
    }

    if (!slideshowSelection.includeGallery && availableSectionIds.length === 0 && galleryAvailable) {
      slideshowSelection.includeGallery = true;
    }
  }
}

function getQueueForSelection(sel) {
  const { grouped, galleryAvailable, availableSectionIds } = getSlideshowAvailability();
  const out = [];

  if (sel?.includeGallery && galleryAvailable) out.push(...(grouped.get(UNASSIGNED) || []));

  const includeAll = !!sel?.includeAllSections;
  const allowed = new Set(sel?.sectionIds || []);

  for (const s of sections) {
    if (!availableSectionIds.includes(s.id)) continue;
    if (includeAll || allowed.has(s.id)) out.push(...(grouped.get(s.id) || []));
  }

  return out;
}

/* ---------- Picker UI ---------- */

function openShowPicker() {
  if (!slideshowPicker) return;

  normalizeSelectionToAvailability({ allowAutoPick: false });
  renderShowPickerList();

  slideshowPicker.classList.add("open");
  slideshowPicker.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeShowPicker() {
  if (!slideshowPicker) return;

  slideshowPicker.classList.remove("open");
  slideshowPicker.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function updateShowPickerSub() {
  if (!showPickerSub) return;

  const { galleryAvailable, availableSectionIds } = getSlideshowAvailability();

  const g = slideshowSelection.includeGallery && galleryAvailable ? 1 : 0;

  const includeAll = !!slideshowSelection.includeAllSections;
  const nSections = includeAll
    ? availableSectionIds.length
    : (slideshowSelection.sectionIds || []).filter((id) =>
        availableSectionIds.includes(id)
      ).length;

  const total = g + nSections;

  showPickerSub.textContent =
    total === 0 ? "0 sélectionnée" : `${total} sélectionnée${total > 1 ? "s" : ""}`;
}

function renderShowPickerList() {
  if (!showPickerList) return;

  const { galleryAvailable, availableSectionIds } = getSlideshowAvailability();

  showPickerList.innerHTML = "";
  showPickerList.classList.add("show-picker-list");

  const canShowAllSections = availableSectionIds.length >= 2;
  if (!canShowAllSections) slideshowSelection.includeAllSections = false;

  const includeAll = !!slideshowSelection.includeAllSections;

  if (galleryAvailable) {
    const gItem = document.createElement("label");
    gItem.className = "show-picker-item";
    gItem.innerHTML = `
      <input type="checkbox" data-kind="gallery" ${slideshowSelection.includeGallery ? "checked" : ""} />
      <div class="label">
        <strong>Galerie</strong>
        <span>Photos non assignées</span>
      </div>
    `;
    showPickerList.appendChild(gItem);
  } else {
    slideshowSelection.includeGallery = false;
  }

  if (canShowAllSections) {
    const allItem = document.createElement("label");
    allItem.className = "show-picker-item";
    allItem.innerHTML = `
      <input type="checkbox" data-kind="allSections" ${includeAll ? "checked" : ""} />
      <div class="label">
        <strong>Toutes les sections</strong>
        <span>Inclut chaque section</span>
      </div>
    `;
    showPickerList.appendChild(allItem);
  }

  for (const s of sections) {
    if (!availableSectionIds.includes(s.id)) continue;

    const checked = includeAll ? true : (slideshowSelection.sectionIds || []).includes(s.id);

    const item = document.createElement("label");
    item.className = "show-picker-item";
    item.style.opacity = includeAll ? "0.6" : "1";
    item.style.pointerEvents = includeAll ? "none" : "auto";

    item.innerHTML = `
      <input type="checkbox" data-kind="section" data-id="${s.id}" ${checked ? "checked" : ""} ${includeAll ? "disabled" : ""} />
      <div class="label">
        <strong>${String(s.title || "Section").replaceAll("<", "&lt;")}</strong>
        <span>Section</span>
      </div>
    `;
    showPickerList.appendChild(item);
  }

  showPickerList.onchange = (e) => {
    const cb = e.target;
    if (!(cb instanceof HTMLInputElement)) return;

    const kind = cb.dataset.kind;

    if (kind === "gallery") {
      slideshowSelection.includeGallery = cb.checked;
      updateShowPickerSub();
      return;
    }

    if (kind === "allSections") {
      slideshowSelection.includeAllSections = cb.checked;
      if (cb.checked) slideshowSelection.sectionIds = [];
      renderShowPickerList();
      return;
    }

    if (kind === "section") {
      const sid = cb.dataset.id;
      if (!sid) return;

      slideshowSelection.includeAllSections = false;

      const set = new Set(slideshowSelection.sectionIds || []);
      if (cb.checked) set.add(sid);
      else set.delete(sid);
      slideshowSelection.sectionIds = [...set];

      updateShowPickerSub();
      return;
    }
  };

  updateShowPickerSub();
}

showPickerCancel?.addEventListener("click", closeShowPicker);

showPickerClear?.addEventListener("click", () => {
  slideshowSelection.includeGallery = false;
  slideshowSelection.includeAllSections = false;
  slideshowSelection.sectionIds = [];
  renderShowPickerList();
});

showPickerSelectAll?.addEventListener("click", () => {
  const { galleryAvailable, availableSectionIds } = getSlideshowAvailability();

  slideshowSelection.includeGallery = galleryAvailable;

  if (availableSectionIds.length >= 2) {
    slideshowSelection.includeAllSections = true;
    slideshowSelection.sectionIds = [];
  } else {
    slideshowSelection.includeAllSections = false;
    slideshowSelection.sectionIds = availableSectionIds.length === 1 ? [availableSectionIds[0]] : [];
  }

  renderShowPickerList();
});

showPickerApply?.addEventListener("click", () => {
  closeShowPicker();
  openShowFromSelection();
});

/* ---------- Shuffle UI (icône inversée) ---------- */

function syncShuffleUI() {
  if (!shuffleBtn) return;

  shuffleBtn.classList.toggle("active", useShuffle);
  shuffleBtn.setAttribute("aria-pressed", useShuffle ? "true" : "false");

  const img = shuffleBtn.querySelector("img");
  if (img) {
    img.src = useShuffle ? "../assets/img/icons/play.svg" : "../assets/img/icons/shuffle.svg";
  }

  shuffleBtn.title = useShuffle ? "Lecture dans l’ordre" : "Lecture aléatoire";
  shuffleBtn.setAttribute("aria-label", useShuffle ? "Lecture dans l’ordre" : "Lecture aléatoire");
}

/* ---------- Fullscreen slideshow + auto-hide controls ---------- */

let fsHoverTimer = null;

function isSlideshowFullscreen() {
  return getFullscreenElement() === slideshow || slideshowPseudoFullscreen;
}

function syncFullscreenUI() {
  const nativeActive = getFullscreenElement() === slideshow;
  if (nativeActive) slideshowPseudoFullscreen = false;
  const active = nativeActive || slideshowPseudoFullscreen;

  slideshow?.classList.toggle("fullscreen", active);
  if (active) slideshow?.classList.remove("show-controls");

  if (toggleFullscreenIcon && toggleFullscreenBtn) {
    toggleFullscreenIcon.src = active
      ? "../assets/img/icons/minimize.svg"
      : "../assets/img/icons/maximize.svg";

    const label = active ? "Quitter le plein écran" : "Plein écran";
    toggleFullscreenBtn.title = label;
    toggleFullscreenBtn.setAttribute("aria-label", label);
  }
}

async function enterFullscreen() {
  if (!slideshow) return;
  const ok = await requestNativeFullscreen(slideshow);
  slideshowPseudoFullscreen = !ok;
  syncFullscreenUI();
}

async function exitFullscreen() {
  if (getFullscreenElement()) {
    await exitNativeFullscreen();
  }
  slideshowPseudoFullscreen = false;
  syncFullscreenUI();
}

toggleFullscreenBtn?.addEventListener("click", () => {
  if (isSlideshowFullscreen()) exitFullscreen();
  else enterFullscreen();
});

slideshow?.addEventListener("mousemove", (e) => {
  if (!slideshow?.classList.contains("fullscreen")) return;

  const inTopZone = e.clientY <= 72;

  if (inTopZone) {
    if (slideshow.classList.contains("show-controls")) return;

    if (!fsHoverTimer) {
      fsHoverTimer = setTimeout(() => {
        slideshow.classList.add("show-controls");
        fsHoverTimer = null;
      }, 1200);
    }
  } else {
    if (fsHoverTimer) {
      clearTimeout(fsHoverTimer);
      fsHoverTimer = null;
    }
    slideshow.classList.remove("show-controls");
  }
});

slideshow?.addEventListener("touchstart", () => {
  if (!slideshow?.classList.contains("fullscreen")) return;

  if (fsHoverTimer) {
    clearTimeout(fsHoverTimer);
    fsHoverTimer = null;
  }

  slideshow.classList.add("show-controls");
  setTimeout(() => {
    if (slideshow?.classList.contains("fullscreen")) {
      slideshow.classList.remove("show-controls");
    }
  }, 2500);
});

/* ---------- Queue + navigation ---------- */

function rebuildBaseQueueFromSelection({ allowAutoPick = false } = {}) {
  normalizeSelectionToAvailability({ allowAutoPick });
  baseQueue = getQueueForSelection(slideshowSelection);
}

function restartFromBeginning() {
  rebuildBaseQueueFromSelection({ allowAutoPick: false });
  queue = useShuffle ? shuffle(baseQueue) : baseQueue.slice();
  idx = 0;
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
    if (useShuffle) queue = shuffle(baseQueue);
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
  togglePlayIcon.src = playing ? "../assets/img/icons/pause.svg" : "../assets/img/icons/play.svg";
}

/* ---------- Open/Close slideshow ---------- */

function openShowFromSelection() {
  rebuildBaseQueueFromSelection({ allowAutoPick: false });

  if (!baseQueue.length) {
    alert("Aucune photo dans la sélection. Coche la galerie et/ou des sections.");
    return;
  }

  useShuffle = false;
  syncShuffleUI();

  queue = baseQueue.slice();
  idx = 0;

  slideshow?.classList.add("open");
  playing = true;
  syncPlayIcon();
  showSlide();
  startAuto();
}

function openShowSmart() {
  const { totalSources, galleryAvailable, availableSectionIds } = getSlideshowAvailability();

  if (totalSources === 0) {
    alert("Ajoute d'abord quelques photos.");
    return;
  }

  if (totalSources === 1) {
    if (galleryAvailable) {
      slideshowSelection = { includeGallery: true, includeAllSections: false, sectionIds: [] };
    } else {
      slideshowSelection = {
        includeGallery: false,
        includeAllSections: false,
        sectionIds: [availableSectionIds[0]],
      };
    }

    rebuildBaseQueueFromSelection({ allowAutoPick: false });

    if (!baseQueue.length) {
      alert("Ajoute d'abord quelques photos.");
      return;
    }

    useShuffle = false;
    syncShuffleUI();

    queue = baseQueue.slice();
    idx = 0;

    slideshow?.classList.add("open");
    playing = true;
    syncPlayIcon();
    showSlide();
    startAuto();
    return;
  }

  openShowPicker();
}

function closeShow() {
  // ✅ si le diapo est en fullscreen, on sort d’abord du fullscreen
  if (isSlideshowFullscreen()) exitFullscreen();

  slideshow?.classList.remove("open");
  stopAuto();
}

/* ---------- Listeners ---------- */

showBtn?.addEventListener("click", openShowSmart);

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

  if (!slideshow?.classList.contains("open")) return;

  restartFromBeginning();
  showSlide();
  startAuto();
});

// Init
syncShuffleUI();
syncFullscreenUI();

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
  uploadCount.textContent = n === 0 ? "Aucun fichier" : n === 1 ? "1 fichier" : `${n} fichiers`;
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
  if (gridLayoutBtn) gridLayoutBtn.disabled = isUploading;
  if (uploadCancelBtn) uploadCancelBtn.disabled = isUploading;

  if (uploadStartBtn) uploadStartBtn.disabled = isUploading || pending.length === 0;

  if (uploadStartBtn) {
    setBtnLoading(uploadStartBtn, isUploading, { label: "Envoi…" });
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
    remove.className = "upload-remove upload-remove-compact";
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
    if (e.key === "Escape" && uploadCancelBtn && !uploadCancelBtn.disabled) uploadCancelBtn.click();
  }
});

/* -------------------- Main -------------------- */

async function main() {
  initGridLayout();
  await ensureAnonAuth();

  onSnapshot(query(collection(db, SECTIONS_COL), orderBy("order", "asc")), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
    // NOTE: plus de buildQueue() (ça n'existe pas dans ton fichier)
    if (slideshow?.classList.contains("open")) {
      restartFromBeginning();
      showSlide();
    }
  });

  onSnapshot(query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")), (snap) => {
    photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
    // NOTE: plus de buildQueue() (ça n'existe pas dans ton fichier)
    if (slideshow?.classList.contains("open")) {
      restartFromBeginning();
      showSlide();
    }
  });
}

main();
