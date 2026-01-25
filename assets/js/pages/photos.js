import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("photosGrid");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const showBtn = document.getElementById("startSlideshowBtn");

const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");

let photos = [];
let queue = [];
let idx = 0;
let playing = true;
let timer = null;

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
  if (!photos.length) return alert("Ajoute d'abord quelques photos 🙂");
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

addBtn.addEventListener("click", () => input.click());

input.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  if (!files.length) return;

  addBtn.textContent = "⏳ Upload…";
  addBtn.disabled = true;

  try {
    for (const f of files) {
      const up = await uploadImage(f);
      await addDoc(collection(db, "photos"), {
        type: "photo",
        createdAt: Date.now(),
        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl: up.secure_url
      });
    }
  } catch (e) {
    alert("Erreur upload : " + e.message);
  } finally {
    input.value = "";
    addBtn.textContent = "＋ Ajouter une photo";
    addBtn.disabled = false;
  }
});

showBtn.addEventListener("click", openShow);
document.getElementById("closeShow").addEventListener("click", closeShow);
document.getElementById("nextSlide").addEventListener("click", next);
document.getElementById("prevSlide").addEventListener("click", prev);
document.getElementById("togglePlay").addEventListener("click", () => {
  playing = !playing;
  document.getElementById("togglePlay").textContent = playing ? "⏸" : "▶";
});
document.addEventListener("keydown", (e) => {
  if (!slideshow.classList.contains("open")) return;
  if (e.key === "Escape") closeShow();
  if (e.key === "ArrowRight") next();
  if (e.key === "ArrowLeft") prev();
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
