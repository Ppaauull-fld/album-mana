import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("videosGrid");
const input = document.getElementById("videoInput");
const addBtn = document.getElementById("addVideoBtn");

let vids = [];

function isVideo(file) {
  return file.type.startsWith("video/") ||
    /\.(mp4|webm|mov|m4v)$/i.test(file.name);
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

  for (const v of vids) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = v.url;
    card.target = "_blank";
    card.rel = "noreferrer";
    card.title = "Ouvrir";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = v.thumbUrl || cloudinaryVideoPoster(v.url) || v.url;
    img.alt = "vidéo";

    const badge = document.createElement("div");
    badge.className = "play-badge";
    badge.textContent = "▶";

    card.appendChild(img);
    card.appendChild(badge);
    grid.appendChild(card);
  }
}

addBtn.addEventListener("click", () => input.click());

input.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  input.value = "";
  if (!files.length) return;

  addBtn.disabled = true;

  try {
    for (const file of files) {
      if (!isVideo(file)) {
        alert(`Format non supporté : ${file.name}`);
        continue;
      }

      const up = await uploadVideo(file);
      const thumbUrl = cloudinaryVideoPoster(up.secure_url) || up.secure_url;

      await addDoc(collection(db, "videos"), {
        createdAt: Date.now(),
        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl
      });
    }
  } catch (e) {
    alert("Erreur upload : " + (e?.message || e));
  } finally {
    addBtn.disabled = false;
  }
});

async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    vids = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
}

main();
