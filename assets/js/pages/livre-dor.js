import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const canvas = document.getElementById("guestCanvas");
const ctx = canvas.getContext("2d");

const tool = document.getElementById("tool");
const fontSel = document.getElementById("font");
const textValue = document.getElementById("textValue");
const color = document.getElementById("color");
const size = document.getElementById("size");
const penSize = document.getElementById("penSize");

const undoBtn = document.getElementById("undo");
const clearBtn = document.getElementById("clear");
const exportBtn = document.getElementById("exportCanvasPng");

// bouton publier dessin
const publishBtn = document.createElement("button");
publishBtn.className = "btn";
publishBtn.textContent = "Publier dessin";
publishBtn.style.marginLeft = "8px";
undoBtn.parentElement.insertBefore(publishBtn, undoBtn);

let localStrokes = [];
let isDown = false;
let currentStroke = null;

let sharedItems = [];
const imageCache = new Map();

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}

function posFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const p = (e.touches?.[0]) || e;
  return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

function drawStroke(stroke) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawTextItem(it) {
  ctx.fillStyle = it.color || "#111";
  ctx.font = `${it.size || 28}px ${it.font || "Georgia, serif"}`;
  ctx.textBaseline = "top";
  ctx.fillText(it.text || "", it.x || 20, it.y || 20);
}

async function getImage(url) {
  if (!url) return null;
  if (imageCache.has(url)) return imageCache.get(url);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode().catch(() => {});
  imageCache.set(url, img);
  return img;
}

async function drawDrawingItem(it) {
  const img = await getImage(it.imageUrl);
  if (!img) return;
  const x = it.x || 20;
  const y = it.y || 20;
  const w = 260;
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  ctx.drawImage(img, x, y, w, h);
}

async function redraw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, rect.width, rect.height);

  for (const it of sharedItems) {
    if (it.kind === "text") drawTextItem(it);
    if (it.kind === "drawing") await drawDrawingItem(it);
  }

  for (const s of localStrokes) drawStroke(s);
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);

  if (tool.value === "pen") {
    isDown = true;
    const p = posFromEvent(e);
    currentStroke = { color: color.value, width: Number(penSize.value), points: [p] };
    localStrokes.push(currentStroke);
    redraw();
  } else {
    const txt = textValue.value.trim();
    if (!txt) return alert("Tape ton message, puis clique pour le placer");
    const p = posFromEvent(e);
    addDoc(collection(db, "guestbook"), {
      createdAt: Date.now(),
      kind: "text",
      x: p.x,
      y: p.y,
      text: txt,
      font: fontSel.value,
      size: Number(size.value),
      color: color.value,
      imageUrl: ""
    });
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!isDown || tool.value !== "pen") return;
  currentStroke.points.push(posFromEvent(e));
  redraw();
});

canvas.addEventListener("pointerup", () => {
  if (tool.value !== "pen") return;
  isDown = false;
  currentStroke = null;
});

undoBtn.addEventListener("click", () => {
  localStrokes.pop();
  redraw();
});

clearBtn.addEventListener("click", () => {
  localStrokes = [];
  redraw();
});

publishBtn.addEventListener("click", async () => {
  if (!localStrokes.length) return alert("Dessine quelque chose avant de publier 🙂");

  const rect = canvas.getBoundingClientRect();
  const off = document.createElement("canvas");
  off.width = Math.round(rect.width);
  off.height = Math.round(rect.height);
  const octx = off.getContext("2d");
  octx.clearRect(0,0,off.width,off.height);

  for (const s of localStrokes) {
    octx.lineCap = "round";
    octx.lineJoin = "round";
    octx.strokeStyle = s.color;
    octx.lineWidth = s.width;
    octx.beginPath();
    const pts = s.points;
    if (!pts.length) continue;
    octx.moveTo(pts[0].x, pts[0].y);
    for (let i=1;i<pts.length;i++) octx.lineTo(pts[i].x, pts[i].y);
    octx.stroke();
  }

  const blob = await new Promise((resolve) => off.toBlob(resolve, "image/png"));
  if (!blob) return;

  publishBtn.textContent = "Upload…";
  publishBtn.disabled = true;

  try {
    const file = new File([blob], `drawing-${Date.now()}.png`, { type: "image/png" });
    const up = await uploadImage(file);

    await addDoc(collection(db, "guestbook"), {
      createdAt: Date.now(),
      kind: "drawing",
      x: 24,
      y: 24,
      text: "",
      font: "",
      size: 0,
      color: "",
      imageUrl: up.secure_url
    });

    localStrokes = [];
    redraw();
  } catch (e) {
    alert("Erreur upload : " + e.message);
  } finally {
    publishBtn.textContent = "Publier dessin";
    publishBtn.disabled = false;
  }
});

exportBtn.addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = `livre-dor-${Date.now()}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
});

window.addEventListener("resize", resizeCanvas);

async function main() {
  await ensureAnonAuth();

  const q = query(collection(db, "guestbook"), orderBy("createdAt", "asc"));
  onSnapshot(q, async (snap) => {
    sharedItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    await redraw();
  });
}

resizeCanvas();
main();
