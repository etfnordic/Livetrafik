const map = L.map("map").setView([59.3293, 18.0686], 12);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

const markers = new Map(); // id -> {group,labelMarker,arrowMarker}

// --- PIL-SVG (lik din) ---
function arrowSvg(color) {
  return `
  <svg width="34" height="34" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <path d="M50 5 L10 95 L50 75 Z" fill="none" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
    <path d="M50 5 L50 75 L90 95 Z" fill="${color}" stroke="#111" stroke-width="6" stroke-linejoin="round"/>
  </svg>`;
}

function colorForLine(line) {
  // Tillfällig logik: ändra när du vill
  const n = Number(line);
  if (n >= 10 && n < 20) return "#2F80ED"; // blå
  if (n >= 20 && n < 30) return "#27AE60"; // grön
  return "#EB5757"; // röd
}

function fmtSpeed(speedKmh) {
  if (speedKmh == null || Number.isNaN(speedKmh)) return "";
  return ` • ${Math.round(speedKmh)} km/h`;
}

function makeArrowIcon(line, bearingDeg) {
  const color = colorForLine(line);
  const html = `
    <div class="trainMarker" style="transform: rotate(${bearingDeg ?? 0}deg);">
      ${arrowSvg(color)}
    </div>
  `;
  return L.divIcon({
    className: "trainIconWrap",
    html,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function makeLabelIcon(line, dest, speedKmh) {
  const text = `${line} mot ${dest || "?"}${fmtSpeed(speedKmh)}`;
  return L.divIcon({
    className: "trainLabelWrap",
    html: `<div class="trainLabel">${text}</div>`,
    iconSize: [1, 1],
    iconAnchor: [0, 0],
  });
}

function upsertTrain(v) {
  const pos = [v.lat, v.lon];

  const arrowIcon = makeArrowIcon(v.line, v.bearing);
  const labelIcon = makeLabelIcon(v.line, v.dest, v.speedKmh);

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

// --- Mock-data (Steg 2) ---
function mockFetch() {
  return [
    { id:"t1", lat:59.334, lon:18.060, line:"14", dest:"Fruängen", speedKmh:48, bearing:190 },
    { id:"t2", lat:59.343, lon:18.020, line:"17", dest:"Åkeshov",  speedKmh:31, bearing:320 },
    { id:"t3", lat:59.310, lon:18.070, line:"19", dest:"Hagsätra", speedKmh:55, bearing:10  }
  ];
}

function refreshMock() {
  const data = mockFetch();
  for (const v of data) upsertTrain(v);
}

refreshMock();
setInterval(refreshMock, 3000);
