import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev";

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

const markers = new Map();
let timer = null;

// Spara senaste position + bearing vi räknat ut, så den inte hoppar tillbaka till 0/norr
const lastPos = new Map();      // id -> { lat, lon, ts }
const lastBearing = new Map();  // id -> number

function colorForLine(line) {
  const l = String(line ?? "").toUpperCase().trim();

  if (l === "7") return "#878C85"; // grå
  if (l === "10" || l === "11") return "#0091D2"; // blå
  if (l === "12") return "#738BA4"; // ljusgrå
  if (l === "13" || l === "14") return "#E31F26"; // röd
  if (l === "17" || l === "18" || l === "19") return "#00B259"; // grön
  if (l === "21") return "#B76934"; // brun
  if (l === "25" || l === "26") return "#21B6BA"; // turkos

  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29") return "#A86DAE"; // lila
  if (l === "30" || l === "31") return "#E08A32"; // orange
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48") return "#ED66A5"; // rosa

  return "#111827";
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

// GTFS bearing: 0 = norr. Vår SVG-pil pekar "åt höger" från start, därför -90.
function makeArrowSvg(color) {
  return `
  <svg width="34" height="34" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5 L10 95 L50 75 Z" fill="none" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
    <path d="M50 5 L50 75 L90 95 Z" fill="${color}" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
  </svg>`;
}

function makeCircleHtml(color) {
  return `<div class="trainDot" style="background:${color};"></div>`;
}

function makeArrowIcon(line, bearingDeg) {
  const color = colorForLine(line);

  // Om ingen bearing ännu => cirkel
  if (!Number.isFinite(bearingDeg)) {
    return L.divIcon({
      className: "trainIconWrap",
      html: makeCircleHtml(color),
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  const rot = bearingDeg - 90;
  const html = `
    <div class="trainMarker" style="transform: rotate(${rot}deg);">
      ${makeArrowSvg(color)}
    </div>
  `;

  return L.divIcon({
    className: "trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function makeLabelIcon(line, speedKmh) {
  const text = `${line ?? "?"}${fmtSpeed(speedKmh)}`;
  const color = colorForLine(line);

  return L.divIcon({
    className: "trainLabelWrap",
    // label får linjens färg + fet text via CSS
    html: `<div class="trainLabel" style="background:${color};">${text}</div>`,
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  });
}

function headingFromPoints(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  const θ = Math.atan2(y, x);
  return (toDeg(θ) + 360) % 360;
}

function enrichLine(v) {
  // Worker ger ofta tripId men routeId null -> använd TRIP_TO_LINE
  const tripId = v.tripId ?? "";
  const line = TRIP_TO_LINE?.[tripId] ?? null;
  return { ...v, line };
}

function upsertTrain(raw) {
  const v = enrichLine(raw);
  const pos = [v.lat, v.lon];

  // 1) bearing från API om den finns och är > 0
  let bearing = Number.isFinite(v.bearing) ? v.bearing : null;
  if (bearing === 0) bearing = null; // 0 är ofta "okänt" för vissa fordon

  // 2) annars: räkna ut från rörelse (om den rört sig lite)
  const prev = lastPos.get(v.id);
  if (bearing == null && prev && prev.lat != null && prev.lon != null) {
    const moved =
      Math.abs(v.lat - prev.lat) > 0.00002 || // ~2m
      Math.abs(v.lon - prev.lon) > 0.00002;

    if (moved) {
      bearing = headingFromPoints(prev.lat, prev.lon, v.lat, v.lon);
    }
  }

  // 3) annars: behåll senaste bearing så den inte hoppar till norr
  if (bearing == null && lastBearing.has(v.id)) {
    bearing = lastBearing.get(v.id);
  }

  // spara nuvarande position + bearing
  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });
  if (Number.isFinite(bearing)) lastBearing.set(v.id, bearing);

  const arrowIcon = makeArrowIcon(v.line, bearing);
  const labelIcon = makeLabelIcon(v.line, v.speedKmh);

  if (!markers.has(v.id)) {
    const group = L.layerGroup();

    const labelMarker = L.marker(pos, {
      icon: labelIcon,
      interactive: false,
      zIndexOffset: 1000,
    });
    const arrowMarker = L.marker(pos, {
      icon: arrowIcon,
      interactive: false,
      zIndexOffset: 500,
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
  const data = await res.json();

  const seen = new Set();
  for (const v of data) {
    if (!v?.id || v.lat == null || v.lon == null) continue;
    seen.add(v.id);
    upsertTrain(v);
  }

  // städa bort gamla fordon
  for (const [id, m] of markers.entries()) {
    if (!seen.has(id)) {
      map.removeLayer(m.group);
      markers.delete(id);
      lastPos.delete(id);
      lastBearing.delete(id);
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
