import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev"; // worker root (returnerar array)

/* --- Poll + animation tuning --- */
const POLL_MS = 3000; // behåll 3000 om du vill (ändra till 10000 när du behöver)
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
const lastPos = new Map(); // {lat, lon, ts}
const lastBearing = new Map(); // bearingDeg
const bearingEstablished = new Map(); // boolean per train id

let timer = null;

/* ----------------------------
   Hover/Pin label-state
----------------------------- */
let hoverTrainId = null;
let hoverLabelMarker = null;

let pinnedTrainId = null;
let pinnedLabelMarker = null;

// robust hover-state (för att garantera att labeln försvinner)
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
  if (pinnedTrainId === v.id) return; // rör inte pinnad label

  // ta bort tidigare hover-label om vi byter tåg
  if (hoverTrainId && hoverTrainId !== v.id && hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
  }

  hoverTrainId = v.id;

  // hover label får "hover"-klass (svagare skugga i CSS)
  const icon = makeLabelIcon(v.line, buildLabelText(v), v.speedKmh, false);

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
  // Ta bort hover-label direkt när vi klickar (så inga “spöken”/dubbla labels)
  if (hoverLabelMarker) {
    map.removeLayer(hoverLabelMarker);
    hoverLabelMarker = null;
    hoverTrainId = null;
  }
  isPointerOverTrain = false;

  // Klick på samma tåg -> avpinna
  if (pinnedTrainId === v.id) {
    if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
    pinnedLabelMarker = null;
    pinnedTrainId = null;
    return;
  }

  // Ny pin -> ta bort gammal pin
  if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);

  // pinned label får "pinned"-klass (starkare skugga i CSS)
  const icon = makeLabelIcon(v.line, buildLabelText(v), v.speedKmh, true);

  pinnedTrainId = v.id;
  pinnedLabelMarker = L.marker(pos, {
    icon,
    interactive: false,
    zIndexOffset: 2500,
  }).addTo(map);
}

// klick på kartbakgrund -> avpinna + städa hover
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

  isPointerOverTrain = false;
});

// failsafe: om Leaflet/DOM missar mouseout så städar vi ändå
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
   Animation helpers (NYTT)
----------------------------- */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// duration baserat på pixelavstånd (känns konstant oavsett zoom)
function computeAnimMs(fromLatLng, toLatLng) {
  const p1 = map.latLngToLayerPoint(fromLatLng);
  const p2 = map.latLngToLayerPoint(toLatLng);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const distPx = Math.sqrt(dx * dx + dy * dy);

  // tweak: 5..10 ms per pixel
  const ms = distPx * 7;
  return clamp(ms, ANIM_MIN_MS, ANIM_MAX_MS);
}

