/* ================================================
   UNIMAP — Main Script
   ================================================ */

const RSU_CENTER = [4.7975, 6.9805];
const RSU_BOUNDS = L.latLngBounds([4.788, 6.972], [4.808, 6.990]);
const ARRIVAL_RADIUS_M = 20;

const POPULAR_PLACES = [
  "UST Shuttle Park","Convocation Arena","Faculty of Management Sciences",
  "FACULTY OF ENGINEERING","Faculty of Law, Rivers State University",
  "F&G hostel","NDDC Hostel","Hostel C","Shopping Complex","Love Garden",
  "PG&H Hostel","Back Gate Shuttle Park","UST Back Gate",
  "CCE(Centre for Continuous Education)","College of Medical Sciences, RSU"
];

const POPULAR_LABELS = {
  "UST Shuttle Park":                          "Shuttle Park",
  "Convocation Arena":                         "Convo Arena",
  "Faculty of Management Sciences":            "Management",
  "FACULTY OF ENGINEERING":                    "Engineering",
  "Faculty of Law, Rivers State University":   "Law Faculty",
  "F&G hostel":                                "F&G Hostel",
  "NDDC Hostel":                               "NDDC Hostel",
  "Hostel C":                                  "Hostel C",
  "Shopping Complex":                          "Shopping Complex",
  "Love Garden":                               "Love Garden",
  "PG&H Hostel":                               "PG&H Hostel",
  "Back Gate Shuttle Park":                    "Back Gate Park",
  "UST Back Gate":                             "Back Gate",
  "CCE(Centre for Continuous Education)":      "CCE",
  "College of Medical Sciences, RSU":          "Med Sciences"
};

const DEFAULT_MARKER_STYLE  = { radius: 6, fillColor: '#2563EB', color: '#ffffff', weight: 2, opacity: 0.9, fillOpacity: 0.55 };
const SELECTED_MARKER_STYLE = { radius: 9, fillColor: '#2563EB', color: '#ffffff', weight: 3, opacity: 1,   fillOpacity: 0.95 };

/* ── State ── */
let map, userMarker, userLocation = null;
let routingControl = null;
let allLocations   = [];
let selectedLoc    = null;
let isNavigating   = false;
let hasCenteredOnUser = false;
let navDestination = null;
let activeSuggestionIndex = -1;

/* ── DOM ── */
const $ = id => document.getElementById(id);
const defaultBar  = $('defaultBar');
const fullSheet   = $('fullSheet');
const navBar      = $('navBar');
const navOverlay  = $('navOverlay');
const navEta      = $('navEta');
const searchInput = $('searchInput');
const suggestions = $('suggestions');
const clearBtn    = $('clearBtn');
const lostBtn     = $('lostBtn');

/* ════════════════════════════════
   STATE MACHINE
   ════════════════════════════════ */
function setState(s) {
  // Reset all
  defaultBar.classList.add('hidden');
  fullSheet.classList.remove('open');
  navBar.classList.add('hidden');
  navOverlay.classList.remove('visible');
  lostBtn.classList.add('hidden');

  if (s === 'default') {
    defaultBar.classList.remove('hidden');
    lostBtn.classList.remove('hidden');
  }
  if (s === 'search') {
    fullSheet.classList.add('open');
    setTimeout(() => searchInput.focus(), 60);
  }
  if (s === 'location') {
    navBar.classList.remove('hidden');
    lostBtn.classList.remove('hidden');
  }
  if (s === 'navigating') {
    navOverlay.classList.add('visible');
    lostBtn.classList.remove('hidden');
  }
}

/* ════════════════════════════════
   MAP INIT
   ════════════════════════════════ */
function initMap() {
  map = L.map('map', {
    center: RSU_CENTER,
    zoom: 16,
    zoomControl: true,
    maxBounds: RSU_BOUNDS,
    maxBoundsViscosity: 0.85
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
    minZoom: 14
  }).addTo(map);

  loadLocations();
  trackUser();
  watchOffline();
}

/* ════════════════════════════════
   LOAD GEOJSON
   ════════════════════════════════ */
async function loadLocations() {
  try {
    const res  = await fetch('unimap.geojson');
    const data = await res.json();
    allLocations = data.features.filter(f => f.geometry.type === 'Point');

    allLocations.forEach(feature => {
      const [lng, lat] = feature.geometry.coordinates;
      const name = feature.properties.Name;
      const desc = feature.properties.description;

      // Markers are visible (dimly) by default so the map is browsable,
      // not just reachable through search / chips / "I'm Lost".
      const m = L.circleMarker([lat, lng], DEFAULT_MARKER_STYLE).addTo(map);

      m.bindPopup(
        `<strong>${name}</strong>` +
        (desc ? `<br><span style="color:#6B8CAE;font-size:12px">${desc}</span>` : '')
      );
      m.on('click', () => selectLocation(feature));
      feature._marker = m;
    });

    buildChips();
  } catch (e) {
    console.error('GeoJSON load failed:', e);
    toast('⚠️ Could not load campus locations');
  }
}

