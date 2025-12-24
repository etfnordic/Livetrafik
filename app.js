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

const BUS_COLOR = "#0B0C10"; // nästan svart
const BUS_STROKE = "#000000";

function colorForRailLine(line) {
  const l = normalizeLine(line);

  if (l === "7") return "#878C85"; // Spårväg city
  if (l === "10" || l === "11") return "#0091D2"; // T-bana blå
  if (l === "12") return "#738BA4"; // Nockebybanan
  if (l === "13" || l === "14") return "#E31F26"; // T-bana röd
  if (l === "17" || l === "18" || l === "19") return "#00B259"; // T-bana grön
  if (l === "21") return "#B76934"; // Lidingöbanan
  if (l === "25" || l === "26") return "#21B6BA"; // Saltsjöbanan
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE"; // Roslagsbanan
  if (l === "30" || l === "31") return "#E08A32"; // Tvärbanan
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48")
    return "#ED66A5"; // Pendeltåg

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
function railArrowSvg(fillColor, strokeColor) {
  return `
    <svg width="34" height="34" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
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

// Bus “▶” triangle (mindre, enklare)
function busTriangleSvg(color) {
  return `
    <svg width="22" height="22" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M7 5 L19 12 L7 19 Z" fill="${color}" />
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
        ${railArrowSvg(color, stroke)}
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
  // vi roterar samma som rail (så “spetsen” pekar framåt)
  const rot = Number.isFinite(bearingDeg) ? bearingDeg + 90 : 0;

  const html = `
    <div style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
      <div style="transform: rotate(${rot}deg); width:22px; height:22px; display:flex; align-items:center; justify-content:center;">
        ${busTriangleSvg(BUS_COLOR)}
      </div>
    </div>
  `;

  return L.divIcon({
    className: "busIconWrap",
    html,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
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
   enrich: nu även type
----------------------------- */
function enrich(v) {
  if (!v?.tripId) return null;
  const info = TRIP_TO_LINE[v.tripId];
  if (!info?.line) return null;

  return {
    ...v,
    line: info.line,
    headsign: info.headsign ?? null,
    type: info.type ?? null, // <-- viktigt
  };
}

/* =========================================================
   FILTER + CHIP UI (med BUSS-toggle)
========================================================= */

const LS_KEY = "sl_live.selectedLines.v4";
const LS_BUS_KEY = "sl_live.busEnabled.v1";

/**
 * selectedLines:
 * - Tom Set => visa ALLA (för spårtrafik)
 * - "__NONE__" => visa INGA (för spårtrafik)
 * - Annars => visa bara linjerna i set (för spårtrafik)
 *
 * bussar styrs separat av busEnabled (eftersom det finns väldigt många linjer)
 */
let selectedLines = loadSelectedLines();
let busEnabled = loadBusEnabled();

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

  // Buss-chip, ingen undermeny
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

function loadBusEnabled() {
  try {
    const raw = localStorage.getItem(LS_BUS_KEY);
    if (raw == null) return true; // default: visa bussar när de väl finns
    return raw === "1";
  } catch {
    return true;
  }
}
function saveBusEnabled() {
  try {
    localStorage.setItem(LS_BUS_KEY, busEnabled ? "1" : "0");
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
  selectedLines = new Set();
  saveSelectedLines();
}

function isRailLineSelected(line) {
  const l = normalizeLine(line);
  if (isShowNone()) return false;
  if (selectedLines.size === 0) return true;
  return selectedLines.has(l);
}

function passesFilter(v) {
  // Bussar styrs av busEnabled
  if (v.type === 700) return busEnabled;

  // Spårtrafik styrs av selectedLines
  return isRailLineSelected(v.line);
}

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

function setRailSelectionFromSearch(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => normalizeLine(s))
    .filter((s) => s && s !== "__NONE__");

  if (parts.length === 0) return;

  selectedLines = new Set(parts);
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
    // Buss: ingen undermeny, bara toggle
    if (def.key === "bus") {
      const btn = makeChipButton({
        label: def.label,
        bg: def.chipBg,
        onClick: (e) => {
          e.stopPropagation();
          busEnabled = !busEnabled;
          saveBusEnabled();
          // stäng ev panel så det känns tydligt att buss-knappen inte har undermeny
          closeSubchipPanel();
          // om vi stänger av bussar: ta bort ev buss-markers direkt
          if (!busEnabled) removeAllVehiclesOfTypeNow(700);
          updateModeChipInactiveStates();
          refreshLive().catch(console.error);
        },
        classes: [],
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
      refreshLive().catch(console.error);
    })
  );

  rowEl.appendChild(
    makeMiniButton("Rensa", () => {
      setShowNone();
      // rensa spårtrafik nu
      removeAllRailNow();
      renderSubchips();
      updateModeChipInactiveStates();
    })
  );

  const searchWrap = document.createElement("div");
  searchWrap.className = "chipSearchWrap";

  searchInputEl = document.createElement("input");
  searchInputEl.className = "chipSearch";
  searchInputEl.type = "text";
  searchInputEl.placeholder = "Linje (14,17)…";

  searchBtnEl = document.createElement("button");
  searchBtnEl.type = "button";
  searchBtnEl.className = "chipSearchBtn";
  searchBtnEl.innerHTML = magnifierSvg();

  const runSearch = () => {
    const raw = searchInputEl.value;
    if (!raw || !raw.trim()) return;

    setRailSelectionFromSearch(raw);
    searchInputEl.value = "";

    renderSubchips();
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

    // Buss:
    if (key === "bus") {
      btn.classList.toggle("is-inactive", !busEnabled);
      btn.classList.toggle("is-activeMode", false);
      continue;
    }

    let anySelected = false;

    if (isShowNone()) anySelected = false;
    else if (selectedLines.size === 0) anySelected = true;
    else {
      for (const l of def.lines) {
        if (isRailLineSelected(l)) {
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

    btn.classList.toggle("is-unselected", !isRailLineSelected(line));
    subPanelEl.appendChild(btn);
  }

  updateModeChipInactiveStates();
}

/* =========================================================
   Marker lifecycle helpers
========================================================= */

function removeTrainCompletely(id) {
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

function removeAllVehiclesOfTypeNow(type) {
  for (const [id, m] of markers.entries()) {
    if (m?.lastV?.type !== type) continue;
    removeTrainCompletely(id);
  }
}

function removeAllRailNow() {
  for (const [id, m] of markers.entries()) {
    // behåll bussar
    if (m?.lastV?.type === 700) continue;
    removeTrainCompletely(id);
  }
}

/* =========================================================
   Upsert train/bus (samma logik + annan ikon för buss)
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

    // Uppdatera icon (buss = alltid busIcon, spår = railIcon + pop)
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

  // “Rensa” gäller bara spårtrafik – bussar kan fortfarande visas om bussEnabled = true
  for (const raw of data) {
    if (!raw?.id || raw.lat == null || raw.lon == null) continue;

    const v = enrich(raw);
    if (!v) continue;

    v.line = normalizeLine(v.line);
    knownLines.add(v.line);

    if (!passesFilter(v)) {
      if (markers.has(v.id)) removeTrainCompletely(v.id);
      continue;
    }

    seen.add(v.id);
    upsertVehicle(v);
  }

  for (const [id, m] of markers.entries()) {
    if (!seen.has(id)) removeTrainCompletely(id);
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
