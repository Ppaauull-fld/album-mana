import { ensureAnonAuth, db } from "../firebase.js";
import { uploadImage } from "../cloudinary.js";

import {
  collection, addDoc, onSnapshot, query, orderBy,
  doc, updateDoc, deleteDoc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const canvas = document.getElementById("guestCanvas");
const ctx = canvas.getContext("2d");

const toolTextBtn = document.getElementById("toolText");
const toolDrawBtn = document.getElementById("toolDraw");

const textControls = document.getElementById("textControls");
const drawControls = document.getElementById("drawControls");

const fontSel = document.getElementById("font");
const sizeInput = document.getElementById("size");
const colorInput = document.getElementById("color");
const boldBtn = document.getElementById("boldBtn");
const italicBtn = document.getElementById("italicBtn");
const underlineBtn = document.getElementById("underlineBtn");

const penSizeInput = document.getElementById("penSize");
const penColorInput = document.getElementById("penColor");
const publishBtn = document.getElementById("publish");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const deleteBtn = document.getElementById("deleteSelected");
const exportBtn = document.getElementById("exportCanvasPng");

const hint = document.getElementById("hint");

// editor robust
const editorShell = document.getElementById("editorShell");
const floatingEditor = document.getElementById("floatingEditor");
const editorOk = document.getElementById("editorOk");
const editorCancel = document.getElementById("editorCancel");

let mode = "text";
let items = [];
const imageCache = new Map();

let selectedId = null;
let drag = null;
const HANDLE_RADIUS = 14;
const MIN_W = 60;
const MIN_H = 40;

// drawing local
let isDrawing = false;
let currentStroke = null;
let strokes = [];
let redoStrokes = [];

// global undo/redo
const undoStack = [];
const redoStack = [];

// editor state
let editorState = null; // {mode:"create"|"edit", id?, x,y}

function setHint(t){ hint.textContent = t; }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function applyActive(btn,on){ btn.classList.toggle("active", !!on); }

function getTextStyle(){
  return {
    font: fontSel.value,
    size: Number(sizeInput.value || 32),
    color: colorInput.value,
    bold: boldBtn.classList.contains("active"),
    italic: italicBtn.classList.contains("active"),
    underline: underlineBtn.classList.contains("active")
  };
}

function buildFontCss(it){
  const parts = [];
  if (it.italic) parts.push("italic");
  if (it.bold) parts.push("700");
  parts.push(`${Number(it.size||32)}px`);
  parts.push(it.font || "Georgia");
  return parts.join(" ");
}

function measureTextBox(it){
  ctx.save();
  ctx.font = buildFontCss(it);
  const m = ctx.measureText(it.text || "");
  const w = Math.max(MIN_W, Math.ceil(m.width) + 24);
  const h = Math.max(MIN_H, Math.ceil((it.size||32) * 1.2) + 18);
  ctx.restore();
  return { w, h };
}

function dprResize(){
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  redraw();
}

function posFromEvent(e){
  const rect = canvas.getBoundingClientRect();
  const p = (e.touches?.[0]) || e;
  return { x: p.clientX - rect.left, y: p.clientY - rect.top };
}

function setMode(next){
  mode = next;

  toolTextBtn.classList.toggle("active", mode==="text");
  toolDrawBtn.classList.toggle("active", mode==="draw");
  toolTextBtn.setAttribute("aria-selected", mode==="text" ? "true":"false");
  toolDrawBtn.setAttribute("aria-selected", mode==="draw" ? "true":"false");

  textControls.style.display = mode==="text" ? "" : "none";
  drawControls.style.display = mode==="draw" ? "" : "none";

  hideEditor();

  setHint(mode==="text"
    ? "Texte : clique pour ajouter • Double clic pour éditer"
    : "Dessin : dessine • Annuler/Rétablir = traits • Publier pour ajouter"
  );

  updateButtons();
  redraw();
}

function updateButtons(){
  // priorité au dessin local en mode draw
  const hasLocal = mode==="draw" && (strokes.length > 0 || redoStrokes.length > 0);

  if (mode==="draw") {
    undoBtn.disabled = strokes.length === 0 && undoStack.length === 0;
    redoBtn.disabled = redoStrokes.length === 0 && redoStack.length === 0;
  } else {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  publishBtn.disabled = mode!=="draw" || strokes.length === 0;
  deleteBtn.disabled = !selectedId;
}

function drawBackground(){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
}

function drawStroke(s){
  ctx.lineCap="round";
  ctx.lineJoin="round";
  ctx.strokeStyle=s.color;
  ctx.lineWidth=s.width;
  ctx.beginPath();
  const pts=s.points;
  if(!pts.length) return;
  ctx.moveTo(pts[0].x,pts[0].y);
  for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x,pts[i].y);
  ctx.stroke();
}

function drawText(it){
  ctx.save();
  ctx.fillStyle = it.color || "#111";
  ctx.font = buildFontCss(it);
  ctx.textBaseline = "top";
  ctx.fillText(it.text || "", it.x, it.y);

  if (it.underline) {
    const m = ctx.measureText(it.text || "");
    const yLine = it.y + (Number(it.size||32) * 1.05);
    ctx.strokeStyle = it.color || "#111";
    ctx.lineWidth = Math.max(1, Math.round((Number(it.size||32))/18));
    ctx.beginPath();
    ctx.moveTo(it.x, yLine);
    ctx.lineTo(it.x + m.width, yLine);
    ctx.stroke();
  }
  ctx.restore();
}

async function getImage(url){
  if(imageCache.has(url)) return imageCache.get(url);
  const img=new Image();
  img.crossOrigin="anonymous";
  const p=new Promise((res,rej)=>{ img.onload=()=>res(img); img.onerror=rej; });
  img.src=url;
  imageCache.set(url,p);
  return p;
}

async function drawDrawing(it){
  if(!it.imageUrl) return;
  try{
    const img = await getImage(it.imageUrl);
    ctx.drawImage(img, it.x, it.y, it.w, it.h);
  }catch{}
}

function getSelectedItem(){
  return items.find(i=>i.id===selectedId) || null;
}

function drawSelectionBox(it){
  ctx.save();
  ctx.strokeStyle="rgba(0,0,0,.35)";
  ctx.lineWidth=1;
  ctx.setLineDash([6,5]);
  ctx.strokeRect(it.x,it.y,it.w,it.h);
  ctx.setLineDash([]);

  const hs=[
    ["nw", it.x, it.y],
    ["ne", it.x+it.w, it.y],
    ["se", it.x+it.w, it.y+it.h],
    ["sw", it.x, it.y+it.h],
  ];
  for(const [k,x,y] of hs){
    ctx.fillStyle="#fff";
    ctx.strokeStyle="rgba(0,0,0,.35)";
    ctx.beginPath();
    ctx.arc(x,y,7,0,Math.PI*2);
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

async function redraw(){
  drawBackground();

  for(const it of items){
    if(it.kind==="text") drawText(it);
    if(it.kind==="drawing") await drawDrawing(it);
  }

  for(const s of strokes) drawStroke(s);
  if(currentStroke) drawStroke(currentStroke);

  const sel=getSelectedItem();
  if(sel) drawSelectionBox(sel);

  updateButtons();
}

/* ---------- hit testing ---------- */

function handleHit(it,x,y){
  const corners=[
    ["nw", it.x, it.y],
    ["ne", it.x+it.w, it.y],
    ["se", it.x+it.w, it.y+it.h],
    ["sw", it.x, it.y+it.h],
  ];
  for(const [k,cx,cy] of corners){
    const dx=x-cx, dy=y-cy;
    if(Math.sqrt(dx*dx+dy*dy) <= HANDLE_RADIUS) return k;
  }
  return null;
}

function itemHit(x,y){
  for(let i=items.length-1;i>=0;i--){
    const it=items[i];
    if(x>=it.x && x<=it.x+it.w && y>=it.y && y<=it.y+it.h) return it;
  }
  return null;
}

/* ---------- Editor : IMPORTANT (fix "je ne peux pas écrire") ---------- */

function editorOpen(){
  return editorShell.style.display !== "none";
}

function showEditor(x,y, initial, state){
  editorState = { ...state, x, y };

  editorShell.style.display = "block";
  editorShell.style.left = `${x}px`;
  editorShell.style.top = `${y}px`;

  floatingEditor.value = initial || "";
  floatingEditor.focus({ preventScroll:true });

  // ✅ Quand l'éditeur est ouvert : on évite que le canvas capte les events
  canvas.classList.add("canvas-disabled");
}

function hideEditor(){
  editorShell.style.display = "none";
  editorState = null;
  canvas.classList.remove("canvas-disabled");
}

editorCancel.addEventListener("click", hideEditor);

// empêche que cliquer dans l'éditeur “retombe” sur le canvas (Safari)
editorShell.addEventListener("mousedown", (e)=>e.stopPropagation());
editorShell.addEventListener("touchstart", (e)=>{ e.stopPropagation(); }, { passive:false });

editorOk.addEventListener("click", async ()=>{
  if(!editorState) return;
  const txt=(floatingEditor.value||"").trim();
  if(!txt){ hideEditor(); return; }

  if(editorState.mode==="create"){
    const style=getTextStyle();
    const temp={ kind:"text", text:txt, x:editorState.x, y:editorState.y, ...style };
    const {w,h}=measureTextBox(temp);

    const ref = await addDoc(collection(db,"guestbook"), {
      kind:"text",
      createdAt: Date.now(),
      text: txt,
      x: editorState.x,
      y: editorState.y,
      w,h,
      ...style
    });

    // undo = delete this doc
    undoStack.push({ kind:"create", id: ref.id, data: null });
    redoStack.length = 0;
    selectedId = ref.id;
  }

  if(editorState.mode==="edit" && editorState.id){
    const beforeSnap = await getDoc(doc(db,"guestbook", editorState.id));
    const before = beforeSnap.data();
    const temp = { ...before, text: txt };
    const {w,h}=measureTextBox(temp);

    await updateDoc(doc(db,"guestbook", editorState.id), { text: txt, w, h });

    undoStack.push({
      kind:"update",
      id: editorState.id,
      before: { text: before.text, w: before.w, h: before.h },
      after:  { text: txt, w, h }
    });
    redoStack.length = 0;
  }

  hideEditor();
  redraw();
});

/* ---------- Undo/Redo (Ctrl+Z / Ctrl+Shift+Z semantics) ---------- */

async function applyAction(action, direction){
  // direction: "undo" means apply reverse, "redo" apply forward
  if(action.kind === "create"){
    if(direction === "undo"){
      const snap = await getDoc(doc(db,"guestbook", action.id));
      const data = snap.exists() ? snap.data() : null;
      await deleteDoc(doc(db,"guestbook", action.id));
      // push inverse into redo
      redoStack.push({ kind:"recreate", id: action.id, data });
      if(selectedId===action.id) selectedId=null;
    } else {
      // redo create not used (create pushes recreate)
    }
    return;
  }

  if(action.kind === "recreate"){
    if(direction === "undo"){
      // undo of recreate -> delete again
      await deleteDoc(doc(db,"guestbook", action.id));
      // back to redo stack? on renvoie action identique en redo
      redoStack.push(action);
    } else {
      // redo recreate -> recreate same id
      if(!action.data) return;
      await setDoc(doc(db,"guestbook", action.id), action.data);
      undoStack.push({ kind:"create", id: action.id, data: null });
    }
    return;
  }

  if(action.kind === "update"){
    const payload = direction === "undo" ? action.before : action.after;
    await updateDoc(doc(db,"guestbook", action.id), payload);
    if(direction === "undo") redoStack.push(action);
    else undoStack.push(action);
    return;
  }

  if(action.kind === "delete"){
    // delete action stores {id,data}
    if(direction === "undo"){
      await setDoc(doc(db,"guestbook", action.id), action.data);
      redoStack.push({ kind:"delete", id: action.id, data: action.data });
    } else {
      await deleteDoc(doc(db,"guestbook", action.id));
      undoStack.push({ kind:"delete", id: action.id, data: action.data });
    }
    return;
  }
}

async function undo(){
  // priorité aux strokes locaux si on est en draw et qu’il y en a
  if(mode==="draw" && strokes.length>0){
    const s = strokes.pop();
    redoStrokes.push(s);
    redraw();
    return;
  }

  const a = undoStack.pop();
  if(!a) return;
  // a.kind create/update/delete
  await applyAction(a, "undo");
  redraw();
}

async function redo(){
  // priorité aux redoStrokes locaux
  if(mode==="draw" && redoStrokes.length>0){
    const s = redoStrokes.pop();
    strokes.push(s);
    redraw();
    return;
  }

  const a = redoStack.pop();
  if(!a) return;

  // redoStack contient surtout recreate/update/delete
  if(a.kind==="recreate"){
    await applyAction(a, "redo");
  } else if (a.kind==="update"){
    // redo update = apply after
    await updateDoc(doc(db,"guestbook", a.id), a.after);
    undoStack.push(a);
  } else if (a.kind==="delete"){
    await deleteDoc(doc(db,"guestbook", a.id));
    undoStack.push(a);
  }

  redraw();
}

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

/* ---------- style buttons -> update selected text ---------- */

boldBtn.addEventListener("click", async ()=>{
  applyActive(boldBtn, !boldBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
italicBtn.addEventListener("click", async ()=>{
  applyActive(italicBtn, !italicBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});
underlineBtn.addEventListener("click", async ()=>{
  applyActive(underlineBtn, !underlineBtn.classList.contains("active"));
  await updateSelectedTextStyle();
});

fontSel.addEventListener("change", updateSelectedTextStyle);
sizeInput.addEventListener("change", updateSelectedTextStyle);
colorInput.addEventListener("change", updateSelectedTextStyle);

async function updateSelectedTextStyle(){
  const it=getSelectedItem();
  if(!it || it.kind!=="text") return;

  const beforeSnap = await getDoc(doc(db,"guestbook", it.id));
  const before = beforeSnap.data();

  const style=getTextStyle();
  const temp = { ...before, ...style };
  const {w,h}=measureTextBox(temp);

  await updateDoc(doc(db,"guestbook", it.id), { ...style, w, h });

  undoStack.push({
    kind:"update",
    id: it.id,
    before: { font: before.font, size: before.size, color: before.color, bold: before.bold, italic: before.italic, underline: before.underline, w: before.w, h: before.h },
    after:  { ...style, w, h }
  });
  redoStack.length=0;
  redraw();
}

/* ---------- pointer interactions ---------- */

async function onDown(e){
  if (editorOpen()) return; // ✅ ne rien faire si éditeur ouvert

  const {x,y} = posFromEvent(e);

  const hit = itemHit(x,y);
  if(hit){
    selectedId = hit.id;

    const h = handleHit(hit, x, y);
    drag = h
      ? { type:"resize", handle:h, startX:x, startY:y, orig:{...hit} }
      : { type:"move", startX:x, startY:y, orig:{...hit} };

    redraw();
    return;
  }

  selectedId = null;
  redraw();

  if(mode==="text"){
    showEditor(x,y,"",{ mode:"create" });
    return;
  }

  if(mode==="draw"){
    e.preventDefault();
    isDrawing = true;
    currentStroke = {
      color: penColorInput.value,
      width: Number(penSizeInput.value||6),
      points:[{x,y}]
    };
    // si on redessine après avoir annulé, on vide redoStrokes
    redoStrokes = [];
  }
}

async function onMove(e){
  if (editorOpen()) return;

  const {x,y} = posFromEvent(e);

  if(mode==="draw" && isDrawing && currentStroke){
    e.preventDefault();
    currentStroke.points.push({x,y});
    redraw();
    return;
  }

  if(!drag) return;
  const it=getSelectedItem();
  if(!it) return;

  const dx=x-drag.startX;
  const dy=y-drag.startY;

  if(drag.type==="move"){
    it.x = drag.orig.x + dx;
    it.y = drag.orig.y + dy;
  }else{
    let nx=drag.orig.x, ny=drag.orig.y, nw=drag.orig.w, nh=drag.orig.h;

    if(drag.handle.includes("e")) nw = drag.orig.w + dx;
    if(drag.handle.includes("s")) nh = drag.orig.h + dy;
    if(drag.handle.includes("w")) { nw = drag.orig.w - dx; nx = drag.orig.x + dx; }
    if(drag.handle.includes("n")) { nh = drag.orig.h - dy; ny = drag.orig.y + dy; }

    nw = clamp(nw, MIN_W, 5000);
    nh = clamp(nh, MIN_H, 5000);

    it.x=nx; it.y=ny; it.w=nw; it.h=nh;
  }
  redraw();
}

async function onUp(e){
  if (editorOpen()) return;

  if(mode==="draw" && isDrawing){
    isDrawing=false;
    if(currentStroke){
      strokes.push(currentStroke);
      currentStroke=null;
      redraw();
    }
    return;
  }

  if(!drag) return;

  const it=getSelectedItem();
  const orig=drag.orig;
  drag=null;
  if(!it) return;

  const changed = it.x!==orig.x || it.y!==orig.y || it.w!==orig.w || it.h!==orig.h;
  if(!changed) return;

  try{
    await updateDoc(doc(db,"guestbook", it.id), { x: it.x, y: it.y, w: it.w, h: it.h });
    undoStack.push({
      kind:"update",
      id: it.id,
      before: { x: orig.x, y: orig.y, w: orig.w, h: orig.h },
      after:  { x: it.x, y: it.y, w: it.w, h: it.h }
    });
    redoStack.length=0;
  }catch{
    alert("Impossible de déplacer/redimensionner (règles Firestore ?).");
  }
  redraw();
}

canvas.addEventListener("mousedown", onDown);
canvas.addEventListener("mousemove", onMove);
window.addEventListener("mouseup", onUp);

canvas.addEventListener("touchstart", onDown, { passive:false });
canvas.addEventListener("touchmove", onMove, { passive:false });
window.addEventListener("touchend", onUp, { passive:false });

canvas.addEventListener("dblclick", (e)=>{
  if (editorOpen()) return;
  const {x,y}=posFromEvent(e);
  const hit=itemHit(x,y);
  if(!hit || hit.kind!=="text") return;
  selectedId=hit.id;
  redraw();
  showEditor(hit.x, hit.y, hit.text||"", { mode:"edit", id: hit.id });
});

/* ---------- delete selected ---------- */

deleteBtn.addEventListener("click", async ()=>{
  if(!selectedId) return;
  if(!confirm("Supprimer cet élément ?")) return;

  const it=getSelectedItem();
  if(!it) return;

  try{
    const snap = await getDoc(doc(db,"guestbook", it.id));
    const data = snap.data();
    await deleteDoc(doc(db,"guestbook", it.id));

    undoStack.push({ kind:"delete", id: it.id, data });
    redoStack.length=0;

    selectedId=null;
    redraw();
  }catch{
    alert("Suppression impossible (règles Firestore ?).");
  }
});

/* ---------- publish drawing ---------- */

publishBtn.addEventListener("click", async ()=>{
  if(mode!=="draw" || !strokes.length) return;

  publishBtn.disabled=true;
  publishBtn.textContent="⏳";

  try{
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for(const s of strokes){
      for(const p of s.points){
        minX=Math.min(minX,p.x); minY=Math.min(minY,p.y);
        maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y);
      }
    }
    const pad=18;
    minX=Math.max(0,minX-pad); minY=Math.max(0,minY-pad);

    const rect=canvas.getBoundingClientRect();
    maxX=Math.min(rect.width,maxX+pad);
    maxY=Math.min(rect.height,maxY+pad);

    const w=Math.max(80,maxX-minX);
    const h=Math.max(80,maxY-minY);

    const off=document.createElement("canvas");
    off.width=Math.round(w);
    off.height=Math.round(h);
    const octx=off.getContext("2d");

    octx.fillStyle="#fff";
    octx.fillRect(0,0,off.width,off.height);

    for(const s of strokes){
      octx.lineCap="round"; octx.lineJoin="round";
      octx.strokeStyle=s.color;
      octx.lineWidth=s.width;
      octx.beginPath();
      const pts=s.points;
      octx.moveTo(pts[0].x-minX, pts[0].y-minY);
      for(let i=1;i<pts.length;i++) octx.lineTo(pts[i].x-minX, pts[i].y-minY);
      octx.stroke();
    }

    const blob=await new Promise(res=>off.toBlob(res,"image/png"));
    const file=new File([blob],`dessin-${Date.now()}.png`,{type:"image/png"});
    const up=await uploadImage(file);

    const ref=await addDoc(collection(db,"guestbook"),{
      kind:"drawing",
      createdAt:Date.now(),
      imageUrl: up.secure_url,
      x:minX,y:minY,w,h
    });

    undoStack.push({ kind:"create", id: ref.id, data:null });
    redoStack.length=0;

    strokes=[];
    redoStrokes=[];
    selectedId=ref.id;
    redraw();
  }catch(e){
    alert("Erreur publication : " + (e?.message || e));
  }finally{
    publishBtn.disabled=false;
    publishBtn.textContent="Publier";
  }
});

/* ---------- export ---------- */

exportBtn.addEventListener("click", async ()=>{
  await redraw();
  const a=document.createElement("a");
  a.href=canvas.toDataURL("image/png");
  a.download=`livre-dor-${Date.now()}.png`;
  a.click();
});

/* ---------- tool buttons ---------- */

toolTextBtn.addEventListener("click", ()=>setMode("text"));
toolDrawBtn.addEventListener("click", ()=>setMode("draw"));

/* ---------- keyboard ---------- */

document.addEventListener("keydown", (e)=>{
  if (editorOpen()) {
    if (e.key==="Escape") hideEditor();
    if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); editorOk.click(); }
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==="z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
});

/* ---------- Firestore realtime ---------- */

async function main(){
  await ensureAnonAuth();

  const q=query(collection(db,"guestbook"), orderBy("createdAt","asc"));
  onSnapshot(q, (snap)=>{
    items = snap.docs.map(d=>({ id:d.id, ...d.data() }))
      .map(it=>{
        if(typeof it.x!=="number") it.x=40;
        if(typeof it.y!=="number") it.y=40;

        if(it.kind==="text"){
          it.bold=!!it.bold;
          it.italic=!!it.italic;
          it.underline=!!it.underline;

          if(typeof it.w!=="number" || typeof it.h!=="number"){
            const b=measureTextBox(it);
            it.w=b.w; it.h=b.h;
          }
        }

        if(it.kind==="drawing"){
          if(typeof it.w!=="number") it.w=240;
          if(typeof it.h!=="number") it.h=160;
        }
        return it;
      });

    if(selectedId && !items.some(i=>i.id===selectedId)) selectedId=null;
    redraw();
  });

  dprResize();
  window.addEventListener("resize", dprResize);
  setMode("text");
}
main();
