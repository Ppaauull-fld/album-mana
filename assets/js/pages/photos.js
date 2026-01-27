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
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const PHOTOS_COL = "photos";
const SECTIONS_COL = "photoSections";
const UNASSIGNED = "__unassigned__";

// UI (page)
const sectionsWrap = document.getElementById("sectionsWrap");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const addSectionBtn = document.getElementById("addSectionBtn");
const arrangeBtn = document.getElementById("arrangeBtn");
const showBtn = document.getElementById("startSlideshowBtn");

// Picker modal
const picker = document.getElementById("sectionPicker");
const pickerGrid = document.getElementById("pickerGrid");
const pickerTitle = document.getElementById("pickerTitle");
const pickerSub = document.getElementById("pickerSub");
const pickerCancel = document.getElementById("pickerCancel");
const pickerSelectAll = document.getElementById("pickerSelectAll");
const pickerClear = document.getElementById("pickerClear");
const pickerApply = document.getElementById("pickerApply");

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

// Data
let photos = [];
let sections = [];

let queue = [];
let idx = 0;
let playing = true;
let timer = null;

let pending = [];
let currentViewed = null;

// Arrange mode
let arranging = false;

// Drag (pointer-based)
let drag = null; // { id, fromSectionId, ghostEl, placeholderEl, originEl, activeGridEl }

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
   Group + render
---------------------------- */

function sortByOrderThenCreated(arr) {
  arr.sort((a, b) => {
    const ao = a.order ?? a.createdAt ?? 0;
    const bo = b.order ?? b.createdAt ?? 0;
    return ao - bo;
  });
  return arr;
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

  for (const arr of grouped.values()) sortByOrderThenCreated(arr);
  return grouped;
}

function renderPhotoCard(p) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card card-btn";
  card.title = arranging ? "Déplacer" : "Ouvrir";
  card.dataset.id = p.id;

  const img = document.createElement("img");
  img.className = "thumb";
  img.src = p.thumbUrl || p.url;
  img.alt = "photo";
  if (p.rotation) applyRotationThumb(img, p.rotation);

  card.appendChild(img);

  // click -> viewer seulement hors arrange mode
  card.addEventListener("click", () => {
    if (arranging) return;
    openViewer(p);
  });

  // pointer drag seulement en arrange mode
  card.addEventListener("pointerdown", (e) => {
    if (!arranging) return;
    // évite drag si clic droit / etc.
    if (e.button !== 0) return;
    startPointerDrag(e, card);
  });

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

  const cta = document.createElement("div");
  cta.className = "section-cta";

  // Bouton "Ajouter / déplacer..."
  if (id !== UNASSIGNED) {
    const pickBtn = document.createElement("button");
    pickBtn.className = "btn";
    pickBtn.type = "button";
    pickBtn.textContent = "Ajouter / déplacer des photos";
    pickBtn.addEventListener("click", () => openPickerForSection(id, title || "Section"));
    cta.appendChild(pickBtn);
  }

  head.appendChild(t);
  head.appendChild(cta);

  const grid = document.createElement("div");
  grid.className = "section-grid";
  grid.dataset.sectionId = id;

  // Important : zone drop fiable (même vide)
  grid.addEventListener("pointerenter", () => {
    if (drag) drag.activeGridEl = grid;
  });

  for (const p of items) grid.appendChild(renderPhotoCard(p));

  card.appendChild(head);
  card.appendChild(grid);
  return card;
}

