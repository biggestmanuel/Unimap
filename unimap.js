/* ================================================
   UNIMAP — Main Script
   ================================================ */

const RSU_CENTER = [4.7975, 6.9805];
const RSU_BOUNDS = L.latLngBounds([4.788, 6.972], [4.808, 6.990]);
const REPORT_EMAIL = 'unimap.rsu@gmail.com'; // TODO: swap for the real inbox this should land in

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
  "NDDC Hostel":                                "NDDC Hostel",
  "Hostel C":                                  "Hostel C",
  "Shopping Complex":                          "Shopping Complex",
  "Love Garden":                               "Love Garden",
  "PG&H Hostel":                               "PG&H Hostel",
  "Back Gate Shuttle Park":                    "Back Gate Park",
  "UST Back Gate":                             "Back Gate",
  "CCE(Centre for Continuous Education)":      "CCE",
  "College of Medical Sciences, RSU":          "Med Sciences"
};

/* ── Category config: color + icon per POI type ── */
const CATEGORIES = {
  academic:     { label: 'Academic',     color: '#2563EB', icon: '📚' },
  'lecture-hall': { label: 'Lecture Hall', color: '#4F46E5', icon: '🏛️' },
  laboratory:   { label: 'Laboratory',   color: '#0D9488', icon: '🧪' },
  department:   { label: 'Department',   color: '#1D4ED8', icon: '🧑‍🏫' },
  faculty:      { label: 'Faculty',      color: '#7C3AED', icon: '🏢' },
  hostel:       { label: 'Hostel',       color: '#F59E0B', icon: '🏠' },
  sports:       { label: 'Sports',       color: '#10B981', icon: '⚽' },
  bank:         { label: 'Bank',         color: '#059669', icon: '🏦' },
  admin:        { label: 'Admin',        color: '#0891B2', icon: '🏢' },
  church:       { label: 'Church',       color: '#9333EA', icon: '⛪' },
  medical:      { label: 'Medical',      color: '#EF4444', icon: '⛑️' },
  library:      { label: 'Library',      color: '#2563EB', icon: '📖' },
  transit:      { label: 'Transit',      color: '#6B7280', icon: '🚌' },
  amenity:      { label: 'Amenity',      color: '#D97706', icon: '🛍️' },
  eatery:       { label: 'Eatery',       color: '#EA580C', icon: '🍽️' },
  landmark:     { label: 'Landmark',     color: '#DB2777', icon: '📍' },
  other:        { label: 'Other',        color: '#64748B', icon: '📌' }
};
const EVENT_COLOR  = '#DC2626';
const SAFETY_COLOR = '#EF4444';

/* ── State ── */
let map, userMarker, userLocation = null;
let routingControl = null;
let allLocations   = [];
let allEvents      = [];
let selectedLoc    = null;
let isNavigating   = false;
let activeCategory = null; // null = show all

/* ── DOM ── */
const $ = id => document.getElementById(id);
const defaultBar  = $('defaultBar');
const fullSheet   = $('fullSheet');
const navBar      = $('navBar');
const navOverlay  = $('navOverlay');
const searchInput = $('searchInput');
const suggestions = $('suggestions');
const clearBtn    = $('clearBtn');
const lostBtn     = $('lostBtn');

/* ════════════════════════════════
   STATE MACHINE
   ════════════════════════════════ */
function setState(s) {
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
  loadEvents();
  trackUser();
  watchOffline();
}

/* ════════════════════════════════
   LOAD GEOJSON (POIs)
   ════════════════════════════════ */
async function loadLocations() {
  try {
    const res  = await fetch('unimap.geojson');
    const data = await res.json();
    allLocations = data.features.filter(f => f.geometry.type === 'Point');

    allLocations.forEach(feature => {
      const { Name, category, safety } = feature.properties;
      const cat = CATEGORIES[category] ? category : 'other';
      const cfg = CATEGORIES[cat];
      const [lng, lat] = feature.geometry.coordinates;

      const m = L.circleMarker([lat, lng], {
        radius: safety ? 9 : 7,
        fillColor: safety ? SAFETY_COLOR : cfg.color,
        color: '#ffffff',
        weight: safety ? 3 : 2,
        opacity: 1,
        fillOpacity: 0.55,           // dimly visible by default (Phase 1: category-tagged pins)
        className: safety ? 'pin-safety' : ''
      }).addTo(map);

      m.bindPopup(() => buildPopupHTML(feature));
      m.on('click', () => selectLocation(feature));
      feature._marker = m;
    });

    buildChips();
    buildCategoryFilters();
  } catch (e) {
    console.error('GeoJSON load failed:', e);
  }
}

