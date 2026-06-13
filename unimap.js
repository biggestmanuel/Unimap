/* =====================
   UNIMAP — MAIN SCRIPT
   ===================== */

const RSU_CENTER = [4.7975, 6.9805];
const RSU_BOUNDS = L.latLngBounds([4.788, 6.972], [4.808, 6.990]);

const POPULAR_PLACES = [
  "UST Shuttle Park","Convocation Arena","Faculty of Management Sciences",
  "FACULTY OF ENGINEERING","Faculty of Law, Rivers State University",
  "F&G hostel","NDDC Hostel","Hostel C","Shopping Complex","Love Garden",
  "PG&H Hostel","Back Gate Shuttle Park","UST Back Gate",
  "CCE(Centre for Continuous Education)","College of Medical Sciences, RSU"
];

const POPULAR_LABELS = {
  "UST Shuttle Park": "Shuttle Park",
  "Convocation Arena": "Convo Arena",
  "Faculty of Management Sciences": "Management",
  "FACULTY OF ENGINEERING": "Engineering",
  "Faculty of Law, Rivers State University": "Law Faculty",
  "F&G hostel": "F&G Hostel",
  "NDDC Hostel": "NDDC Hostel",
  "Hostel C": "Hostel C",
  "Shopping Complex": "Shopping Complex",
  "Love Garden": "Love Garden",
  "PG&H Hostel": "PG&H Hostel",
  "Back Gate Shuttle Park": "Back Gate Park",
  "UST Back Gate": "Back Gate",
  "CCE(Centre for Continuous Education)": "CCE",
  "College of Medical Sciences, RSU": "Med Sciences"
};

// =====================
// STATE
// =====================
// 'default' | 'search' | 'location' | 'navigating'
let currentState = 'default';
let map, userMarker, userLocation = null;
let routingControl = null;
let allLocations = [];
let selectedLocation = null;
let isNavigating = false;

// =====================
// DOM REFS
// =====================
const defaultBar   = document.getElementById('defaultBar');
const fullSheet    = document.getElementById('fullSheet');
const navBar       = document.getElementById('navBar');
const navControls  = document.getElementById('navControls');
const searchInput  = document.getElementById('searchInput');
const suggestions  = document.getElementById('suggestions');
const clearBtn     = document.getElementById('clearBtn');
const backBtn      = document.getElementById('backBtn');
const lostBtn      = document.getElementById('lostBtn');
const searchTrigger= document.getElementById('searchTrigger');

// =====================
// STATE MACHINE
// =====================
function setState(state) {
  currentState = state;

  // Hide everything first
  defaultBar.classList.add('hidden');
  fullSheet.classList.remove('open');
  navBar.classList.add('hidden');
  navControls.classList.remove('visible');
  lostBtn.classList.add('hidden');

  if (state === 'default') {
    defaultBar.classList.remove('hidden');
    lostBtn.classList.remove('hidden');
  }

  if (state === 'search') {
    fullSheet.classList.add('open');
    setTimeout(() => searchInput.focus(), 80);
  }

  if (state === 'location') {
    navBar.classList.remove('hidden');
    lostBtn.classList.remove('hidden');
  }

  if (state === 'navigating') {
    navControls.classList.add('visible');
    lostBtn.classList.remove('hidden');
  }
}

// =====================
// INIT MAP
// =====================
function initMap() {
  map = L.map('map', {
    center: RSU_CENTER,
    zoom: 16,
    zoomControl: true,
    maxBounds: RSU_BOUNDS,
    maxBoundsViscosity: 0.8
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    minZoom: 14
  }).addTo(map);

  loadLocations();
  startTracking();
  handleOffline();
}

// =====================
// LOAD GEOJSON
// =====================
async function loadLocations() {
  try {
    const res = await fetch('unimap.geojson');
    const data = await res.json();
    allLocations = data.features.filter(f => f.geometry.type === 'Point');

    allLocations.forEach(feature => {
      const [lng, lat] = feature.geometry.coordinates;
      const name = feature.properties.Name;
      const desc = feature.properties.description;

      const marker = L.circleMarker([lat, lng], {
        radius: 8, fillColor: '#2563eb', color: '#ffffff',
        weight: 2, opacity: 0, fillOpacity: 0
      }).addTo(map);

      marker.bindPopup(`<strong>${name}</strong>${desc ? `<br><span style="color:#6b7fa3;font-size:12px">${desc}</span>` : ''}`);
      marker.on('click', () => selectLocation(feature));
      feature._marker = marker;
    });

    renderPopularChips();
  } catch (err) {
    console.error('Failed to load locations:', err);
  }
}

// =====================
// POPULAR CHIPS
// =====================
function renderPopularChips() {
  const container = document.getElementById('popularChips');
  container.innerHTML = '';
  POPULAR_PLACES.forEach((name, i) => {
    const loc = allLocations.find(f => f.properties.Name === name);
    if (!loc) return;
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = POPULAR_LABELS[name] || name;
    chip.style.animationDelay = `${i * 30}ms`;
    chip.addEventListener('click', () => selectLocation(loc));
    container.appendChild(chip);
  });
}

// =====================
// SEARCH INTERACTIONS
// =====================
// Open search on tap
searchTrigger.addEventListener('click', () => setState('search'));

// Back button
backBtn.addEventListener('click', () => {
  searchInput.value = '';
  suggestions.innerHTML = '';
  suggestions.classList.remove('open');
  clearBtn.classList.remove('visible');
  document.getElementById('popularSection').style.display = 'block';
  setState('default');
});