function renderAll() {
  if (!sectionsWrap) return;

  const grouped = groupPhotos();
  sectionsWrap.innerHTML = "";

  // Unassigned grid (sans titre)
  sectionsWrap.appendChild(
    renderSectionCard(
      { id: UNASSIGNED, title: "", editable: false, hideTitle: true },
      grouped.get(UNASSIGNED) || []
    )
  );

  // Sections
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
   Arrange mode toggle
---------------------------- */

function setArranging(on) {
  arranging = !!on;
  document.body.classList.toggle("arranging", arranging);
  document.querySelector(".page")?.classList.toggle("arranging", arranging);

  if (arrangeBtn) {
    arrangeBtn.classList.toggle("primary", arranging);
    arrangeBtn.textContent = arranging ? "Terminer" : "Arranger";
    // Remet l’icône si tu veux la garder : simple (optionnel)
    // (tu peux aussi laisser juste le texte)
  }

  // Re-render pour que les cards prennent le bon comportement (click vs drag)
  renderAll();
}

arrangeBtn?.addEventListener("click", () => setArranging(!arranging));

/* ---------------------------
   Pointer drag with placeholder (iPhone-like)
---------------------------- */

function createPlaceholderLike(el) {
  const ph = document.createElement("div");
  ph.className = "drop-placeholder";
  ph.style.width = `${el.getBoundingClientRect().width}px`;
  return ph;
}

function startPointerDrag(e, cardEl) {
  e.preventDefault();
  cardEl.setPointerCapture(e.pointerId);

  const id = cardEl.dataset.id;
  const originGrid = cardEl.closest(".section-grid");
  const fromSectionId = originGrid?.dataset.sectionId || UNASSIGNED;

  const rect = cardEl.getBoundingClientRect();

  const ghost = cardEl.cloneNode(true);
  ghost.classList.add("drag-ghost");
  ghost.style.position = "fixed";
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.zIndex = "9999";
  ghost.style.pointerEvents = "none";

  const placeholder = createPlaceholderLike(cardEl);

  // Remplace l’élément par le placeholder
  cardEl.parentNode.insertBefore(placeholder, cardEl);
  cardEl.style.display = "none";

  document.body.appendChild(ghost);

  drag = {
    id,
    fromSectionId,
    originEl: cardEl,
    ghostEl: ghost,
    placeholderEl: placeholder,
    activeGridEl: originGrid,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };

  window.addEventListener("pointermove", onPointerMove, { passive: false });
  window.addEventListener("pointerup", onPointerUp, { passive: false });
}

function findInsertBefore(gridEl, x, y) {
  const items = [...gridEl.querySelectorAll(".card-btn")].filter(
    (el) => el.style.display !== "none" && !el.classList.contains("drag-ghost")
  );

  // Trouve l’item le plus proche pour décider avant/après
  let closest = null;
  let closestDist = Infinity;

  for (const it of items) {
    const r = it.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < closestDist) {
      closestDist = dist;
      closest = { el: it, rect: r };
    }
  }

  if (!closest) return null;

  // Si on est à droite du centre -> après, sinon avant
  const before = x < (closest.rect.left + closest.rect.width / 2);
  return before ? closest.el : closest.el.nextSibling;
}

function onPointerMove(e) {
  if (!drag) return;
  e.preventDefault();

  // Move ghost
  drag.ghostEl.style.left = `${e.clientX - drag.offsetX}px`;
  drag.ghostEl.style.top = `${e.clientY - drag.offsetY}px`;

  // Determine active grid under pointer
  const elUnder = document.elementFromPoint(e.clientX, e.clientY);
  const grid = elUnder?.closest?.(".section-grid");
  if (grid) {
    drag.activeGridEl = grid;
  }

  const activeGrid = drag.activeGridEl;
  if (!activeGrid) return;

  activeGrid.classList.add("drag-over");

  // Insert placeholder position
  const ref = findInsertBefore(activeGrid, e.clientX, e.clientY);
  if (ref !== drag.placeholderEl) {
    activeGrid.insertBefore(drag.placeholderEl, ref);
  }
}

async function onPointerUp(e) {
  if (!drag) return;
  e.preventDefault();

  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);

  // cleanup drag-over
  document.querySelectorAll(".section-grid.drag-over").forEach((g) => g.classList.remove("drag-over"));

  const activeGrid = drag.activeGridEl;
  const newSectionId = activeGrid?.dataset.sectionId || UNASSIGNED;

  // Replace placeholder with original element in DOM
  drag.placeholderEl.parentNode.insertBefore(drag.originEl, drag.placeholderEl);
  drag.placeholderEl.remove();
  drag.originEl.style.display = "";

  drag.ghostEl.remove();

  // Compute new "order" based on neighbors around the dropped element
  const siblings = [...drag.originEl.parentNode.querySelectorAll(".card-btn")];
  const i = siblings.indexOf(drag.originEl);

  const prev = i > 0 ? siblings[i - 1] : null;
  const next = i < siblings.length - 1 ? siblings[i + 1] : null;

  const prevId = prev?.dataset.id;
  const nextId = next?.dataset.id;

  const prevDoc = prevId ? photos.find((p) => p.id === prevId) : null;
  const nextDoc = nextId ? photos.find((p) => p.id === nextId) : null;

  const prevOrder = prevDoc ? (prevDoc.order ?? prevDoc.createdAt ?? 0) : null;
  const nextOrder = nextDoc ? (nextDoc.order ?? nextDoc.createdAt ?? 0) : null;

  let newOrder;
  if (prevOrder == null && nextOrder == null) {
    newOrder = Date.now();
  } else if (prevOrder == null) {
    newOrder = nextOrder - 1;
  } else if (nextOrder == null) {
    newOrder = prevOrder + 1;
  } else {
    // milieu : moyenne (float OK)
    newOrder = (prevOrder + nextOrder) / 2;
  }

  const sectionValue = newSectionId === UNASSIGNED ? null : newSectionId;

  try {
    await updateDoc(doc(db, PHOTOS_COL, drag.id), {
      sectionId: sectionValue,
      order: newOrder,
    });
  } catch (err) {
    alert("Impossible de déplacer la photo (Firestore).");
    console.error(err);
  }

  drag = null;
}

/* ---------------------------
   Picker (checkbox) for section
---------------------------- */

let pickerTargetSectionId = null;
let pickerSelected = new Set();

