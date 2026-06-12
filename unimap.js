/* =====================
   UNIMAP — MAIN SCRIPT
   ===================== */

// RSU Campus center coordinates
const RSU_CENTER = [4.7975, 6.9805];
const RSU_BOUNDS = L.latLngBounds(
  [4.788, 6.972],
  [4.808, 6.990]
);

// Popular places (matching names in GeoJSON)
const POPULAR_PLACES = [
  "UST Shuttle Park",
  "Convocation Arena",
  "Faculty of Management Sciences",
  "FACULTY OF ENGINEERING",
  "Faculty of Law, Rivers State University",
  "F&G hostel",
  "NDDC Hostel",
  "Hostel C",
  "Shopping Complex",
  "Love Garden",
  "PG&H Hostel",
  "Back Gate Shuttle Park",
  "UST Back Gate",
  "CCE(Centre for Continuous Education)",
  "College of Medical Sciences, RSU"
];

// Friendly display names for popular chips
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
let map;
let userMarker;
let userLocation = null;
let routingControl = null;
let allLocations = [];
let selectedLocation = null;
let watchId = null;
let isNavigating = false;

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

  // OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    minZoom: 14
  }).addTo(map);

  // Load GeoJSON
  loadLocations();

  // Start tracking user
  startTracking();

  // Offline detection
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

    // Add markers to map
    allLocations.forEach(feature => {
      const [lng, lat] = feature.geometry.coordinates;
      const name = feature.properties.Name;
      const desc = feature.properties.description;

      const marker = L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: '#22a060',
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      }).addTo(map);

      marker.bindPopup(`<strong>${name}</strong>${desc ? `<br><span style="color:#6b7f74;font-size:12px">${desc}</span>` : ''}`);

      marker.on('click', () => {
        selectLocation(feature);
      });

      feature._marker = marker;
    });

    // Render popular chips
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

  POPULAR_PLACES.forEach(name => {
    const location = allLocations.find(f => f.properties.Name === name);
    if (!location) return;

    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = POPULAR_LABELS[name] || name;
    chip.addEventListener('click', () => {
      selectLocation(location);
      closeSuggestions();
    });
    container.appendChild(chip);
  });
}

