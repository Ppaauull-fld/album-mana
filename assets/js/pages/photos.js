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

// 👉 Conteneurs utiles pour le fit rotation
const viewerBoxEl = viewer?.querySelector(".viewer-box") || null;
const viewerWrapEl = viewer?.querySelector(".viewer-wrap") || null;
const slideshowImgWrapEl = slideshow?.querySelector(".imgwrap") || null;

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

/**
 * ✅ Rotation qui FIT automatiquement dans le conteneur (rotation + scale)
 * boxEl = conteneur qui doit contenir l'image (viewer-wrap / imgwrap)
 */
function fitRotatedInBox(imgEl, boxEl, deg) {
  if (!imgEl || !boxEl) return;

  const rot = clampRotation(deg || 0);

  const bw = boxEl.clientWidth;
  const bh = boxEl.clientHeight;
  if (!bw || !bh) return;

  // naturalWidth/Height si possible
  const iw = imgEl.naturalWidth || imgEl.clientWidth || 1;
  const ih = imgEl.naturalHeight || imgEl.clientHeight || 1;

  const rotated = rot === 90 || rot === 270;

  // Dimensions "effectives" après rotation
  const effW = rotated ? ih : iw;
  const effH = rotated ? iw : ih;

  // scale pour tenir dans le conteneur
  const scale = Math.min(bw / effW, bh / effH);

  imgEl.style.transformOrigin = "center center";
  imgEl.style.transform = `rotate(${rot}deg) scale(${scale})`;
}

/**
 * Wrapper pratique : applique le fit après load, et si déjà chargé => immediate
 */
function applyRotationFitted(imgEl, deg, boxEl) {
  if (!imgEl) return;

  const onLoad = () => fitRotatedInBox(imgEl, boxEl, deg);
  imgEl.addEventListener("load", onLoad, { once: true });

  if (imgEl.complete) {
    fitRotatedInBox(imgEl, boxEl, deg);
  }
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
    cloudinaryWithTransform(p.thumbUrl || p.url, "f_auto,q_auto,c_fill,w_600,h_600")
  );
}