// Live search
searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();
  const popularSection = document.getElementById('popularSection');

  clearBtn.classList.toggle('visible', query.length > 0);

  if (!query) {
    suggestions.innerHTML = '';
    suggestions.classList.remove('open');
    popularSection.style.display = 'block';
    return;
  }

  popularSection.style.display = 'none';

  const matches = allLocations.filter(f =>
    f.properties.Name.toLowerCase().includes(query)
  );

  suggestions.innerHTML = '';
  if (!matches.length) { suggestions.classList.remove('open'); return; }

  suggestions.classList.add('open');
  matches.slice(0, 8).forEach((feature, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 25}ms`;
    li.innerHTML = `<span class="sug-icon">📍</span>${feature.properties.Name}`;
    li.addEventListener('click', () => selectLocation(feature));
    suggestions.appendChild(li);
  });
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  suggestions.innerHTML = '';
  suggestions.classList.remove('open');
  clearBtn.classList.remove('visible');
  document.getElementById('popularSection').style.display = 'block';
  searchInput.focus();
});

// =====================
// MARKER VISIBILITY
// =====================
function hideAllMarkers() {
  allLocations.forEach(f => {
    if (f._marker) f._marker.setStyle({ opacity: 0, fillOpacity: 0 });
  });
}

function showMarker(feature) {
  hideAllMarkers();
  if (feature._marker) feature._marker.setStyle({ opacity: 1, fillOpacity: 0.9 });
}

// =====================
// SELECT LOCATION
// =====================
function selectLocation(feature) {
  selectedLocation = feature;
  const [lng, lat] = feature.geometry.coordinates;

  showMarker(feature);
  map.flyTo([lat, lng], 18, { duration: 1.0, easeLinearity: 0.3 });

  document.getElementById('navLocationName').textContent = feature.properties.Name;

  setState('location');
}

// =====================
// NAVIGATE
// =====================
document.getElementById('navigateBtn').addEventListener('click', () => {
  if (!selectedLocation) return;
  if (!userLocation) { showToast('📍 Still finding your location...'); return; }
  const [lng, lat] = selectedLocation.geometry.coordinates;
  startNavigation([lat, lng]);
});

function startNavigation(destination) {
  clearRoute();
  isNavigating = true;
  setState('navigating');

  routingControl = L.Routing.control({
    waypoints: [
      L.latLng(userLocation[0], userLocation[1]),
      L.latLng(destination[0], destination[1])
    ],
    routeWhileDragging: false,
    addWaypoints: false,
    fitSelectedRoutes: true,
    showAlternatives: false,
    router: L.Routing.osrmv1({
      serviceUrl: 'https://router.project-osrm.org/route/v1',
      profile: 'foot'
    }),
    lineOptions: { styles: [{ color: '#2563eb', weight: 5, opacity: 0.9 }] },
    createMarker: () => null
  }).addTo(map);

  routingControl.on('routesfound', () => checkArrival(destination));
}

function clearRoute() {
  if (routingControl) { map.removeControl(routingControl); routingControl = null; }
}

// Cancel navigation
document.getElementById('cancelNavBtn').addEventListener('click', () => {
  clearRoute();
  hideAllMarkers();
  isNavigating = false;
  setState('default');
});

// =====================
// ARRIVAL CHECK
// =====================
function checkArrival(destination) {
  if (!isNavigating) return;
  const interval = setInterval(() => {
    if (!userLocation || !isNavigating) { clearInterval(interval); return; }
    if (getDistanceMeters(userLocation, destination) < 20) {
      clearInterval(interval);
      isNavigating = false;
      showToast("🎉 You've arrived at your destination!");
      clearRoute();
      hideAllMarkers();
      setState('default');
    }
  }, 3000);
}

// =====================
// USER LOCATION
// =====================
function startTracking() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    ({ coords: { latitude, longitude } }) => {
      userLocation = [latitude, longitude];
      if (!userMarker) {
        userMarker = L.circleMarker([latitude, longitude], {
          radius: 10, fillColor: '#3b9eff', color: '#ffffff', weight: 3, fillOpacity: 1
        }).addTo(map).bindPopup('📍 You are here');
        map.setView([latitude, longitude], 17);
      } else {
        userMarker.setLatLng([latitude, longitude]);
      }
      // Reroute if off track
      if (isNavigating && routingControl) {
        const wps = routingControl.getWaypoints();
        if (wps.length >= 2) {
          routingControl.setWaypoints([
            L.latLng(latitude, longitude),
            wps[wps.length - 1].latLng
          ]);
        }
      }
    },
    err => console.warn('Location error:', err.message),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

// =====================
// I'M LOST
// =====================
lostBtn.addEventListener('click', () => {
  if (!userLocation) { showToast('📍 Still finding your location...'); return; }
  let nearest = null, minDist = Infinity;
  allLocations.forEach(feature => {
    const [lng, lat] = feature.geometry.coordinates;
    const dist = getDistanceMeters(userLocation, [lat, lng]);
    if (dist < minDist) { minDist = dist; nearest = feature; }
  });
  if (nearest) {
    showToast(`📍 Nearest: ${nearest.properties.Name} (${Math.round(minDist)}m)`);
    map.flyTo(userLocation, 17);
    setTimeout(() => selectLocation(nearest), 2000);
  }
});

// =====================
// TOAST
// =====================
function showToast(message) {
  const toast = document.getElementById('arrivedToast');
  toast.querySelector('.toast-msg').textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// =====================
// OFFLINE
// =====================
function handleOffline() {
  const banner = document.getElementById('offlineBanner');
  window.addEventListener('offline', () => banner.classList.add('show'));
  window.addEventListener('online', () => banner.classList.remove('show'));
  if (!navigator.onLine) banner.classList.add('show');
}

// =====================
// DISTANCE HELPER
// =====================
function getDistanceMeters([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// =====================
// START
// =====================
initMap();
setState('default');