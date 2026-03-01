// IMPORTANT:
// We must reconnect the socket after login/signup so the socket handshake includes the new session cookie.
let socket = io();

// Sections
const authSection = document.getElementById('auth-section');
const tripSection = document.getElementById('trip-section');
const mainContent = document.getElementById('main-content');

// Buttons / inputs
const signupBtn = document.getElementById('signup-btn');
const loginBtn = document.getElementById('login-btn');
const joinTripBtn = document.getElementById('join-trip-btn');
const addItemBtn = document.getElementById('add-item-btn');
const sendChatBtn = document.getElementById('send-chat-btn');
const backToJoinBtn = document.getElementById('back-to-join-btn');

const signupUsername = document.getElementById('signup-username');
const signupEmail = document.getElementById('signup-email');
const signupPassword = document.getElementById('signup-password');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const authMessage = document.getElementById('auth-message');

const tripIdInput = document.getElementById('trip-id');
const itineraryInput = document.getElementById('itinerary-input');
const chatInput = document.getElementById('chat-input');

// Lists
const itineraryList = document.getElementById('itinerary-list');
const pinnedLocationsList = document.getElementById('pinned-locations-list');
const messagesList = document.getElementById('messages');

// Destination selectors
const destinationSection = document.getElementById('destination-section');
const countrySelect = document.getElementById('country');
const stateSelect = document.getElementById('state');

// Map
const mapElement = document.getElementById('map');
const mapContainer = document.getElementById('map-container');
const mapSearchInput = document.getElementById('map-search');
const maptilerKey = mapContainer?.dataset?.maptilerKey;

// State
let currentTripId = null;
let currentUsername = null;
let isTripSocketJoined = false;

let map = null;
let markers = [];
let mapReadyPromise = null;
let pendingMapCenter = null;
let pendingMarkerData = null;
let searchResultMarker = null;

// ===============================
// Socket helpers
// ===============================
function reconnectSocket() {
  try {
    // Remove old listeners + reconnect so the handshake carries the new session cookie
    socket.removeAllListeners();
    socket.disconnect();
    isTripSocketJoined = false;

    socket = io();

    // Rebind all socket listeners (chat, itinerary, markers, map)
    bindSocketListeners();
  } catch (err) {
    console.error('Socket reconnect failed:', err);
  }
}

