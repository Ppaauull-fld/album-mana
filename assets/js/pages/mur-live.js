import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage, uploadVideo } from "../cloudinary.js";
import { setBtnLoading } from "../ui.js";

import {
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const LIVE_COL = "liveWallPosts";
const NAME_KEY = "album-mana-live-name";

const form = document.getElementById("livePostForm");
const authorInput = document.getElementById("liveAuthor");
const messageInput = document.getElementById("liveMessage");
const fileInput = document.getElementById("liveFile");
const submitBtn = document.getElementById("liveSubmitBtn");
const wallGrid = document.getElementById("liveWallGrid");
const liveCount = document.getElementById("liveCount");
const liveEmpty = document.getElementById("liveEmpty");
const shareWhatsAppBtn = document.getElementById("shareWhatsAppBtn");

function formatDate(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function createMedia(post) {
  if (!post?.url) return null;

  if (post.kind === "image") {
    const img = document.createElement("img");
    img.className = "live-media";
    img.src = post.url;
    img.alt = `Contribution de ${post.author || "Famille"}`;
    return img;
  }

  if (post.kind === "video") {
    const video = document.createElement("video");
    video.className = "live-media";
    video.src = post.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    return video;
  }

  if (post.kind === "audio") {
    const audio = document.createElement("audio");
    audio.className = "live-audio";
    audio.src = post.url;
    audio.controls = true;
    audio.preload = "metadata";
    return audio;
  }

  return null;
}

function renderWall(posts) {
  if (!wallGrid || !liveEmpty || !liveCount) return;

  wallGrid.innerHTML = "";
  liveCount.textContent = `${posts.length} contribution${posts.length > 1 ? "s" : ""}`;
  liveEmpty.style.display = posts.length ? "none" : "block";

  for (const post of posts) {
    const card = document.createElement("article");
    card.className = "live-card";

    const head = document.createElement("div");
    head.className = "live-card-head";

    const author = document.createElement("strong");
    author.textContent = post.author || "Famille";

    const date = document.createElement("span");
    date.textContent = formatDate(post.createdAt);

    head.appendChild(author);
    head.appendChild(date);

    card.appendChild(head);

    const media = createMedia(post);
    if (media) card.appendChild(media);

    if (post.message) {
      const msg = document.createElement("p");
      msg.className = "live-message";
      msg.textContent = post.message;
      card.appendChild(msg);
    }

    wallGrid.appendChild(card);
  }
}

function getFileKind(file) {
  if (!file) return null;
  const type = file.type || "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return null;
}

async function uploadFile(file) {
  const kind = getFileKind(file);
  if (!kind) throw new Error("Format de fichier non supporte");

  if (kind === "image") {
    const up = await uploadImage(file);
    return { kind, url: up.secure_url, publicId: up.public_id || null };
  }

  const up = await uploadVideo(file);
  return { kind, url: up.secure_url, publicId: up.public_id || null };
}

async function publishPost(e) {
  e.preventDefault();

  const author = (authorInput?.value || "").trim();
  const message = (messageInput?.value || "").trim();
  const file = fileInput?.files?.[0] || null;

  if (!author) {
    alert("Ajoute ton prenom.");
    return;
  }
  if (!message && !file) {
    alert("Ajoute un message ou un media.");
    return;
  }

  try {
    localStorage.setItem(NAME_KEY, author);
  } catch {}

  setBtnLoading(submitBtn, true, { label: "Publication..." });

  try {
    const payload = {
      author,
      message,
      createdAt: Date.now(),
      kind: "text",
      url: null,
      publicId: null,
    };

    if (file) {
      const up = await uploadFile(file);
      payload.kind = up.kind;
      payload.url = up.url;
      payload.publicId = up.publicId;
    }

    await addDoc(collection(db, LIVE_COL), payload);

    messageInput.value = "";
    if (fileInput) fileInput.value = "";
  } catch (err) {
    console.error(err);
    alert("Publication impossible : " + (err?.message || err));
  } finally {
    setBtnLoading(submitBtn, false);
  }
}

function shareOnWhatsApp() {
  const url = window.location.href;
  const txt = `Rejoins le Mur Live de Mamie ici : ${url}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(txt)}`;
  window.open(wa, "_blank", "noopener,noreferrer");
}

async function main() {
  await ensureAnonAuth();

  try {
    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName && authorInput) authorInput.value = savedName;
  } catch {}

  form?.addEventListener("submit", publishPost);
  shareWhatsAppBtn?.addEventListener("click", shareOnWhatsApp);

  const q = query(collection(db, LIVE_COL), orderBy("createdAt", "desc"), limit(250));
  onSnapshot(q, (snap) => {
    const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderWall(posts);
  });
}

main().catch((err) => {
  console.error(err);
  alert("Erreur d'initialisation du Mur Live.");
});
