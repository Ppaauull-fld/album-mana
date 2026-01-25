import { ensureAnonAuth, db, onAuth, adminLogin, adminLogout, isAdmin } from "../firebase.js";
import { uploadImage, imageThumbUrl } from "../cloudinary.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const grid = document.getElementById("photosGrid");
const input = document.getElementById("photoInput");
const addBtn = document.getElementById("addPhotoBtn");
const showBtn = document.getElementById("startSlideshowBtn");

const sortMode = document.getElementById("sortMode");
const personFilter = document.getElementById("personFilter");
const dateFrom = document.getElementById("dateFrom");
const dateTo = document.getElementById("dateTo");

const adminBtn = document.getElementById("adminBtn");
const adminBadge = document.getElementById("adminBadge");

const uploader = document.getElementById("uploader");
const closeUploader = document.getElementById("closeUploader");
const fileList = document.getElementById("fileList");
const startUpload = document.getElementById("startUpload");

const slideshow = document.getElementById("slideshow");
const slideImg = document.getElementById("slideImg");
const slideCounter = document.getElementById("slideCounter");

let photos = [];
let filtered = [];
let queue = [];
let idx = 0;
let playing = true;
let timer = null;
let ADMIN = false;

function uniqPersons(items) {
  const s = new Set();
  for (const it of items) if (it.person) s.add(it.person);
  return [...s].sort((a,b)=>a.localeCompare(b));
}

function applyFilters() {
  const p = personFilter.value.trim();
  const from = dateFrom.value ? new Date(dateFrom.value).getTime() : null;
  const to = dateTo.value ? (new Date(dateTo.value).getTime() + 24*3600*1000 - 1) : null;

  filtered = photos.filter(x => {
    if (p && (x.person || "") !== p) return false;
    const t = x.takenAt || x.createdAt || 0;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });

  render();
}

function render() {
  grid.innerHTML = "";
  for (const p of filtered) {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.className = "thumb";
    img.src = p.thumbUrl || p.url;
    img.alt = p.person ? `photo ${p.person}` : "photo";
    card.appendChild(img);

    if (ADMIN) {
      const del = document.createElement("button");
      del.className = "delbtn";
      del.type = "button";
      del.title = "Supprimer";
      del.textContent = "🗑";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Supprimer cette photo ?")) return;
        await deleteDoc(doc(db, "photos", p.id));
      });
      card.appendChild(del);
    }

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
function buildQueue() { queue = shuffle(filtered.length ? filtered : photos); idx = 0; }

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
  idx = Math.max(0, idx - 1);
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

function openUploader() {
  uploader.classList.add("open");
}
function closeUploadUI() {
  uploader.classList.remove("open");
  fileList.innerHTML = "";
  input.value = "";
}

addBtn.addEventListener("click", () => input.click());
closeUploader.addEventListener("click", closeUploadUI);

input.addEventListener("change", async () => {
  const files = [...(input.files || [])];
  if (!files.length) return;

  fileList.innerHTML = "";

  for (const f of files) {
    const row = document.createElement("div");
    row.className = "fileitem";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(f);
    row.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "filemeta";

    const r1 = document.createElement("div");
    r1.className = "row";
    r1.innerHTML = `<div class="small">${f.name}</div>`;

    const r2 = document.createElement("div");
    r2.className = "row";

    const person = document.createElement("input");
    person.placeholder = "Personne (ex: Mamie)";
    person.style.padding = "9px 12px";
    person.style.borderRadius = "999px";
    person.style.border = "1px solid rgba(0,0,0,.10)";
    person.style.background = "rgba(255,255,255,.9)";
    person.style.outline = "none";
    person.style.fontSize = "13px";

    const date = document.createElement("input");
    date.type = "date";
    date.style.padding = "9px 12px";
    date.style.borderRadius = "999px";
    date.style.border = "1px solid rgba(0,0,0,.10)";
    date.style.background = "rgba(255,255,255,.9)";
    date.style.outline = "none";
    date.style.fontSize = "13px";

    r2.appendChild(person);
    r2.appendChild(date);

    const prog = document.createElement("div");
    prog.className = "progress";
    const bar = document.createElement("div");
    prog.appendChild(bar);

    meta.appendChild(r1);
    meta.appendChild(r2);
    meta.appendChild(prog);

    row.appendChild(meta);

    row._file = f;
    row._person = person;
    row._date = date;
    row._bar = bar;

    fileList.appendChild(row);
  }

  openUploader();
});

startUpload.addEventListener("click", async () => {
  const rows = [...fileList.querySelectorAll(".fileitem")];
  if (!rows.length) return;

  startUpload.disabled = true;
  addBtn.disabled = true;
  addBtn.textContent = "⏳ Upload…";

  try {
    await ensureAnonAuth();

    for (const row of rows) {
      const f = row._file;
      const person = row._person.value.trim();
      const takenAt = row._date.value ? new Date(row._date.value).getTime() : Date.now();

      const up = await uploadImage(f, (pct) => {
        if (pct == null) return;
        row._bar.style.width = `${pct}%`;
      });

      const thumb = imageThumbUrl(up.public_id);

      await addDoc(collection(db, "photos"), {
        type: "photo",
        createdAt: Date.now(),
        takenAt,
        person,
        publicId: up.public_id,
        url: up.secure_url,
        thumbUrl: thumb
      });

      row._bar.style.width = "100%";
    }

    closeUploadUI();
  } catch (e) {
    console.error(e);
    alert("Erreur upload : " + (e?.message || e));
  } finally {
    startUpload.disabled = false;
    addBtn.disabled = false;
    addBtn.textContent = "＋ Ajouter une photo";
  }
});

// Slideshow controls
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

// Filters UI
[personFilter, dateFrom, dateTo].forEach(el => el.addEventListener("change", applyFilters));

// Admin login
adminBtn.addEventListener("click", async () => {
  if (ADMIN) {
    await adminLogout();
    return;
  }
  const email = prompt("Email admin :");
  if (!email) return;
  const password = prompt("Mot de passe admin :");
  if (!password) return;
  try {
    await adminLogin(email, password);
  } catch (e) {
    alert("Login admin impossible : " + (e?.message || e));
  }
});

onAuth(async () => {
  ADMIN = await isAdmin().catch(() => false);
  adminBadge.style.display = ADMIN ? "inline-flex" : "none";
  adminBtn.textContent = ADMIN ? "Logout" : "Admin";
  render();
});

// Firestore live (sort mode)
function subscribe() {
  const mode = sortMode.value;
  const q = query(collection(db, "photos"), orderBy("createdAt", mode));
  return onSnapshot(q, (snap) => {
    photos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // persons dropdown
    const people = uniqPersons(photos);
    const current = personFilter.value;
    personFilter.innerHTML = `<option value="">Toutes</option>` + people.map(x => `<option value="${x}">${x}</option>`).join("");
    if (people.includes(current)) personFilter.value = current;

    applyFilters();
  });
}

let unsub = null;

sortMode.addEventListener("change", () => {
  if (unsub) unsub();
  unsub = subscribe();
});

(async function main() {
  await ensureAnonAuth();
  unsub = subscribe();
})();