function bindSocketListeners() {
  // Itinerary updates
  socket.on('updateItinerary', (itinerary) => {
    itineraryList.innerHTML = '';
    itinerary.forEach((item) => {
      if (!item?.name) return;

      const li = document.createElement('li');
      li.innerHTML = `
        ${item.name} - Upvotes: ${item.upvotes}, Downvotes: ${item.downvotes}
        <button class="upvote-btn" data-item="${item.name}">Upvote</button>
        <button class="downvote-btn" data-item="${item.name}">Downvote</button>
      `;
      itineraryList.appendChild(li);
    });

    document.querySelectorAll('.upvote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemName = e.target.getAttribute('data-item');
        socket.emit('voteItem', { tripId: currentTripId, itemName, vote: 'upvote' });
      });
    });

    document.querySelectorAll('.downvote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const itemName = e.target.getAttribute('data-item');
        socket.emit('voteItem', { tripId: currentTripId, itemName, vote: 'downvote' });
      });
    });
  });

  socket.on('updateVotes', (updatedItem) => {
    const parent = document.querySelector(`.upvote-btn[data-item="${updatedItem.name}"]`)?.parentElement;
    if (!parent) return;

    parent.innerHTML = `
      ${updatedItem.name} - Upvotes: ${updatedItem.upvotes}, Downvotes: ${updatedItem.downvotes}
      <button class="upvote-btn" data-item="${updatedItem.name}">Upvote</button>
      <button class="downvote-btn" data-item="${updatedItem.name}">Downvote</button>
    `;

    parent.querySelector('.upvote-btn')?.addEventListener('click', () => {
      socket.emit('voteItem', { tripId: currentTripId, itemName: updatedItem.name, vote: 'upvote' });
    });

    parent.querySelector('.downvote-btn')?.addEventListener('click', () => {
      socket.emit('voteItem', { tripId: currentTripId, itemName: updatedItem.name, vote: 'downvote' });
    });
  });

  // Chat updates
  socket.on('receiveMessage', (data) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${data.username}:</strong> ${data.message}`;
    messagesList.appendChild(li);
    messagesList.scrollTop = messagesList.scrollHeight;
  });

  // Markers + map center
  socket.on('updateMarkers', (markerData) => {
    renderMarkers(markerData);
  });

  socket.on('centerMap', ({ lat, lng, zoom }) => {
    pendingMapCenter = { lat, lng, zoom };
    if (map) applyPendingMapCenter();
  });

  socket.on('tripJoined', ({ tripId }) => {
    if (tripId === currentTripId) {
      isTripSocketJoined = true;
    }
  });
}

// Bind once at initial load
bindSocketListeners();

// ===============================
// Helpers: UI
// ===============================
function setAuthMessage(text, color = 'green') {
  if (!authMessage) return;
  authMessage.style.color = color;
  authMessage.textContent = text;
}

function toggleBackButton(visible) {
  if (!backToJoinBtn) return;
  backToJoinBtn.style.display = visible ? 'block' : 'none';
}

function showAuth() {
  authSection.style.display = 'block';
  tripSection.style.display = 'none';
  mainContent.style.display = 'none';
  toggleBackButton(false);
}

function showTripJoin() {
  authSection.style.display = 'none';
  tripSection.style.display = 'block';
  mainContent.style.display = 'none';
  toggleBackButton(false);
}

async function showMain() {
  authSection.style.display = 'none';
  tripSection.style.display = 'none';
  mainContent.style.display = 'flex';
  toggleBackButton(true);

  try {
    await waitForMapLibrary();
    initMap();
  } catch (err) {
    console.error(err);
    alert('Map failed to load. Check console + MapTiler key.');
  }
}

backToJoinBtn?.addEventListener('click', () => {
  mainContent.style.display = 'none';
  tripSection.style.display = 'block';
  toggleBackButton(false);
});

function resetTripUI() {
  isTripSocketJoined = false;
  if (itineraryList) itineraryList.innerHTML = '';
  if (messagesList) messagesList.innerHTML = '';
  if (pinnedLocationsList) pinnedLocationsList.innerHTML = '';

  if (markers?.length) markers.forEach(m => m.remove());
  markers = [];

  if (searchResultMarker) {
    searchResultMarker.remove();
    searchResultMarker = null;
  }
}

// ===============================
// Destination dropdown setup
// ===============================
const countries = ["USA"];
const statesUSA = [
  "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia",
  "Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts",
  "Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey",
  "New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island",
  "South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia",
  "Wisconsin","Wyoming"
];

countries.forEach(country => {
  const option = document.createElement('option');
  option.value = country;
  option.text = country;
  countrySelect.add(option);
});

countrySelect.addEventListener('change', () => {
  const selectedCountry = countrySelect.value;

  if (selectedCountry === 'USA') {
    stateSelect.style.display = 'block';
    stateSelect.innerHTML = '<option value="">Select State</option>';

    statesUSA.forEach(state => {
      const option = document.createElement('option');
      option.value = state;
      option.text = state;
      stateSelect.add(option);
    });
  } else {
    stateSelect.style.display = 'none';
  }
});

tripIdInput.addEventListener('input', () => {
  const tripId = tripIdInput.value.trim();
  if (!tripId) {
    destinationSection.style.display = 'none';
    return;
  }

  socket.emit('checkTrip', { tripId }, (tripExists) => {
    destinationSection.style.display = tripExists ? 'none' : 'block';
  });
});

// ===============================
// Auth (REAL) + SOCKET RECONNECT
// ===============================
signupBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  const username = signupUsername.value.trim();
  const email = signupEmail.value.trim();
  const password = signupPassword.value.trim();

  if (!username || !email || !password) {
    setAuthMessage('Please fill all signup fields', 'red');
    return;
  }

  try {
    const res = await fetch('/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
      credentials: 'include'
    });

    const msg = await res.text();
    if (!res.ok) {
      setAuthMessage(msg || 'Signup failed', 'red');
      return;
    }

    currentUsername = username;

    // ✅ CRITICAL: reconnect socket so server sees session username for chat
    reconnectSocket();

    setAuthMessage('Signup successful!', 'green');
    showTripJoin();
  } catch (err) {
    console.error(err);
    setAuthMessage('Signup error. Try again.', 'red');
  }
});

loginBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  const username = loginUsername.value.trim();
  const password = loginPassword.value.trim();

  if (!username || !password) {
    setAuthMessage('Please enter username and password', 'red');
    return;
  }

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'include'
    });

    const msg = await res.text();
    if (!res.ok) {
      setAuthMessage(msg || 'Login failed', 'red');
      return;
    }

    currentUsername = username;

    // ✅ CRITICAL: reconnect socket so server sees session username for chat
    reconnectSocket();

    setAuthMessage('Login successful!', 'green');
    showTripJoin();
  } catch (err) {
    console.error(err);
    setAuthMessage('Login error. Try again.', 'red');
  }
});

// ===============================
// Join Trip
// ===============================
joinTripBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  resetTripUI();

  const tripId = tripIdInput.value.trim();
  const country = countrySelect.value;
  const state = stateSelect.value;

  if (!tripId) {
    alert('Please enter a Trip ID');
    return;
  }

  let mustProvideDestination = false;
  await new Promise((resolve) => {
    socket.emit('checkTrip', { tripId }, (exists) => {
      mustProvideDestination = !exists;
      resolve();
    });
  });

  if (mustProvideDestination) {
    if (!country) {
      alert('Please select a country for a new trip.');
      return;
    }
    if (country === 'USA' && !state) {
      alert('Please select a state for the USA.');
      return;
    }
  }

  try {
    const res = await fetch('/join-trip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tripId,
        destinationCity: state || 'N/A',
        destinationCountry: country || 'N/A'
      }),
      credentials: 'include'
    });

    const msg = await res.text();

    if (!res.ok) {
      alert(msg || 'Join trip failed');
      if (res.status === 401) showAuth();
      return;
    }

    currentTripId = tripId;

    // ✅ socket join relies on server session
    socket.emit('joinTrip', { tripId, username: currentUsername });

    await showMain();

    if (mustProvideDestination && country) {
      centerMapOnLocation(country, state);
    }

    alert(msg);
  } catch (err) {
    console.error(err);
    alert('Error joining trip. Check console.');
  }
});

// ===============================
// Itinerary
// ===============================
addItemBtn.addEventListener('click', () => {
  const item = itineraryInput.value.trim();
  if (!item || !currentTripId) {
    alert('Please type an item and make sure you joined a trip.');
    return;
  }
  socket.emit('addItem', { tripId: currentTripId, item });
  itineraryInput.value = '';
});

// ===============================
// Chat (FIXED)
// ===============================
function sendChat() {
  const message = chatInput.value.trim();
  if (!message || !currentTripId) {
    alert('Please type a message and make sure you joined a trip.');
    return;
  }

  socket.emit('sendMessage', {
    tripId: currentTripId,
    username: currentUsername,
    message
  });
  chatInput.value = '';
}

sendChatBtn.addEventListener('click', sendChat);

// Optional: press Enter to send
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendChat();
  }
});

// ===============================
// Map
// ===============================
function waitForMapLibrary(maxWaitMs = 10000) {
  if (window.maplibregl) return Promise.resolve();

  if (!mapReadyPromise) {
    mapReadyPromise = new Promise((resolve, reject) => {
      const start = Date.now();
      const intervalId = setInterval(() => {
        if (window.maplibregl) {
          clearInterval(intervalId);
          resolve();
          return;
        }
        if (Date.now() - start > maxWaitMs) {
          clearInterval(intervalId);
          reject(new Error('MapLibre did not load.'));
        }
      }, 100);
    });
  }

  return mapReadyPromise;
}

function applyPendingMapCenter() {
  if (!map || !pendingMapCenter) return;

  map.jumpTo({
    center: [pendingMapCenter.lng, pendingMapCenter.lat],
    zoom: pendingMapCenter.zoom
  });
  pendingMapCenter = null;
}

function initMap() {
  if (map) {
    map.resize();
    applyPendingMapCenter();
    if (pendingMarkerData) renderMarkers(pendingMarkerData);
    return;
  }

  map = new maplibregl.Map({
    container: mapElement,
    style: `https://api.maptiler.com/maps/streets-v2/style.json?key=${maptilerKey}`,
    center: [-95.7129, 37.0902],
    zoom: 3
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  applyPendingMapCenter();

  map.on('load', () => {
    map.resize();
    applyPendingMapCenter();
    if (pendingMarkerData) renderMarkers(pendingMarkerData);
  });
}

