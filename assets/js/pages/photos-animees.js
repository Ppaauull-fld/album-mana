import { ensureAnonAuth, db } from "../firebase.js";
import { uploadVideo } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("animatedGrid");
const input = document.getElementById("animatedInput");
const addBtn = document.getElementById("addAnimatedBtn");

let items = [];

function render() {
  grid.innerHTML = "";
  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = it.thumbUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='600'%3E%3Crect width='100%25' height='100%25' fill='%23000'/%3E%3C/svg%3E";
    img.alt = it.title || "photo animée";

    const badge = document.createElement("div");
    badge.className = "play-badge";
    badge.innerHTML = "<span>▶</span>";

    card.appendChild(img);
    card.appendChild(badge);

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
    const up = await uploadVideo(f);
    await addDoc(collection(db, "animated"), {
      type: "animated",
      createdAt: Date.now(),
      title: f.name,
      url: up.secure_url,
      thumbUrl: ""
    });
  } catch (e) {
    alert("Erreur upload : " + e.message);
  } finally {
    input.value = "";
    addBtn.textContent = "＋ Ajouter une photo animée";
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
