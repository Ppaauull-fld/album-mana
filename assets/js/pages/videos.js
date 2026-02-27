import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo } from "../cloudinary.js";
import { createMediaInteractionPanel } from "../media-interactions.js";
import {
  setBtnLoading,
  initSectionJumpButton,
  initPullToRefreshGuard,
} from "../ui.js";

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

const ITEMS_COL = "videos";
const SECTIONS_COL = "videoSections";
const UNASSIGNED = "__unassigned__";
const FAVORITES = "__favorites__";
const FAVORITES_TITLE = "Favorites";
const HEART_STROKES_ICON = "../assets/img/icons/Heart%20strokes.svg";
const HEART_FILLED_ICON = "../assets/img/icons/Heart%20filled.svg";

const IS_COARSE_POINTER =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(pointer: coarse)").matches;
const LONG_PRESS_MS = IS_COARSE_POINTER ? 180 : 260;
const DRAG_START_PX = IS_COARSE_POINTER ? 10 : 8;
const TOUCH_DRAG_START_PX = IS_COARSE_POINTER ? 6 : DRAG_START_PX;
const AUTO_SCROLL_EDGE_PX = IS_COARSE_POINTER ? 190 : 110;
const AUTO_SCROLL_MAX_SPEED = IS_COARSE_POINTER ? 42 : 26;
const TOUCH_PLACE_BIAS_Y = IS_COARSE_POINTER ? 18 : 0;
const TOUCH_AXIS_LOCK_RATIO = 1.35;
const ROW_MERGE_TOLERANCE_RATIO = IS_COARSE_POINTER ? 0.62 : 0.45;
const ROW_VERTICAL_BAND_RATIO = IS_COARSE_POINTER ? 0.36 : 0.22;
const ROW_VERTICAL_BAND_MIN = IS_COARSE_POINTER ? 16 : 10;

const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("videoInput");
const addBtn = document.getElementById("addVideoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
const arrangeBtn = document.getElementById("arrangeBtn");
const gridLayoutBtn = document.getElementById("gridLayoutBtn");
const gridLayoutLabel = document.getElementById("gridLayoutLabel");
const actionsBar = document.querySelector(".actions");

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
const viewer = document.getElementById("videoViewer");
const viewerVideo = document.getElementById("viewerVideo");
const viewerDownload = document.getElementById("viewerDownload");
const viewerDelete = document.getElementById("viewerDelete");
const viewerClose = document.getElementById("viewerClose");
const viewerInteractions = createMediaInteractionPanel({
  modalEl: viewer,
  mediaType: "video",
});

let sections = [];
let items = []; // videos
let pending = []; // [{file, url}]
let currentViewed = null;
let viewerScrollY = 0;
let hasViewerScrollSnapshot = false;

let arranging = false;
let selectedItemIds = new Set();
let bulkDeleteBtn = null;
let arrangeContextBar = null;
let arrangeContextLabel = null;
let arrangeContextActions = null;
let arrangeContextDeleteBtn = null;
let arrangeContextDoneBtn = null;
const favoriteUpdatePendingIds = new Set();
let currentGridCols = 2;
let gridLayoutInitialized = false;
const GRID_CYCLE_ORDER = [2, 3, 4, 1];

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function snapshotViewerScroll() {
  viewerScrollY = Math.max(
    0,
    window.scrollY || window.pageYOffset || document.documentElement?.scrollTop || 0
  );
  hasViewerScrollSnapshot = true;
}

function restoreViewerScroll() {
  if (!hasViewerScrollSnapshot) return;
  const target = Math.max(0, viewerScrollY || 0);
  hasViewerScrollSnapshot = false;
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: target, behavior: "auto" });
  });
}

function edgeAutoScrollSpeed(coord, size, edge, maxSpeed) {
  if (coord < edge) {
    const strength = clamp(1 - coord / edge, 0, 1);
    return -(strength * strength * maxSpeed);
  }
  if (coord > size - edge) {
    const strength = clamp(1 - (size - coord) / edge, 0, 1);
    return strength * strength * maxSpeed;
  }
  return 0;
}

