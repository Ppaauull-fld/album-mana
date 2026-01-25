import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo, uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("animatedGrid");
const input = document.getElementById("animatedInput");
const addBtn = document.getElementById("addAnimatedBtn");

let items = [];

function isGif(file) {
  return file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
}

function isVideo(file) {
  return file.type.startsWith("video/") ||
    /\.(mp4|webm|mov|m4v)$/i.test(file.name);
}

/**
 * Miniature automatique Cloudinary pour les vidéos :
 * on prend la secure_url video et on demande un frame en jpg.
 * Ex: .../video/upload/.../file.mp4 -> .../video/upload/so_0/.../file.jpg
 */
function cloudinaryVideoPoster(videoUrl) {
  try {
    if (!videoUrl.includes("/video/upload/")) return null;
    // insertion "so_0" (start offset) après /upload/
    const withTransform = videoUrl.replace("/upload/", "/upload/so_0/");
    // remplacer extension par .jpg
    return withTransform.replace(/\.[a-z0-9]+(\?.*)?$/i, ".jpg");
  } catch {
    return null;
  }
}

function render() {
  grid.innerHTML = "";

  for (const it of items) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = it.url;
    card.target = "_blank";
    card.rel = "noreferrer";
    card.title = "Ouvrir";

    const img = document.createElement("img");
    img.className = "thumb";

    // ✅ si vidéo: poster auto ; si gif: on affiche le gif direct
    if (it.kind === "video") {
      img.src = it.thumbUrl || cloudinaryVideoPoster(it.url) || it.url;
    } else {
      img.src = it.thumbUrl || it.url;
    }

    img.alt = "animé";

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
      // ✅ support mp4/webm/mov + gif
      if (!isGif(file) && !isVideo(file)) {
        alert(`Format non supporté : ${file.name}`);
        continue;
      }

      let up, kind;

      if (isGif(file)) {
        // GIF animé -> image upload (Cloudinary garde l’animation)
        up = await uploadImage(file);
        kind = "gif";
      } else {
        up = await uploadVideo(file);
        kind = "video";
      }

      const thumbUrl = kind === "video"
        ? (cloudinaryVideoPoster(up.secure_url) || up.secure_url)
        : up.secure_url;

      await addDoc(collection(db, "animated"), {
        createdAt: Date.now(),
        kind,                 // "video" | "gif"
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
  const q = query(collection(db, "animated"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
}

main();