function openPickerForSection(sectionId, title) {
  pickerTargetSectionId = sectionId;
  pickerSelected = new Set();

  pickerTitle.textContent = `Ajouter / déplacer — ${title}`;
  pickerSub.textContent = "0 sélectionnée";

  renderPickerGrid();

  picker.classList.add("open");
  picker.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}

function closePicker() {
  picker.classList.remove("open");
  picker.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");

  pickerTargetSectionId = null;
  pickerSelected.clear();
}

function updatePickerSub() {
  const n = pickerSelected.size;
  pickerSub.textContent = n === 0 ? "0 sélectionnée" : n === 1 ? "1 sélectionnée" : `${n} sélectionnées`;
}

function renderPickerGrid() {
  pickerGrid.innerHTML = "";

  // On propose toutes les photos (y compris celles d'autres sections)
  const list = sortByOrderThenCreated(photos.slice());

  for (const p of list) {
    const item = document.createElement("div");
    item.className = "pick-item";
    item.dataset.id = p.id;

    const img = document.createElement("img");
    img.src = p.thumbUrl || p.url;
    img.alt = "photo";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "pick-check";
    cb.checked = pickerSelected.has(p.id);

    const setSel = (val) => {
      if (val) pickerSelected.add(p.id);
      else pickerSelected.delete(p.id);
      item.classList.toggle("selected", val);
      cb.checked = val;
      updatePickerSub();
    };

    cb.addEventListener("change", () => setSel(cb.checked));
    item.addEventListener("click", (e) => {
      if (e.target === cb) return;
      setSel(!pickerSelected.has(p.id));
    });

    item.appendChild(img);
    item.appendChild(cb);
    pickerGrid.appendChild(item);
  }

  updatePickerSub();
}

pickerCancel?.addEventListener("click", closePicker);
picker.addEventListener("click", (e) => {
  if (e.target === picker) closePicker();
});

pickerSelectAll?.addEventListener("click", () => {
  photos.forEach((p) => pickerSelected.add(p.id));
  renderPickerGrid();
});

pickerClear?.addEventListener("click", () => {
  pickerSelected.clear();
  renderPickerGrid();
});

pickerApply?.addEventListener("click", async () => {
  if (!pickerTargetSectionId) return;
  if (!pickerSelected.size) return closePicker();

  try {
    pickerApply.disabled = true;

    const batch = writeBatch(db);
    const now = Date.now();

    for (const id of pickerSelected) {
      batch.update(doc(db, PHOTOS_COL, id), {
        sectionId: pickerTargetSectionId,
        order: now + Math.random(), // évite collisions
      });
    }

    await batch.commit();
    closePicker();
  } catch (e) {
    alert("Impossible d'ajouter les photos : " + (e?.message || e));
    console.error(e);
  } finally {
    pickerApply.disabled = false;
  }
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
viewer.addEventListener("click", (e) => { if (e.target === viewer) closeViewer(); });

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
  timer = setInterval(() => { if (playing) next(); }, 3500);
}

function stopAuto() {
  if (timer) clearInterval(timer);
  timer = null;
}

function syncPlayIcon() {
  if (!togglePlayIcon) return;
  togglePlayIcon.src = playing ? "../assets/img/icons/pause.svg" : "../assets/img/icons/play.svg";
}

function openShow() {
  if (!photos.length) return alert("Ajoute d'abord quelques photos.");
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
togglePlayBtn?.addEventListener("click", () => { playing = !playing; syncPlayIcon(); });

/* ---------------------------
   Upload modal (inchangé)
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
  uploadCount.textContent = n === 0 ? "Aucun fichier" : n === 1 ? "1 fichier" : `${n} fichiers`;
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

      const now = Date.now();

      await addDoc(collection(db, PHOTOS_COL), {
        type: "photo",
        createdAt: now,
        order: now,      // important: ordre stable
        sectionId: null, // par défaut dans la grille principale

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
   Sections: create
---------------------------- */

addSectionBtn?.addEventListener("click", async () => {
  const title = prompt("Titre de la section ?");
  if (!title) return;

  try {
    const now = Date.now();
    await addDoc(collection(db, SECTIONS_COL), {
      title: title.trim(),
      order: now,
      createdAt: now,
    });
  } catch (e) {
    alert("Impossible de créer la section : " + (e?.message || e));
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
  if (picker.classList.contains("open")) {
    if (e.key === "Escape") closePicker();
  }
});

/* ---------------------------
   Main (listeners robustes)
---------------------------- */

async function main() {
  await ensureAnonAuth();

  // Sections (sans orderBy, tri local)
  onSnapshot(collection(db, SECTIONS_COL), (snap) => {
    sections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    sortByOrderThenCreated(sections);
    renderAll();
  });

  // Photos : orderBy createdAt pour inclure toutes les anciennes
  onSnapshot(query(collection(db, PHOTOS_COL), orderBy("createdAt", "desc")), (snap) => {
    photos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
}

main();
