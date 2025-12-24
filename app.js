import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev";

/* --- Poll + animation tuning --- */
const POLL_MS = 3000;
const ANIM_MIN_MS = 350;
const ANIM_MAX_MS = Math.min(POLL_MS * 0.85, 2500);

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
    'Tiles style by <a href="https://www.hotosm.org/">Humanitarian OpenStreetMap Team</a>',
}).addTo(map);

const markers = new Map();
const lastPos = new Map();
const lastBearing = new Map();
const bearingEstablished = new Map();

let timer = null;

/* ----------------------------
   Hover/Pin label-state
----------------------------- */
let hoverTrainId = null;
let hoverLabelMarker = null;

let pinnedTrainId = null;
let pinnedLabelMarker = null;

let isPointerOverTrain = false;

function buildLabelText(v) {
  return v.headsign ? `${v.line} → ${v.headsign}` : v.line;
}

function hideHoverLabel(trainId) {
  if (hoverTrainId !== trainId) return;
  if (pinnedTrainId === trainId) return;

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }
  hoverTrainId = null;
}

function showHoverLabel(v, pos) {
  if (pinnedTrainId === v.id) return;

  if (hoverTrainId && hoverTrainId !== v.id && hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }

  hoverTrainId = v.id;
  const icon = makeLabelIcon(v, buildLabelText(v), v.speedKmh, false);

  if (!hoverLabelMarker) {
    hoverLabelMarker = L.marker(pos, {
      icon,
      interactive: false,
      zIndexOffset: 2000,
    }).addTo(map);
  } else {
    hoverLabelMarker.setLatLng(pos);
    hoverLabelMarker.setIcon(icon);
  }
}

function togglePinnedLabel(v, pos) {
  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }
  isPointerOverTrain = false;

  if (pinnedTrainId === v.id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
    return;
  }

  if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);

  const icon = makeLabelIcon(v, buildLabelText(v), v.speedKmh, true);

  pinnedTrainId = v.id;
  pinnedLabelMarker = L.marker(pos, {
    icon,
    interactive: false,
    zIndexOffset: 2500,
  }).addTo(map);
}

map.on("click", () => {
  if (pinnedLabelMarker) {
    map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }

  closeSubchipPanel();
  isPointerOverTrain = false;
});

map.on("mousemove", () => {
  if (
    !isPointerOverTrain &&
    hoverTrainId &&
    hoverLabelMarker &&
    pinnedTrainId !== hoverTrainId
  ) {
    hideHoverLabel(hoverTrainId);
  }
});

/* ----------------------------
   Animation helpers
----------------------------- */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function computeAnimMs(fromLatLng, toLatLng) {
  const p1 = map.latLngToLayerPoint(fromLatLng);
  const p2 = map.latLngToLayerPoint(toLatLng);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const distPx = Math.sqrt(dx * dx + dy * dy);
  const ms = distPx * 7;
  return clamp(ms, ANIM_MIN_MS, ANIM_MAX_MS);
}

function animateTrainTo(m, toPos, durationMs, onFrame) {
  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  const from = m.arrowMarker.getLatLng();
  const to = L.latLng(toPos[0], toPos[1]);

  const dLat = Math.abs(from.lat - to.lat);
  const dLng = Math.abs(from.lng - to.lng);
  if (dLat < 1e-8 && dLng < 1e-8) {
    m.arrowMarker.setLatLng(to);
    onFrame?.(to);
    m.anim = null;
    return;
  }

  const start = performance.now();
  const anim = { raf: null };
  m.anim = anim;

  const step = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutCubic(t);

    const lat = from.lat + (to.lat - from.lat) * e;
    const lng = from.lng + (to.lng - from.lng) * e;
    const cur = L.latLng(lat, lng);

    m.arrowMarker.setLatLng(cur);
    onFrame?.(cur);

    if (t < 1) anim.raf = requestAnimationFrame(step);
    else {
      anim.raf = null;
      m.anim = null;
    }
  };

  anim.raf = requestAnimationFrame(step);
}

/* ----------------------------
   Utilities
----------------------------- */
function normalizeLine(rawLine) {
  const s = String(rawLine ?? "").trim();
  const m = s.match(/(\d+\s*[A-Z]+|\d+)/i);
  return (m ? m[1] : s).replace(/\s+/g, "").toUpperCase();
}

/* Bussfärg (chip + label + ikon) */
const BUS_COLOR = "#020224";

