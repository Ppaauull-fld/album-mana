import { ensureAnonAuth, db, onAuth, isAdmin } from "../firebase.js";
import { uploadVideo, videoThumbUrl } from "../cloudinary.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("animatedGrid");
const input = document.getElementById("animatedInput");
const addBtn = document.getElementById("addAnimatedBtn");

let items = [];
let ADMIN = false;

function render() {
  grid.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = it.thumbUrl || "";
    img.alt = it.title || "photo animée";

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
        if (!confirm("Supprimer cet élément ?")) return;
        await deleteDoc(doc(db, "animated", it.id));
      });
      card.appendChild(del);
    }

    card.addEventListener("click", () => window.open(it.url, "_blank", "noopener"));
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

    await addDoc(collection(db, "animated"), {
      type: "animated",
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
    addBtn.textContent = "＋ Ajouter une photo animée";
    addBtn.disabled = false;
  }
});

onAuth(async () => {
  ADMIN = await isAdmin().catch(() => false);
  render();
});

(async function main() {
  await ensureAnonAuth();
  const q = query(collection(db, "animated"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  });
})();
