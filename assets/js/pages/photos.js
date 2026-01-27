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

// UI (page)
const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
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

// Data state
let photos = [];        // tous les docs photos
let sections = [];      // docs sections
let queue = [];
let idx = 0;
let playing = true;
let timer = null;

// sélection en attente (avant envoi)
let pending = []; // [{file, url}]

// viewer state
let currentViewed = null; // {id, url, rotation?, ...}

// drag state
let draggedId = null;

function clampRotation(deg) {
  const allowed = [0, 90, 180, 270];
  return allowed.includes(deg) ? deg : 0;
}

function applyRotation(el, deg) {
  const rot = clampRotation(deg || 0);
  el.style.transform = `rotate(${rot}deg)`;
  el.style.transformOrigin = "center center";
}

/** Galerie : si rotation 90/270 => contain pour éviter crop */
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
   Sections + rendu
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

  // tri par order asc (si absent, fallback createdAt)
  for (const arr of grouped.values()) {
    arr.sort((a, b) => {
      const ao = (a.order ?? a.createdAt ?? 0);
      const bo = (b.order ?? b.createdAt ?? 0);
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

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = p.thumbUrl || p.url;
  img.alt = "photo";

  if (p.rotation) applyRotationThumb(img, p.rotation);

  card.appendChild(img);
  card.addEventListener("click", () => openViewer(p));

  // drag
  card.dataset.id = p.id;
  enableDnDForItem(card);

  return card;
}

function renderSectionCard({ id, title, editable, hideTitle }, items) {
  const card = document.createElement("div");
  card.className = "section-card";
  if (hideTitle) card.classList.add("no-title");

  const head = document.createElement("div");
  head.className = "section-head";

  const t = document.createElement("div");
  t.className = "section-title";
  t.textContent = title || "";

  if (editable) {
    t.contentEditable = "true";
    t.spellcheck = false;
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

  head.appendChild(t);

  const grid = document.createElement("div");
  grid.className = "section-grid";
  grid.dataset.sectionId = id;

  enableDnDForGrid(grid);

  for (const p of items) {
    grid.appendChild(renderPhotoCard(p));
  }

  card.appendChild(head);
  card.appendChild(grid);
  return card;
}

function renderAll() {
  if (!sectionsWrap) return;

  const grouped = groupPhotos();
  sectionsWrap.innerHTML = "";

  // Grille principale (sans titre)
  sectionsWrap.appendChild(
    renderSectionCard(
      { id: UNASSIGNED, title: "", editable: false, hideTitle: true },
      grouped.get(UNASSIGNED) || []
    )
  );

  // Sections créées (avec titres)
  for (const s of sections) {
    sectionsWrap.appendChild(
      renderSectionCard(
        { id: s.id, title: s.title || "Section", editable: true, hideTitle: false },
        grouped.get(s.id) || []
      )
    );
  }
}

/* ---------------------------
   Drag & drop
---------------------------- */

function enableDnDForItem(el) {
  el.draggable = true;

  el.addEventListener("dragstart", (e) => {
    draggedId = el.dataset.id;
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    draggedId = null;
  });
}

function enableDnDForGrid(grid) {
  grid.addEventListener("dragover", (e) => {
    e.preventDefault();
    grid.classList.add("drag-over");
  });

  grid.addEventListener("dragleave", () => {
    grid.classList.remove("drag-over");
  });

  grid.addEventListener("drop", async (e) => {
    e.preventDefault();
    grid.classList.remove("drag-over");
    if (!draggedId) return;

    const target = grid.dataset.sectionId; // UNASSIGNED ou id Firestore
    const newSectionValue = (target === UNASSIGNED) ? null : target;

    try {
      // drop = on met à la fin via order = Date.now()
      await updateDoc(doc(db, PHOTOS_COL, draggedId), {
        sectionId: newSectionValue,
        order: Date.now(),
      });
    } catch (err) {
      alert("Impossible de déplacer la photo.");
      console.error(err);
    }
  });
}

/* ---------------------------
   Viewer (plein écran)
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

// Rotation persistée Firestore
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
   Upload modal (preview + progression)
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
        order: Date.now(),     // ordre éditable via drag&drop
        sectionId: null,       // non classée au départ

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
   Sections: création + listeners Firestore
---------------------------- */

addSectionBtn?.addEventListener("click", async () => {
  const title = prompt("Titre de la section ?");
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

  // Sections (uniquement celles créées)
  onSnapshot(query(collection(db, SECTIONS_COL), orderBy("order", "asc")), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });

  // Photos : on trie par "order" (sinon ça ne peut pas être réarrangé)
  onSnapshot(query(collection(db, PHOTOS_COL), orderBy("order", "asc")), (snap) => {
    photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
}

main();
