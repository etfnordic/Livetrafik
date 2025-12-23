import { TRIP_TO_LINE } from "./data/trip_to_line.js";

const API_URL = "https://metro.etfnordic.workers.dev"; // worker root (returnerar array)

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const markers = new Map();
const lastPos = new Map();      // {lat, lon, ts}
const lastBearing = new Map();  // bearingDeg
const bearingEstablished = new Map(); // boolean per train id

let timer = null;

function normalizeLine(rawLine) {
  const s = String(rawLine ?? "").trim();

  // Ex: "Linje 40" -> "40", "Line 43X" -> "43X", "  27S " -> "27S"
  const m = s.match(/(\d+\s*[A-Z]+|\d+)/i);
  return (m ? m[1] : s).replace(/\s+/g, "").toUpperCase();
}
/**
 * Linjefärger enligt din specifikation.
 */
function colorForLine(line) {
  const l = normalizeLine(line);
  // ...resten oförändrad

  // Tunnelbana / Spårväg m.m.
  if (l === "7") return "#878C85";                 // grå
  if (l === "10" || l === "11") return "#0091D2";  // blå
  if (l === "12") return "#738BA4";                // ljusgrå
  if (l === "13" || l === "14") return "#E31F26";  // röd
  if (l === "17" || l === "18" || l === "19") return "#00B259"; // grön
  if (l === "21") return "#B76934";                // brun
  if (l === "25" || l === "26") return "#21B6BA";  // turkos

  // Roslagsbanan (inkl express)
  if (l === "27" || l === "27S" || l === "28" || l === "28S" || l === "29")
    return "#A86DAE"; // lila

  // Tvärbana
  if (l === "30" || l === "31") return "#E08A32";  // orange

  // Pendeltåg (inkl express)
  if (l === "40" || l === "41" || l === "43" || l === "43X" || l === "48")
    return "#ED66A5"; // rosa

  return "#111827";
}

/**
 * Heading 0..360 (0=norr, 90=öst)
 */
function headingFromPoints(lat1, lon1, lat2, lon2) {
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
 * Pil-SVG (fylld).
 */
function arrowSvg(fillColor) {
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
 * Icon: cirkel (innan bearing) eller pil (när bearing finns).
 * Skugga via filter: drop-shadow.
 */
function makeArrowIcon(line, bearingDeg) {
  const color = colorForLine(line);

  // Ingen bearing => cirkel
  if (!Number.isFinite(bearingDeg)) {
    const html = `
      <div class="trainMarker" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));">
        <div class="trainDot" style="
          width: 16px; height: 16px;
          border-radius: 999px;
          background: ${color};
          border: 2px solid #111;
        "></div>
      </div>
    `;
    return L.divIcon({
      className: "trainIconWrap",
      html,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  // SVG-pilen pekar åt höger från början → -90 för GTFS (0=norr)
  const rot = bearingDeg + 90;

  const html = `
    <div class="trainMarker"
      style="
        transform: rotate(${rot}deg);
        filter: drop-shadow(0 2px 2px rgba(0,0,0,.35));
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
 * Label ovanför tåget: "14 • 45 km/h"
 * Bakgrund = linjens färg
 * Centrerad ovanför
 */
function makeLabelIcon(line, speedKmh) {
  const text = `${line}${fmtSpeed(speedKmh)}`;
  const color = colorForLine(line);

  return L.divIcon({
    className: "trainLabelWrap",
    html: `
      <div class="trainLabel trainLabelPos" style="background:${color};">
        ${text}
      </div>
    `,
    iconAnchor: [0, 0] // koordinaten är "fästpunkten"
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

  // Vill du filtrera hårt på typer (som dina GTFS route_type: 100/401/900)
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
  // Normalisera linjen tidigt så allt (färg + label) matchar
  v.line = normalizeLine(v.line);

  const pos = [v.lat, v.lon];

  let bearing = null;
  let establishedNow = false;

  // 1) Använd API-bearing om den är giltig och > 0
  if (Number.isFinite(v.bearing) && v.bearing > 0) {
    bearing = v.bearing;
    establishedNow = true;
  }

  // 2) Annars: räkna ut från rörelse (senaste två positionerna)
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

  // Markera som etablerad om vi fick bearing nu
  if (establishedNow) {
    bearingEstablished.set(v.id, true);
    lastBearing.set(v.id, bearing);
  }

  // 3) Efter att bearing väl är etablerad: återanvänd senast kända om vi inte får en ny
  if (
    bearing == null &&
    bearingEstablished.get(v.id) === true &&
    lastBearing.has(v.id)
  ) {
    bearing = lastBearing.get(v.id);
  }

  // Spara position till nästa uppdatering
  lastPos.set(v.id, { lat: v.lat, lon: v.lon, ts: v.ts ?? Date.now() });

  const arrowIcon = makeArrowIcon(v.line, Number.isFinite(bearing) ? bearing : NaN);
  const labelIcon = makeLabelIcon(v.line, v.speedKmh);

  // ...resten av upsertTrain oförändrad


  if (!markers.has(v.id)) {
    const group = L.layerGroup();

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
    if (!v) continue;

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
      bearingEstablished.delete(id);
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
