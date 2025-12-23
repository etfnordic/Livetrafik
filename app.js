import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev"; // din worker root som returnerar array

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const markers = new Map();
const lastPos = new Map();
let timer = null;

/**
 * Linjefärger enligt din specifikation.
 * (Du kan byta hex om du vill finjustera nyanser.)
 */
function colorForLine(line) {
  const l = String(line ?? "").toUpperCase().trim();

  // Tunnelbana m.m.
  if (l === "7") return "#878C85";           // grå
  if (l === "10" || l === "11") return "#0091D2"; // blå
  if (l === "12") return "#738BA4";         // ljusgrå
  if (l === "13" || l === "14") return "#E31F26"; // röd
  if (l === "17" || l === "18" || l === "19") return "#00B259"; // grön
  if (l === "21") return "#B76934";         // brun
  if (l === "25" || l === "26") return "#21B6BA"; // turkos

  // Roslagsbanan (inkl express)
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE"; // lila

  // Tvärbana
  if (l === "30" || l === "31") return "#E08A32"; // orange

  // Pendeltåg (inkl express)
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48")
    return "#ED66A5"; // rosa

  // fallback
  return "#111827";
}

function headingFromPoints(lat1, lon1, lat2, lon2) {
  // Returnerar grader 0..360 (0 = norr, 90 = öst)
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

/**
 * Fylld “pil”-SVG (enkel och tydlig).
 * Roteras via wrapper-diven.
 */
function arrowSvg(fillColor) {
  // En "pappersflygplan/pil"-form som syns bra även liten
  return `
    <svg width="34" height="34" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M10 50 L92 10 L62 50 L92 90 Z"
        fill="${fillColor}"
        stroke="#111"
        stroke-width="6"
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
 * Gör Leaflet-icon för pilen.
 * Bearing roteras i wrappern (grad).
 */
function makeArrowIcon(line, bearingDeg) {
  const color = colorForLine(line);
  const rot = Number.isFinite(bearingDeg) ? (bearingDeg + 90) : 0;

  const html = `
    <div class="trainMarker" style="
      transform: rotate(${rot}deg);
      transform-origin: 17px 17px;
      width:34px;height:34px;
    ">
      ${arrowSvg(color)}
    </div>
  `;

  return L.divIcon({
    className: "trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

/**
 * Label ovanför pilen: "Linje 14 • 45 km/h"
 */
function makeLabelIcon(line, speedKmh) {
  const text = `Linje ${line}${fmtSpeed(speedKmh)}`;

  return L.divIcon({
    className: "trainLabelWrap",
    html: `<div class="trainLabel">${text}</div>`,
    iconSize: [120, 28],     // en fast "yta" så Leaflet placerar korrekt
    iconAnchor: [60, 40]     // mitten X, och lite ovanför pilen
  });
}

/**
 * Enrich: koppla tripId -> line/type via TRIP_TO_LINE.
 * Returnerar null om okänd (då visar vi inte fordonet).
 */
function enrich(v) {
  if (!v?.tripId) return null;
  const info = TRIP_TO_LINE[v.tripId];
  if (!info?.line) return null;

  // Om du vill vara extra hård: filtrera bara dessa typer
  // (du kan ta bort detta om du redan har 100/401/900 i kartan)
  if (info.type != null && ![100, 401, 900].includes(info.type)) return null;

  return {
    ...v,
    line: String(info.line),
    routeType: info.type ?? null
  };
}

/**
 * Skapa/uppdatera marker-grupp för ett fordon
 */
function upsertTrain(v) {
  const pos = [v.lat, v.lon];

let bearing = Number.isFinite(v.bearing) ? v.bearing : null;

// Om bearing saknas (eller alltid 0 på vissa fordon): räkna ut från rörelse
const prev = lastPos.get(v.id);
if ((bearing == null || bearing === 0) && prev && prev.lat != null && prev.lon != null) {
  // kräver att den faktiskt flyttat sig lite, annars blir det brus
  const moved =
    Math.abs(v.lat - prev.lat) > 0.00002 || // ~2m
    Math.abs(v.lon - prev.lon) > 0.00002;

  if (moved) {
    bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
  }
}

// spara nuvarande som "förra" till nästa uppdatering
lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

const arrowIcon = makeArrowIcon(v.line, bearing);

  const labelIcon = makeLabelIcon(v.line, v.speedKmh);

  if (!markers.has(v.id)) {
    const group = L.layerGroup();

    // Label lite ovanför markören
    const labelMarker = L.marker(pos, {
      icon: labelIcon,
      interactive: false,
      zIndexOffset: 1000
    });

    const arrowMarker = L.marker(pos, {
      icon: arrowIcon,
      interactive: false,
      zIndexOffset: 500
    });

    group.addLayer(labelMarker);
    group.addLayer(arrowMarker);
    group.addTo(map);

    markers.set(v.id, { group, labelMarker, arrowMarker });
  } else {
    const m = markers.get(v.id);
    m.labelMarker.setLatLng(pos);
    m.arrowMarker.setLatLng(pos);
    m.labelMarker.setIcon(labelIcon);
    m.arrowMarker.setIcon(arrowIcon);
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
    if (!v) continue; // okänd trip -> visas inte

    seen.add(v.id);
    upsertTrain(v);
  }

  // städa bort gamla fordon
  for (const [id, m] of markers.entries()) {
    if (!seen.has(id)) {
      map.removeLayer(m.group);
      markers.delete(id);
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