// animera marker mellan två positioner, och låt labels följa med per frame
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

    if (t < 1) {
      anim.raf = requestAnimationFrame(step);
    } else {
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

function colorForLine(line) {
  const l = normalizeLine(line);
  // Spårväg city
  if (l === "7") return "#878C85";
  // Tunnelbanan blå linje
  if (l === "10" || l === "11") return "#0091D2";
  // Nockebybanan
  if (l === "12") return "#738BA4";
  // Tunnelbanan röd linje
  if (l === "13" || l === "14") return "#E31F26";
  // Tunnelbanan grön linje
  if (l === "17" || l === "18" || l === "19") return "#00B259";
  // Lidingöbanan
  if (l === "21") return "#B76934";
  // Saltsjöbanan
  if (l === "25" || l === "26") return "#21B6BA";
  // Roslagsbanan
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE";
  // Tvärbanan
  if (l === "30" || l === "31") return "#E08A32";
  // Pendeltåg
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

function arrowSvg(fillColor, strokeColor) {
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

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

/**
 * Icon: cirkel (innan bearing) eller pil (när bearing finns).
 * pop=true används när ett tåg går från cirkel -> pil första gången.
 */
function makeArrowIcon(line, bearingDeg, pop = false) {
  const color = colorForLine(line);
  const stroke = darkenHex(color, 0.5);

  // Ingen bearing => cirkel
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

  // Viktigt: pop-animation på wrapper (inte på rotate-diven)
  const html = `
    <div class="${popWrapClass}" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
      <div class="trainMarker" style="transform: rotate(${rot}deg);">
        ${arrowSvg(color, stroke)}
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

/**
 * Label ovanför tåget.
 * pinned=false => hover-stil
 * pinned=true  => pinnad-stil
 */
function makeLabelIcon(line, labelText, speedKmh, pinned = false) {
  const color = colorForLine(line);
  const text = `${labelText}${fmtSpeed(speedKmh)}`;

  const cls = pinned
    ? "trainLabel trainLabelPos trainLabelPinned"
    : "trainLabel trainLabelPos trainLabelHover";

  return L.divIcon({
    className: "trainLabelWrap",
    html: `
      <div class="${cls}" style="background:${color};">
        ${text}
      </div>
    `,
    iconAnchor: [0, 0],
  });
}

function enrich(v) {
  if (!v?.tripId) return null;
  const info = TRIP_TO_LINE[v.tripId];
  if (!info?.line) return null;

  return {
    ...v,
    line: info.line,
    headsign: info.headsign ?? null,
  };
}

/* =========================================================
   FILTER + CHIP UI (NYTT)
   - modes uppe till höger
   - underchips per linje
   - fritext input
========================================================= */

const LS_KEY = "sl_live.selectedLines.v1";

/**
 * selectedLines:
 * - Tom Set => visa ALLA
 * - Annars => visa bara de linjer som finns i set
 */
let selectedLines = loadSelectedLines();
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

function isLineSelected(line) {
  const l = normalizeLine(line);
  if (selectedLines.size === 0) return true; // visa allt
  return selectedLines.has(l);
}

function passesFilter(v) {
  return isLineSelected(v.line);
}

// Linjer per trafikslag (som du bad om)
const MODE_DEFS = [
  {
    key: "metro",
    label: "Tunnelbana",
    modeColor: "linear-gradient(90deg,#00B259 0%,#00B259 33%,#E31F26 33%,#E31F26 66%,#0091D2 66%,#0091D2 100%)",
    lines: ["10", "11", "13", "14", "17", "18", "19"],
  },
  {
    key: "commuter",
    label: "Pendeltåg",
    modeColor: colorForLine("40"),
    lines: ["40", "41", "43", "43X", "48"],
  },
  {
    key: "tram",
    label: "Tvärbanan",
    modeColor: colorForLine("30"),
    lines: ["30", "31"],
  },
  {
    key: "roslags",
    label: "Roslagsbanan",
    modeColor: colorForLine("28"),
    lines: ["27", "27S", "28", "28S", "29"],
  },
  {
    key: "saltsjo",
    label: "Saltsjöbanan",
    modeColor: colorForLine("25"),
    lines: ["25", "26"],
  },
  {
    key: "lidingo",
    label: "Lidingöbanan",
    modeColor: colorForLine("21"),
    lines: ["21"],
  },
  {
    key: "nockeby",
    label: "Nockebybanan",
    modeColor: colorForLine("12"),
    lines: ["12"],
  },
  {
    key: "city",
    label: "Spårväg City",
    modeColor: colorForLine("7"),
    lines: ["7"],
  },
];

const knownLines = new Set(); // fylls från live-feeden (för att kunna “auto-visa” nya linjer)
let activeModeKey = null;

function ensureChipStylesOnce() {
  if (document.getElementById("chipDockStyles")) return;

  const style = document.createElement("style");
  style.id = "chipDockStyles";
  style.textContent = `
    .chipDock{
      position:absolute;
      top:12px;
      right:12px;
      z-index:9999;
      display:flex;
      flex-direction:column;
      gap:8px;
      align-items:flex-end;
      pointer-events:none;
    }
    .chipRow{
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      justify-content:flex-end;
      max-width:min(560px, calc(100vw - 24px));
      pointer-events:auto;
    }
    .chipRow--sub{
      opacity:0;
      transform:translateY(-6px);
      pointer-events:none;
      transition:160ms ease;
    }
    .chipRow--sub.is-open{
      opacity:1;
      transform:translateY(0);
      pointer-events:auto;
    }
    .chipRow--search{
      display:flex;
      gap:8px;
      align-items:center;
    }
    .chipSearch{
      border-radius:999px;
      border:0;
      outline:0;
      padding:8px 12px;
      font:600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:#111827;
      background:rgba(255,255,255,0.92);
      box-shadow:0 8px 18px rgba(0,0,0,0.18);
      width:min(220px, calc(100vw - 24px));
    }
    .chipHint{
      font:600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color:rgba(255,255,255,0.9);
      text-shadow:0 1px 2px rgba(0,0,0,0.35);
      padding:0 4px;
      user-select:none;
    }
    /* Återanvänd din “tåg-label” look */
    .uiChipBtn{
      border:0;
      background:transparent;
      padding:0;
      cursor:pointer;
    }
    .uiChipBtn:active{
      transform:translateY(1px);
    }
    .uiChip{
      display:inline-flex;
      align-items:center;
      gap:8px;
    }
    .uiChip.is-selected .trainLabel{
      outline:2px solid rgba(255,255,255,0.95);
      outline-offset:1px;
    }
    .uiChipSmall .trainLabel{
      padding:6px 10px;
      font-weight:800;
    }
  `;
  document.head.appendChild(style);
}

let chipDockEl = null;
let modeRowEl = null;
let searchRowEl = null;
let lineRowEl = null;
let searchInputEl = null;

function ensureChipDock() {
  ensureChipStylesOnce();
  if (chipDockEl) return;

  chipDockEl = document.createElement("div");
  chipDockEl.className = "chipDock";

  // Rad 1: modes
  modeRowEl = document.createElement("div");
  modeRowEl.className = "chipRow";
  chipDockEl.appendChild(modeRowEl);

  // Rad 2: sök
  searchRowEl = document.createElement("div");
  searchRowEl.className = "chipRow chipRow--search";
  chipDockEl.appendChild(searchRowEl);

  searchInputEl = document.createElement("input");
  searchInputEl.className = "chipSearch";
  searchInputEl.type = "text";
  searchInputEl.placeholder = "Skriv linje (t.ex. 14, 43X)…";

  const hint = document.createElement("div");
  hint.className = "chipHint";
  hint.textContent = "Enter = toggle";

  searchRowEl.appendChild(searchInputEl);
  searchRowEl.appendChild(hint);

  // Rad 3: underchips
  lineRowEl = document.createElement("div");
  lineRowEl.className = "chipRow chipRow--sub";
  chipDockEl.appendChild(lineRowEl);

  document.body.appendChild(chipDockEl);

  // events: sök
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const raw = searchInputEl.value;
    const l = normalizeLine(raw);
    if (!l) return;

    toggleLineSelection(l);
    searchInputEl.value = "";

    // Uppdatera chips + karta direkt
    renderLineChips();
    refreshLive().catch(console.error);
  });

  renderModeChips();
  renderLineChips();
}

function makeModeChip(def) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uiChipBtn uiChip";
  btn.dataset.mode = def.key;

  // Vi använder samma CSS-klass som dina labels (trainLabel...)
  const html = `
    <div class="trainLabel" style="
      background:${def.modeColor};
      border-radius:999px;
      padding:8px 12px;
      font-weight:800;
      box-shadow:0 10px 20px rgba(0,0,0,0.22);
    ">
      ${def.label}
    </div>
  `;
  btn.innerHTML = html;

  btn.addEventListener("click", () => {
    activeModeKey = activeModeKey === def.key ? null : def.key;
    renderModeSelectedState();
    renderLineChips();
  });

  return btn;
}

function makeLineChip(line) {
  const l = normalizeLine(line);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uiChipBtn uiChip uiChipSmall";
  btn.dataset.line = l;

  const bg = colorForLine(l);
  const html = `
    <div class="trainLabel" style="
      background:${bg};
      border-radius:999px;
      padding:7px 11px;
      font-weight:900;
      box-shadow:0 10px 20px rgba(0,0,0,0.22);
    ">
      ${l}
    </div>
  `;
  btn.innerHTML = html;

  btn.addEventListener("click", () => {
    toggleLineSelection(l);
    renderLineChips();
    refreshLive().catch(console.error);
  });

  // selected state
  btn.classList.toggle("is-selected", isLineSelected(l));
  return btn;
}

function renderModeChips() {
  ensureChipDock();
  modeRowEl.innerHTML = "";
  for (const def of MODE_DEFS) {
    modeRowEl.appendChild(makeModeChip(def));
  }
  renderModeSelectedState();
}

function renderModeSelectedState() {
  if (!modeRowEl) return;
  for (const el of modeRowEl.querySelectorAll("button[data-mode]")) {
    el.classList.toggle("is-selected", el.dataset.mode === activeModeKey);
  }
}

function linesForActiveMode() {
  if (!activeModeKey) return [];

  const def = MODE_DEFS.find((d) => d.key === activeModeKey);
  if (!def) return [];

  // Bas-lista (exakt som du bad om)
  const base = def.lines.map(normalizeLine);

  // Plus: om live-feeden råkar innehålla något extra som matchar färg-mappningen
  // (så du slipper “varför finns inte X?” om API:t plötsligt skickar mer)
  const extras = [];
  for (const l of knownLines) {
    const nl = normalizeLine(l);
    if (!base.includes(nl) && colorForLine(nl) !== "#111827") {
      // bara ta med sådana vi känner färg för
      // och som “hör hemma” i samma def om den matchar en av basfärgerna? (försiktigt)
      // Här: lägg inte till automatiskt i fel mode.
    }
  }

  // Just nu: håll det strikt enligt def.lines (tydligast UI)
  const out = base;

  // sort: numeriskt först
  out.sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    const fa = Number.isFinite(na);
    const fb = Number.isFinite(nb);
    if (fa && fb) return na - nb || a.localeCompare(b);
    if (fa) return -1;
    if (fb) return 1;
    return a.localeCompare(b);
  });

  return out;
}

function renderLineChips() {
  ensureChipDock();
  lineRowEl.innerHTML = "";

  if (!activeModeKey) {
    lineRowEl.classList.remove("is-open");
    return;
  }

  const lines = linesForActiveMode();
  for (const l of lines) {
    lineRowEl.appendChild(makeLineChip(l));
  }

  lineRowEl.classList.add("is-open");
}

function toggleLineSelection(line) {
  const l = normalizeLine(line);
  if (!l) return;

  // Om vi är i “visa allt”-läge (tom set) och användaren klickar en linje:
  // initiera selection med ALLA kända + alla definierade linjer, så toggling blir intuitivt.
  if (selectedLines.size === 0) {
    const allDefined = MODE_DEFS.flatMap((d) => d.lines).map(normalizeLine);
    const all = new Set([...allDefined, ...knownLines].map(normalizeLine));
    selectedLines = all;
  }

  if (selectedLines.has(l)) selectedLines.delete(l);
  else selectedLines.add(l);

  // Om selection råkar bli “allt igen” -> återgå till tom set (visa allt)
  const allDefined = MODE_DEFS.flatMap((d) => d.lines).map(normalizeLine);
  const allUniverse = new Set([...allDefined, ...knownLines].map(normalizeLine));

  let allSelected = true;
  for (const x of allUniverse) {
    if (!selectedLines.has(x)) {
      allSelected = false;
      break;
    }
  }
  if (allSelected) selectedLines = new Set();

  saveSelectedLines();
}

/* =========================================================
   Upsert + refresh med filter (NYTT)
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

function upsertTrain(v) {
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
    // nytt tåg: inget "pop" här (vi vet inte om det nyss var cirkel)
    const arrowIcon = makeArrowIcon(v.line, hasBearingNow ? bearing : NaN, false);

    const group = L.layerGroup();
    const arrowMarker = L.marker(pos, {
      icon: arrowIcon,
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

    // uppdatera icon (och ev pop-anim)
    m.arrowMarker.setIcon(makeArrowIcon(v.line, hasBearingNow ? bearing : NaN, pop));

    // animera position med distansbaserad duration
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

    // uppdatera ikon/text för pinnad label (pos sköts av animationen)
    if (pinnedTrainId === v.id && pinnedLabelMarker) {
      pinnedLabelMarker.setIcon(makeLabelIcon(v.line, buildLabelText(v), v.speedKmh, true));
    }

    // uppdatera ikon/text för hover label (pos sköts av animationen)
    if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
      hoverLabelMarker.setIcon(makeLabelIcon(v.line, buildLabelText(v), v.speedKmh, false));
    }
  }
}

async function refreshLive() {
  if (document.visibilityState !== "visible") return;

  ensureChipDock();

  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const seen = new Set();

  for (const raw of data) {
    if (!raw?.id || raw.lat == null || raw.lon == null) continue;

    const v = enrich(raw);
    if (!v) continue;

    v.line = normalizeLine(v.line);
    knownLines.add(v.line);

    // FILTER: om linjen inte är vald, ta bort ev marker och hoppa över
    if (!passesFilter(v)) {
      if (markers.has(v.id)) removeTrainCompletely(v.id);
      continue;
    }

    seen.add(v.id);
    upsertTrain(v);
  }

  // Städa tåg som inte längre finns i feeden
  for (const [id] of markers.entries()) {
    if (!seen.has(id)) removeTrainCompletely(id);
  }

  // Om underchips är öppna: håll selected-outline uppdaterad
  if (activeModeKey) renderLineChips();
}

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