function colorForRailLine(line) {
  const l = normalizeLine(line);

  if (l === "7") return "#878C85";
  if (l === "10" || l === "11") return "#0091D2";
  if (l === "12") return "#738BA4";
  if (l === "13" || l === "14") return "#E31F26";
  if (l === "17" || l === "18" || l === "19") return "#00B259";
  if (l === "21") return "#B76934";
  if (l === "25" || l === "26") return "#21B6BA";
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE";
  if (l === "30" || l === "31") return "#E08A32";
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48")
    return "#ED66A5";

  return "#111827";
}

function darkenHex(hex, amount = 0.5) {
  const clamp255 = (v) => Math.max(0, Math.min(255, v));
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const dr = clamp255(Math.round(r * (1 - amount)));
  const dg = clamp255(Math.round(g * (1 - amount)));
  const db = clamp255(Math.round(b * (1 - amount)));

  return `#${dr.toString(16).padStart(2, "0")}${dg
    .toString(16)
    .padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

function headingFromPoints(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

/* ----------------------------
   Icons
----------------------------- */

// Rail arrow SVG (som tidigare)
function railArrowSvg(fillColor, strokeColor, sizePx = 34) {
  return `
    <svg width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 50 L92 10 L62 50 L92 90 Z"
        fill="${fillColor}"
        stroke="${strokeColor}"
        stroke-width="4"
        stroke-linejoin="round"
      />
    </svg>
  `;
}

function makeRailIcon(line, bearingDeg, pop = false) {
  const color = colorForRailLine(line);
  const stroke = darkenHex(color, 0.5);

  if (!Number.isFinite(bearingDeg)) {
    const html = `
      <div class="trainMarker" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
        <div class="trainDot" style="
          width: 16px; height: 16px;
          border-radius: 999px;
          background: ${color};
          border: 2px solid ${stroke};
        "></div>
      </div>
    `;
    return L.divIcon({
      className: "trainIconWrap",
      html,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  const rot = bearingDeg + 90;
  const popWrapClass = pop ? "trainMarkerPopWrap" : "";

  const html = `
    <div class="${popWrapClass}" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
      <div class="trainMarker" style="transform: rotate(${rot}deg);">
        ${railArrowSvg(color, stroke, 34)}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function makeBusIcon(bearingDeg) {
  // samma form som tåg men mindre + mörk färg
  const stroke = darkenHex(BUS_COLOR, 0.35);
  const rot = Number.isFinite(bearingDeg) ? bearingDeg + 90 : 0;
  const size = 22;

  const html = `
    <div style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
      <div style="transform: rotate(${rot}deg); width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center;">
        ${railArrowSvg(BUS_COLOR, stroke, size)}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "busIconWrap",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeLabelIcon(v, labelText, speedKmh, pinned = false) {
  const bg = v.type === 700 ? BUS_COLOR : colorForRailLine(v.line);
  const text = `${labelText}${fmtSpeed(speedKmh)}`;

  const cls = pinned
    ? "trainLabel trainLabelPos trainLabelPinned"
    : "trainLabel trainLabelPos trainLabelHover";

  return L.divIcon({
    className: "trainLabelWrap",
    html: `
      <div class="${cls}" style="background:${bg};">
        ${text}
      </div>
    `,
    iconAnchor: [0, 0],
  });
}

/* ----------------------------
   enrich: line + headsign + type
----------------------------- */
function enrich(v) {
  if (!v?.tripId) return null;
  const info = TRIP_TO_LINE[v.tripId];
  if (!info?.line) return null;

  return {
    ...v,
    line: info.line,
    headsign: info.headsign ?? null,
    type: info.type ?? null, // 700 buss, etc
  };
}

/* =========================================================
   FILTER + CHIP UI (bussar följer samma logik)
========================================================= */

const LS_KEY = "sl_live.selectedLines.v5";

// Special token för att kunna “visa bara bussar” utan att lista alla busslinjer
const BUS_TOKEN = "__BUS__";

/**
 * selectedLines:
 * - Tom Set => visa ALLT (spår + buss)
 * - "__NONE__" => visa inget
 * - Innehåller BUS_TOKEN => bussar är på i urvalet
 * - Innehåller vanliga linjer => visa bara dessa linjer (oavsett typ)
 *
 * Viktigt: om selectedLines INTE är tomt och INTE innehåller BUS_TOKEN
 *          så visas bussar bara om deras line finns i set.
 */
let selectedLines = loadSelectedLines();

const knownLines = new Set();

const MODE_DEFS = [
  {
    key: "metro",
    label: "Tunnelbana",
    chipBg:
      "linear-gradient(90deg,#00B259 0%,#00B259 33%,#E31F26 33%,#E31F26 66%,#0091D2 66%,#0091D2 100%)",
    lines: ["10", "11", "13", "14", "17", "18", "19"],
  },
  { key: "commuter", label: "Pendeltåg", chipBg: colorForRailLine("40"), lines: ["40", "41", "43", "43X", "48"] },
  { key: "tram", label: "Tvärbanan", chipBg: colorForRailLine("30"), lines: ["30", "31"] },
  { key: "roslags", label: "Roslagsbanan", chipBg: colorForRailLine("28"), lines: ["27", "27S", "28", "28S", "29"] },
  { key: "saltsjo", label: "Saltsjöbanan", chipBg: colorForRailLine("25"), lines: ["25", "26"] },
  { key: "lidingo", label: "Lidingöbanan", chipBg: colorForRailLine("21"), lines: ["21"] },
  { key: "nockeby", label: "Nockebybanan", chipBg: colorForRailLine("12"), lines: ["12"] },
  { key: "city", label: "Spårväg City", chipBg: colorForRailLine("7"), lines: ["7"] },
  { key: "bus", label: "Buss", chipBg: BUS_COLOR, lines: null },
];

function loadSelectedLines() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(normalizeLine) : []);
  } catch {
    return new Set();
  }
}
function saveSelectedLines() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...selectedLines]));
  } catch {}
}

function isShowNone() {
  return selectedLines.has("__NONE__");
}
function setShowNone() {
  selectedLines = new Set(["__NONE__"]);
  saveSelectedLines();
}
function setShowAll() {
  selectedLines = new Set(); // tom = allt
  saveSelectedLines();
}

function hasBusToken() {
  return selectedLines.has(BUS_TOKEN);
}

function isLineSelected(line) {
  const l = normalizeLine(line);
  if (isShowNone()) return false;
  if (selectedLines.size === 0) return true;
  return selectedLines.has(l);
}

/**
 * Filter-regler:
 * - "__NONE__": visa inget
 * - empty set: visa allt (inkl buss)
 * - non-empty:
 *   - spårtrafik: visa om line finns i set
 *   - buss:
 *        - om BUS_TOKEN finns => visa alla bussar
 *        - annars visa bara bussar vars line finns i set
 */
function passesFilter(v) {
  if (isShowNone()) return false;
  if (selectedLines.size === 0) return true;

  const l = normalizeLine(v.line);

  if (v.type === 700) {
    if (hasBusToken()) return true;
    return selectedLines.has(l);
  }

  return selectedLines.has(l);
}

/**
 * Toggle för spår-linjechips (undermenyer):
 * - Om “Rensa” eller “Visa alla”: sätt till {linje} (starta filtrering)
 * - Annars toggla linje i set
 */
function toggleRailLineSelection(line) {
  const l = normalizeLine(line);
  if (!l) return;

  if (isShowNone() || selectedLines.size === 0) {
    selectedLines = new Set([l]);
    saveSelectedLines();
    return;
  }

  if (selectedLines.has(l)) selectedLines.delete(l);
  else selectedLines.add(l);

  if (selectedLines.size === 0) {
    setShowNone();
    return;
  }

  saveSelectedLines();
}

/**
 * Buss-chip:
 * - Om Visa alla (empty): gör “visa bara bussar” => {BUS_TOKEN}
 * - Om Rensa (none): gör “visa bara bussar” => {BUS_TOKEN}
 * - Annars:
 *    - toggla BUS_TOKEN i set (så man kan ha “visa bussar + vissa spårlinjer”)
 *    - Om set blir tom efter toggling => visa inget (Rensa)
 */
function toggleBusMode() {
  if (selectedLines.size === 0 || isShowNone()) {
    selectedLines = new Set([BUS_TOKEN]);
    saveSelectedLines();
    return;
  }

  if (selectedLines.has(BUS_TOKEN)) selectedLines.delete(BUS_TOKEN);
  else selectedLines.add(BUS_TOKEN);

  if (selectedLines.size === 0) {
    setShowNone();
    return;
  }

  saveSelectedLines();
}

/**
 * Sök = “set selection”
 * - Om input innehåller enbart t.ex. "4" => { "4" } (visar bara buss 4 om den finns, och inga andra bussar)
 * - "14,17" => {"14","17"}
 * - "bus" => {BUS_TOKEN} (bonus)
 * - "bus,4" => {BUS_TOKEN,"4"} (visa alla bussar + även linje 4 (redundant men ok))
 */
function setSelectionFromSearch(raw) {
  const partsRaw = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  if (partsRaw.length === 0) return;

  const out = new Set();

  for (const p of partsRaw) {
    const low = p.toLowerCase();
    if (low === "bus" || low === "buss") {
      out.add(BUS_TOKEN);
      continue;
    }
    const norm = normalizeLine(p);
    if (norm && norm !== "__NONE__") out.add(norm);
  }

  if (out.size === 0) return;

  selectedLines = out;
  saveSelectedLines();
}

/* ----------------------------
   Chip DOM
----------------------------- */

let dockEl = null;
let rowEl = null;
let subPanelEl = null;
let subPanelModeKey = null;

let searchInputEl = null;
let searchBtnEl = null;

function ensureChipStylesOnce() {
  if (document.getElementById("chipDockStyles")) return;

  const style = document.createElement("style");
  style.id = "chipDockStyles";
  style.textContent = `
    .chipDock{
      position:absolute;
      top:10px;
      right:10px;
      z-index:9999;
      pointer-events:none;
      max-width:calc(100vw - 20px);
    }
    .chipRowTop{
      display:flex;
      flex-wrap:nowrap;
      gap:8px;
      align-items:center;
      justify-content:flex-end;
      overflow-x:auto;
      overflow-y:hidden;
      padding:2px;
      pointer-events:auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .chipRowTop::-webkit-scrollbar{ display:none; }

    .uiChipBtn{
      border:0;
      background:transparent;
      padding:0;
      cursor:pointer;
      user-select:none;
    }
    .uiChipBtn:active{ transform: translateY(1px); }

    .uiChipFace{
      border-radius: 10px;
      padding: 6px 10px;
      font: 600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:#fff;
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
      text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      white-space: nowrap;
    }

    .uiChipBtn.is-inactive .uiChipFace{
      background: rgba(120,120,120,0.30) !important;
      color: rgba(255,255,255,0.85);
      box-shadow: 0 6px 14px rgba(0,0,0,0.12);
      text-shadow:none;
      backdrop-filter: blur(1px);
    }

    .uiChipBtn.is-activeMode .uiChipFace{
      outline: 2px solid rgba(255,255,255,0.90);
      outline-offset: 1px;
    }

    .uiMiniBtn{
      border-radius: 10px;
      padding: 6px 10px;
      border: 0;
      cursor: pointer;
      font: 600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: #fff;
      background: rgba(17,24,39,0.65);
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
      white-space: nowrap;
    }
    .uiMiniBtn:active{ transform: translateY(1px); }

    .chipSearchWrap{
      display:flex;
      align-items:center;
      gap:6px;
      background: rgba(255,255,255,0.92);
      border-radius: 10px;
      padding: 4px 6px;
      box-shadow: 0 8px 16px rgba(0,0,0,0.18);
    }
    .chipSearch{
      width: 120px;
      border:0;
      outline:0;
      background: transparent;
      padding: 4px 6px;
      font: 600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:#111827;
    }
    .chipSearchBtn{
      border:0;
      background: rgba(17,24,39,0.10);
      border-radius: 8px;
      cursor:pointer;
      width: 26px;
      height: 26px;
      display:flex;
      align-items:center;
      justify-content:center;
    }
    .chipSearchBtn:hover{ background: rgba(17,24,39,0.16); }
    .chipSearchBtn:active{ transform: translateY(1px); }
    .chipSearchIcon{ width: 16px; height: 16px; opacity: 0.8; }

    .subPanel{
      position:absolute;
      z-index:10000;
      pointer-events:auto;
      display:none;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
      padding: 8px;
      background: rgba(255,255,255,0.18);
      backdrop-filter: blur(2px);
      border-radius: 12px;
    }
    .subPanel.is-open{ display:flex; }

    .uiChipBtn.is-unselected .uiChipFace{
      background: rgba(140,140,140,0.26) !important;
      color: rgba(255,255,255,0.85);
      box-shadow: 0 6px 14px rgba(0,0,0,0.12);
      text-shadow:none;
    }
  `;
  document.head.appendChild(style);
}

function ensureChipDock() {
  ensureChipStylesOnce();
  if (dockEl) return;

  dockEl = document.createElement("div");
  dockEl.className = "chipDock";

  rowEl = document.createElement("div");
  rowEl.className = "chipRowTop";
  dockEl.appendChild(rowEl);

  subPanelEl = document.createElement("div");
  subPanelEl.className = "subPanel";
  dockEl.appendChild(subPanelEl);

  document.body.appendChild(dockEl);

  document.addEventListener("click", (e) => {
    if (!subPanelEl.classList.contains("is-open")) return;
    const t = e.target;
    const clickedInside = dockEl.contains(t) || subPanelEl.contains(t);
    if (!clickedInside) closeSubchipPanel();
  });

  renderTopRow();
}

function makeChipButton({ label, bg, onClick, classes = [] }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = ["uiChipBtn", ...classes].join(" ");
  btn.innerHTML = `<div class="uiChipFace" style="background:${bg};">${label}</div>`;
  btn.addEventListener("click", onClick);
  return btn;
}

function makeMiniButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uiMiniBtn";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function magnifierSvg() {
  return `
    <svg class="chipSearchIcon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z" stroke="currentColor" stroke-width="2"/>
      <path d="M16.3 16.3 21 21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
}

function renderTopRow() {
  ensureChipDock();
  rowEl.innerHTML = "";

  for (const def of MODE_DEFS) {
    if (def.key === "bus") {
      const btn = makeChipButton({
        label: def.label,
        bg: def.chipBg,
        onClick: (e) => {
          e.stopPropagation();
          toggleBusMode();
          // buss-chip ska inte ha undermeny
          closeSubchipPanel();
          // om buss-token försvann och vi inte uttryckligen visar busslinjer -> ta bort bussmarkers direkt
          if (selectedLines.size !== 0 && !selectedLines.has(BUS_TOKEN)) {
            // vi kan fortfarande visa en busslinje om den finns i set, så vi tar inte bort “alla bussar” här.
            // refreshLive sköter det korrekt.
          }
          updateModeChipInactiveStates();
          refreshLive().catch(console.error);
        },
      });
      btn.dataset.mode = def.key;
      rowEl.appendChild(btn);
      continue;
    }

    const btn = makeChipButton({
      label: def.label,
      bg: def.chipBg,
      onClick: (e) => {
        e.stopPropagation();
        toggleSubchipPanel(def.key, btn);
      },
    });
    btn.dataset.mode = def.key;
    rowEl.appendChild(btn);
  }

  rowEl.appendChild(
    makeMiniButton("Visa alla", () => {
      setShowAll();
      renderSubchips();
      updateModeChipInactiveStates();
      refreshLive().catch(console.error);
    })
  );

  rowEl.appendChild(
    makeMiniButton("Rensa", () => {
      setShowNone();
      removeAllNow();
      renderSubchips();
      updateModeChipInactiveStates();
    })
  );

  const searchWrap = document.createElement("div");
  searchWrap.className = "chipSearchWrap";

  searchInputEl = document.createElement("input");
  searchInputEl.className = "chipSearch";
  searchInputEl.type = "text";
  searchInputEl.placeholder = "Linje (14,4)…";

  searchBtnEl = document.createElement("button");
  searchBtnEl.type = "button";
  searchBtnEl.className = "chipSearchBtn";
  searchBtnEl.innerHTML = magnifierSvg();

  const runSearch = () => {
    const raw = searchInputEl.value;
    if (!raw || !raw.trim()) return;

    setSelectionFromSearch(raw);
    searchInputEl.value = "";

    renderSubchips();
    updateModeChipInactiveStates();
    refreshLive().catch(console.error);
  };

  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  searchBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    runSearch();
  });

  searchWrap.appendChild(searchInputEl);
  searchWrap.appendChild(searchBtnEl);
  rowEl.appendChild(searchWrap);

  updateModeChipInactiveStates();
}

