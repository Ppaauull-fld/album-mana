import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo } from "../cloudinary.js";

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  deleteDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("videosGrid");
const input = document.getElementById("videoInput");
const addBtn = document.getElementById("addVideoBtn");

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

let vids = [];
let pending = []; // [{file, url}]
let currentViewed = null;

/* =========================
   Modal helpers
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
   Upload button state (spinner, no emoji)
   ========================= */
function setUploadingState(isUploading) {
  addBtn.disabled = isUploading;
  uploadCancelBtn.disabled = isUploading;
  uploadStartBtn.disabled = isUploading || pending.length === 0;

  if (isUploading) {
    uploadStartBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span>Envoi…`;
  } else {
    uploadStartBtn.textContent = "Envoyer";
  }
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
    try {
      URL.revokeObjectURL(p.url);
    } catch {}
  }
}

/* =========================
   Play badge (SVG file, no emoji)
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
   Render grid
   ========================= */
function render() {
  if (!grid) return;
  grid.innerHTML = "";

  for (const v of vids) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card card-btn";
    card.title = "Lire";

    const img = document.createElement("img");
    img.className = "thumb";

    const poster = v.thumbUrl || cloudinaryVideoPoster(v.url);
    img.src = poster || fallbackPosterDataUri();
    img.alt = "vidéo";

    card.appendChild(img);
    card.appendChild(makePlayBadge());
    card.addEventListener("click", () => openViewer(v));

    grid.appendChild(card);
  }
}

/* =========================
   Viewer
   ========================= */
function openViewer(v) {
  currentViewed = v;

  // reset propre
  try {
    viewerVideo.pause();
  } catch {}
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  viewerVideo.src = v.url;
  viewerVideo.playsInline = true;
  viewerVideo.controls = true;
  viewerVideo.load();

  viewerDownload.href = v.url;
  viewerDownload.setAttribute("download", `video-${v.id}.mp4`);

  openModal(viewer);

  // tentative autoplay (peut être refusée par Safari)
  setTimeout(() => {
    viewerVideo.play().catch(() => {});
  }, 60);
}

function closeViewer() {
  try {
    viewerVideo.pause();
  } catch {}
  viewerVideo.removeAttribute("src");
  viewerVideo.load();

  currentViewed = null;
  closeModal(viewer);
}

viewerClose?.addEventListener("click", closeViewer);

viewer?.addEventListener("click", (e) => {
  if (e.target === viewer) closeViewer();
});

viewerDelete?.addEventListener("click", async () => {
  if (!currentViewed) return;
  if (!confirm("Supprimer cette vidéo de la galerie ?")) return;

  try {
    viewerDelete.disabled = true;
    await deleteDoc(doc(db, "videos", currentViewed.id));
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
function openUpload() {
  openModal(uploadModal);
}
function closeUpload() {
  closeModal(uploadModal);
}

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
    remove.className = "upload-remove";
    remove.type = "button";
    remove.textContent = "Retirer";
    remove.addEventListener("click", () => {
      try {
        URL.revokeObjectURL(pending[i].url);
      } catch {}
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
  openUpload();
});

uploadCancelBtn?.addEventListener("click", () => {
  if (uploadCancelBtn.disabled) return;

  cleanupPendingUrls();
  pending = [];
  resetProgressUI();
  closeUpload();
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

      const up = await uploadVideo(file, {
        onProgress: (r) => updateOverall(r, file.name),
      });

      const thumbUrl = cloudinaryVideoPoster(up.secure_url) || up.secure_url;

      await addDoc(collection(db, "videos"), {
        createdAt: Date.now(),
        publicId: up.public_id,
        url: up.secure_url,
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
      closeUpload();
      resetProgressUI();
      setUploadingState(false);
    }, 450);
  } catch (e) {
    setUploadingState(false);
    alert("Erreur upload : " + (e?.message || e));
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
async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));

  onSnapshot(q, (snap) => {
    vids = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
}

main();