function resolveDragPlacementPoint(state) {
  if (!state || state.pointerType !== "touch") {
    return { x: state?.lastX ?? 0, y: state?.lastY ?? 0 };
  }

  const dx = state.lastX - state.startX;
  const dy = state.lastY - state.startY;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let x = state.lastX;
  let y = state.lastY + TOUCH_PLACE_BIAS_Y;

  if (absDy > absDx * TOUCH_AXIS_LOCK_RATIO) {
    x = state.startX;
  } else if (absDx > absDy * TOUCH_AXIS_LOCK_RATIO) {
    y = state.startY + TOUCH_PLACE_BIAS_Y;
  }

  return { x, y };
}

function compareFavoriteThenOrder(a, b) {
  const af = a?.favorite ? 1 : 0;
  const bf = b?.favorite ? 1 : 0;
  if (af !== bf) return bf - af;

  const ao = typeof a.order === "number" ? a.order : a.createdAt ?? 0;
  const bo = typeof b.order === "number" ? b.order : b.createdAt ?? 0;
  return ao - bo;
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

/* =========================
   Modal helpers (existing modals)
   ========================= */
function openModal(el) {
  if (!el) return;
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeModal(el) {
  if (!el) return;
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

/* =========================
   uiModal (confirm/prompt) — même UX que photos
   ========================= */
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
  if (!modal) {
    console.error("uiModal introuvable dans le DOM");
    return;
  }
  modal.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeUiModal() {
  const { modal } = getUiModalEls();
  modal.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function uiConfirm(message, opts = {}) {
  const { modal, title, msg, ok, cancel, fieldWrap } = getUiModalEls();

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

  title.textContent = opts.title || "Saisie";
  msg.textContent = message || "";

  fieldWrap.style.display = "";
  input.value = opts.defaultValue || "";
  input.placeholder = opts.placeholder || "";

  ok.textContent = opts.okText || "OK";
  cancel.textContent = opts.cancelText || "Annuler";

  ok.classList.remove("danger");

  openUiModal();
  setTimeout(() => input.focus(), 10);

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      closeUiModal();
    };

    const onOk = () => {
      const val = (input.value || "").trim();
      cleanup();
      resolve(val || null);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
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

/* =========================
   Upload button state
   ========================= */
function setUploadingState(isUploading) {
  addBtn.disabled = isUploading;
  addSectionBtn && (addSectionBtn.disabled = isUploading);
  arrangeBtn && (arrangeBtn.disabled = isUploading);
  gridLayoutBtn && (gridLayoutBtn.disabled = isUploading);

  uploadCancelBtn.disabled = isUploading;
  uploadStartBtn.disabled = isUploading || pending.length === 0;

  setBtnLoading(uploadStartBtn, isUploading, { label: "Envoi…" });
}

function fmtCount() {
  const n = pending.length;
  uploadCount.textContent = n === 0 ? "Aucun fichier" : n === 1 ? "1 fichier" : `${n} fichiers`;
}

function resetProgressUI() {
  uploadProgressBar.value = 0;
  uploadProgressText.textContent = "0 / 0";
  uploadProgressDetail.textContent = "—";
}

/* =========================
   File helpers
   ========================= */
function isVideo(file) {
  return file?.type?.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file?.name || "");
}

/** Poster Cloudinary (frame jpg) */
function cloudinaryVideoPoster(videoUrl) {
  try {
    if (!videoUrl || !videoUrl.includes("/video/upload/")) return null;
    const withTransform = videoUrl.replace("/upload/", "/upload/so_0/");
    return withTransform.replace(/\.[a-z0-9]+(\?.*)?$/i, ".jpg");
  } catch {
    return null;
  }
}

function fallbackPosterDataUri() {
  return (
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
        <rect width="100%" height="100%" fill="#111"/>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(255,255,255,0.04)"/>
      </svg>
    `)
  );
}

function cleanupPendingUrls() {
  for (const p of pending) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }
}

/* =========================
   Play badge
   ========================= */
function makePlayBadge() {
  const badge = document.createElement("div");
  badge.className = "play-badge";

  const icon = document.createElement("img");
  icon.className = "icon-img";
  icon.src = "../assets/img/icons/play.svg";
  icon.alt = "";

  badge.appendChild(icon);
  return badge;
}

/* =========================
   Arrange mode
   ========================= */
function ensureArrangeLabelSpan() {
  if (!arrangeBtn) return null;

  let label = arrangeBtn.querySelector("[data-arrange-label]");
  if (label) return label;

  label = document.createElement("span");
  label.setAttribute("data-arrange-label", "");
  label.textContent = arrangeBtn.textContent?.trim?.() || "Arranger";
  arrangeBtn.textContent = "";
  arrangeBtn.appendChild(label);
  return label;
}

function setArranging(on) {
  arranging = !!on;

  document.body.classList.add("page");
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
    cancelSectionResize();
    setSelectedIds([]);
  }

  syncBulkDeleteBtn();
  syncArrangeContextBar();
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* =========================
   Fullscreen section
   ========================= */
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

  const card = sectionsWrap.querySelector(`.section-card[data-section-card-id="${sectionId}"]`);
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
    const card = document.querySelector(`.section-card[data-section-card-id="${fullscreenSectionId}"]`);
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

  if (sectionBackdropEl && sectionBackdropEl.parentElement) sectionBackdropEl.remove();

  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");

  window.removeEventListener("keydown", onFullscreenKeydown);
}

/* =========================
   Delete section (unassign items)
   ========================= */
async function deleteSectionAndUnassignItems(sectionId) {
  if (!sectionId || sectionId === UNASSIGNED) return;

  const ok = await uiConfirm(
    "Supprimer cette section ? Les vidéos resteront dans la galerie (non supprimées).",
    { title: "Supprimer la section", danger: true, okText: "Supprimer" }
  );
  if (!ok) return;

  try {
    const q = query(collection(db, ITEMS_COL), where("sectionId", "==", sectionId));
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

/* =========================
   Grouping + render
   ========================= */
function groupItems() {
  const grouped = new Map();
  grouped.set(UNASSIGNED, []);
  grouped.set(FAVORITES, []);
  for (const s of sections) grouped.set(s.id, []);

  for (const it of items) {
    const sid = it.sectionId;
    if (!sid || !grouped.has(sid)) grouped.get(UNASSIGNED).push(it);
    else grouped.get(sid).push(it);

    if (it?.favorite) grouped.get(FAVORITES).push(it);
  }

  for (const arr of grouped.values()) {
    arr.sort(compareFavoriteThenOrder);
  }

  return grouped;
}

function bestThumb(it) {
  const poster = it.thumbUrl || cloudinaryVideoPoster(it.url);
  return poster || fallbackPosterDataUri();
}

function renderItemCard(it) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card card-btn";
  card.title = "Lire";
  card.dataset.id = it.id;
  const isSelected = selectedItemIds.has(it.id);
  card.classList.toggle("is-selected", isSelected);
  card.setAttribute("aria-pressed", isSelected ? "true" : "false");

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = bestThumb(it);
  img.alt = "vidéo";

  const fav = document.createElement("span");
  fav.className = "card-favorite-toggle";
  fav.dataset.favToggle = "1";

  const favIcon = document.createElement("img");
  favIcon.className = "card-favorite-icon";
  favIcon.alt = "";
  favIcon.setAttribute("aria-hidden", "true");
  fav.appendChild(favIcon);

  const syncFavUi = (isFavorite) => {
    fav.classList.toggle("is-favorite", isFavorite);
    fav.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    favIcon.src = isFavorite ? HEART_FILLED_ICON : HEART_STROKES_ICON;
    const label = isFavorite ? "Retirer des favoris" : "Ajouter aux favoris";
    fav.setAttribute("aria-label", label);
    fav.title = label;
  };
  syncFavUi(!!it.favorite);

  const toggleFavorite = async () => {
    if (!it?.id) return;
    if (favoriteUpdatePendingIds.has(it.id)) return;

    const previous = !!it.favorite;
    const next = !previous;

    favoriteUpdatePendingIds.add(it.id);
    it.favorite = next;
    renderAll();

    try {
      await updateDoc(doc(db, ITEMS_COL, it.id), { favorite: next });
    } catch (e) {
      it.favorite = previous;
      renderAll();
      alert("Impossible de mettre a jour le favori.");
      console.error(e);
    } finally {
      favoriteUpdatePendingIds.delete(it.id);
    }
  };

  fav.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite();
  });

  card.appendChild(img);
  card.appendChild(fav);
  card.appendChild(makePlayBadge());

  card.addEventListener("click", () => {
    if (arranging) return;
    openViewer(it);
  });

  return card;
}

function selectedCount() {
  return selectedItemIds.size;
}

function ensureArrangeContextBar() {
  if (arrangeContextBar) return arrangeContextBar;

  const bar = document.createElement("div");
  bar.className = "arrange-context-bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Actions du mode arrangement");
  bar.setAttribute("aria-hidden", "true");

  const label = document.createElement("div");
  label.className = "arrange-context-label";
  label.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "arrange-context-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn danger arrange-context-delete";
  deleteBtn.style.display = "none";
  deleteBtn.addEventListener("click", () => {
    if (deleteBtn.disabled) return;
    void deleteSelectedItems();
  });

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "btn primary arrange-context-done";
  doneBtn.textContent = "Terminer";
  doneBtn.addEventListener("click", () => setArranging(false));

  actions.appendChild(deleteBtn);
  actions.appendChild(doneBtn);
  bar.appendChild(label);
  bar.appendChild(actions);
  document.body.appendChild(bar);

  arrangeContextBar = bar;
  arrangeContextLabel = label;
  arrangeContextActions = actions;
  arrangeContextDeleteBtn = deleteBtn;
  arrangeContextDoneBtn = doneBtn;
  return arrangeContextBar;
}

function syncArrangeContextBar() {
  if (!arranging && !arrangeContextBar) {
    document.body.classList.remove("arrange-context-open");
    return;
  }

  const bar = ensureArrangeContextBar();
  if (!bar) return;

  const n = selectedCount();
  const visible = arranging;
  const hasSelection = n > 0;

  bar.classList.toggle("open", visible);
  bar.setAttribute("aria-hidden", visible ? "false" : "true");
  document.body.classList.toggle("arrange-context-open", visible);

  if (arrangeContextLabel) {
    arrangeContextLabel.textContent =
      n <= 0 ? "Mode arrangement actif" : n === 1 ? "1 video selectionnee" : `${n} videos selectionnees`;
  }

  if (arrangeContextActions) {
    arrangeContextActions.classList.toggle("has-selection", hasSelection);
  }

  if (arrangeContextDeleteBtn) {
    arrangeContextDeleteBtn.style.display = hasSelection ? "inline-flex" : "none";
    arrangeContextDeleteBtn.disabled = !hasSelection;
    arrangeContextDeleteBtn.textContent =
      n <= 1 ? "Supprimer la selection" : `Supprimer ${n} videos`;
  }

  if (arrangeContextDoneBtn) {
    arrangeContextDoneBtn.disabled = !visible;
  }
}

function ensureBulkDeleteBtn() {
  if (bulkDeleteBtn) return bulkDeleteBtn;
  if (!actionsBar) return null;

  bulkDeleteBtn = document.createElement("button");
  bulkDeleteBtn.type = "button";
  bulkDeleteBtn.className = "btn danger";
  bulkDeleteBtn.style.display = "none";
  bulkDeleteBtn.addEventListener("click", deleteSelectedItems);
  actionsBar.appendChild(bulkDeleteBtn);
  return bulkDeleteBtn;
}

function syncBulkDeleteBtn() {
  const btn = ensureBulkDeleteBtn();
  if (!btn) {
    syncArrangeContextBar();
    return;
  }
  const n = selectedCount();
  const visible = arranging && n > 0;
  btn.style.display = visible ? "inline-flex" : "none";
  btn.disabled = !visible;
  btn.textContent = n <= 1 ? "Supprimer la selection" : `Supprimer ${n} videos`;
  syncArrangeContextBar();
}

function syncSelectedCardsUi() {
  sectionsWrap?.querySelectorAll(".card-btn[data-id]").forEach((el) => {
    const id = el.dataset.id;
    const selected = !!id && selectedItemIds.has(id);
    el.classList.toggle("is-selected", selected);
    el.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function setSelectedIds(ids) {
  selectedItemIds = new Set(ids || []);
  syncSelectedCardsUi();
  syncBulkDeleteBtn();
}

function toggleItemSelection(id) {
  if (!id) return;
  const next = new Set(selectedItemIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  setSelectedIds(next);
}

function pruneSelectionAgainstData() {
  const available = new Set(items.map((it) => it.id));
  const next = new Set();
  for (const id of selectedItemIds) {
    if (available.has(id)) next.add(id);
  }
  selectedItemIds = next;
}

async function deleteSelectedItems() {
  const ids = [...selectedItemIds];
  if (!ids.length) return;

  const n = ids.length;
  const ok = await uiConfirm(
    n === 1
      ? "Supprimer 1 video selectionnee de la galerie ?"
      : `Supprimer ${n} videos selectionnees de la galerie ?`,
    {
      title: "Supprimer des videos",
      danger: true,
      okText: n === 1 ? "Supprimer la video" : `Supprimer ${n} videos`,
      cancelText: "Annuler",
    }
  );
  if (!ok) return;

  const btn = ensureBulkDeleteBtn();
  if (btn) btn.disabled = true;

  try {
    const batch = writeBatch(db);
    for (const id of ids) batch.delete(doc(db, ITEMS_COL, id));
    await batch.commit();
    setSelectedIds([]);
  } catch (e) {
    console.error(e);
    alert("Suppression multiple impossible.");
  } finally {
    syncBulkDeleteBtn();
  }
}

function renderSectionCard({ id, title, editable, hideTitle, staticSection = false }, itemsInSection) {
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

  if (editable && !staticSection) {
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

  if (!staticSection) head.appendChild(move);
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

  if (!staticSection && id !== UNASSIGNED && id !== FAVORITES) {
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
      deleteSectionAndUnassignItems(id);
    });
    actions.appendChild(delBtn);
  }

  head.appendChild(actions);

  const grid = document.createElement("div");
  grid.className = "section-grid";
  grid.dataset.sectionId = id;

  for (const it of itemsInSection) grid.appendChild(renderItemCard(it));

  card.appendChild(head);
  card.appendChild(grid);

  return card;
}

function renderAll() {
  if (!sectionsWrap) return;
  pruneSelectionAgainstData();

  const grouped = groupItems();
  sectionsWrap.innerHTML = "";

  // unassigned (galerie)
  sectionsWrap.appendChild(
    renderSectionCard({ id: UNASSIGNED, title: "", editable: false, hideTitle: true }, grouped.get(UNASSIGNED) || [])
  );

  const favoritesItems = grouped.get(FAVORITES) || [];
  if (favoritesItems.length > 0) {
    sectionsWrap.appendChild(
      renderSectionCard(
        { id: FAVORITES, title: FAVORITES_TITLE, editable: false, hideTitle: false, staticSection: true },
        favoritesItems
      )
    );
  }

  // sections
  for (const s of sections) {
    sectionsWrap.appendChild(
      renderSectionCard({ id: s.id, title: s.title || "Section", editable: true, hideTitle: false }, grouped.get(s.id) || [])
    );
  }

  syncSelectedCardsUi();
  syncBulkDeleteBtn();
}

/* =========================
   FLIP helper (items)
   ========================= */
function getRects(container) {
  const map = new Map();
  const nodes = [...container.querySelectorAll(".card-btn")];
  for (const el of nodes) map.set(el, el.getBoundingClientRect());
  return map;
}

function animateFLIP(container, before) {
  if (!container || !before) return;

  const nodes = [...container.querySelectorAll(".card-btn")];
  for (const el of nodes) {
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

/* =========================
   Drag ITEMS (pointer + long-press)
   ========================= */
let drag = null;
let autoScrollRaf = null;

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

    const H = window.innerHeight;
    const y = drag.lastY;
    const vy = edgeAutoScrollSpeed(y, H, AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_SPEED);

    if (vy) {
      window.scrollBy(0, vy);

      const placementPoint = resolveDragPlacementPoint(drag);
      const grid =
        gridFromPoint(placementPoint.x, placementPoint.y) ||
        gridFromPoint(drag.lastX, drag.lastY) ||
        drag.srcGrid;
      if (grid && drag.placeholderEl) {
        if (drag.placeholderEl.parentElement !== grid) {
          grid.appendChild(drag.placeholderEl);
        }
        placePlaceholder(
          grid,
          drag.placeholderEl,
          placementPoint.x,
          placementPoint.y,
          drag.draggedIdsSet
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
  const grid = el?.closest?.(".section-grid") || null;
  if (grid?.dataset.sectionId === FAVORITES) return null;
  return grid;
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
      };
    })
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);

  const rows = [];
  for (const it of items) {
    const prev = rows[rows.length - 1];
    if (!prev) {
      rows.push({
        top: it.r.top,
        bottom: it.r.bottom,
        items: [it],
      });
      continue;
    }

    const prevHeight = Math.max(1, prev.bottom - prev.top);
    const tol = Math.max(12, Math.min(prevHeight, it.r.height) * ROW_MERGE_TOLERANCE_RATIO);
    if (Math.abs(it.r.top - prev.top) <= tol) {
      prev.top = Math.min(prev.top, it.r.top);
      prev.bottom = Math.max(prev.bottom, it.r.bottom);
      prev.items.push(it);
    } else {
      rows.push({
        top: it.r.top,
        bottom: it.r.bottom,
        items: [it],
      });
    }
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.r.left - b.r.left);
  }

  let rowIndex = rows.findIndex((row) => y <= row.bottom);
  if (rowIndex === -1) rowIndex = rows.length - 1;

  const row = rows[rowIndex];
  const nextRowFirst = rows[rowIndex + 1]?.items?.[0]?.el || null;

  let beforeEl = null;

  if (y < row.top) {
    beforeEl = row.items[0].el;
  } else {
    const rowMid = (row.top + row.bottom) / 2;
    const verticalBand = Math.max(
      ROW_VERTICAL_BAND_MIN,
      (row.bottom - row.top) * ROW_VERTICAL_BAND_RATIO
    );

    if (Math.abs(y - rowMid) > verticalBand) {
      beforeEl = y < rowMid ? row.items[0].el : nextRowFirst;
    } else {
      for (const it of row.items) {
        if (x < it.cx) {
          beforeEl = it.el;
          break;
        }
      }
      if (!beforeEl) beforeEl = nextRowFirst;
    }
  }

  const alreadyPlaced =
    placeholderEl.parentElement === gridEl &&
    ((!beforeEl && gridEl.lastElementChild === placeholderEl) ||
      (beforeEl && beforeEl.previousElementSibling === placeholderEl));
  if (alreadyPlaced) return;

  const beforeRects = getRects(gridEl);

  if (!beforeEl) gridEl.appendChild(placeholderEl);
  else gridEl.insertBefore(placeholderEl, beforeEl);

  animateFLIP(gridEl, beforeRects);
}

function onPointerDown(e) {
  if (!arranging) return;
  if (sectionDrag) return;
  if (e.target?.closest?.('[data-fav-toggle="1"]')) return;

  const cardEl = e.target.closest?.(".card-btn");
  if (!cardEl) return;

  if ((e.pointerType || "mouse") !== "touch") e.preventDefault();

  const id = cardEl.dataset.id;
  const srcGrid = cardEl.closest(".section-grid");
  if (!srcGrid) return;
  if ((srcGrid.dataset.sectionId || UNASSIGNED) === FAVORITES) return;

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
    selectedItemIds.has(drag.id) && selectedItemIds.size > 0
      ? [...selectedItemIds]
      : [drag.id];
  drag.draggedIds = [...new Set(selectedIdsForDrag)];
  drag.draggedIdsSet = new Set(drag.draggedIds);

  if (!selectedItemIds.has(drag.id) || selectedItemIds.size <= 1) {
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

  const placementPoint = resolveDragPlacementPoint(drag);
  placePlaceholder(
    drag.srcGrid,
    drag.placeholderEl,
    placementPoint.x,
    placementPoint.y,
    drag.draggedIdsSet
  );

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
    if (Math.hypot(dx, dy) >= TOUCH_DRAG_START_PX) {
      if (drag.pressTimer) {
        clearTimeout(drag.pressTimer);
        drag.pressTimer = null;
      }
      const cardEl = sectionsWrap?.querySelector(`.card-btn[data-id="${drag.id}"]`);
      if (cardEl) startDrag(cardEl);
    } else {
      return;
    }
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
  if (drag.pointerType === "touch") e.preventDefault();

  const x = drag.lastX - drag.offsetX;
  const y = drag.lastY - drag.offsetY;
  drag.ghostEl.style.left = `${x}px`;
  drag.ghostEl.style.top = `${y}px`;

  startAutoScroll();

  const placementPoint = resolveDragPlacementPoint(drag);
  const grid =
    gridFromPoint(placementPoint.x, placementPoint.y) ||
    gridFromPoint(drag.lastX, drag.lastY) ||
    drag.srcGrid;
  if (!grid) return;

  const oldParent = drag.placeholderEl.parentElement;
  if (oldParent !== grid) {
    const beforeOld = oldParent ? getRects(oldParent) : null;
    const beforeNew = getRects(grid);

    grid.appendChild(drag.placeholderEl);

    animateFLIP(oldParent, beforeOld);
    animateFLIP(grid, beforeNew);
  }

  placePlaceholder(
    grid,
    drag.placeholderEl,
    placementPoint.x,
    placementPoint.y,
    drag.draggedIdsSet
  );
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
    if (child.classList?.contains("card-btn") && !child.classList.contains("dragging")) dropIndex++;
  }

  const movedIds = [...(state.draggedIds || [state.id])];
  const movedSet = new Set(movedIds);

  const grouped = groupItems();
  const targetList = (grouped.get(targetSectionId) || []).filter((p) => !movedSet.has(p.id));
  const movedList = items
    .filter((it) => movedSet.has(it.id))
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
    batch.update(doc(db, ITEMS_COL, finalList[i].id), {
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
    toggleItemSelection(state.id);
  }
  if (!wasStarted) return;

  if (placeholder && placeholder.parentElement) {
    finalizeDrop(state)
      .catch((err) => {
        console.error(err);
        alert("Impossible de déplacer la vidéo.");
      })
      .finally(() => {
        try { placeholder.remove(); } catch {}
      });
  }
}

/* =========================
   Drag SECTIONS (poignée ⋮⋮)
   ========================= */
let sectionDrag = null;
let autoScrollSectionRaf = null;

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

    const H = window.innerHeight;
    const y = sectionDrag.lastY;
    const vy = edgeAutoScrollSpeed(y, H, AUTO_SCROLL_EDGE_PX, AUTO_SCROLL_MAX_SPEED);

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

  const original = sectionsWrap?.querySelector(`.section-card[data-section-card-id="${sectionDrag.id}"]`);
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
  const rect = sectionEl.getBoundingClientRect();
  ph.style.height = `${rect.height}px`;
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
    if (sid === FAVORITES) return false;
    if (sid === draggedId) return false;
    return true;
  });

  if (!cards.length) {
    if (galleryEl?.nextSibling) wrap.insertBefore(placeholderEl, galleryEl.nextSibling);
    else wrap.appendChild(placeholderEl);
    return;
  }

  const itemsInfo = cards
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, midY: r.top + r.height / 2 };
    })
    .sort((a, b) => a.midY - b.midY);

  let beforeEl = null;
  for (const it of itemsInfo) {
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
  if (!id || id === UNASSIGNED || id === FAVORITES) return;

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

    const sectionEl = sectionsWrap?.querySelector(`.section-card[data-section-card-id="${sectionDrag.id}"]`);
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
    .filter((sid) => sid && sid !== UNASSIGNED && sid !== FAVORITES);

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

    try { placeholder.remove(); } catch {}

    finalizeSectionDropAndPersist(wrap).catch((err) => {
      console.error(err);
      alert("Impossible de réordonner les sections.");
    });
  }
}

function cancelSectionResize() {
  // no-op (compat)
}

/* =========================
   Pointer listeners
   ========================= */
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

/* =========================
   Viewer
   ========================= */
function openViewer(v) {
  snapshotViewerScroll();
  currentViewed = v;

  try { viewerVideo.pause(); } catch {}
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  viewerVideo.src = v.url;
  viewerVideo.playsInline = true;
  viewerVideo.controls = true;
  viewerVideo.load();

  viewerDownload.href = v.url;
  viewerDownload.setAttribute("download", `video-${v.id}.mp4`);

  openModal(viewer);
  void viewerInteractions.openForMedia(currentViewed);

  setTimeout(() => {
    viewerVideo.play().catch(() => {});
  }, 60);
}

function closeViewer() {
  try { viewerVideo.pause(); } catch {}
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  viewerInteractions.close();
  currentViewed = null;
  closeModal(viewer);
  restoreViewerScroll();
}

viewerClose?.addEventListener("click", closeViewer);

viewer?.addEventListener("click", (e) => {
  if (e.target === viewer) closeViewer();
});

viewerDelete?.addEventListener("click", async () => {
  if (!currentViewed) return;

  const ok = await uiConfirm("Supprimer cette vidéo de la galerie ?", {
    title: "Supprimer",
    danger: true,
    okText: "Supprimer",
  });
  if (!ok) return;

  try {
    viewerDelete.disabled = true;
    await deleteDoc(doc(db, ITEMS_COL, currentViewed.id));
    closeViewer();
  } catch (e) {
    alert("Suppression impossible : " + (e?.message || e));
  } finally {
    viewerDelete.disabled = false;
  }
});

/* =========================
   Upload modal
   ========================= */
function renderPending() {
  uploadPreviewGrid.innerHTML = "";
  fmtCount();

  if (!pending.length) {
    const empty = document.createElement("div");
    empty.className = "upload-empty";
    empty.textContent = "Sélectionne des vidéos pour les prévisualiser ici.";
    uploadPreviewGrid.appendChild(empty);
    uploadStartBtn.disabled = true;
    return;
  }

  for (let i = 0; i < pending.length; i++) {
    const { file, url } = pending[i];

    const item = document.createElement("div");
    item.className = "upload-item";

    const vid = document.createElement("video");
    vid.className = "upload-thumb upload-thumb-video";
    vid.src = url;
    vid.muted = true;
    vid.playsInline = true;
    vid.loop = true;
    vid.preload = "metadata";

    vid.addEventListener("loadeddata", () => {
      vid.play().catch(() => {});
    });

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
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      try { URL.revokeObjectURL(pending[i].url); } catch {}
      pending.splice(i, 1);
      renderPending();
      setUploadingState(false);
    });

    item.appendChild(vid);
    item.appendChild(meta);
    item.appendChild(remove);
    uploadPreviewGrid.appendChild(item);
  }

  uploadStartBtn.disabled = false;
}

addBtn?.addEventListener("click", () => input.click());

input?.addEventListener("change", () => {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;

  cleanupPendingUrls();
  pending = files.filter(isVideo).map((file) => ({ file, url: URL.createObjectURL(file) }));

  resetProgressUI();
  renderPending();
  setUploadingState(false);
  openModal(uploadModal);
});

uploadCancelBtn?.addEventListener("click", () => {
  if (uploadCancelBtn.disabled) return;

  cleanupPendingUrls();
  pending = [];
  resetProgressUI();
  closeModal(uploadModal);
});

uploadStartBtn?.addEventListener("click", async () => {
  if (!pending.length) return;

  setUploadingState(true);
  resetProgressUI();

  const total = pending.length;
  let done = 0;

  const updateOverall = (ratio, name) => {
    const overall = Math.max(0, Math.min(1, (done + ratio) / total));
    uploadProgressBar.value = Math.round(overall * 100);
    uploadProgressText.textContent = `${done} / ${total}`;
    uploadProgressDetail.textContent = name
      ? `Envoi de ${name} — ${Math.round(ratio * 100)}%`
      : "—";
  };

  try {
    for (const { file } of pending) {
      updateOverall(0, file.name);

      const up = await uploadVideo(file, { onProgress: (r) => updateOverall(r, file.name) });

      const url = up.secure_url;
      const thumbUrl = cloudinaryVideoPoster(url) || url;

      await addDoc(collection(db, ITEMS_COL), {
        createdAt: Date.now(),
        order: Date.now(),
        sectionId: null,
        favorite: false,
        publicId: up.public_id,
        url,
        thumbUrl,
      });

      done++;
      uploadProgressText.textContent = `${done} / ${total}`;
      uploadProgressBar.value = Math.round((done / total) * 100);
      uploadProgressDetail.textContent = `Envoyé : ${file.name}`;
    }

    cleanupPendingUrls();
    pending = [];

    uploadProgressDetail.textContent = "Terminé.";
    setTimeout(() => {
      closeModal(uploadModal);
      resetProgressUI();
      setUploadingState(false);
    }, 450);
  } catch (e) {
    setUploadingState(false);
    alert("Erreur upload : " + (e?.message || e));
  }
});

/* =========================
   Sections: create
   ========================= */
addSectionBtn?.addEventListener("click", async () => {
  const title = await uiPrompt("Titre de la section ?", {
    title: "Nouvelle section",
    placeholder: "Ex: Été 2018",
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

/* =========================
   Keyboard
   ========================= */
document.addEventListener("keydown", (e) => {
  if (viewer?.classList.contains("open")) {
    if (e.key === "Escape") closeViewer();
    return;
  }
  if (uploadModal?.classList.contains("open")) {
    if (e.key === "Escape" && !uploadCancelBtn.disabled) uploadCancelBtn.click();
  }
});

/* =========================
   Firestore realtime
   ========================= */
initPullToRefreshGuard();
initSectionJumpButton({
  sectionsEl: sectionsWrap,
  downIconSrc: "../assets/img/icons/Arrow%20down.svg",
  upIconSrc: "../assets/img/icons/Arrow%20up.svg",
});

async function main() {
  initGridLayout();
  await ensureAnonAuth();

  onSnapshot(query(collection(db, SECTIONS_COL), orderBy("order", "asc")), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });

  onSnapshot(query(collection(db, ITEMS_COL), orderBy("createdAt", "desc")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
}

main();