function bestFull(p) {
  return cloudinaryFromPublicId(p.publicId, "f_auto,q_auto") || cloudinaryWithTransform(p.url, "f_auto,q_auto");
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
    const q = query(collection(db, PHOTOS_COL), where("sectionId", "==", sectionId));
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
    <img class="icon-img" data-maximize-icon src="../assets/img/icons/maximize.svg" alt="" aria-hidden="true" />
    <span class="sr-only">Agrandir</span>
  `;

  // (tu gardes ta logique section fullscreen ici si tu veux, je ne la réécris pas)
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
        { id: s.id, title: s.title || "Section", editable: true, hideTitle: false },
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
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* -------------------- Viewer -------------------- */

// ✅ IMPORTANT: fullscreen sur la box (pas le backdrop du modal)
function isViewerFullscreen() {
  return document.fullscreenElement === viewerBoxEl;
}

async function enterViewerFullscreen() {
  if (!viewerBoxEl?.requestFullscreen) return;
  try {
    await viewerBoxEl.requestFullscreen();
  } catch {}
}

async function exitViewerFullscreen() {
  if (!document.fullscreenElement) return;
  try {
    await document.exitFullscreen();
  } catch {}
}

function syncViewerFullscreenUI() {
  const active = isViewerFullscreen();

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

  // ✅ refit après changement
  if (viewer?.classList.contains("open") && currentViewed && viewerImg && viewerWrapEl) {
    fitRotatedInBox(viewerImg, viewerWrapEl, currentViewed.rotation || 0);
  }
}

function openViewer(photo) {
  currentViewed = { ...photo };

  if (viewerTitle) viewerTitle.textContent = "Photo";

  if (viewerImg) {
    viewerImg.src = bestFull(photo);
    // ✅ rotation + fit (évite que ça recouvre le bandeau)
    applyRotationFitted(viewerImg, photo.rotation || 0, viewerWrapEl);
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
  if (isViewerFullscreen()) exitViewerFullscreen();

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

  // ✅ rotation + fit (le cœur du fix)
  applyRotationFitted(viewerImg, newRot, viewerWrapEl);

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

/* -------------------- Slideshow (picker + queue + fullscreen) -------------------- */

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

/* ---------- Shuffle UI ---------- */

function syncShuffleUI() {
  if (!shuffleBtn) return;

  shuffleBtn.classList.toggle("active", useShuffle);
  shuffleBtn.setAttribute("aria-pressed", useShuffle ? "true" : "false");

  const img = shuffleBtn.querySelector("img");
  if (img) img.src = useShuffle ? "../assets/img/icons/play.svg" : "../assets/img/icons/shuffle.svg";

  shuffleBtn.title = useShuffle ? "Lecture dans l’ordre" : "Lecture aléatoire";
  shuffleBtn.setAttribute("aria-label", useShuffle ? "Lecture dans l’ordre" : "Lecture aléatoire");
}

/* ---------- Fullscreen slideshow ---------- */

let fsHoverTimer = null;

function isSlideshowFullscreen() {
  return document.fullscreenElement === slideshow;
}

function syncFullscreenUI() {
  const active = isSlideshowFullscreen();

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

  // ✅ refit slide image après fullscreen
  if (slideshow?.classList.contains("open") && queue.length && slideImg && slideshowImgWrapEl) {
    const s = queue[idx];
    if (s) fitRotatedInBox(slideImg, slideshowImgWrapEl, s.rotation || 0);
  }
}

async function enterFullscreen() {
  if (!slideshow?.requestFullscreen) return;
  try {
    await slideshow.requestFullscreen();
  } catch {}
}

async function exitFullscreen() {
  if (!document.fullscreenElement) return;
  try {
    await document.exitFullscreen();
  } catch {}
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
    // ✅ rotation + fit
    applyRotationFitted(slideImg, s.rotation || 0, slideshowImgWrapEl);
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
      slideshowSelection = { includeGallery: false, includeAllSections: false, sectionIds: [availableSectionIds[0]] };
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

// ✅ UN seul fullscreenchange pour tout
document.addEventListener("fullscreenchange", () => {
  syncViewerFullscreenUI();
  syncFullscreenUI();
});

// ✅ refit au resize (viewer + slideshow)
window.addEventListener("resize", () => {
  if (viewer?.classList.contains("open") && currentViewed && viewerImg && viewerWrapEl) {
    fitRotatedInBox(viewerImg, viewerWrapEl, currentViewed.rotation || 0);
  }
  if (slideshow?.classList.contains("open") && queue.length && slideImg && slideshowImgWrapEl) {
    const s = queue[idx];
    if (s) fitRotatedInBox(slideImg, slideshowImgWrapEl, s.rotation || 0);
  }
});

// Init UI
syncShuffleUI();
syncFullscreenUI();
syncViewerFullscreenUI();

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
  if (uploadCancelBtn) uploadCancelBtn.disabled = isUploading;

  if (uploadStartBtn) uploadStartBtn.disabled = isUploading || pending.length === 0;

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

  if (uploadStartBtn) uploadStartBtn.disabled = false;
}

addBtn?.addEventListener("click", () => input?.click());

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
    const overall = clamp((done + currentRatio) / total, 0, 1);
    if (uploadProgressBar) uploadProgressBar.value = Math.round(overall * 100);
    if (uploadProgressText) uploadProgressText.textContent = `${done} / ${total}`;
    if (uploadProgressDetail) {
      uploadProgressDetail.textContent = currentName
        ? `Envoi de ${currentName} — ${Math.round(currentRatio * 100)}%`
        : "—";
    }
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
      try { URL.revokeObjectURL(p.url); } catch {}
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
  await ensureAnonAuth();

  onSnapshot(query(collection(db, SECTIONS_COL), orderBy("order", "asc")), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();

    if (slideshow?.classList.contains("open")) {
      restartFromBeginning();
      showSlide();
    }
  });

  onSnapshot(query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")), (snap) => {
    photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();

    if (slideshow?.classList.contains("open")) {
      restartFromBeginning();
      showSlide();
    }
  });
}

main();