/* ════════════════════════════════
   LOAD EVENTS (Phase 1: event pins)
   ════════════════════════════════ */
async function loadEvents() {
  try {
    const res  = await fetch('events.json');
    const data = await res.json();
    const now  = new Date();

    allEvents = (data.events || []).filter(ev => new Date(ev.end) >= now);

    allEvents.forEach(ev => {
      const [lng, lat] = ev.coordinates;
      const icon = L.divIcon({
        className: 'event-pin',
        html: `<div class="event-pin-inner">📅</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      const m = L.marker([lat, lng], { icon }).addTo(map);
      m.bindPopup(buildEventPopupHTML(ev));
      ev._marker = m;
    });
  } catch (e) {
    console.warn('events.json not loaded (optional):', e.message);
  }
}

function buildEventPopupHTML(ev) {
  const start = new Date(ev.start);
  const dateStr = start.toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = start.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  return `
    <strong>📅 ${escapeHTML(ev.title)}</strong><br>
    <span style="color:#6B8CAE;font-size:12px">${dateStr} · ${timeStr}</span>
    ${ev.description ? `<p style="margin-top:6px;font-size:13px">${escapeHTML(ev.description)}</p>` : ''}
  `;
}

/* ════════════════════════════════
   POPUP BUILDER (indoor desc, accessibility, safety, report)
   ════════════════════════════════ */
function buildPopupHTML(feature) {
  const { Name, category, indoorDescription, accessibility, safety } = feature.properties;
  const cfg = CATEGORIES[category] || CATEGORIES.other;

  let html = `<strong>${cfg.icon} ${escapeHTML(Name)}</strong>`;
  html += `<br><span style="color:${cfg.color};font-size:11.5px;font-weight:600">${cfg.label}${safety ? ' · Safety Point' : ''}</span>`;

  if (indoorDescription) {
    html += `<p style="margin-top:6px;font-size:12.5px;color:#1E3A5F">${escapeHTML(indoorDescription)}</p>`;
  }

  if (accessibility && accessibility.length) {
    const tags = accessibility.map(a => `<span class="a11y-tag">♿ ${escapeHTML(a)}</span>`).join('');
    html += `<div style="margin-top:8px">${tags}</div>`;
  }

  html += `<button class="popup-report-btn" onclick="reportIssue('${escapeAttr(Name)}')">⚠️ Report an issue here</button>`;
  return html;
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
function escapeAttr(str) {
  return (str ?? '').replace(/'/g, "\\'");
}

/* ════════════════════════════════
   REPORT AN ISSUE (Phase 1 stopgap — no backend yet)
   ════════════════════════════════ */
function reportIssue(placeName) {
  const subject = encodeURIComponent(`UniMap Issue Report: ${placeName || 'General'}`);
  const bodyLines = [
    `Location: ${placeName || 'Not specified'}`,
    userLocation ? `My current coordinates: ${userLocation[0].toFixed(6)}, ${userLocation[1].toFixed(6)}` : '',
    `Reported at: ${new Date().toLocaleString('en-NG')}`,
    '',
    'Describe the issue (wrong pin location, missing pin, broken route, accessibility problem, safety concern, etc.):',
    ''
  ].filter(Boolean).join('%0D%0A');
  window.location.href = `mailto:${REPORT_EMAIL}?subject=${subject}&body=${bodyLines}`;
}
window.reportIssue = reportIssue;

/* ════════════════════════════════
   CATEGORY FILTER CHIPS
   ════════════════════════════════ */
function buildCategoryFilters() {
  const wrap = $('categoryFilters');
  if (!wrap) return;
  wrap.innerHTML = '';

  const counts = {};
  allLocations.forEach(f => {
    const c = CATEGORIES[f.properties.category] ? f.properties.category : 'other';
    counts[c] = (counts[c] || 0) + 1;
  });

  Object.entries(CATEGORIES).forEach(([key, cfg]) => {
    if (!counts[key]) return;
    const btn = document.createElement('button');
    btn.className = 'chip cat-chip' + (activeCategory === key ? ' active' : '');
    btn.style.setProperty('--cat-color', cfg.color);
    btn.textContent = `${cfg.icon} ${cfg.label}`;
    btn.dataset.cat = key;
    btn.addEventListener('click', () => toggleCategory(key, btn));
    wrap.appendChild(btn);
  });
}

function toggleCategory(key, btn) {
  const isActive = activeCategory === key;
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));

  activeCategory = isActive ? null : key;
  if (!isActive) btn.classList.add('active');

  allLocations.forEach(f => {
    const cat = CATEGORIES[f.properties.category] ? f.properties.category : 'other';
    const show = !activeCategory || cat === activeCategory;
    f._marker?.setStyle({ opacity: show ? 1 : 0, fillOpacity: show ? 0.55 : 0 });
  });

  // Show/refresh the suggestion list for the new filter state
  renderSuggestions();
}

/* Clears the active category filter — called once a navigation session
   wraps up (arrival or cancel), so the next search starts unfiltered
   rather than silently staying scoped to whatever was picked before. */
function resetCategoryFilter() {
  activeCategory = null;
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
  restoreDefaultMarkers();
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

$('backBtn').addEventListener('click', () => {
  resetSearch();
  resetCategoryFilter();
  setState('default');
});

searchInput.addEventListener('input', () => renderSuggestions());

function renderSuggestions() {
  const q = searchInput.value.trim().toLowerCase();
  clearBtn.classList.toggle('visible', q.length > 0);

  // Popular places only make sense with no active filter and no query
  $('popularWrap').style.display = (q || activeCategory) ? 'none' : 'block';

  let hits = allLocations;
  if (activeCategory) {
    hits = hits.filter(f => (CATEGORIES[f.properties.category] ? f.properties.category : 'other') === activeCategory);
  }
  if (q) {
    hits = hits.filter(f => f.properties.Name.toLowerCase().includes(q));
  }

  suggestions.innerHTML = '';

  // Nothing to show: no query and no category selected
  if (!q && !activeCategory) { suggestions.classList.remove('open'); return; }

  if (!hits.length) {
    suggestions.classList.add('open');
    suggestions.innerHTML = `<li class="no-results">No matches${activeCategory ? ` in ${CATEGORIES[activeCategory].label}` : ''}</li>`;
    return;
  }

  suggestions.classList.add('open');
  const limit = q ? 8 : hits.length; // full category list when browsing, capped when searching
  hits.slice(0, limit).forEach((feature, i) => {
    const cfg = CATEGORIES[feature.properties.category] || CATEGORIES.other;
    const li = document.createElement('li');
    li.style.animationDelay = `${Math.min(i, 12) * 28}ms`;
    li.innerHTML = `
      <div class="sug-dot" style="color:${cfg.color};background:${cfg.color}1A">${cfg.icon}</div>
      <span>${escapeHTML(feature.properties.Name)}${feature.properties.safety ? ' <span class="safety-badge">safety</span>' : ''}</span>
    `;
    li.addEventListener('click', () => selectLocation(feature));
    suggestions.appendChild(li);
  });
}

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchInput.focus();
  renderSuggestions();
});

function resetSearch() {
  searchInput.value = '';
  clearBtn.classList.remove('visible');
  suggestions.innerHTML = '';
  suggestions.classList.remove('open');
  $('popularWrap').style.display = 'block';
}

/* ════════════════════════════════
   MARKERS
   ════════════════════════════════ */
function hideAllMarkers() {
  allLocations.forEach(f => f._marker?.setStyle({ opacity: 0, fillOpacity: 0 }));
}

function restoreDefaultMarkers() {
  allLocations.forEach(f => {
    const cat = CATEGORIES[f.properties.category] ? f.properties.category : 'other';
    const show = !activeCategory || cat === activeCategory;
    f._marker?.setStyle({ opacity: show ? 1 : 0, fillOpacity: show ? 0.55 : 0 });
  });
}

function showMarker(feature) {
  hideAllMarkers();
  feature._marker?.setStyle({ opacity: 1, fillOpacity: 0.95 });
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

$('navBackBtn').addEventListener('click', () => {
  selectedLoc = null;
  restoreDefaultMarkers(); // respects the active category filter, if any
  setState('default');
});

/* ════════════════════════════════
   NAVIGATE
   ════════════════════════════════ */
$('navigateBtn').addEventListener('click', () => {
  if (!selectedLoc) return;
  if (!userLocation) { toast('📍 Still finding your location…'); return; }
  const [lng, lat] = selectedLoc.geometry.coordinates;
  startNav([lat, lng]);
});

function startNav(dest) {
  clearRoute();
  isNavigating = true;
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

  routingControl.on('routesfound', () => checkArrival(dest));
  routingControl.on('routingerror', () => {
    toast('⚠️ Could not find a route. Check your connection.');
    isNavigating = false;
    setState('location');
    clearRoute();
  });
}

function clearRoute() {
  if (routingControl) { map.removeControl(routingControl); routingControl = null; }
}

$('cancelNavBtn').addEventListener('click', () => {
  clearRoute();
  resetCategoryFilter();
  isNavigating = false;
  setState('default');
});

/* ════════════════════════════════
   ARRIVAL CHECK — runs off the GPS watcher, not its own timer
   ════════════════════════════════ */
let arrivalDest = null;
function checkArrival(dest) {
  arrivalDest = dest;
}

function evaluateArrival() {
  if (!arrivalDest || !userLocation || !isNavigating) return;
  if (dist(userLocation, arrivalDest) < 20) {
    arrivalDest = null;
    isNavigating = false;
    clearRoute();
    resetCategoryFilter();
    toast("🎉 You've arrived!");
    setState('default');
  }
}

/* ════════════════════════════════
   USER LOCATION
   ════════════════════════════════ */
function trackUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    ({ coords: { latitude: lat, longitude: lng } }) => {
      userLocation = [lat, lng];
      if (!userMarker) {
        userMarker = L.circleMarker([lat, lng], {
          radius: 10, fillColor: '#3B82F6', color: '#fff', weight: 3, fillOpacity: 1
        }).addTo(map).bindPopup('📍 You are here');
        map.setView([lat, lng], 17);
      } else {
        userMarker.setLatLng([lat, lng]);
      }
      if (isNavigating && routingControl) {
        const wps = routingControl.getWaypoints();
        if (wps.length >= 2) {
          routingControl.setWaypoints([L.latLng(lat, lng), wps.at(-1).latLng]);
        }
      }
      evaluateArrival();
    },
    err => {
      console.warn('Geolocation error:', err.message);
      if (err.code === err.PERMISSION_DENIED) {
        toast('📍 Location access denied — enable it in your browser settings to navigate.');
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
  if (!RSU_BOUNDS.contains(userLocation)) {
    toast("📍 You appear to be off-campus — can't pinpoint a nearby landmark.");
    return;
  }
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
   THEME (system / light / dark)
   ════════════════════════════════ */
const THEME_KEY   = 'unimap-theme-pref';
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_ICONS = { system: '🖥️', light: '☀️', dark: '🌙' };
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function resolveTheme(pref) {
  return pref === 'system' ? (darkMediaQuery.matches ? 'dark' : 'light') : pref;
}

function applyTheme(pref) {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  const iconEl = $('themeIcon');
  if (iconEl) iconEl.textContent = THEME_ICONS[pref];
}

function initTheme() {
  const pref = localStorage.getItem(THEME_KEY) || 'system';
  applyTheme(pref);
  darkMediaQuery.addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system');
  });
}

$('themeToggleBtn')?.addEventListener('click', () => {
  const current = localStorage.getItem(THEME_KEY) || 'system';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  toast(`Theme: ${next[0].toUpperCase()}${next.slice(1)}`);
});

/* ════════════════════════════════
   BOOT
   ════════════════════════════════ */
initTheme();
initMap();
setState('default');