function updateModeChipInactiveStates() {
  for (const btn of rowEl.querySelectorAll("button[data-mode]")) {
    const key = btn.dataset.mode;
    const def = MODE_DEFS.find((d) => d.key === key);
    if (!def) continue;

    if (key === "bus") {
      // buss-chip är inaktivt om vi explicit filtrerar och varken BUS_TOKEN eller någon busslinje finns i set
      let active = true;
      if (isShowNone()) active = false;
      else if (selectedLines.size === 0) active = true;
      else {
        active = selectedLines.has(BUS_TOKEN);
        // Om vi filtrerar på en busslinje (t.ex. {4}) ska chipet inte se “inaktivt” ut
        if (!active) {
          for (const x of selectedLines) {
            if (x !== "__NONE__" && x !== BUS_TOKEN) {
              // kan vara busslinje eller spårlinje; vi kan inte veta här.
              // Men om användaren valt en siffra som är busslinje, vill de att chipet ska kännas aktivt.
              // Vi låter därför chipet vara aktivt om urvalet innehåller någon "vanlig linje".
              active = true;
              break;
            }
          }
        }
      }
      btn.classList.toggle("is-inactive", !active);
      btn.classList.toggle("is-activeMode", false);
      continue;
    }

    let anySelected = false;

    if (isShowNone()) anySelected = false;
    else if (selectedLines.size === 0) anySelected = true;
    else {
      for (const l of def.lines) {
        if (isLineSelected(l)) {
          anySelected = true;
          break;
        }
      }
    }

    btn.classList.toggle("is-inactive", !anySelected);
    btn.classList.toggle("is-activeMode", subPanelModeKey === key);
  }
}

