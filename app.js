import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev"; // worker root (returnerar array)

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
  if (!isPointerOverTrain && hoverTrainId && hoverLabelMarker && pinnedTrainId !== hoverTrainId) {
    hideHoverLabel(hoverTrainId);
  }
});

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
  const clamp = (v) => Math.max(0, Math.min(255, v));

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  const dr = clamp(Math.round(r * (1 - amount)));
  const dg = clamp(Math.round(g * (1 - amount)));
  const db = clamp(Math.round(b * (1 - amount)));

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

function makeArrowIcon(line, bearingDeg) {
  const color = colorForLine(line);
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

  const html = `
    <div class="trainMarker"
      style="
        transform: rotate(${rot}deg);
        filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));
      ">
      ${arrowSvg(color, stroke)}
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
      Math.abs(v.lat - prev.lat) > 0.00002 || Math.abs(v.lon - prev.lon) > 0.00002;

    if (moved) {
      bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
      establishedNow = true;
    }
  }

  if (establishedNow) {
    bearingEstablished.set(v.id, true);
    lastBearing.set(v.id, bearing);
  }

  if (bearing == null && bearingEstablished.get(v.id) === true && lastBearing.has(v.id)) {
    bearing = lastBearing.get(v.id);
  }

  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

  const arrowIcon = makeArrowIcon(v.line, Number.isFinite(bearing) ? bearing : NaN);

  if (!markers.has(v.id)) {
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

    markers.set(v.id, { group, arrowMarker, lastV: v, lastPos: pos });
  } else {
    const m = markers.get(v.id);

    m.lastV = v;
    m.lastPos = pos;

    m.arrowMarker.setLatLng(pos);
    m.arrowMarker.setIcon(arrowIcon);

    // om hoverad (och inte pinnad): uppdatera hover-label så den följer med
    if (hoverTrainId === v.id && hoverLabelMarker && pinnedTrainId !== v.id) {
      showHoverLabel(v, pos);
    }

    // om pinnad: uppdatera pinnad label (med pinned-stil)
    if (pinnedTrainId === v.id && pinnedLabelMarker) {
      pinnedLabelMarker.setLatLng(pos);
      pinnedLabelMarker.setIcon(makeLabelIcon(v.line, buildLabelText(v), v.speedKmh, true));
    }
  }
}

async function refreshLive() {
  if (document.visibilityState !== "visible") return;

  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const seen = new Set();

  for (const raw of data) {
    if (!raw?.id || raw.lat == null || raw.lon == null) continue;

    const v = enrich(raw);
    if (!v) continue;

    seen.add(v.id);
    upsertTrain(v);
  }

  for (const [id, m] of markers.entries()) {
    if (!seen.has(id)) {
      map.removeLayer(m.group);
      markers.delete(id);
      lastPos.delete(id);
      lastBearing.delete(id);
      bearingEstablished.delete(id);

      // städa hover/pin om det var detta tåg
      if (hoverTrainId === id) hideHoverLabel(id);

      if (pinnedTrainId === id) {
        if (pinnedLabelMarker) map.removeLayer(pinnedLabelMarker);
        pinnedLabelMarker = null;
        pinnedTrainId = null;
      }
    }
  }
}

function startPolling() {
  stopPolling();
  timer = setInterval(() => refreshLive().catch(console.error), 3000);
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
