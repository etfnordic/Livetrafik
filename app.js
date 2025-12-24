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
  if (v.unknownLine) return "Ej i trafik";
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

  if (!line || line === "?") return "#1F2937";
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
  // Om API:et inte ens har tripId -> visa ändå (okänd/ej i trafik)
  if (!v?.tripId) {
    return {
      ...v,
      line: "?",
      headsign: null,
      unknownLine: true,
    };
  }

  const info = TRIP_TO_LINE[v.tripId];

  // Om tripId inte finns i mappen eller saknar line -> visa ändå
  if (!info?.line) {
    return {
      ...v,
      line: "?",
      headsign: null,
      unknownLine: true,
    };
  }

  return {
    ...v,
    line: info.line,
    headsign: info.headsign ?? null,
    unknownLine: false,
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
      // stoppa ev animation
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
  }
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
