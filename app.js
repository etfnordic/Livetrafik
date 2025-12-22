const API_URL = "https://metro.etfnordic.workers.dev";

const map = L.map("map").setView([59.3293, 18.0686], 12);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const markers = new Map();
let timer = null;

function arrowSvg(color) {
  return `
  <svg width="34" height="34" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5 L10 95 L50 75 Z" fill="none" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
    <path d="M50 5 L50 75 L90 95 Z" fill="${color}" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
  </svg>`;
}

// Tillfällig färgning innan vi har “riktig linje” (14/17/…)
function colorForRouteId(routeId) {
  const s = String(routeId ?? "");
  // enkel deterministic färg: röd/grön/blå baserat på sista siffran
  const last = Number(s.replace(/\D/g, "").slice(-1));
  if (!Number.isFinite(last)) return "#2F80ED";
  if (last % 3 === 0) return "#EB5757"; // röd
  if (last % 3 === 1) return "#27AE60"; // grön
  return "#2F80ED"; // blå
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh) || speedKmh < 0) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

function makeArrowIcon(routeId, bearingDeg) {
  const color = colorForRouteId(routeId);
  const html = `
    <div class="trainMarker" style="transform: rotate(${bearingDeg ?? 0}deg);">
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

function makeLabelIcon(routeId, speedKmh) {
  const text = `${routeId ?? "?"}${fmtSpeed(speedKmh)}`;
  return L.divIcon({
    className: "trainLabelWrap",
    html: `<div class="trainLabel">${text}</div>`,
    iconSize: [1, 1],
    iconAnchor: [0, 0]
  });
}

function upsertTrain(v) {
  const pos = [v.lat, v.lon];
  const arrowIcon = makeArrowIcon(v.routeId, v.bearing);
  const labelIcon = makeLabelIcon(v.routeId, v.speedKmh);

  if (!markers.has(v.id)) {
    const group = L.layerGroup();
    const labelMarker = L.marker(pos, { icon: labelIcon, interactive: false, zIndexOffset: 1000 });
    const arrowMarker = L.marker(pos, { icon: arrowIcon, interactive: false, zIndexOffset: 500 });

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