/* ════════════════════════════════
   POPULAR CHIPS
   ════════════════════════════════ */
function buildChips() {
  const wrap = $('popularChips');
  wrap.innerHTML = '';
  POPULAR_PLACES.forEach((name, i) => {
    const loc = allLocations.find(f => f.properties.Name === name);
    if (!loc) return;
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = POPULAR_LABELS[name] || name;
    btn.style.animationDelay = `${i * 32}ms`;
    btn.addEventListener('click', () => selectLocation(loc));
    wrap.appendChild(btn);
  });
}

/* ════════════════════════════════
   SEARCH
   ════════════════════════════════ */
$('searchTrigger').addEventListener('click', () => setState('search'));
$('searchTrigger').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setState('search'); }
});

$('backBtn').addEventListener('click', () => {
  resetSearch();
  setState('default');
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  clearBtn.classList.toggle('visible', q.length > 0);
  $('popularWrap').style.display = q ? 'none' : 'block';
  activeSuggestionIndex = -1;

  if (!q) { suggestions.innerHTML = ''; suggestions.classList.remove('open'); searchInput.setAttribute('aria-expanded', 'false'); return; }

  const hits = allLocations.filter(f => f.properties.Name.toLowerCase().includes(q));
  suggestions.innerHTML = '';

  if (!hits.length) { suggestions.classList.remove('open'); searchInput.setAttribute('aria-expanded', 'false'); return; }

  suggestions.classList.add('open');
  searchInput.setAttribute('aria-expanded', 'true');
  hits.slice(0, 8).forEach((feature, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 28}ms`;
    li.setAttribute('role', 'option');
    li.tabIndex = -1;
    li.innerHTML = `
      <div class="sug-dot">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
      </div>
      <span>${feature.properties.Name}</span>
    `;
    li.addEventListener('click', () => selectLocation(feature));
    suggestions.appendChild(li);
  });
});

// Keyboard navigation through suggestions (Arrow Up/Down + Enter)
searchInput.addEventListener('keydown', e => {
  const items = Array.from(suggestions.querySelectorAll('li'));
  if (!items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
    updateActiveSuggestion(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
    updateActiveSuggestion(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      items[activeSuggestionIndex].click();
    }
  } else if (e.key === 'Escape') {
    resetSearch();
  }
});

function updateActiveSuggestion(items) {
  items.forEach((li, i) => li.classList.toggle('sug-active', i === activeSuggestionIndex));
  items[activeSuggestionIndex]?.scrollIntoView({ block: 'nearest' });
}

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.classList.remove('visible');
  suggestions.innerHTML = '';
  suggestions.classList.remove('open');
  $('popularWrap').style.display = 'block';
  searchInput.focus();
});

function resetSearch() {
  searchInput.value = '';
  clearBtn.classList.remove('visible');
  suggestions.innerHTML = '';
  suggestions.classList.remove('open');
  searchInput.setAttribute('aria-expanded', 'false');
  activeSuggestionIndex = -1;
  $('popularWrap').style.display = 'block';
}

/* ════════════════════════════════
   MARKERS
   ════════════════════════════════ */
function hideAllMarkers() {
  allLocations.forEach(f => f._marker?.setStyle(DEFAULT_MARKER_STYLE));
}

function showMarker(feature) {
  hideAllMarkers();
  feature._marker?.setStyle(SELECTED_MARKER_STYLE);
  feature._marker?.bringToFront();
}

/* ════════════════════════════════
   SELECT LOCATION
   ════════════════════════════════ */
function selectLocation(feature) {
  selectedLoc = feature;
  const [lng, lat] = feature.geometry.coordinates;
  showMarker(feature);
  map.flyTo([lat, lng], 18, { duration: 0.9, easeLinearity: 0.25 });
  $('destLabel').textContent = feature.properties.Name;
  resetSearch();
  setState('location');
}

/* ════════════════════════════════
   NAVIGATE
   ════════════════════════════════ */
$('navBackBtn').addEventListener('click', () => {
  hideAllMarkers();
  selectedLoc = null;
  resetSearch();
  setState('search');
});

$('navigateBtn').addEventListener('click', () => {
  if (!selectedLoc) return;
  if (!userLocation) { toast('📍 Still finding your location…'); return; }
  const [lng, lat] = selectedLoc.geometry.coordinates;
  startNav([lat, lng]);
});

function startNav(dest) {
  clearRoute();
  isNavigating = true;
  navDestination = dest;
  navEta.textContent = '';
  setState('navigating');

  routingControl = L.Routing.control({
    waypoints: [L.latLng(...userLocation), L.latLng(...dest)],
    routeWhileDragging: false,
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false,
    router: L.Routing.osrmv1({
      serviceUrl: 'https://router.project-osrm.org/route/v1',
      profile: 'foot'
    }),
    lineOptions: {
      styles: [{ color: '#2563EB', weight: 5, opacity: 0.9 }]
    },
    createMarker: () => null
  }).addTo(map);

  routingControl.on('routesfound', e => updateEta(e));
  routingControl.on('routingerror', () => {
    toast("⚠️ Couldn't find a walking route — try again");
  });
}

/* Update the live "X m · Y min" readout shown during navigation.
   routesfound fires again whenever waypoints are recalculated
   (e.g. as the user's GPS position updates), so this just refreshes
   the label rather than spawning any new timers/listeners. */
function updateEta(e) {
  const route = e?.routes?.[0];
  if (!route?.summary) return;
  const meters = route.summary.totalDistance;
  const mins   = Math.max(1, Math.round(route.summary.totalTime / 60));
  const distText = meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  navEta.textContent = `${distText} · ${mins} min walk`;
}

function clearRoute() {
  if (routingControl) { map.removeControl(routingControl); routingControl = null; }
  navDestination = null;
  navEta.textContent = '';
}

$('cancelNavBtn').addEventListener('click', () => {
  clearRoute();
  hideAllMarkers();
  isNavigating = false;
  setState('default');
});

/* ════════════════════════════════
   ARRIVAL CHECK
   ════════════════════════════════
   Checked directly off each geolocation update in trackUser()
   rather than via its own setInterval — avoids stacking up
   duplicate timers every time the route recalculates. */
function maybeCheckArrival() {
  if (!isNavigating || !navDestination || !userLocation) return;
  if (dist(userLocation, navDestination) < ARRIVAL_RADIUS_M) {
    isNavigating = false;
    clearRoute();
    hideAllMarkers();
    toast("🎉 You've arrived!");
    setState('default');
  }
}

/* ════════════════════════════════
   USER LOCATION
   ════════════════════════════════ */
function trackUser() {
  if (!navigator.geolocation) {
    toast('📍 Geolocation not supported on this device');
    return;
  }
  navigator.geolocation.watchPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      userLocation = [lat, lng];
      if (!userMarker) {
        userMarker = L.circleMarker([lat, lng], {
          radius: 10, fillColor: '#3B82F6', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(map).bindPopup('📍 You are here');

        // Only auto-recenter on the very first fix, and only if the
        // user is actually within the campus bounds — otherwise this
        // fights maxBounds and snaps the view somewhere confusing.
        if (!hasCenteredOnUser) {
          hasCenteredOnUser = true;
          if (RSU_BOUNDS.contains([lat, lng])) {
            map.setView([lat, lng], 17);
          }
        }
      } else {
        userMarker.setLatLng([lat, lng]);
      }

      if (isNavigating && routingControl) {
        const wps = routingControl.getWaypoints();
        if (wps.length >= 2) {
          routingControl.setWaypoints([L.latLng(lat, lng), wps.at(-1).latLng]);
        }
        // Keep the map following the user while they're walking a route.
        map.panTo([lat, lng], { animate: true, duration: 0.6 });
      }

      maybeCheckArrival();
    },
    err => {
      console.warn('Geolocation error:', err.message);
      if (err.code === err.PERMISSION_DENIED) {
        toast('📍 Location access denied — enable it in your browser settings to navigate');
      } else if (err.code === err.TIMEOUT) {
        toast('📍 Location signal lost — retrying…');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

/* ════════════════════════════════
   I'M LOST
   ════════════════════════════════ */
lostBtn.addEventListener('click', () => {
  if (!userLocation) { toast("📍 Still finding your location…"); return; }
  let nearest = null, minD = Infinity;
  allLocations.forEach(f => {
    const [lng, lat] = f.geometry.coordinates;
    const d = dist(userLocation, [lat, lng]);
    if (d < minD) { minD = d; nearest = f; }
  });
  if (nearest) {
    toast(`📍 Nearest: ${nearest.properties.Name} (${Math.round(minD)}m)`);
    map.flyTo(userLocation, 17);
    setTimeout(() => selectLocation(nearest), 2200);
  }
});

/* ════════════════════════════════
   TOAST
   ════════════════════════════════ */
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.querySelector('.toast-msg').textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

/* ════════════════════════════════
   OFFLINE
   ════════════════════════════════ */
function watchOffline() {
  const bar = $('offlineBar');
  window.addEventListener('offline', () => bar.classList.add('show'));
  window.addEventListener('online',  () => bar.classList.remove('show'));
  if (!navigator.onLine) bar.classList.add('show');
}

/* ════════════════════════════════
   DISTANCE (Haversine)
   ════════════════════════════════ */
function dist([lat1, lon1], [lat2, lon2]) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ════════════════════════════════
   BOOT
   ════════════════════════════════ */
initMap();
setState('default');