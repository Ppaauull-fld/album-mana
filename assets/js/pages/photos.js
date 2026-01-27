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
  where,
  getDocs,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PHOTOS_COL = "photos";
const SECTIONS_COL = "photoSections";
const UNASSIGNED = "__unassigned__"; // bucket logique (pas une section Firestore)

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

// Drag sections (reorder uniquement)
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

function renderSectionCard({ id, title, editable, hideTitle }, items) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.sectionCardId = id;

  if (hideTitle) card.classList.add("no-title");

  const head = document.createElement("div");
  head.className = "section-head";

  // poignée (sert uniquement en mode arranger — le CSS la cache sinon)
  const move = document.createElement("button");
  move.type = "button";
  move.className = "section-move";
  move.title = "Réordonner la section";
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

  // Galerie (unassigned) en haut
  sectionsWrap.appendChild(
    renderSectionCard(
      { id: UNASSIGNED, title: "", editable: false, hideTitle: true },
      grouped.get(UNASSIGNED) || []
    )
  );

  // Sections en dessous (pile)
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

  // boutons maximize/delete (gardés)
  requestAnimationFrame(() => {
    ensureSectionHeaderActions();
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
    cancelSectionDrag();
  }
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* ---------------------------
   Drag SECTIONS (reorder uniquement) + auto-scroll
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
    const H = window.innerHeight;

    const y = sectionDrag.lastY;
    let vy = 0;

    if (y < edge) vy = -maxSpeed * (1 - y / edge);
    else if (y > H - edge) vy = maxSpeed * (1 - (H - y) / edge);

    if (vy) {
      window.scrollBy(0, vy);
      if (sectionDrag?.placeholderEl) {
        placeSectionPlaceholderList(
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

  try { sectionDrag.ghostEl?.remove(); } catch {}
  try { sectionDrag.placeholderEl?.remove(); } catch {}

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

function createSectionPlaceholder() {
  const ph = document.createElement("div");
  ph.className = "section-placeholder";
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

function placeSectionPlaceholderList(wrap, placeholderEl, y, draggedId) {
  if (!wrap) return;

  const cards = [...wrap.querySelectorAll(".section-card")].filter((c) => {
    const sid = c.dataset.sectionCardId;
    // on ne réordonne PAS la galerie UNASSIGNED
    return sid && sid !== draggedId && sid !== UNASSIGNED;
  });

  if (!cards.length) {
    wrap.appendChild(placeholderEl);
    return;
  }

  let beforeEl = null;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    if (y < midY) {
      beforeEl = el;
      break;
    }
  }

  if (!beforeEl) wrap.appendChild(placeholderEl);
  else wrap.insertBefore(placeholderEl, beforeEl);
}

function onSectionPointerDown(e) {
  if (!arranging) return;

  const handle = e.target?.closest?.('[data-section-move="1"]');
  if (!handle) return;

  const sectionEl = handle.closest(".section-card");
  if (!sectionEl) return;

  const id = sectionEl.dataset.sectionCardId;
  if (!id || id === UNASSIGNED) return; // pas la galerie

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
  sectionDrag.placeholderEl = createSectionPlaceholder();
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
  placeSectionPlaceholderList(
    sectionsWrap,
    sectionDrag.placeholderEl,
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

    if (original) wrap.insertBefore(original, placeholder);
    try { placeholder.remove(); } catch {}

    finalizeSectionDrop(wrap).catch((err) => {
      console.error(err);
      alert("Impossible de réordonner la section.");
    });
  }
}

/* ---------------------------
   Listeners (delegation)
---------------------------- */

sectionsWrap?.addEventListener("pointerdown", onSectionPointerDown, {
  passive: false,
});

window.addEventListener("pointermove", onSectionPointerMove, { passive: false });
window.addEventListener("pointerup", onSectionPointerUp);

window.addEventListener("pointercancel", (e) => {
  try { onSectionPointerUp(e); } catch {}
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
  const ok = confirm("Supprimer cette photo ?");
  if (!ok) return;

  try {
    viewerDelete.disabled = true;
    await deleteDoc(doc(db, PHOTOS_COL, currentViewed.id));
    closeViewer();
  } catch (e) {
    alert("Suppression impossible.");
  } finally {
    viewerDelete.disabled = false;
  }
});

viewerRotate?.addEventListener("click", async () => {
  if (!currentViewed) return;

  const cur = clampRotation(currentViewed.rotation || 0);
  const next = (cur + 90) % 360;
  currentViewed.rotation = next;
  applyRotation(viewerImg, next);

  try {
    await updateDoc(doc(db, PHOTOS_COL, currentViewed.id), { rotation: next });
  } catch {
    alert("Rotation non sauvegardée.");
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
  idx = (idx + 1) % queue.length;
  showSlide();
}

function prev() {
  if (!queue.length) return;
  idx = Math.max(0, idx - 1);
  showSlide();
}

function startAuto() {
  stopAuto();
  timer = setInterval(() => playing && next(), 3500);
}

function stopAuto() {
  if (timer) clearInterval(timer);
  timer = null;
}

function syncPlayIcon() {
  togglePlayIcon.src = playing
    ? "../assets/img/icons/pause.svg"
    : "../assets/img/icons/play.svg";
}

function openShow() {
  if (!photos.length) {
    alert("Ajoute des photos d’abord.");
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
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeUploadModal() {
  uploadModal.classList.remove("open");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function resetProgressUI() {
  uploadProgressBar.value = 0;
  uploadProgressText.textContent = "0 / 0";
  uploadProgressDetail.textContent = "—";
}

function setUploadingState(on) {
  addBtn.disabled = on;
  showBtn.disabled = on;
  addSectionBtn.disabled = on;
  arrangeBtn && (arrangeBtn.disabled = on);
  uploadCancelBtn.disabled = on;
  uploadStartBtn.disabled = on || pending.length === 0;
  setBtnLoading(uploadStartBtn, on, { label: "Envoi…" });
}

function renderPending() {
  uploadPreviewGrid.innerHTML = "";
  uploadCount.textContent =
    pending.length === 0
      ? "Aucun fichier"
      : `${pending.length} fichier(s)`;

  if (!pending.length) return;

  pending.forEach(({ file, url }, i) => {
    const item = document.createElement("div");
    item.className = "upload-item";

    const img = document.createElement("img");
    img.className = "upload-thumb";
    img.src = url;

    const btn = document.createElement("button");
    btn.className = "upload-remove";
    btn.textContent = "Retirer";
    btn.onclick = () => {
      URL.revokeObjectURL(url);
      pending.splice(i, 1);
      renderPending();
    };

    item.append(img, btn);
    uploadPreviewGrid.appendChild(item);
  });
}

addBtn?.addEventListener("click", () => input.click());

input?.addEventListener("change", () => {
  pending.forEach((p) => URL.revokeObjectURL(p.url));
  pending = [...input.files].map((f) => ({
    file: f,
    url: URL.createObjectURL(f),
  }));
  input.value = "";
  resetProgressUI();
  renderPending();
  openUploadModal();
});

uploadCancelBtn?.addEventListener("click", () => {
  pending.forEach((p) => URL.revokeObjectURL(p.url));
  pending = [];
  closeUploadModal();
});

uploadStartBtn?.addEventListener("click", async () => {
  if (!pending.length) return;
  setUploadingState(true);
  resetProgressUI();

  try {
    for (const { file } of pending) {
      const up = await uploadImage(file);
      await addDoc(collection(db, PHOTOS_COL), {
        createdAt: Date.now(),
        order: Date.now(),
        sectionId: null,
        url: up.secure_url,
        thumbUrl: up.secure_url,
        rotation: 0,
      });
    }
    pending = [];
    closeUploadModal();
  } catch {
    alert("Erreur lors de l’upload.");
  } finally {
    setUploadingState(false);
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
    });
  } catch {
    alert("Impossible de créer la section.");
  }
});

/* ---------------------------
   Sections: fullscreen + delete
---------------------------- */

let sectionModal = null;

function ensureSectionModal() {
  if (sectionModal) return sectionModal;

  const el = document.createElement("div");
  el.className = "section-modal";
  el.innerHTML = `
    <div class="section-modal-panel">
      <div class="section-modal-head">
        <div class="section-modal-title"></div>
        <button class="btn section-modal-close">Fermer</button>
      </div>
      <div class="section-modal-grid"></div>
    </div>
  `;

  el.querySelector(".section-modal-close").onclick = closeSectionFullscreen;
  el.onclick = (e) => e.target === el && closeSectionFullscreen();

  document.body.appendChild(el);
  sectionModal = el;
  return el;
}

function openSectionFullscreen(sectionId) {
  const overlay = ensureSectionModal();
  const titleEl = overlay.querySelector(".section-modal-title");
  const grid = overlay.querySelector(".section-modal-grid");

  const section = sections.find((s) => s.id === sectionId);
  titleEl.textContent = section?.title || "Section";
  grid.innerHTML = "";

  photos
    .filter((p) => p.sectionId === sectionId)
    .forEach((p) => grid.appendChild(renderPhotoCard(p)));

  overlay.classList.add("open");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closeSectionFullscreen() {
  sectionModal?.classList.remove("open");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

async function deleteSectionAndUnassignPhotos(sectionId) {
  const q = query(collection(db, PHOTOS_COL), where("sectionId", "==", sectionId));
  const snap = await getDocs(q);
  const batch = writeBatch(db);

  snap.forEach((d) =>
    batch.update(doc(db, PHOTOS_COL, d.id), { sectionId: null })
  );
  batch.delete(doc(db, SECTIONS_COL, sectionId));
  await batch.commit();
}

function ensureSectionHeaderActions() {
  const cards = [...sectionsWrap.querySelectorAll(".section-card")];
  for (const card of cards) {
    const head = card.querySelector(".section-head");
    if (!head || head.querySelector(".section-actions")) continue;

    const sid = card.dataset.sectionCardId;
    if (!sid || sid === UNASSIGNED) continue;

    const actions = document.createElement("div");
    actions.className = "section-actions";

    actions.innerHTML = `
      <button class="section-action-btn" data-section-max>
        <img src="../assets/img/icons/maximize.svg" alt="">
      </button>
      <button class="section-action-btn danger" data-section-delete>
        <img src="../assets/img/icons/delete.svg" alt="">
      </button>
    `;

    head.appendChild(actions);
  }
}

sectionsWrap?.addEventListener("click", async (e) => {
  const card = e.target.closest(".section-card");
  if (!card) return;
  const sid = card.dataset.sectionCardId;

  if (e.target.closest("[data-section-max]")) {
    openSectionFullscreen(sid);
  }

  if (e.target.closest("[data-section-delete]")) {
    const ok = confirm("Supprimer cette section ?");
    if (!ok) return;
    await deleteSectionAndUnassignPhotos(sid);
  }
});

/* ---------------------------
   Keyboard shortcuts
---------------------------- */

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;

  if (viewer.classList.contains("open")) closeViewer();
  if (slideshow.classList.contains("open")) closeShow();
  if (sectionModal?.classList.contains("open")) closeSectionFullscreen();
  if (uploadModal.classList.contains("open")) closeUploadModal();
});

/* ---------------------------
   Main
---------------------------- */

async function main() {
  await ensureAnonAuth();

  onSnapshot(
    query(collection(db, SECTIONS_COL), orderBy("order", "asc")),
    (snap) => {
      sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );

  onSnapshot(
    query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")),
    (snap) => {
      photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    }
  );
}

main();