async function geocodeLocation(query, options = {}) {
  if (!maptilerKey) throw new Error('Missing MapTiler API key.');

  const params = new URLSearchParams({
    key: maptilerKey,
    limit: String(options.limit ?? 1)
  });

  if (options.country) params.set('country', options.country);

  const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?${params.toString()}`);
  if (!response.ok) throw new Error(`Geocoding failed with status ${response.status}`);

  const data = await response.json();
  return data.features || [];
}

function attachPinHandler(buttonId, feature) {
  window.setTimeout(() => {
    const pinButton = document.getElementById(buttonId);
    if (!pinButton) return;

    pinButton.addEventListener('click', () => {
      if (!currentTripId) {
        alert('Join a trip before pinning locations.');
        return;
      }

      socket.emit('addMarker', {
        tripId: currentTripId,
        lat: feature.center[1],
        lng: feature.center[0],
        description: feature.place_name || feature.text || 'Pinned location'
      });
    }, { once: true });
  }, 0);
}

async function handleMapSearch() {
  const query = mapSearchInput.value.trim();
  if (!query || !map) return;

  try {
    const [feature] = await geocodeLocation(query, { country: countrySelect.value === 'USA' ? 'us' : undefined });
    if (!feature) {
      alert('No matching locations found.');
      return;
    }

    if (searchResultMarker) searchResultMarker.remove();

    const popupButtonId = `pin-location-${Date.now()}`;
    const popupHtml = `
      <div>
        <strong>${feature.text || 'Location'}</strong><br>
        ${feature.place_name || ''}<br><br>
        <button id="${popupButtonId}">Pin Location</button>
      </div>
    `;

    searchResultMarker = new maplibregl.Marker({ color: '#d97706' })
      .setLngLat(feature.center)
      .setPopup(new maplibregl.Popup({ offset: 24 }).setHTML(popupHtml))
      .addTo(map);

    searchResultMarker.togglePopup();
    attachPinHandler(popupButtonId, feature);

    if (feature.bbox) {
      map.fitBounds([
        [feature.bbox[0], feature.bbox[1]],
        [feature.bbox[2], feature.bbox[3]]
      ], { padding: 40, duration: 1000 });
    } else {
      map.flyTo({ center: feature.center, zoom: 10, duration: 1000 });
    }
  } catch (error) {
    console.error('Map search failed:', error);
    alert('Location search failed. Check the MapTiler key and try again.');
  }
}

mapSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleMapSearch();
  }
});

function renderMarkers(markerData) {
  if (!map) {
    pendingMarkerData = markerData;
    return;
  }

  markers.forEach(marker => marker.remove());
  markers = [];

  if (pinnedLocationsList) pinnedLocationsList.innerHTML = '';

  markerData.forEach(data => {
    const popup = new maplibregl.Popup({ offset: 24 }).setText(data.description);
    const marker = new maplibregl.Marker()
      .setLngLat([data.lng, data.lat])
      .setPopup(popup)
      .addTo(map);

    markers.push(marker);

    if (pinnedLocationsList) {
      const li = document.createElement('li');
      li.textContent = data.description;
      pinnedLocationsList.appendChild(li);
    }
  });

  pendingMarkerData = null;
  updateRoute();
}

function updateRoute() {
  if (!map || markers.length < 2) return;

  const bounds = new maplibregl.LngLatBounds();
  markers.forEach(marker => bounds.extend(marker.getLngLat()));
  map.fitBounds(bounds, { padding: 60, duration: 900 });
}

function centerMapOnLocation(country, state) {
  if (!map) return;

  const location = state ? `${state}, ${country}` : country;
  const geocodeCountry = country === 'USA' ? 'us' : undefined;

  geocodeLocation(location, { country: geocodeCountry })
    .then(([feature]) => {
      if (!feature) throw new Error(`No geocoding result for ${location}`);

      const saveCenter = () => {
        const center = map.getCenter();
        socket.emit('saveMapCenter', {
          tripId: currentTripId,
          lat: center.lat,
          lng: center.lng,
          zoom: map.getZoom()
        });
      };

      map.once('moveend', saveCenter);

      if (feature.bbox) {
        map.fitBounds([
          [feature.bbox[0], feature.bbox[1]],
          [feature.bbox[2], feature.bbox[3]]
        ], { padding: 50, duration: 1000 });
      } else {
        map.flyTo({ center: feature.center, zoom: state ? 6.5 : 4, duration: 1000 });
      }
    })
    .catch(err => console.error('Map centering failed:', err));
}

// ===============================
// ✅ STARTUP: decide based on /session
// Also reconnect socket if already logged in.
// ===============================
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/session', { credentials: 'include' });
    const data = await res.json();

    if (data.loggedIn) {
      currentUsername = data.username;

      // ✅ Ensure socket handshake has session
      reconnectSocket();

      showTripJoin();
    } else {
      showAuth();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    showAuth();
  }
});