// =====================
// SEARCH
// =====================
const searchInput = document.getElementById('searchInput');
const suggestionsList = document.getElementById('suggestions');
const clearBtn = document.getElementById('clearBtn');
const popularSection = document.getElementById('popularSection');

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim().toLowerCase();

  if (query.length === 0) {
    closeSuggestions();
    clearBtn.classList.remove('visible');
    popularSection.style.display = 'block';
    return;
  }

  clearBtn.classList.add('visible');
  popularSection.style.display = 'none';

  const matches = allLocations.filter(f =>
    f.properties.Name.toLowerCase().includes(query)
  );

  if (matches.length === 0) {
    closeSuggestions();
    return;
  }

  suggestionsList.innerHTML = '';
  matches.slice(0, 8).forEach(feature => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="sug-icon">📍</span> ${feature.properties.Name}`;
    li.addEventListener('click', () => {
      searchInput.value = feature.properties.Name;
      closeSuggestions();
      selectLocation(feature);
    });
    suggestionsList.appendChild(li);
  });

  suggestionsList.classList.add('open');
});

clearBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearBtn.classList.remove('visible');
  closeSuggestions();
  popularSection.style.display = 'block';
  closeBottomCard();
  clearRoute();
});

function closeSuggestions() {
  suggestionsList.classList.remove('open');
  suggestionsList.innerHTML = '';
}

// =====================
// SELECT LOCATION
// =====================
function selectLocation(feature) {
  selectedLocation = feature;
  const [lng, lat] = feature.geometry.coordinates;
  const name = feature.properties.Name;
  const desc = feature.properties.description;

  // Fly to location
  map.flyTo([lat, lng], 18, { duration: 1.2 });

  // Update bottom card
  document.getElementById('locationName').textContent = name;
  document.getElementById('locationDesc').textContent = desc || '';

  // Calculate ETA using real OSRM walking route
  document.getElementById('locationEta').textContent = '🚶 Calculating...';
  if (userLocation) {
    getRealETA(userLocation, [lat, lng]).then(eta => {
      document.getElementById('locationEta').textContent = eta;
    });
  } else {
    document.getElementById('locationEta').textContent = '';
  }

  openBottomCard();
}

// =====================
// NAVIGATION
// =====================
document.getElementById('navigateBtn').addEventListener('click', () => {
  if (!selectedLocation) return;

  if (!userLocation) {
    showToast('📍 Waiting for your location...');
    return;
  }

  const [lng, lat] = selectedLocation.geometry.coordinates;
  startNavigation([lat, lng]);
});

function startNavigation(destination) {
  clearRoute();
  isNavigating = true;

  // Hide lost button during nav
  document.getElementById('lostBtn').classList.add('hidden');

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
    lineOptions: {
      styles: [{ color: '#22a060', weight: 5, opacity: 0.85 }]
    },
    createMarker: () => null // hide default markers
  }).addTo(map);

  routingControl.on('routesfound', (e) => {
    const route = e.routes[0];
    const seconds = route.summary.totalTime;
    const minutes = Math.ceil(seconds / 60);
    const distance = Math.round(route.summary.totalDistance);
    document.getElementById('locationEta').textContent = `🚶 ~${minutes} min walk · ${distance}m away`;

    // Start arrival check
    checkArrival(destination);
  });

  closeBottomCard();

  // Show cancel button as floating
  document.getElementById('cancelBtn').addEventListener('click', stopNavigation);
}

function stopNavigation() {
  clearRoute();
  isNavigating = false;
  document.getElementById('lostBtn').classList.remove('hidden');
  closeBottomCard();
  clearRoute();
}

function clearRoute() {
  if (routingControl) {
    map.removeControl(routingControl);
    routingControl = null;
  }
}

// =====================
// ARRIVAL CHECK
// =====================
function checkArrival(destination) {
  if (!isNavigating) return;

  const interval = setInterval(() => {
    if (!userLocation || !isNavigating) {
      clearInterval(interval);
      return;
    }

    const distance = getDistanceMeters(userLocation, destination);

    if (distance < 20) {
      clearInterval(interval);
      isNavigating = false;
      showArrivedToast();
      clearRoute();
      document.getElementById('lostBtn').classList.remove('hidden');
    }
  }, 3000);
}

// =====================
// USER LOCATION TRACKING
// =====================
function startTracking() {
  if (!navigator.geolocation) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      userLocation = [latitude, longitude];

      if (!userMarker) {
        userMarker = L.circleMarker([latitude, longitude], {
          radius: 10,
          fillColor: '#4a90e2',
          color: '#ffffff',
          weight: 3,
          fillOpacity: 1
        }).addTo(map).bindPopup('📍 You are here');

        // First location — center map
        map.setView([latitude, longitude], 17);
      } else {
        userMarker.setLatLng([latitude, longitude]);
      }

      // Reroute if navigating and off track
      if (isNavigating && routingControl) {
        const waypoints = routingControl.getWaypoints();
        if (waypoints.length >= 2) {
          routingControl.setWaypoints([
            L.latLng(latitude, longitude),
            waypoints[waypoints.length - 1].latLng
          ]);
        }
      }
    },
    (err) => {
      console.warn('Location error:', err.message);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }
  );
}

// =====================
// I'M LOST
// =====================
document.getElementById('lostBtn').addEventListener('click', () => {
  if (!userLocation) {
    showToast('📍 Still finding your location...');
    return;
  }

  // Find nearest location
  let nearest = null;
  let minDist = Infinity;

  allLocations.forEach(feature => {
    const [lng, lat] = feature.geometry.coordinates;
    const dist = getDistanceMeters(userLocation, [lat, lng]);
    if (dist < minDist) {
      minDist = dist;
      nearest = feature;
    }
  });

  if (nearest) {
    const name = nearest.properties.Name;
    const meters = Math.round(minDist);
    showToast(`📍 Nearest: ${name} (${meters}m away)`);
    map.flyTo([userLocation[0], userLocation[1]], 17);
    setTimeout(() => selectLocation(nearest), 2000);
  }
});

// =====================
// BOTTOM CARD
// =====================
function openBottomCard() {
  document.getElementById('bottomCard').classList.add('open');
  document.getElementById('lostBtn').classList.add('hidden');
}

function closeBottomCard() {
  document.getElementById('bottomCard').classList.remove('open');
  document.getElementById('lostBtn').classList.remove('hidden');
}

document.getElementById('cancelBtn').addEventListener('click', () => {
  closeBottomCard();
  clearRoute();
  isNavigating = false;
  document.getElementById('lostBtn').classList.remove('hidden');
});

// =====================
// TOASTS
// =====================
function showToast(message) {
  const toast = document.getElementById('arrivedToast');
  toast.querySelector('.toast-msg').textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function showArrivedToast() {
  showToast("🎉 You've arrived at your destination!");
}

// =====================
// OFFLINE HANDLING
// =====================
function handleOffline() {
  const banner = document.getElementById('offlineBanner');

  window.addEventListener('offline', () => {
    banner.classList.add('show');
  });

  window.addEventListener('online', () => {
    banner.classList.remove('show');
  });

  if (!navigator.onLine) {
    banner.classList.add('show');
  }
}

// =====================
// REAL ETA FROM OSRM
// =====================
async function getRealETA([lat1, lon1], [lat2, lon2]) {
  try {
    const url = `https://router.project-osrm.org/route/v1/foot/${lon1},${lat1};${lon2},${lat2}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes.length > 0) {
      const seconds = data.routes[0].duration;
      const distance = Math.round(data.routes[0].distance);
      const minutes = Math.ceil(seconds / 60);
      return `🚶 ~${minutes} min walk · ${distance}m away`;
    }
  } catch (err) {
    console.warn('OSRM ETA failed:', err);
  }
  // Fallback to straight line
  const distance = getDistanceMeters([lat1, lon1], [lat2, lon2]);
  const minutes = Math.ceil(distance / 80);
  return `🚶 ~${minutes} min walk · ${Math.round(distance)}m away`;
}


function getDistanceMeters([lat1, lon1], [lat2, lon2]) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// =====================
// CLOSE SUGGESTIONS ON MAP CLICK
// =====================
document.getElementById('map').addEventListener('click', () => {
  closeSuggestions();
});

// =====================
// START
// =====================
initMap();