function toggleSubchipPanel(modeKey, modeBtnEl) {
  ensureChipDock();

  if (subPanelEl.classList.contains("is-open") && subPanelModeKey === modeKey) {
    closeSubchipPanel();
    return;
  }

  subPanelModeKey = modeKey;

  const rect = modeBtnEl.getBoundingClientRect();
  const dockRect = dockEl.getBoundingClientRect();

  const top = rect.bottom - dockRect.top + 8;
  const left = rect.left - dockRect.left;

  subPanelEl.style.top = `${top}px`;
  subPanelEl.style.left = `${left}px`;

  renderSubchips();
  subPanelEl.classList.add("is-open");
  updateModeChipInactiveStates();
}

function closeSubchipPanel() {
  if (!subPanelEl) return;
  subPanelEl.classList.remove("is-open");
  subPanelModeKey = null;
  updateModeChipInactiveStates();
}

function renderSubchips() {
  ensureChipDock();
  subPanelEl.innerHTML = "";

  if (!subPanelModeKey) {
    updateModeChipInactiveStates();
    return;
  }

  const def = MODE_DEFS.find((d) => d.key === subPanelModeKey);
  if (!def || !def.lines) return;

  for (const line of def.lines.map(normalizeLine)) {
    const bg = colorForRailLine(line);
    const btn = makeChipButton({
      label: line,
      bg,
      onClick: (e) => {
        e.stopPropagation();
        toggleRailLineSelection(line);
        renderSubchips();
        updateModeChipInactiveStates();
        refreshLive().catch(console.error);
      },
    });

    btn.classList.toggle("is-unselected", !isLineSelected(line));
    subPanelEl.appendChild(btn);
  }

  updateModeChipInactiveStates();
}

