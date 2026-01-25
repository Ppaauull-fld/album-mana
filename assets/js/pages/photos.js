import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("photosGrid");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
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

const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");

let photos = [];
let queue = [];
let idx = 0;
let playing = true;
let timer = null;

// sélection en attente (avant envoi)
let pending = []; // [{file, url}]

function render() {
  grid.innerHTML = "";
  for (const p of photos) {
    const card = document.createElement("div");
    card.className = "card";
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = p.thumbUrl || p.url;
    img.alt = "photo";
    card.appendChild(img);
    grid.appendChild(card);
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildQueue() { queue = shuffle(photos); idx = 0; }

function showSlide() {
  if (!queue.length) return;
  const s = queue[idx];
  slideImg.src = s.url;
  slideCounter.textContent = `${idx + 1} / ${queue.length}`;
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

function openShow() {
  if (!photos.length) return alert("Ajoute d'abord quelques photos");
  buildQueue();
  slideshow.classList.add("open");
  playing = true;
  document.getElementById("togglePlay").textContent = "⏸";
  showSlide();
  startAuto();
}
function closeShow() {
  slideshow.classList.remove("open");
  stopAuto();
}

/* ---------------------------
   Upload modal
---------------------------- */

function openUploadModal() {
  uploadModal.classList.add("open");
  uploadModal.setAttribute("aria-hidden", "false");
}
function closeUploadModal() {
  uploadModal.classList.remove("open");
  uploadModal.setAttribute("aria-hidden", "true");
}

function fmtCount() {
  const n = pending.length;
  uploadCount.textContent = n === 0 ? "Aucun fichier" : (n === 1 ? "1 fichier" : `${n} fichiers`);
}

function resetProgressUI() {
  uploadProgressBar.value = 0;
  uploadProgressText.textContent = "0 / 0";
  uploadProgressDetail.textContent = "—";
}

function setUploadingState(isUploading) {
  addBtn.disabled = isUploading;
  showBtn.disabled = isUploading;
  uploadCancelBtn.disabled = isUploading;
  uploadStartBtn.disabled = isUploading || pending.length === 0;
  uploadStartBtn.textContent = isUploading ? "⏳ Envoi…" : "Envoyer";
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
    remove.title = "Retirer de la sélection";
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

addBtn.addEventListener("click", () => input.click());

input.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  input.value = ""; // important : permet de re-sélectionner les mêmes fichiers ensuite
  if (!files.length) return;

  // libère anciennes previews
  for (const p of pending) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }
  pending = files.map(file => ({ file, url: URL.createObjectURL(file) }));

  resetProgressUI();
  renderPending();
  setUploadingState(false);
  openUploadModal();
});

uploadCancelBtn.addEventListener("click", () => {
  if (uploadCancelBtn.disabled) return;
  for (const p of pending) {
    try { URL.revokeObjectURL(p.url); } catch {}
  }
  pending = [];
  resetProgressUI();
  closeUploadModal();
});

uploadStartBtn.addEventListener("click", async () => {
  if (!pending.length) return;

  setUploadingState(true);
  resetProgressUI();

  const total = pending.length;
  let done = 0;

  // une progression "globale" : (done + progressDuFichierCourant) / total
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
        onProgress: (ratio) => updateOverall(ratio, file.name)
      });

      await addDoc(collection(db, "photos"), {
        type: "photo",
        createdAt: Date.now(),
        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl: up.secure_url
      });

      done++;
      uploadProgressText.textContent = `${done} / ${total}`;
      uploadProgressDetail.textContent = `Envoyé : ${file.name}`;
      uploadProgressBar.value = Math.round((done / total) * 100);
    }

    // nettoyage
    for (const p of pending) {
      try { URL.revokeObjectURL(p.url); } catch {}
    }
    pending = [];

    uploadProgressDetail.textContent = "Terminé !";
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
   Slideshow events
---------------------------- */

showBtn.addEventListener("click", openShow);
document.getElementById("closeShow").addEventListener("click", closeShow);
document.getElementById("nextSlide").addEventListener("click", next);
document.getElementById("prevSlide").addEventListener("click", prev);
document.getElementById("togglePlay").addEventListener("click", () => {
  playing = !playing;
  document.getElementById("togglePlay").textContent = playing ? "⏸" : "▶";
});
document.addEventListener("keydown", (e) => {
  if (slideshow.classList.contains("open")) {
    if (e.key === "Escape") closeShow();
    if (e.key === "ArrowRight") next();
    if (e.key === "ArrowLeft") prev();
  } else if (uploadModal.classList.contains("open")) {
    if (e.key === "Escape" && !uploadCancelBtn.disabled) uploadCancelBtn.click();
  }
});

async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "photos"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    photos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
}

main();
