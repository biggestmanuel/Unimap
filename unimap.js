/* ================================================
   UNIMAP — Modern Script (Redesign)
   ================================================ */

const RSU_CENTER = [4.7975, 6.9805];
const RSU_BOUNDS = L.latLngBounds([4.788, 6.972], [4.808, 6.990]);
const REPORT_EMAIL = 'unimap.rsu@gmail.com';

/* ── Geofencing Config (100m buffer for GPS drift tolerance) ── */
const GEOFENCE_BUFFER_METERS = 100;
const RSU_CAMPUS_POLYGON = [
  [4.808, 6.990],
  [4.808, 6.972],
  [4.788, 6.972],
  [4.788, 6.990],
  [4.808, 6.990]
];
const GEOFENCE_CHECK_INTERVAL = 10000; // 10 seconds

/* ── Network Resilience Config ── */
const RETRY_CONFIG = {
  maxAttempts: 3,
  initialDelay: 1000,      // Start with 1s
  maxDelay: 10000,         // Cap at 10s
  backoffMultiplier: 2,    // Exponential: 1s, 2s, 4s
  timeout: 5000            // 5s request timeout
};

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
let activeCategory = null;

/* ── Geofence State ── */
let isOnCampus = false;
let geofenceCheckTimer = null;
let featuresFrozen = false;

/* ── Network State ── */
let isOnlineConnection = navigator.onLine;
let networkBannerTimer = null;

/* ── DOM ── */
const $ = id => document.getElementById(id);
const defaultBar   = $('defaultBar');
const fullSheet    = $('fullSheet');
const navBar       = $('navBar');
const navOverlay   = $('navOverlay');
const searchInput  = $('searchInput');
const suggestions  = $('suggestions');
const clearBtn     = $('clearBtn');
const lostBtn      = $('lostBtn');
const geofenceModal = $('geofenceModal');
const retryLocationBtn = $('retryLocationBtn');
const networkBanner = $('networkBanner');

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
   NETWORK RESILIENCE
   ════════════════════════════════ */

/**
 * Show/hide network status banner
 */
function showNetworkBanner(show = true) {
  if (!networkBanner) return;
  if (show) {
    networkBanner.classList.add('visible');
  } else {
    networkBanner.classList.remove('visible');
  }
}

/**
 * Detect network status changes
 */
function setupNetworkDetection() {
  // Check online/offline status
  window.addEventListener('online', () => {
    isOnlineConnection = true;
    showNetworkBanner(false);
    toast('Connected - Using live data');
  });

  window.addEventListener('offline', () => {
    isOnlineConnection = false;
    showNetworkBanner(true);
    toast('Offline - Using cached data');
  });

  // Check connection speed periodically (simple method)
  setInterval(() => {
    if (!navigator.connection) return;
    
    const connection = navigator.connection;
    const effectiveType = connection.effectiveType; // '4g', '3g', '2g', 'slow-2g'
    const saveData = connection.saveData;
    
    if (effectiveType === '2g' || effectiveType === 'slow-2g' || saveData) {
      isOnlineConnection = true; // Still online, but slow
      showNetworkBanner(true);
    }
  }, 5000);
}

/**
 * Fetch with smart retry and timeout
 */