/* =========================================================
   Marker lifecycle helpers
========================================================= */

function removeVehicleCompletely(id) {
  const m = markers.get(id);
  if (!m) return;

  if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);

  map.removeLayer(m.group);
  markers.delete(id);

  lastPos.delete(id);
  lastBearing.delete(id);
  bearingEstablished.delete(id);

  if (hoverTrainId === id) hideHoverLabel(id);

  if (pinnedTrainId === id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }
}

function removeAllNow() {
  for (const [id, m] of markers.entries()) {
    if (m.anim?.raf) cancelAnimationFrame(m.anim.raf);
    map.removeLayer(m.group);
    markers.delete(id);
  }
  lastPos.clear();
  lastBearing.clear();
  bearingEstablished.clear();

  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }
  if (pinnedLabelMarker) {
    map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
  }
}

/* =========================================================
   Upsert vehicle (rail/bus)
========================================================= */
function upsertVehicle(v) {
  v.line = normalizeLine(v.line);
  const pos = [v.lat, v.lon];

  let bearing = null;
  let establishedNow = false;

  if (Number.isFinite(v.bearing) && v.bearing > 0) {
    bearing = v.bearing;
    establishedNow = true;
  }

  const prev = lastPos.get(v.id);
  if (bearing == null && prev && prev.lat != null && prev.lon != null) {
    const moved =
      Math.abs(v.lat - prev.lat) > 0.00002 ||
      Math.abs(v.lon - prev.lon) > 0.00002;

    if (moved) {
      bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
      establishedNow = true;
    }
  }

  if (establishedNow) {
    bearingEstablished.set(v.id, true);
    lastBearing.set(v.id, bearing);
  }

  if (
    bearing == null &&
    bearingEstablished.get(v.id) === true &&
    lastBearing.has(v.id)
  ) {
    bearing = lastBearing.get(v.id);
  }

  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

  const hasBearingNow = Number.isFinite(bearing);

  if (!markers.has(v.id)) {
    const icon =
      v.type === 700
        ? makeBusIcon(hasBearingNow ? bearing : NaN)
        : makeRailIcon(v.line, hasBearingNow ? bearing : NaN, false);

    const group = L.layerGroup();
    const arrowMarker = L.marker(pos, {
      icon,
      interactive: true,
      zIndexOffset: 500,
    });

    arrowMarker.on("mouseover", () => {
      isPointerOverTrain = true;
      const m = markers.get(v.id);
      if (m?.lastV) showHoverLabel(m.lastV, m.lastPos);
    });

    arrowMarker.on("mouseout", () => {
      isPointerOverTrain = false;
      hideHoverLabel(v.id);
    });

    arrowMarker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      const m = markers.get(v.id);
      if (m?.lastV) togglePinnedLabel(m.lastV, m.lastPos);
    });

    group.addLayer(arrowMarker);
    group.addTo(map);

    markers.set(v.id, {
      group,
      arrowMarker,
      lastV: v,
      lastPos: pos,
      hasBearing: hasBearingNow,
      anim: null,
    });
  } else {
    const m = markers.get(v.id);

    const hadBearingBefore = m.hasBearing === true;
    const pop = !hadBearingBefore && hasBearingNow;

    m.lastV = v;
    m.lastPos = pos;
    m.hasBearing = hasBearingNow;

    if (v.type === 700) {
      m.arrowMarker.setIcon(makeBusIcon(hasBearingNow ? bearing : NaN));
    } else {
      m.arrowMarker.setIcon(makeRailIcon(v.line, hasBearingNow ? bearing : NaN, pop));
    }

    const from = m.arrowMarker.getLatLng();
    const to = L.latLng(pos[0], pos[1]);
    const dur = computeAnimMs(from, to);

    animateTrainTo(m, pos, dur, (curLatLng) => {
      if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
        hoverLabelMarker.setLatLng(curLatLng);
      }
      if (pinnedTrainId === v.id && pinnedLabelMarker) {
        pinnedLabelMarker.setLatLng(curLatLng);
      }
    });

    if (pinnedTrainId === v.id && pinnedLabelMarker) {
      pinnedLabelMarker.setIcon(makeLabelIcon(v, buildLabelText(v), v.speedKmh, true));
    }

    if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
      hoverLabelMarker.setIcon(makeLabelIcon(v, buildLabelText(v), v.speedKmh, false));
    }
  }
}

/* =========================================================
   refreshLive
========================================================= */
async function refreshLive() {
  if (document.visibilityState !== "visible") return;

  ensureChipDock();

  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const seen = new Set();

  // Om visa inget: städa och return
  if (isShowNone()) {
    removeAllNow();
    updateModeChipInactiveStates();
    renderSubchips();
    return;
  }

  for (const raw of data) {
    if (!raw?.id || raw.lat == null || raw.lon == null) continue;

    const v = enrich(raw);
    if (!v) continue;

    v.line = normalizeLine(v.line);
    knownLines.add(v.line);

    if (!passesFilter(v)) {
      if (markers.has(v.id)) removeVehicleCompletely(v.id);
      continue;
    }

    seen.add(v.id);
    upsertVehicle(v);
  }

  for (const [id] of markers.entries()) {
    if (!seen.has(id)) removeVehicleCompletely(id);
  }

  updateModeChipInactiveStates();
  renderSubchips();
}

/* =========================================================
   polling
========================================================= */
function startPolling() {
  stopPolling();
  timer = setInterval(() => refreshLive().catch(console.error), POLL_MS);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

startPolling();
refreshLive().catch(console.error);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startPolling();
    refreshLive().catch(console.error);
  } else {
    stopPolling();
  }
});
