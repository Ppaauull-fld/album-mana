import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo, uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("animatedGrid");
const input = document.getElementById("animatedInput");
const addBtn = document.getElementById("addAnimatedBtn");

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
const viewer = document.getElementById("animatedViewer");
const viewerGif = document.getElementById("viewerGif");
const viewerVideo = document.getElementById("viewerVideo");
const viewerDownload = document.getElementById("viewerDownload");
const viewerDelete = document.getElementById("viewerDelete");
const viewerClose = document.getElementById("viewerClose");

let items = [];
let pending = []; // [{file, url}]
let currentViewed = null;

function openModal(el) {
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  document.documentElement.classList.add("noscroll");
  document.body.classList.add("noscroll");
}
function closeModal(el) {
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
  document.documentElement.classList.remove("noscroll");
  document.body.classList.remove("noscroll");
}

function isGif(file) {
  return file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
}
function isVideo(file) {
  return file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

function cloudinaryVideoPoster(videoUrl) {
  try {
    if (!videoUrl.includes("/video/upload/")) return null;
    const withTransform = videoUrl.replace("/upload/", "/upload/so_0/");
    return withTransform.replace(/\.[a-z0-9]+(\?.*)?$/i, ".jpg");
  } catch {
    return null;
  }
}

function render() {
  grid.innerHTML = "";

  for (const it of items) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card card-btn";
    card.title = "Lire";

    const img = document.createElement("img");
    img.className = "thumb";

    if (it.kind === "video") {
      img.src = it.thumbUrl || cloudinaryVideoPoster(it.url) || it.url;
      const badge = document.createElement("div");
      badge.className = "play-badge";
      badge.textContent = "▶";
      card.appendChild(img);
      card.appendChild(badge);
    } else {
      img.src = it.thumbUrl || it.url;
      card.appendChild(img);
    }

    card.addEventListener("click", () => openViewer(it));
    grid.appendChild(card);
  }
}

/* ---------- Viewer ---------- */

function openViewer(it) {
  currentViewed = it;

  // reset
  viewerGif.style.display = "none";
  viewerVideo.style.display = "none";
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  if (it.kind === "gif") {
    viewerGif.src = it.url;
    viewerGif.style.display = "block";
    viewerDownload.href = it.url;
    viewerDownload.setAttribute("download", `animation-${it.id}.gif`);
  } else {
    viewerVideo.src = it.url;
    viewerVideo.style.display = "block";
    viewerVideo.load();

    viewerDownload.href = it.url;
    viewerDownload.setAttribute("download", `animation-${it.id}.mp4`);

    setTimeout(() => {
      viewerVideo.play().catch(() => {});
    }, 50);
  }

  openModal(viewer);
}

function closeViewer() {
  viewerVideo.pause();
  viewerVideo.removeAttribute("src");
  viewerVideo.load();
  currentViewed = null;
  closeModal(viewer);
}

viewerClose.addEventListener("click", closeViewer);
viewer.addEventListener("click", (e) => { if (e.target === viewer) closeViewer(); });

viewerDelete.addEventListener("click", async () => {
  if (!currentViewed) return;
  if (!confirm("Supprimer cet élément de la galerie ?")) return;

  try {
    viewerDelete.disabled = true;
    await deleteDoc(doc(db, "animated", currentViewed.id));
    closeViewer();
  } catch (e) {
    alert("Suppression impossible : " + (e?.message || e));
  } finally {
    viewerDelete.disabled = false;
  }
});

/* ---------- Upload modal ---------- */

function openUpload() { openModal(uploadModal); }
function closeUpload() { closeModal(uploadModal); }

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
    empty.textContent = "Sélectionne des fichiers pour les prévisualiser ici.";
    uploadPreviewGrid.appendChild(empty);
    uploadStartBtn.disabled = true;
    return;
  }

  for (let i = 0; i < pending.length; i++) {
    const { file, url } = pending[i];

    const item = document.createElement("div");
    item.className = "upload-item";

    if (isGif(file)) {
      const img = document.createElement("img");
      img.className = "upload-thumb";
      img.src = url;
      img.alt = file.name;
      item.appendChild(img);
    } else {
      const vid = document.createElement("video");
      vid.className = "upload-thumb upload-thumb-video";
      vid.src = url;
      vid.muted = true;
      vid.playsInline = true;
      vid.loop = true;
      vid.preload = "metadata";
      vid.addEventListener("loadeddata", () => { vid.play().catch(() => {}); });
      item.appendChild(vid);
    }

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
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      try { URL.revokeObjectURL(pending[i].url); } catch {}
      pending.splice(i, 1);
      renderPending();
      setUploadingState(false);
    });

    item.appendChild(meta);
    item.appendChild(remove);
    uploadPreviewGrid.appendChild(item);
  }

  uploadStartBtn.disabled = false;
}

addBtn.addEventListener("click", () => input.click());

input.addEventListener("change", () => {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;

  for (const p of pending) { try { URL.revokeObjectURL(p.url); } catch {} }

  pending = files
    .filter(f => isGif(f) || isVideo(f))
    .map(file => ({ file, url: URL.createObjectURL(file) }));

  resetProgressUI();
  renderPending();
  setUploadingState(false);
  openUpload();
});

uploadCancelBtn.addEventListener("click", () => {
  if (uploadCancelBtn.disabled) return;
  for (const p of pending) { try { URL.revokeObjectURL(p.url); } catch {} }
  pending = [];
  resetProgressUI();
  closeUpload();
});

uploadStartBtn.addEventListener("click", async () => {
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

      let up, kind;
      if (isGif(file)) {
        up = await uploadImage(file, { onProgress: (r) => updateOverall(r, file.name) });
        kind = "gif";
      } else {
        up = await uploadVideo(file, { onProgress: (r) => updateOverall(r, file.name) });
        kind = "video";
      }

      const thumbUrl = kind === "video"
        ? (cloudinaryVideoPoster(up.secure_url) || up.secure_url)
        : up.secure_url;

      await addDoc(collection(db, "animated"), {
        createdAt: Date.now(),
        kind,
        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl,
      });

      done++;
      uploadProgressText.textContent = `${done} / ${total}`;
      uploadProgressBar.value = Math.round((done / total) * 100);
    }

    for (const p of pending) { try { URL.revokeObjectURL(p.url); } catch {} }
    pending = [];

    uploadProgressDetail.textContent = "✅ Terminé !";
    setTimeout(() => {
      closeUpload();
      resetProgressUI();
      setUploadingState(false);
    }, 450);
  } catch (e) {
    setUploadingState(false);
    alert("Erreur upload : " + (e?.message || e));
  }
});

/* ---------- Keyboard ---------- */
document.addEventListener("keydown", (e) => {
  if (viewer.classList.contains("open")) {
    if (e.key === "Escape") closeViewer();
    return;
  }
  if (uploadModal.classList.contains("open")) {
    if (e.key === "Escape" && !uploadCancelBtn.disabled) uploadCancelBtn.click();
  }
});

async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "animated"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
}

main();