async function fetchWithRetry(url, options = {}) {
  let lastError;
  let delay = RETRY_CONFIG.initialDelay;

  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RETRY_CONFIG.timeout);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      
      if (attempt < RETRY_CONFIG.maxAttempts) {
        console.warn(`[Network] Attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * RETRY_CONFIG.backoffMultiplier, RETRY_CONFIG.maxDelay);
      }
    }
  }

  console.error(`[Network] All ${RETRY_CONFIG.maxAttempts} attempts failed:`, lastError);
  throw lastError;
}

/* ════════════════════════════════
   GEOFENCING
   ════════════════════════════════ */

/**
 * Point-in-polygon test using ray casting algorithm
 * Tests if a point is inside a polygon with a buffer tolerance
 */
function isPointInPolygon([lat, lng], polygon, bufferMeters = 0) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [lat1, lon1] = polygon[i];
    const [lat2, lon2] = polygon[j];
    
    if ((lon1 > lng) !== (lon2 > lng) &&
        lat < (lat2 - lat1) * (lng - lon1) / (lon2 - lon1) + lat1) {
      inside = !inside;
    }
  }
  
  if (!inside && bufferMeters > 0) {
    for (let i = 0; i < polygon.length - 1; i++) {
      const edgeDist = pointToLineDistance([lat, lng], polygon[i], polygon[i + 1]);
      if (edgeDist < bufferMeters / 111000) {
        return true;
      }
    }
  }
  
  return inside;
}

/**
 * Calculate perpendicular distance from point to line segment
 */
function pointToLineDistance(point, lineStart, lineEnd) {
  const [lat, lng] = point;
  const [lat1, lng1] = lineStart;
  const [lat2, lng2] = lineEnd;
  
  const A = lat - lat1;
  const B = lng - lng1;
  const C = lat2 - lat1;
  const D = lng2 - lng1;
  
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  
  if (lenSq !== 0) param = dot / lenSq;
  
  let xx, yy;
  if (param < 0) {
    xx = lat1;
    yy = lng1;
  } else if (param > 1) {
    xx = lat2;
    yy = lng2;
  } else {
    xx = lat1 + param * C;
    yy = lng1 + param * D;
  }
  
  const dx = lat - xx;
  const dy = lng - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Check if user is within campus boundary (with buffer)
 */
function checkGeofence(location) {
  if (!location) return false;
  const wasOnCampus = isOnCampus;
  isOnCampus = isPointInPolygon(location, RSU_CAMPUS_POLYGON, GEOFENCE_BUFFER_METERS);
  
  if (!wasOnCampus && isOnCampus) {
    toast('📍 Welcome back to campus! All features unlocked.');
    unlockFeatures();
  } else if (wasOnCampus && !isOnCampus) {
    freezeFeatures();
    showGeofenceModal();
  }
  
  return isOnCampus;
}

/**
 * Show the out-of-campus modal
 */
function showGeofenceModal() {
  geofenceModal.classList.add('visible');
}

/**
 * Hide the geofence modal
 */
function hideGeofenceModal() {
  geofenceModal.classList.remove('visible');
}

/**
 * Freeze (disable) navigation and locked features
 */
function freezeFeatures() {
  featuresFrozen = true;
  $('navigateBtn').disabled = true;
  $('navigateBtn').style.opacity = '0.5';
  $('navigateBtn').style.cursor = 'not-allowed';
  lostBtn.disabled = true;
  lostBtn.style.opacity = '0.5';
}

/**
 * Unlock all features
 */
function unlockFeatures() {
  featuresFrozen = false;
  hideGeofenceModal();
  $('navigateBtn').disabled = false;
  $('navigateBtn').style.opacity = '1';
  $('navigateBtn').style.cursor = 'pointer';
  lostBtn.disabled = false;
  lostBtn.style.opacity = '1';
}

/**
 * Intelligently check geofence - only when navigating or at boundaries
 */
function startGeofenceMonitoring() {
  if (geofenceCheckTimer) clearInterval(geofenceCheckTimer);
  
  // Only check actively when navigating or when location changes significantly
  let lastCheckLocation = userLocation;
  const CHECK_DISTANCE_M = 30; // Only recheck if moved 30+ meters

  geofenceCheckTimer = setInterval(() => {
    if (!userLocation) return;

    // Calculate distance from last check
    const R = 6371000; // Earth radius in meters
    const dLat = (userLocation[0] - lastCheckLocation[0]) * Math.PI / 180;
    const dLng = (userLocation[1] - lastCheckLocation[1]) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lastCheckLocation[0] * Math.PI / 180) * Math.cos(userLocation[0] * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;

    // Only recheck if moved significantly
    if (distance > CHECK_DISTANCE_M || isNavigating) {
      checkGeofence(userLocation);
      lastCheckLocation = userLocation;
    }
  }, 5000); // Check every 5s instead of 10s, but with smart gating
}

/* ════════════════════════════════
   MAP INIT
   ══════════════════════��═════════ */
async function initMap() {
  map = L.map('map', {
    center: RSU_CENTER,
    zoom: 16,
    zoomControl: true,
    maxBounds: RSU_BOUNDS,
    maxBoundsViscosity: 0.85
  });

  // Add tiles immediately (low data impact)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
    minZoom: 14
  }).addTo(map);

  // Initialize DB for caching
  await initDB().catch(() => null);

  // Load POIs first (higher priority), defer events
  await loadLocations();
  
  // Load tracking immediately
  trackUser();
  watchOffline();

  // Hide skeleton once POIs are ready
  const skeleton = $('loadingSkeleton');
  if (skeleton) {
    skeleton.classList.add('hidden');
  }

  // Load events in background (lower priority)
  loadEvents().catch(() => {
    console.warn('[UniMap] Events load failed, continuing without events');
  });
}

/* ════════════════════════════════
   LOAD GEOJSON (POIs) - Optimized with caching
   ════════════════════════════════ */
async function loadLocations() {
  try {
    // Try to use cached data first (stale-while-revalidate)
    let data = null;
    let usedCache = false;

    // Check if cache is fresh
    const cached = await getCachedData(STORES.locations);
    const isFresh = await isCacheFresh(STORES.locations, 6 * 60 * 60 * 1000); // 6 hours

    if (cached && isFresh) {
      // Use cache immediately
      data = { features: cached };
      usedCache = true;
      console.log('[UniMap] Using fresh cached locations');
    }

    // Fetch fresh data in background if not using fresh cache
    if (!isFresh) {
      try {
        const res = await fetchWithRetry('unimap.geojson');
        data = await res.json();
        await cacheData(STORES.locations, data.features, { source: 'network' });
        if (usedCache) console.log('[UniMap] Updated location cache from network');
      } catch (netErr) {
        if (!usedCache) {
          // Network failed and no cache available
          throw netErr;
        }
        // Use stale cache if available
        console.warn('[UniMap] Network failed, using stale cache:', netErr.message);
      }
    }

    if (!data) throw new Error('No data available');

    // Filter and render markers
    allLocations = data.features.filter(f => f.geometry.type === 'Point');

    // Lazy-load markers: render only visible ones initially
    const viewport = map.getBounds();
    let markersRendered = 0;
    const maxInitialMarkers = 50;

    allLocations.forEach((feature, idx) => {
      const [lng, lat] = feature.geometry.coordinates;
      const latlng = L.latLng(lat, lng);
      
      // Only render markers in viewport on initial load (optimization)
      const isVisible = viewport.contains(latlng);
      const shouldRender = isVisible || markersRendered < maxInitialMarkers;

      if (shouldRender) {
        addMarkerToMap(feature);
        markersRendered++;
      } else {
        // Defer marker rendering for off-screen items
        setTimeout(() => addMarkerToMap(feature), 2000 + idx * 10);
      }
    });

    buildChips();
    buildCategoryFilters();
    
  } catch (e) {
    console.error('[UniMap] GeoJSON load failed:', e.message);
    toast('Map data unavailable - check your connection');
  }
}

/**
 * Add single marker to map (extracted for lazy loading)
 */
function addMarkerToMap(feature) {
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
    fillOpacity: 0.5,
    className: safety ? 'pin-safety' : ''
  }).addTo(map);

  m.bindPopup(() => buildPopupHTML(feature));
  m.on('click', () => selectLocation(feature));
  feature._marker = m;
}

/* ════════════════════════════════
   LOAD EVENTS - Background fetch with caching
   ════════════════════════════════ */
async function loadEvents() {
  try {
    // Try cached events first
    let data = null;
    const cached = await getCachedData(STORES.events);
    const isFresh = await isCacheFresh(STORES.events, 2 * 60 * 60 * 1000); // 2 hours for events

    if (cached && isFresh) {
      data = { events: cached };
    }

    // Fetch fresh in background
    fetchWithRetry('events.json')
      .then(res => res.json())
      .then(freshData => {
        if (freshData.events && freshData.events.length > 0) {
          cacheData(STORES.events, freshData.events, { source: 'network' });
        }
      })
      .catch(() => {
        // Silent fail for events (non-critical)
      });

    if (!data) return;

    const now = new Date();
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
    console.warn('[UniMap] Events load failed (optional):', e.message);
  }
}

function buildEventPopupHTML(ev) {
  const start = new Date(ev.start);
  const dateStr = start.toLocaleDateString('en-NG', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = start.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  return `
    <strong>📅 ${escapeHTML(ev.title)}</strong><br>
    <span style="color:#6B6B6F;font-size:12px">${dateStr} · ${timeStr}</span>
    ${ev.description ? `<p style="margin-top:6px;font-size:13px">${escapeHTML(ev.description)}</p>` : ''}
  `;
}

/* ════════════════════════════════
   POPUP BUILDER
   ════════════════════════════════ */
function buildPopupHTML(feature) {
  const { Name, category, indoorDescription, accessibility, safety } = feature.properties;
  const cfg = CATEGORIES[category] || CATEGORIES.other;

  let html = `<strong>${cfg.icon} ${escapeHTML(Name)}</strong>`;
  html += `<br><span style="color:${cfg.color};font-size:11px;font-weight:600">${cfg.label}${safety ? ' · Safety Point' : ''}</span>`;

  if (indoorDescription) {
    html += `<p style="margin-top:6px;font-size:12px;color:#1D1D1F">${escapeHTML(indoorDescription)}</p>`;
  }

  if (accessibility && accessibility.length) {
    const tags = accessibility.map(a => `<span class="a11y-tag">♿ ${escapeHTML(a)}</span>`).join('');
    html += `<div style="margin-top:8px">${tags}</div>`;
  }

  html += `<button class="popup-report-btn" onclick="reportIssue('${escapeAttr(Name)}')">⚠️ Report issue</button>`;
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
   REPORT AN ISSUE
   ════════════════════════════════ */
function reportIssue(placeName) {
  const subject = encodeURIComponent(`UniMap Issue Report: ${placeName || 'General'}`);
  const bodyLines = [
    `Location: ${placeName || 'Not specified'}`,
    userLocation ? `My current coordinates: ${userLocation[0].toFixed(6)}, ${userLocation[1].toFixed(6)}` : '',
    `Reported at: ${new Date().toLocaleString('en-NG')}`,
    '',
    'Describe the issue (wrong pin, missing location, broken route, accessibility, safety concern, etc.):',
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
    f._marker?.setStyle({ opacity: show ? 1 : 0, fillOpacity: show ? 0.5 : 0 });
  });

  renderSuggestions();
}

function resetCategoryFilter() {
  activeCategory = null;
  document.querySelectorAll('.cat-chip').forEach(c => c.classList.remove('active'));
  restoreDefaultMarkers();
}

/* ═════════������═════════════════════
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
    btn.style.animationDelay = `${i * 30}ms`;
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

  $('popularWrap').style.display = (q || activeCategory) ? 'none' : 'block';

  let hits = allLocations;
  if (activeCategory) {
    hits = hits.filter(f => (CATEGORIES[f.properties.category] ? f.properties.category : 'other') === activeCategory);
  }
  if (q) {
    hits = hits.filter(f => f.properties.Name.toLowerCase().includes(q));
  }

  suggestions.innerHTML = '';

  if (!q && !activeCategory) {
    suggestions.classList.remove('open');
    return;
  }

  if (!hits.length) {
    suggestions.classList.add('open');
    suggestions.innerHTML = `<li class="no-results">No matches${activeCategory ? ` in ${CATEGORIES[activeCategory].label}` : ''}</li>`;
    return;
  }

  suggestions.classList.add('open');
  const limit = q ? 8 : hits.length;
  hits.slice(0, limit).forEach((feature, i) => {
    const cfg = CATEGORIES[feature.properties.category] || CATEGORIES.other;
    const li = document.createElement('li');
    li.style.animationDelay = `${Math.min(i, 12) * 25}ms`;
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
    f._marker?.setStyle({ opacity: show ? 1 : 0, fillOpacity: show ? 0.5 : 0 });
  });
}

function showMarker(feature) {
  hideAllMarkers();
  feature._marker?.setStyle({ opacity: 1, fillOpacity: 0.95 });
}

/* ════════════════════════════════
   SELECT LOCATION
   ════════════════════���═══════════ */
function selectLocation(feature) {
  selectedLoc = feature;
  const [lng, lat] = feature.geometry.coordinates;
  showMarker(feature);
  map.flyTo([lat, lng], 18, { duration: 0.9, easeLinearity: 0.25 });
  
  const cfg = CATEGORIES[feature.properties.category] || CATEGORIES.other;
  $('destLabel').textContent = feature.properties.Name;
  $('destCategory').textContent = cfg.label;
  
  resetSearch();
  setState('location');
}

$('navBackBtn').addEventListener('click', () => {
  selectedLoc = null;
  restoreDefaultMarkers();
  setState('default');
});

/* ════════════════════════════════
   NAVIGATE
   ════════════════════════════════ */
$('navigateBtn').addEventListener('click', () => {
  if (!selectedLoc) return;
  if (featuresFrozen) {
    toast('🗺️ Navigation is only available on campus.');
    return;
  }
  if (!userLocation) {
    toast('📍 Still finding your location…');
    return;
  }
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
      styles: [{ color: '#FF6B3D', weight: 5, opacity: 0.85 }]
    },
    createMarker: () => null
  }).addTo(map);

  routingControl.on('routesfound', (e) => {
    updateNavInfo(e.routes[0]);
    checkArrival(dest);
  });
  routingControl.on('routingerror', () => {
    toast('⚠️ Could not find a route. Check your connection.');
    isNavigating = false;
    setState('location');
    clearRoute();
  });
}

function updateNavInfo(route) {
  const distance = Math.round(route.summary.totalDistance);
  const time = Math.round(route.summary.totalTime / 60);
  
  $('navDistance').textContent = `${distance > 1000 ? (distance/1000).toFixed(1) : distance}${distance > 1000 ? 'km' : 'm'}`;
  $('navTime').textContent = `${time} min`;
}

function clearRoute() {
  if (routingControl) {
    map.removeControl(routingControl);
    routingControl = null;
  }
}

$('cancelNavBtn').addEventListener('click', () => {
  clearRoute();
  resetCategoryFilter();
  isNavigating = false;
  setState('default');
});

/* ════════════════════════════════
   ARRIVAL CHECK
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
      
      // Check geofence on location update
      checkGeofence(userLocation);
      
      if (!userMarker) {
        userMarker = L.circleMarker([lat, lng], {
          radius: 10,
          fillColor: '#FF6B3D',
          color: '#fff',
          weight: 3,
          fillOpacity: 1
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
        toast('📍 Enable location in browser settings to navigate.');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

/* ════════════════════════════════
   I'M LOST
   ════════════════════════════════ */
lostBtn.addEventListener('click', () => {
  if (!userLocation) {
    toast("📍 Still finding your location…");
    return;
  }
  if (!RSU_BOUNDS.contains(userLocation)) {
    toast("📍 You're off-campus — can't find a nearby landmark.");
    return;
  }
  let nearest = null, minD = Infinity;
  allLocations.forEach(f => {
    const [lng, lat] = f.geometry.coordinates;
    const d = dist(userLocation, [lat, lng]);
    if (d < minD) {
      minD = d;
      nearest = f;
    }
  });
  if (nearest) {
    const distance = minD > 1000 ? (minD/1000).toFixed(1) + 'km' : Math.round(minD) + 'm';
    toast(`📍 Nearest: ${nearest.properties.Name} (${distance})`);
    map.flyTo(userLocation, 17);
    setTimeout(() => selectLocation(nearest), 2000);
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ════════════════════════════════
   OFFLINE
   ════════════════════════════════ */
function watchOffline() {
  const bar = $('offlineBar');
  window.addEventListener('offline', () => bar.classList.add('show'));
  window.addEventListener('online', () => bar.classList.remove('show'));
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
const THEME_KEY = 'unimap-theme-pref';
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
   LOCATION PERMISSION HANDLERS (Event Delegation)
   ════════════════════════════════ */
document.addEventListener('click', (e) => {
  if (e.target.closest('.btn-enable-location')) {
    const prompt = $('locationPrompt');
    prompt.classList.add('hidden');
    prompt.style.display = 'none';
    trackUser();
  }
  if (e.target.closest('.btn-skip-location')) {
    const prompt = $('locationPrompt');
    prompt.classList.add('hidden');
    prompt.style.display = 'none';
    toast('📍 Location skipped. You can enable it anytime via the map.');
  }
});

/* ════════════════════════════════
   GEOFENCE EVENT LISTENERS
   ════════════════════════════════ */
if (retryLocationBtn) {
  retryLocationBtn.addEventListener('click', () => {
    if (userLocation) {
      checkGeofence(userLocation);
    } else {
      toast('📍 Checking your location...');
    }
  });
}

const viewCampusBtn = document.querySelector('.btn-view-campus-map');
if (viewCampusBtn) {
  viewCampusBtn.addEventListener('click', () => {
    hideGeofenceModal();
    toast('📍 Map is in read-only mode. Move onto campus to unlock navigation.');
  });
}

/* ════════════════════════════════
   BOOT - Optimized startup sequence
   ════════════════════════════════ */

// Show loading skeleton while preparing
const skeleton = $('loadingSkeleton');
if (skeleton) {
  skeleton.classList.remove('hidden');
}

// Start UI immediately
initTheme();
setupNetworkDetection();
setState('default');

// Show network status if offline
if (!navigator.onLine) {
  showNetworkBanner(true);
}

// Initialize map asynchronously (won't block)
initMap()
  .then(() => {
    startGeofenceMonitoring();
    // Skeleton will be hidden by initMap when ready
  })
  .catch((err) => {
    console.error('[UniMap] Boot failed:', err);
    if (skeleton) skeleton.classList.add('hidden');
    toast('Failed to load map - please refresh');
  });
