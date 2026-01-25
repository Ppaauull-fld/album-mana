import { ensureAnonAuth, db, onAuth, adminLogin, adminLogout, isAdmin } from "../firebase.js";
import { uploadVideo, videoThumbUrl } from "../cloudinary.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("videosGrid");
const input = document.getElementById("videoInput");
const addBtn = document.getElementById("addVideoBtn");

let videos = [];
let ADMIN = false;

function render() {
  grid.innerHTML = "";
  for (const v of videos) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = v.thumbUrl || "";
    img.alt = v.title || "vidéo";

    const badge = document.createElement("div");
    badge.className = "play-badge";
    badge.innerHTML = "<span>▶</span>";

    card.appendChild(img);
    card.appendChild(badge);

    if (ADMIN) {
      const del = document.createElement("button");
      del.className = "delbtn";
      del.type = "button";
      del.title = "Supprimer";
      del.textContent = "🗑";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Supprimer cette vidéo ?")) return;
        await deleteDoc(doc(db, "videos", v.id));
      });
      card.appendChild(del);
    }

    card.addEventListener("click", () => window.open(v.url, "_blank", "noopener"));
    grid.appendChild(card);
  }
}

addBtn.addEventListener("click", () => input.click());

input.addEventListener("change", async () => {
  const f = input.files?.[0];
  if (!f) return;

  addBtn.textContent = "⏳ Upload…";
  addBtn.disabled = true;

  try {
    await ensureAnonAuth();
    const up = await uploadVideo(f);
    const thumb = videoThumbUrl(up.public_id);

    await addDoc(collection(db, "videos"), {
      type: "video",
      createdAt: Date.now(),
      title: f.name,
      publicId: up.public_id,
      url: up.secure_url,
      thumbUrl: thumb
    });
  } catch (e) {
    console.error(e);
    alert("Erreur upload : " + (e?.message || e));
  } finally {
    input.value = "";
    addBtn.textContent = "＋ Ajouter";
    addBtn.disabled = false;
  }
});

// Admin login minimal: même bouton que page photos (si tu veux l’ajouter à l’HTML, on le fera)
onAuth(async () => {
  ADMIN = await isAdmin().catch(() => false);
  render();
});

(async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "videos"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    videos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
})();
