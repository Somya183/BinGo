/* ============================================================
   BinGo – Smart Scrap Recycling   ·   script.js  v3.0
   ─────────────────────────────────────────────────────────
   NEW:
   • Real login / signup wired to Flask SQLite backend
   • Persistent session token (localStorage)
   • Live GPS → backend pushes 5-km radius dealers
   • Map shows YOUR real location + only nearby dealers
   • Dealer cards show reverse-geocoded real addresses
   • 5-km radius circle drawn on map
   ============================================================ */

/* ── Config ─────────────────────────────────────────────────── */
const API_BASE = (window.location.origin && window.location.origin.startsWith('http'))
  ? `${window.location.origin}/api`
  : 'http://127.0.0.1:5000/api';

/* ── Static fallback dealers (Nashik-centred, used when API offline) ── */
const DEALERS_STATIC = [
  {id:15, name:'Nagpur Iron & Steel',      rating:4.5, ico:'warehouse',             addr:'Nagpur City',           lat:21.1458, lng:79.0882, phone:'+91 89901 23456'},
  {id:16, name:'Orange City Scrap',        rating:4.8, ico:'local_shipping',        addr:'Nagpur City',           lat:21.1544, lng:79.0832, phone:'+91 88012 34567'},
  {id:17, name:'Sitabuldi Waste Mart',     rating:4.4, ico:'storefront',            addr:'Sitabuldi, Nagpur',      lat:21.1412, lng:79.0762, phone:'+91 87654 00001'},
  {id:18, name:'Dharampeth Eco Hub',       rating:4.7, ico:'recycling',             addr:'Dharampeth, Nagpur',     lat:21.1396, lng:79.0560, phone:'+91 87654 00002'},
  {id:19, name:'Sadar Metals & Scrap',     rating:4.6, ico:'factory',               addr:'Sadar, Nagpur',          lat:21.1610, lng:79.0815, phone:'+91 87654 00003'},
  {id:20, name:'Manish Nagar Recyclers',    rating:4.3, ico:'local_shipping',        addr:'Manish Nagar, Nagpur',   lat:21.0965, lng:79.0754, phone:'+91 87654 00004'},
];

/* ── App State ──────────────────────────────────────────────── */
const S = {
  dealer: null, slot: null, slotId: null, item: null,
  requested: false,
  coords:   { lat: 21.1458, lng: 79.0882 },  // Nagpur default (Sitabuldi)
  user:     null,   // populated after login/signup
  token:    null,   // Bearer token
  target:   'home',
  pickupId: null,
  apiOnline: false,
  liveStream: null,
  nearbyDealers: [],    // dealers within 5km of live GPS
  userAddress: '',      // reverse-geocoded user address
  locationWatchId: null,
  weightKg: 1,
};

const maps = { mainDone:false, dealerDone:false, dealerMap:null, userMarker:null };
const DEMO_MODE = false;   // set false so real GPS is always used

/* ── Keys ────────────────────────────────────────────────────── */
const GEMINI_KEY_STORAGE = 'bingo_gemini_key';
const SESSION_KEY        = 'bingo_token';
const USER_KEY           = 'bingo_user';
function getGeminiKey() { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; }

/* ══════════════════════════════════════════════════════════════
   API HELPER
══════════════════════════════════════════════════════════════ */
async function apiCall(method, path, body = null) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const r    = await fetch(API_BASE + path, opts);
    const data = await r.json();
    S.apiOnline = true;
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    S.apiOnline = false;
    // Distinguish between connectivity issues and other errors
    return { 
      ok: false, 
      status: 0, 
      data: { error: 'Backend server is offline. Please start the Flask API at port 5000.' } 
    };
  }
}

async function checkApiHealth() {
  const r = await fetch(API_BASE + '/health').catch(() => null);
  S.apiOnline = r?.ok || false;
  const badge = document.getElementById('apiBadge');
  if (badge) {
    badge.textContent = S.apiOnline ? '🟢 AI Backend Online' : '🟡 Offline Mode';
    badge.style.color = S.apiOnline ? '#2e7d32' : '#e65100';
  }
}

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════ */
function go(id) {
  const userProtected   = ['scan', 'track'];
  const dealerProtected = ['dealer'];

  if (dealerProtected.includes(id)) {
    if (!S.user || S.user.role !== 'dealer') {
      S.target = id; toast('🏢 Dealer login required'); go('dealerAuth'); return;
    }
  } else if (userProtected.includes(id)) {
    if (!S.user) { S.target = id; toast('🔒 Please login to continue'); go('auth'); return; }
  }

  document.querySelectorAll('.pg').forEach(p => p.classList.remove('on'));
  const el = document.getElementById(id);
  if (el) el.classList.add('on');

  document.querySelectorAll('.nm').forEach(b => b.classList.remove('on'));
  ['home','scan','track','map','dealer'].forEach((nm, i) => {
    if (nm === id) document.querySelectorAll('.nm')[i]?.classList.add('on');
  });

  if (id === 'map')    setTimeout(initMainMap, 120);
  if (id === 'dealer') { 
    initDealerMap(); 
    updateDealerUI();
    setTimeout(renderEarningsGraph, 100); 
    setTimeout(renderDealerPricing, 150); // New: Load pricing table
  }
  if (id === 'track' && S.pickupId) initLiveTracking(S.pickupId);

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════════
   LIVE GPS  — request permission, watch position, push to API
══════════════════════════════════════════════════════════════ */
function startLocationWatch() {
  if (!navigator.geolocation) return;
  if (S.locationWatchId) return;   // already watching

  // Get immediately
  navigator.geolocation.getCurrentPosition(onGPSUpdate, onGPSError, {
    enableHighAccuracy: true, timeout: 10000, maximumAge: 0
  });

  // Then watch
  S.locationWatchId = navigator.geolocation.watchPosition(onGPSUpdate, onGPSError, {
    enableHighAccuracy: true, timeout: 10000, maximumAge: 10000
  });
}

function onGPSError(err) {
  console.warn('[GPS]', err.message);
  // Use stored coords as fallback, still try to load dealers
  pushLocationToAPI(S.coords.lat, S.coords.lng);
}

async function onGPSUpdate(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  S.coords  = { lat, lng };

  // Update live map marker if open
  if (maps._mainMapInstance && maps._userMarkerLive) {
    maps._userMarkerLive.setLatLng([lat, lng]);
    if (!maps._mapCentered) {
      maps._mainMapInstance.setView([lat, lng], 14);
      maps._mapCentered = true;
    }
  }

  // Push to API → get nearby dealers + reverse-geocoded address
  await pushLocationToAPI(lat, lng);
}

async function pushLocationToAPI(lat, lng) {
  if (S.apiOnline && S.user) {
    const { ok, data } = await apiCall('POST', '/auth/update-location', {
      lat, lng, user_id: S.user.id
    });
    if (ok && data.success) {
      S.userAddress    = data.address;
      S.nearbyDealers  = data.dealers || [];
      updateLocationChip(data.address, data.count || 0);
      refreshDealerMapMarkers(data.dealers);
      return;
    }
  }
  // Fallback: call /api/dealers directly with coords
  try {
    const r = await fetch(`${API_BASE}/dealers?lat=${lat}&lng=${lng}&radius=5`);
    const d = await r.json();
    if (d.success) {
      S.nearbyDealers = d.dealers || [];
      refreshDealerMapMarkers(d.dealers);
    }
  } catch(_) {
    // Use static dealers if completely offline
    const uPos = L?.latLng ? L.latLng(lat,lng) : null;
    S.nearbyDealers = DEALERS_STATIC.map(d => {
      const dist = uPos ? parseFloat((uPos.distanceTo(L.latLng(d.lat,d.lng))/1000).toFixed(2)) : 99;
      return {...d, distance_km: dist, eta_min: Math.round(dist/0.4*60)};
    }).filter(d => d.distance_km <= 5).sort((a,b) => a.distance_km - b.distance_km);
    refreshDealerMapMarkers(S.nearbyDealers);
  }
}

function updateLocationChip(address, dealerCount) {
  const chip = document.getElementById('locationChip');
  if (chip) {
    chip.innerHTML = `<span class="material-symbols-rounded" style="font-size:15px;vertical-align:middle">location_on</span> ${address || 'Locating…'} · <b>${dealerCount} dealer${dealerCount !== 1 ? 's' : ''} nearby</b>`;
    chip.style.display = 'flex';
  }
}

/* ══════════════════════════════════════════════════════════════
   AUTH  — REAL forms wired to Flask
══════════════════════════════════════════════════════════════ */
function toggleAuth() {
  const lf = document.getElementById('loginForm');
  const sf = document.getElementById('signupForm');
  const isLogin = lf.style.display !== 'none';
  lf.style.display = isLogin ? 'none' : 'block';
  sf.style.display = isLogin ? 'block' : 'none';
}
function flipAuthBook() {}

function toggleDealerAuth() {
  const lf = document.getElementById('dealerLoginForm');
  const sf = document.getElementById('dealerSignupForm');
  const isLogin = lf.style.display !== 'none';
  lf.style.display = isLogin ? 'none' : 'block';
  sf.style.display = isLogin ? 'block' : 'none';
}

function togglePass(id) {
  const inp = document.getElementById(id);
  const btn = inp?.nextElementSibling;
  const ico = btn?.querySelector('.material-symbols-rounded');
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  if (ico) ico.textContent = inp.type === 'password' ? 'visibility' : 'visibility_off';
}

/* ---------- User signup ---------- */
async function doAuth(mode, role = 'user') {
  // Collect form values by targeting inputs in visible form
  let email = '', password = '', name = '', address = '';

  if (mode === 'login') {
    const form = document.getElementById(role === 'dealer' ? 'dealerLoginForm' : 'loginForm');
    email    = form?.querySelector('input[type="email"]')?.value?.trim() || '';
    password = form?.querySelector('input[type="password"]')?.value?.trim() || '';
  } else {
    const form = document.getElementById(role === 'dealer' ? 'dealerSignupForm' : 'signupForm');
    const texts = form?.querySelectorAll('input[type="text"]');
    name        = texts?.[0]?.value?.trim() || '';
    email       = form?.querySelector('input[type="email"]')?.value?.trim() || '';
    // For users: [0] name, [1] address. For dealers: [0] name, [1] GST, [2] address
    address     = (role === 'dealer' ? texts?.[2]?.value : texts?.[1]?.value)?.trim() || '';
    password    = form?.querySelector('input[type="password"]')?.value?.trim() || '';
    if (role === 'dealer') {
      const gst = texts?.[1]?.value?.trim();
      if (gst) address = (address ? address + ' · ' : '') + 'GST: ' + gst;
    }
  }

  // Client-side validation
  if (!email) { toast('⚠️ Please enter your email', 'warn'); return; }
  if (!password) { toast('⚠️ Please enter a password', 'warn'); return; }
  if (mode === 'signup' && !name) { toast('⚠️ Please enter your name', 'warn'); return; }
  if (mode === 'signup' && password.length < 6) { toast('⚠️ Password must be at least 6 characters', 'warn'); return; }

  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…'; }

  toast(mode === 'login' ? '🔄 Signing in…' : '📝 Creating account…');

  const endpoint = mode === 'login' ? '/auth/login' : '/auth/signup';
  const payload  = mode === 'login'
    ? { email, password, role }
    : { email, password, name, address, role };

  const { ok, status, data } = await apiCall('POST', endpoint, payload);

  if (btn) { btn.disabled = false; btn.textContent = mode === 'login' ? (role === 'dealer' ? 'Sign In to Dashboard' : 'Log In') : (role === 'dealer' ? 'Submit Application' : 'Sign Up'); }

  if (ok && data?.success) {
    if (mode === 'signup') {
        // Show success message without logging in yet
        toast(`✅ Account created successfully! Please login now.`, 'ok');
        
        // Switch the UI back to the login form
        S.token = data.token;
        S.user = { 
            id: data.user_id, 
            name: data.name || 'User', 
            email: data.email,
            role: data.role
        };

        localStorage.setItem(SESSION_KEY, data.token);
        localStorage.setItem(USER_KEY, JSON.stringify(S.user));

        updateAuthUI();

// Smart Redirection
const targetPage = S.user.role === 'dealer' ? 'dealer' : 'home';
setTimeout(() => {
    go(targetPage);
}, 400);;
    } else {
        // This is the login logic - ensure data is fully populated
        S.token = data.token;
        S.user = { 
            id: data.user_id, 
            name: data.name || 'User', // Fallback if name is missing
            email: data.email, 
            role: data.role 
        };
        
        localStorage.setItem(SESSION_KEY, data.token);
        localStorage.setItem(USER_KEY, JSON.stringify(S.user));

        updateAuthUI();
        toast(`✅ Welcome back, ${S.user.name}!`, 'ok');
        startLocationWatch();
        
       // Smart redirection based on role
const targetPage = S.user.role === 'dealer' ? 'dealer' : 'home';

setTimeout(() => {
    go(targetPage);
}, 400);
    }

  } else {
    const msg = data?.error || (status === 409 ? 'Email already registered' : 'Authentication failed');
    toast(`❌ ${msg}`, 'warn');
    // Shake the form
    const formId = role === 'dealer' ? (mode === 'login' ? 'dealerLoginForm' : 'dealerSignupForm') : (mode === 'login' ? 'loginForm' : 'signupForm');
    const form = document.getElementById(formId);
    if (form) { form.style.animation = 'none'; requestAnimationFrame(() => { form.style.animation = 'shake .3s ease'; }); }
  }
}

function logout() {
  if (S.token) apiCall('POST', '/auth/logout').catch(() => {});
  S.user = null; S.token = null; S.nearbyDealers = [];
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_KEY);
  updateAuthUI();
  toast('👋 Logged out successfully.');
  go('home');
}

function updateAuthUI() {
  const nav = document.getElementById('navAuth');
  if (!nav) return;
  if (S.user) {
    const isDealer = S.user.role === 'dealer';
    nav.innerHTML = `
      <button class="btn-outline-sm" onclick="go('${isDealer ? 'dealer' : 'scan'}')">
        ${isDealer ? 'Dealer Dashboard' : 'Request a Pickup'}
      </button>
      <div style="display:flex;align-items:center;margin-left:14px;gap:10px">
        <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--g),var(--gl));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:.85rem;flex-shrink:0">
          ${(S.user.name || 'U').charAt(0).toUpperCase()}
        </div>
        <div style="text-align:right">
          <div style="font-size:.82rem;font-weight:700;color:var(--text)">${S.user.name}</div>
          <div style="font-size:.7rem;color:var(--text3)">${S.user.email}</div>
        </div>
        <button class="btn-outline-sm" style="padding:6px 14px;border-color:#ddd;color:#666;margin-left:4px" onclick="logout()">Logout</button>
      </div>`;
  } else {
    nav.innerHTML = `
      <button class="btn-outline-sm" onclick="go('scan')">Request a Pickup</button>
      <button class="btn-outline-sm" style="margin-left:8px" onclick="go('auth')">Login</button>
      <button class="btn-cta" style="margin-left:8px" onclick="go('auth')">Sign Up</button>`;
  }
}

/* Restore session from localStorage on page load */
function restoreSession() {
  const token = localStorage.getItem(SESSION_KEY);
  const user  = localStorage.getItem(USER_KEY);
  if (token && user) {
    S.token = token;
    S.user  = JSON.parse(user);
    updateAuthUI();
    // Verify token is still valid
    apiCall('GET', '/auth/me').then(({ ok, data }) => {
      if (ok && data.success) {
        S.user = data.user;
        updateAuthUI();
        startLocationWatch();
      } else {
        // Token expired
        S.user = null; S.token = null;
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(USER_KEY);
        updateAuthUI();
      }
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   MAP — real GPS location + dealers within 5km
══════════════════════════════════════════════════════════════ */
function initMainMap() {
  const el = document.getElementById('mainMap');
  if (!el) return;
  if (maps._mainMapInstance) {
    setTimeout(() => maps._mainMapInstance.invalidateSize(), 150);
    return;
  }

  // Start with Nashik until GPS kicks in
  const m = L.map('mainMap').setView([S.coords.lat, S.coords.lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(m);
  maps._mainMapInstance = m;
  maps._mapCentered     = false;

  // ── User marker (pulsing green dot) ──
  const uIco = L.divIcon({ className: '',
    html: `<div style="width:20px;height:20px;background:#2e7d32;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(46,125,50,.25);animation:pulse 1.5s infinite"></div>`,
    iconSize:[20,20], iconAnchor:[10,10] });
  maps._userMarkerLive = L.marker([S.coords.lat, S.coords.lng], { icon: uIco })
    .addTo(m).bindPopup('📍 <b>Your Location</b><br><span id="mapUserAddr">Locating…</span>');

  // ── 5-km radius circle ──
  maps._radiusCircle = L.circle([S.coords.lat, S.coords.lng], {
    radius: 5000, color: '#2e7d32', weight: 2, dashArray: '8,6',
    fillColor: '#2e7d32', fillOpacity: 0.05
  }).addTo(m);

  // ── Dealer markers (yellow, rendered after GPS) ──
  maps._dealerLayerGroup = L.layerGroup().addTo(m);

  // Request GPS — this will trigger onGPSUpdate → pushLocationToAPI → refresh markers
  startLocationWatch();

  // If no GPS in 5 s, load dealers for default coords
  setTimeout(() => {
    if (!maps._mapCentered) pushLocationToAPI(S.coords.lat, S.coords.lng);
  }, 5000);
}

function refreshDealerMapMarkers(dealers) {
  if (!maps._mainMapInstance) return;

  // Update radius circle
  if (maps._radiusCircle) {
    maps._radiusCircle.setLatLng([S.coords.lat, S.coords.lng]);
  }

  // Update user marker & popup
  if (maps._userMarkerLive) {
    maps._userMarkerLive.setLatLng([S.coords.lat, S.coords.lng]);
    const addrEl = document.getElementById('mapUserAddr');
    if (addrEl) addrEl.textContent = S.userAddress || 'Located';
  }

  // Clear old dealer markers
  if (maps._dealerLayerGroup) maps._dealerLayerGroup.clearLayers();

  if (!dealers?.length) {
    toast('⚠️ No dealers found within 5 km. Try moving closer to a city.', 'warn');
    return;
  }

  const dIco = L.divIcon({ className: '',
    html: `<div style="width:16px;height:16px;background:#f9a825;border:2.5px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3)"></div>`,
    iconSize:[16,16], iconAnchor:[8,8] });

  dealers.forEach(d => {
    L.marker([d.lat, d.lng], { icon: dIco })
      .addTo(maps._dealerLayerGroup)
      .bindPopup(
        `<b>${d.name}</b><br>` +
        `⭐ ${d.rating} &nbsp;|&nbsp; 📍 ${d.distance_km} km<br>` +
        `🕐 ~${d.eta_min} min ETA<br>` +
        `<small>${d.addr || ''}</small><br>` +
        `📞 ${d.phone}<br>` +
        `<a href="#" onclick="go('scan')" style="color:#2e7d32;font-weight:600">Request Pickup →</a>`
      );
  });

  // Fit map to show user + all dealers
  const allPoints = [[S.coords.lat, S.coords.lng], ...dealers.map(d => [d.lat, d.lng])];
  if (allPoints.length > 1) maps._mainMapInstance.fitBounds(allPoints, { padding: [40, 40] });

  toast(`📍 ${dealers.length} dealer${dealers.length !== 1 ? 's' : ''} found within 5 km`, 'ok');
}

function initDealerMap() {
  const el = document.getElementById('dMap');
  if (!el || maps.dealerDone) return;
  maps.dealerDone = true;
  const m = L.map('dMap').setView([S.coords.lat, S.coords.lng], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom:19, attribution:'© OSM' }).addTo(m);
  maps.dealerMap = m;

  const dIco = L.divIcon({ className:'',
    html:'<div style="width:18px;height:18px;background:#f9a825;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.3)"></div>',
    iconSize:[18,18], iconAnchor:[9,9] });
  if (S.user && S.user.role === 'dealer') {
    L.marker([S.coords.lat, S.coords.lng], { icon: dIco })
      .addTo(m).bindPopup(`🏭 ${S.user.name} (You)`).openPopup();
  }
  maps.userMarker = null;
}

function updateDMap() {
  if (!maps.dealerMap) return;
  const uIco = L.divIcon({ className:'',
    html:'<div style="width:14px;height:14px;background:#2e7d32;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.25)"></div>',
    iconSize:[14,14], iconAnchor:[7,7] });
  if (maps.userMarker) maps.userMarker.setLatLng([S.coords.lat, S.coords.lng]);
  else maps.userMarker = L.marker([S.coords.lat, S.coords.lng], { icon: uIco })
    .addTo(maps.dealerMap).bindPopup(`📍 ${S.user?.name || 'Customer'}`).openPopup();
  maps.dealerMap.fitBounds([[S.coords.lat, S.coords.lng],[S.coords.lat+0.03, S.coords.lng+0.03]], { padding:[30,30] });
}

/* ══════════════════════════════════════════════════════════════
   COUNTERS
══════════════════════════════════════════════════════════════ */
function animCount(el, target, suffix='', dur=1600) {
  if (!el) return;
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now-start)/dur,1), e = 1-Math.pow(1-p,3);
    el.innerHTML = Math.round(e*target)+suffix;
    if (p<1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
setTimeout(()=>{
  animCount(document.getElementById('h1'),12,'<span>K+</span>');
  animCount(document.getElementById('h2'),340,'<span>+</span>');
  animCount(document.getElementById('h3'),97,'<span>%</span>');
  animCount(document.getElementById('h4'),18,'<span>+</span>');
  animCount(document.getElementById('sb1'),12,'<span>K+</span>');
  animCount(document.getElementById('sb2'),340,'<span>+</span>');
  animCount(document.getElementById('sb3'),48,'<span>L+</span>',1600);
  animCount(document.getElementById('sb4'),18,'<span>+</span>');
  animCount(document.getElementById('sb5'),4.8,'<span>★</span>');
},400);
function showVideo(){toast('Watch the BinGo explainer video – coming soon!','ok');}

/* ══════════════════════════════════════════════════════════════
   SCAN
══════════════════════════════════════════════════════════════ */
function onDrop(e){e.preventDefault();document.getElementById('dropZone').classList.remove('drag');const f=e.dataTransfer.files[0];if(f?.type.startsWith('image/'))processImg(f);}
function onFile(e){const f=e.target.files[0];if(f)processImg(f);}
function processImg(file){const reader=new FileReader();reader.onload=e=>{document.getElementById('prevImg').src=e.target.result;document.getElementById('prevBox').style.display='block';analyze(e.target.result,file);};reader.readAsDataURL(file);}
function clearScan(){document.getElementById('prevBox').style.display='none';document.getElementById('resultPanel').classList.remove('on');document.getElementById('dealerPanel').style.display='none';document.getElementById('scanPlaceholder').style.display='block';document.getElementById('fileInput').value='';S.item=null;S.dealer=null;S.slot=null;}

/* ══════════════════════════════════════════════════════════════
   YOLO DETECT + ANALYZE
══════════════════════════════════════════════════════════════ */
async function detectViaFlask(b64, file) {
  try {
    const fd = new FormData();
    if (file) { fd.append('image', file); }
    else {
      const arr=b64.split(','),mime=arr[0].match(/:(.*?);/)[1];
      const bstr=atob(arr[1]),u8=new Uint8Array(bstr.length);
      for(let i=0;i<bstr.length;i++)u8[i]=bstr.charCodeAt(i);
      fd.append('image',new Blob([u8],{type:mime}),'scan.jpg');
    }
    fd.append('lat', S.coords.lat); fd.append('lng', S.coords.lng);
    const headers = {};
    if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
    const r = await fetch(API_BASE+'/detect',{method:'POST',body:fd,headers});
    if(!r.ok) return null;
    S.apiOnline = true;
    return await r.json();
  } catch(e){ S.apiOnline=false; return null; }
}

async function analyze(b64, file) {
  document.getElementById('resultPanel').classList.remove('on');
  document.getElementById('dealerPanel').style.display='none';
  document.getElementById('scanPlaceholder').style.display='block';
  const loader=document.getElementById('aiLoader');
  loader.classList.add('on');
  document.querySelectorAll('.lstep').forEach(s=>s.classList.remove('on'));
  const stepIds=['ls1','ls2','ls3','ls4'];
  const msgs=['Processing image…','Analyzing material…','Estimating market value…','Finding nearby dealers…'];
  let si=0;
  const ticker=setInterval(()=>{if(si>0)document.getElementById(stepIds[si-1])?.classList.remove('on');if(si<stepIds.length){document.getElementById(stepIds[si])?.classList.add('on');document.getElementById('aiMsg').textContent=msgs[si++];}},700);
  const stopLoader=()=>{clearInterval(ticker);loader.classList.remove('on');};

  // 1. Flask YOLO
  const fResult = await detectViaFlask(b64, file);
  if (fResult?.success && fResult.top_item) {
    stopLoader();
    const top = fResult.top_item;
    S.weightKg = parseFloat(top.weight_kg) || 1;
    const wInput = document.getElementById('weightInput');
    if(wInput) wInput.value = S.weightKg;

    const item = {
      name: top.scrap_category, 
      rec: top.recyclable, 
      desc: top.description || (top.scrap_category + ' — Recyclable through BinGo partners.'),
      ppkg: top.price_per_kg, 
      est: top.estimated_value || top.est_display,
      qty: `${S.weightKg} kg`,
      source: `Smart Vision & Nagpur Hub`,
      price_min: top.price_min, price_max: top.price_max,
    };
    if (fResult.dealers?.length) S.nearbyDealers = fResult.dealers;
    renderResult(item); return;
  }

  // 2. Gemini fallback
  const localFeaturesPromise = extractImageFeatures(b64);
  const apiKey = getGeminiKey();
  if (apiKey) {
    const mt = b64.startsWith('data:image/png')?'image/png':b64.startsWith('data:image/webp')?'image/webp':'image/jpeg';
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({contents:[{parts:[{inline_data:{mime_type:mt,data:b64.split(',')[1]}},{text:WASTE_PROMPT}]}],generationConfig:{temperature:0.1,maxOutputTokens:400}})
      });
      const d = await res.json();
      if (!d.error) {
        const raw = d.candidates?.[0]?.content?.parts?.[0]?.text||'';
        try {
          const clean = raw.replace(/```json|```/g,'').trim();
          const m = clean.match(/\{[\s\S]*\}/);
          const item = JSON.parse(m?m[0]:clean); item.source='Advanced Vision AI';
          stopLoader(); renderResult(item); return;
        } catch(_){}
      }
    } catch(_){}
  }

  // 3. Local vision
  const features = await localFeaturesPromise;
  stopLoader();
  const localItem = classifyWaste(features);
  localItem.source = localItem.source || 'Local Vision Engine';
  renderResult(localItem);
}

/* ── Local vision engine (minified, same as original) ── */
function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0;const l=(max+min)/2;if(max!==min){const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return{h:h*360,s,l};}
function extractImageFeatures(b64){return new Promise(resolve=>{const img=new Image();img.onload=()=>{const W=Math.min(img.width,150),H=Math.min(img.height,150);const cv=document.createElement('canvas');cv.width=W;cv.height=H;const ctx=cv.getContext('2d');ctx.drawImage(img,0,0,W,H);const data=ctx.getImageData(0,0,W,H).data;const total=W*H;let rSum=0,gSum=0,bSum=0;const hues=[],sats=[],lights=[];const hh=new Array(36).fill(0);for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];rSum+=r;gSum+=g;bSum+=b;const hsl=rgbToHsl(r,g,b);hues.push(hsl.h);sats.push(hsl.s);lights.push(hsl.l);hh[Math.floor(hsl.h/10)%36]++;}const avgR=rSum/total,avgG=gSum/total,avgB=bSum/total;const avgS=sats.reduce((a,b)=>a+b,0)/total;const avgL=lights.reduce((a,b)=>a+b,0)/total;const maxHB=hh.indexOf(Math.max(...hh));const dominantHue=maxHB*10;const greenFrac=hues.filter((h,i)=>h>=80&&h<=170&&sats[i]>.18&&lights[i]>.1&&lights[i]<.9).length/total;const ygFrac=hues.filter((h,i)=>h>=55&&h<=80&&sats[i]>.2).length/total;const brownFrac=hues.filter((h,i)=>h>=20&&h<=45&&sats[i]>.15&&lights[i]>.2&&lights[i]<.7).length/total;const rustFrac=hues.filter((h,i)=>h>=15&&h<=38&&sats[i]>.4&&lights[i]<.55).length/total;const copperFrac=hues.filter((h,i)=>((h>=5&&h<=22)||(h>=345&&h<=360))&&sats[i]>.45&&lights[i]>.25&&lights[i]<.6).length/total;const yellowFrac=hues.filter((h,i)=>h>=38&&h<=60&&sats[i]>.35).length/total;const redFrac=hues.filter((h,i)=>((h>=340&&h<=360)||(h>=0&&h<=15))&&sats[i]>.4).length/total;const greyFrac=hues.filter((_,i)=>sats[i]<.15&&lights[i]>.2&&lights[i]<.8).length/total;const brightFrac=lights.filter(l=>l>.75).length/total;const darkFrac=lights.filter(l=>l<.2).length/total;const blueFrac=hues.filter((h,i)=>h>=195&&h<=260&&sats[i]>.2).length/total;const cyanFrac=hues.filter((h,i)=>h>=165&&h<=200&&sats[i]>.15).length/total;const purpleFrac=hues.filter((h,i)=>h>=260&&h<=310&&sats[i]>.2).length/total;const lVar=lights.reduce((acc,l)=>acc+Math.pow(l-avgL,2),0)/total;const textureScore=Math.sqrt(lVar);const sVar=sats.reduce((acc,s)=>acc+Math.pow(s-avgS,2),0)/total;const satVariance=Math.sqrt(sVar);const hueSpread=hh.filter(c=>c/total>.03).length;resolve({avgR,avgG,avgB,avgS,avgL,dominantHue,textureScore,satVariance,hueSpread,greenFrac,ygFrac,brownFrac,rustFrac,copperFrac,yellowFrac,redFrac,greyFrac,brightFrac,darkFrac,blueFrac,cyanFrac,purpleFrac});};img.onerror=()=>resolve(null);img.src=b64;});}
function classifyWaste(f){if(!f)return{name:'Scan Failed',rec:false,desc:'Could not analyse. Try a clearer photo.',ppkg:'N/A',qty:'—',est:'—',price_min:0,price_max:0};const R={organic:{name:'Green / Organic Waste',rec:false,desc:'NOT accepted by scrap dealers. Use green municipal bin.',ppkg:'N/A',qty:'—',est:'—',price_min:0,price_max:0},cardboard:{name:'Cardboard / Paper',rec:true,desc:'Flat dry cardboard fetches the best prices.',ppkg:'₹8–12',qty:'~10 kg',est:'₹80–120',price_min:8,price_max:12},iron:{name:'Iron / Steel Scrap',rec:true,desc:'Ferrous metal in heavy demand.',ppkg:'₹28–36',qty:'~8 kg',est:'₹224–288',price_min:28,price_max:36},copper:{name:'Copper Wire / Scrap',rec:true,desc:'Highest-value scrap metal.',ppkg:'₹480–550',qty:'~1 kg',est:'₹480–550',price_min:480,price_max:550},aluminium:{name:'Aluminium Cans / Scrap',rec:true,desc:'Premium recyclable — lightweight and high-demand.',ppkg:'₹60–80',qty:'~3 kg',est:'₹180–240',price_min:60,price_max:80},steel:{name:'Stainless Steel',rec:true,desc:'Fully recyclable. Clean items get better rates.',ppkg:'₹50–65',qty:'~3 kg',est:'₹150–195',price_min:50,price_max:65},brass:{name:'Brass / Yellow Metal',rec:true,desc:'High-value non-ferrous metal.',ppkg:'₹280–320',qty:'~1 kg',est:'₹280–320',price_min:280,price_max:320},glass:{name:'Glass Bottles',rec:true,desc:'Clear glass is recyclable.',ppkg:'₹2–5',qty:'~6 kg',est:'₹12–30',price_min:2,price_max:5},pet:{name:'PET Plastic Bottles',rec:true,desc:'Clear PET bottles widely accepted.',ppkg:'₹18–25',qty:'~5 kg',est:'₹90–125',price_min:18,price_max:25},plastic:{name:'Mixed Plastic',rec:true,desc:'Coloured plastic containers.',ppkg:'₹8–14',qty:'~5 kg',est:'₹40–70',price_min:8,price_max:14},ewaste:{name:'E-Waste / Electronics',rec:true,desc:'Contains copper, gold, and rare metals.',ppkg:'₹40–100',qty:'~2 kg',est:'₹80–200',price_min:40,price_max:100},rubber:{name:'Rubber / Tyres',rec:true,desc:'Accepted by specialised dealers.',ppkg:'₹5–10',qty:'~5 kg',est:'₹25–50',price_min:5,price_max:10},bags:{name:'Plastic Bags / Polythene',rec:false,desc:'NOT accepted. Return to store drop-off.',ppkg:'N/A',qty:'—',est:'—',price_min:0,price_max:0},styrofoam:{name:'Styrofoam / Thermocol',rec:false,desc:'NOT recyclable. Use hazardous waste disposal.',ppkg:'N/A',qty:'—',est:'—',price_min:0,price_max:0},textiles:{name:'Old Clothes / Fabric',rec:true,desc:'Accepted by rag-picker networks.',ppkg:'₹3–8',qty:'~5 kg',est:'₹15–40',price_min:3,price_max:8}};if(f.forceType&&R[f.forceType])return R[f.forceType];const scores={};scores['organic']=(f.greenFrac*4.5)+(f.ygFrac*2.5);scores['cardboard']=(f.brownFrac*3.5)+(f.avgS<.25&&f.avgL>.45&&f.brownFrac>.08?1.2:0);scores['iron']=(f.greyFrac*3.0)+(f.rustFrac*6.5)+(f.textureScore>.15?2.5:0);scores['copper']=(f.copperFrac*5.0);scores['aluminium']=(f.greyFrac*2.0)+(f.hueSpread>=4&&f.greyFrac>.15?1.5:0);scores['steel']=(f.greyFrac*2.5)+(f.brightFrac>.3&&f.greyFrac>.3?2.0:0);scores['brass']=(f.yellowFrac*4.5)+(f.avgS>.35&&f.dominantHue>=38&&f.dominantHue<=55?2.0:0);scores['glass']=(f.cyanFrac*3.0)+(f.brightFrac*1.5);scores['pet']=(f.brightFrac*2.5)+(f.avgS<.12&&f.avgL>.75?2.5:0);scores['plastic']=(f.redFrac*.8)+(f.blueFrac*.8);scores['ewaste']=(f.darkFrac*1.5)+(f.hueSpread>=5&&f.textureScore>.12?2.0:0);scores['rubber']=(f.darkFrac*2.0)+(f.avgS<.15&&f.avgL<.25?1.5:0);scores['bags']=(f.brightFrac>.8&&f.avgS<.08?1.5:0);scores['styrofoam']=(f.brightFrac>.9&&f.avgS<.05?2.0:0);scores['textiles']=(f.hueSpread>=5&&f.avgS>.2&&f.textureScore>.15?1.5:0);const best=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];return R[best[0]]||R['plastic'];}


const WASTE_PROMPT=`You are an expert Indian scrap/waste classification AI for BinGo. Analyse this image and return ONLY a single valid JSON: {"name":"Category","rec":true,"desc":"description","ppkg":"₹X–Y","qty":"~Z kg","est":"₹A–B", "price_min": X, "price_max": Y}. For non-recyclable: rec:false, ppkg/qty/est as N/A/—/—, price_min: 0, price_max: 0.`;

/* ══════════════════════════════════════════════════════════════
   RENDER RESULT
══════════════════════════════════════════════════════════════ */
function renderResult(item){
  if(!item) return;
  S.item = item;
  const rec = item.rec ?? item.recyclable;
  
  // 1. Result Panel
  const rp = document.getElementById('resultPanel');
  if(rp){
    rp.style.display = 'block';
    rp.classList.add('on');
    setTimeout(() => rp.scrollIntoView({behavior:'smooth',block:'center'}), 150);
  }

  // 2. Details
  const pi = document.getElementById('prevImg');
  const ri = document.getElementById('rImg');
  if(ri && pi) ri.src = pi.src;
  
  const rn = document.getElementById('rName'); if(rn) rn.textContent = item.name || 'Unknown Scrap';
  const rd = document.getElementById('rDesc'); if(rd) rd.textContent = item.desc || 'Analyzing material quality...';
  const pkg = document.getElementById('rPkg'); if(pkg) pkg.textContent = rec ? (item.ppkg || 'N/A') : 'N/A';
  const rest = document.getElementById('rEst'); if(rest) rest.textContent = rec ? (item.est || '—') : '—';
  
  // 3. Badge
  const badge = document.getElementById('rBadge');
  if(badge){
    if(rec){
      badge.textContent = '✅ Recyclable — Scrap Dealers Accept This';
      badge.className = 'rbadge rb-y';
    } else {
      badge.textContent = '🚫 NOT Recyclable — Cannot be Sold as Scrap';
      badge.className = 'rbadge rb-n';
    }
  }

  // 4. Panel Switching
  const placeholder = document.getElementById('scanPlaceholder');
  if(placeholder) placeholder.style.display = 'none';
  
  const dp = document.getElementById('dealerPanel');
  if(dp) dp.style.display = rec ? 'block' : 'none';

  if(rec){
    try {
      renderDealers();
      addPts(10);
      toast('✅ Item identified! Pick a dealer below.','ok');
    } catch(e) { console.error("Dealer render failed:", e); }
  } else {
    toast('🚫 Not recyclable. See disposal tip below.','warn');
  }
}

/* ══════════════════════════════════════════════════════════════
   DEALERS (5-km filtered, real addresses)
══════════════════════════════════════════════════════════════ */
function renderDealers() {
  const list = document.getElementById('dealerList');
  if(!list) return;
  list.innerHTML = '<div style="padding:22px;text-align:center;color:var(--text3);font-size:.85rem">🔍 Scanning Nagpur hub…</div>';

  const itemParam = S.item ? `&item=${encodeURIComponent(S.item.name)}` : '';
  fetch(`${API_BASE}/dealers?lat=${S.coords.lat}&lng=${S.coords.lng}&radius=50${itemParam}`)
    .then(r => r.json())
    .then(d => {
      S.nearbyDealers = d.dealers || [];
      _renderDealerCards(S.nearbyDealers);
    })
    .catch(() => {
      _renderDealerCards([]);
    });
}

function updateWeight(val) {
  const v = parseFloat(val);
  if(isNaN(v) || v < 1) return;
  S.weightKg = v;
  if(S.item) {
    const pMin = parseFloat(S.item.price_min);
    const pMax = parseFloat(S.item.price_max);
    
    if(!isNaN(pMin) && !isNaN(pMax)) {
      const mn = Math.round(pMin * v);
      const mx = Math.round(pMax * v);
      const est = document.getElementById('rEst');
      if(est) est.textContent = `₹${mn}–${mx}`;
    } else {
      // Fallback if structured prices are missing
      const est = document.getElementById('rEst');
      if(est) est.textContent = '—';
    }
    renderDealers(); // Re-fetch with item context
  }
}

function haversineJS(lat1,lng1,lat2,lng2){const R=6371;const dlat=Math.PI/180*(lat2-lat1);const dlng=Math.PI/180*(lng2-lng1);const a=Math.sin(dlat/2)**2+Math.cos(Math.PI/180*lat1)*Math.cos(Math.PI/180*lat2)*Math.sin(dlng/2)**2;return R*2*Math.asin(Math.sqrt(a));}

function _renderDealerCards(dealers) {
  const list = document.getElementById('dealerList');
  list.innerHTML = '';

  if (!dealers?.length) {
    list.innerHTML = `<div style="padding:28px;text-align:center;color:var(--text3);font-size:.87rem;background:#fff8e1;border-radius:12px;border:1px solid #ffe082">
      <div style="font-size:2rem;margin-bottom:8px">📍</div>
      <div style="font-weight:700;margin-bottom:4px">No dealers within search radius</div>
      <div>Try increasing your search distance or checking if dealers are online.</div>
    </div>`;
    return;
  }

  dealers.forEach(d => {
    const el = document.createElement('div');
    el.className = 'dcard'; el.id = 'dc'+d.id;
    const ico = d.ico || 'store';
    el.innerHTML = `
      <div class="dcard-ico"><span class="material-symbols-rounded">${ico}</span></div>
      <div class="dcard-info">
        <div class="dcard-name">${d.name}</div>
        <div class="dcard-meta">
          <span>⭐ ${d.rating?.toFixed(1) || '4.5'}</span>
          <span style="color:var(--g);font-weight:600">📍 ${d.distance_km} km</span>
          <span>🕐 ~${d.eta_min} min</span>
        </div>
        <div class="dcard-meta" style="margin-top:2px;color:var(--text3);font-size:.78rem">
          <span class="material-symbols-rounded" style="font-size:13px;vertical-align:middle">location_on</span>
          ${d.addr || 'Near your location'}
        </div>
        <div class="dcard-meta" style="margin-top:1px;font-size:.75rem">📞 ${d.phone}</div>
      </div>
      <div class="dcard-pr">
        <div class="price-val" style="font-size:1.1rem;font-weight:800;color:var(--g)">${d.price_per_kg || '—'}</div>
        <div class="price-unit">${S.item?.name ? '/kg' : 'loading…'}</div>
        <div class="verified" style="font-size:.65rem;color:var(--text3);margin-top:2px">Authorized ✓</div>
      </div>`;
    el.onclick = ev => pickDealer(d, ev);
    list.appendChild(el);
  });
}

function pickDealer(d, e) {
  S.dealer = d;
  document.querySelectorAll('.dcard').forEach(c => c.classList.remove('sel'));
  document.getElementById('dc'+d.id)?.classList.add('sel');
  document.getElementById('slotPanel').style.display = 'block';
  renderSlots(d.id);
  toast('Selected: '+d.name, 'ok');
  spawnParticles(e);
}

async function renderSlots(dealerId) {
  const grid = document.getElementById('slotsGrid');
  grid.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:.85rem">⏳ Loading slots…</div>';
  let slots = null;
  if (S.apiOnline) {
    try {
      const r = await fetch(`${API_BASE}/dealers/${dealerId}/slots?days=3`);
      const d = await r.json();
      if (d.slots) slots = d.slots;
    } catch(_){}
  }
  if (!slots) {
    slots = [];
    const days=['Tomorrow','Day After','In 3 Days'], times=['09:00','11:00','13:00','15:00','17:00'];
    days.forEach((day,di)=>times.forEach((t,ti)=>{
      const avail=true;
      slots.push({id:`${dealerId}-${di}-${ti}`,day,time:t,available:avail});
    }));
  }
  grid.innerHTML='';
  slots.forEach(slot=>{
    const el=document.createElement('div');
    el.className='slot'+(slot.available===false?' disabled':'');
    const timeLabel = slot.label || `${slot.day}, ${slot.time}`;
    const shortTime = slot.time || (slot.label||'').split('·')[1]?.trim() || slot.label || '';
    const shortDay  = slot.day  || (slot.label||'').split('·')[0]?.trim() || '';
    el.innerHTML=`<div>${shortTime}</div><div class="slot-d">${shortDay}</div>`;
    if(slot.available!==false){el.onclick=e=>{document.querySelectorAll('.slot').forEach(s=>s.classList.remove('sel'));el.classList.add('sel');S.slot=timeLabel;S.slotId=slot.id;document.getElementById('cbName').textContent=S.dealer?.name||'—';document.getElementById('cbSlot').textContent=S.slot;document.getElementById('confirmBar').classList.add('on');spawnParticles(e);};}
    grid.appendChild(el);
  });
}

/* ══════════════════════════════════════════════════════════════
   SEND PICKUP REQUEST
══════════════════════════════════════════════════════════════ */
async function sendReq() {
  if (!S.dealer || !S.slot) { toast('Please pick a dealer and time slot!','warn'); return; }
  if (!S.user) { toast('🔒 Please login first','warn'); go('auth'); return; }

  toast('📤 Sending request…','ok');
  const payload = {
    user_id:      S.user.id,
    user_name:    S.user.name,
    dealer_id:    S.dealer.id,
    slot_id:      S.slotId || S.slot,
    item_name:    S.item?.name || 'Mixed Scrap',
    weight_kg:    S.weightKg || 1,
    condition:    'good',
    price_per_kg: S.item?.ppkg || S.item?.price_per_kg || '₹12–32',
    est_earning:  S.item?.est  || S.item?.est_display  || '₹12',
    user_lat:     S.coords.lat,
    user_lng:     S.coords.lng,
    user_address: S.userAddress || `${S.coords.lat.toFixed(4)}, ${S.coords.lng.toFixed(4)}`,
  };

  let pickupId = null;
  if (S.apiOnline) {
    try {
      const headers = {'Content-Type':'application/json'};
      if (S.token) headers['Authorization'] = `Bearer ${S.token}`;
      const r = await fetch(API_BASE+'/pickups',{method:'POST',headers,body:JSON.stringify(payload)});
      const d = await r.json();
      if (d.success) { pickupId = d.pickup_id; }
    } catch(_){}
  }
  if (!pickupId) pickupId = 'BG-'+Math.random().toString(36).slice(2,6).toUpperCase();
  S.pickupId = pickupId;

  // Push live GPS tagged to this pickup
  if (S.apiOnline) {
    apiCall('POST', '/location', {
      pickup_id: pickupId,
      role:      'user',
      lat:       S.coords.lat,
      lng:       S.coords.lng,
      label:     S.user.name,
      address:   S.userAddress,
    }).catch(() => {});
  }

  S.requested = true;
  renderTracking();
  prepDealerReq();
  addPts(50);
  go('track');
  toast('🚀 Request sent to '+S.dealer.name+'!','ok');
  spawnParticles({clientX:window.innerWidth/2,clientY:window.innerHeight/2});
}

/* ══════════════════════════════════════════════════════════════
   LIVE TRACKING
══════════════════════════════════════════════════════════════ */
function initLiveTracking(pickupId) {
  if (!pickupId) return;
  if (!document.getElementById('liveMap')) _injectLiveMapPanel();
  if (S.apiOnline && typeof EventSource !== 'undefined') {
    if (S.liveStream) S.liveStream.close();
    S.liveStream = new EventSource(`${API_BASE}/location/${pickupId}/stream`);
    S.liveStream.onmessage = e => { try { updateLiveMap(JSON.parse(e.data)); } catch(_){} };
    S.liveStream.onerror = () => { S.liveStream.close(); _pollTracking(pickupId); };
  } else {
    _pollTracking(pickupId);
  }
}
function _pollTracking(pid) {
  if (window._lti) clearInterval(window._lti);
  window._lti = setInterval(async()=>{
    try{const r=await fetch(`${API_BASE}/location/${pid}`);const d=await r.json();if(d.success)updateLiveMap(d);}
    catch(_){_simTracking();}
  },4000);
  _simTracking();
}
let _sA=0;
function _simTracking(){if(!S.dealer)return;_sA+=0.03;const t=Math.min((_sA/Math.PI)*.5,.95);const dlat=S.dealer.lat+(S.coords.lat-S.dealer.lat)*t+(Math.random()-.5)*.001;const dlng=S.dealer.lng+(S.coords.lng-S.dealer.lng)*t+(Math.random()-.5)*.001;const dist=Math.sqrt(Math.pow((dlat-S.coords.lat)*111,2)+Math.pow((dlng-S.coords.lng)*91,2));updateLiveMap({user:{lat:S.coords.lat,lng:S.coords.lng,label:S.user?.name||'You',type:'user',address:S.userAddress},dealer:{lat:dlat,lng:dlng,label:S.dealer.name,type:'dealer',address:S.dealer.addr||''},distance_km:dist.toFixed(2),eta_min:Math.max(1,Math.round(dist/0.4*60)),status:t>.1?'en_route':'confirmed'});}

function _injectLiveMapPanel(){
  const tc=document.getElementById('trackCard');if(!tc||document.getElementById('liveMap'))return;
  const p=document.createElement('div');p.id='liveMapPanel';
  p.innerHTML=`<div style="margin-top:24px"><div style="font-family:'Barlow',sans-serif;font-weight:700;font-size:.78rem;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">📍 Live Location Tracking</div><div id="liveEtaBanner" style="background:linear-gradient(135deg,#e8f5e9,#f1f8e9);border:1.5px solid #a5d6a7;border-radius:12px;padding:12px 18px;margin-bottom:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap"><span style="width:10px;height:10px;background:#4caf50;border-radius:50%;display:inline-block;box-shadow:0 0 8px #4caf50;animation:pulse 1.5s infinite;flex-shrink:0"></span><div><div style="font-weight:700;color:var(--g);font-size:.95rem" id="liveEtaText">Connecting to dealer…</div><div style="font-size:.78rem;color:var(--text3)" id="liveDistText">Getting live location</div></div><div style="margin-left:auto;text-align:right"><div style="font-size:.7rem;color:var(--text3)">Status</div><div id="liveStatusText" style="font-weight:700;color:var(--g);font-size:.85rem">—</div></div></div><div id="liveMap" style="height:320px;border-radius:14px;overflow:hidden;border:1.5px solid var(--border)"></div><div class="map-leg" style="margin-top:10px"><div class="mleg"><div class="ldot" style="background:#2e7d32"></div>Your Location</div><div class="mleg"><div class="ldot" style="background:#f9a825"></div>Dealer</div></div></div>`;
  tc.appendChild(p);
}

let _lmi=null,_lum=null,_ldm=null,_ll=null;
function updateLiveMap(data){
  const mel=document.getElementById('liveMap');if(!mel)return;
  if(!_lmi){_lmi=L.map('liveMap').setView([S.coords.lat,S.coords.lng],14);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OSM'}).addTo(_lmi);}
  const uLat=data.user?.lat||S.coords.lat,uLng=data.user?.lng||S.coords.lng;
  const dLat=data.dealer?.lat||S.dealer?.lat,dLng=data.dealer?.lng||S.dealer?.lng;
  const uI=L.divIcon({className:'',html:'<div style="width:16px;height:16px;background:#2e7d32;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,.3)"></div>',iconSize:[16,16],iconAnchor:[8,8]});
  if(_lum)_lum.setLatLng([uLat,uLng]);else _lum=L.marker([uLat,uLng],{icon:uI}).addTo(_lmi).bindPopup(`📍 ${data.user?.label||'You'}<br><small>${data.user?.address||''}</small>`);
  const dI=L.divIcon({className:'',html:'<div style="width:22px;height:22px;background:#f9a825;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font-size:12px">🚛</div>',iconSize:[22,22],iconAnchor:[11,11]});
  if(_ldm)_ldm.setLatLng([dLat,dLng]);else _ldm=L.marker([dLat,dLng],{icon:dI}).addTo(_lmi).bindPopup(`🚛 ${data.dealer?.label||'Dealer'}<br><small>${data.dealer?.address||''}</small>`);
  if(_ll)_lmi.removeLayer(_ll);_ll=L.polyline([[uLat,uLng],[dLat,dLng]],{color:'#2e7d32',weight:3,dashArray:'8,6',opacity:.7}).addTo(_lmi);
  _lmi.fitBounds([[uLat,uLng],[dLat,dLng]],{padding:[40,40]});
  const eta=document.getElementById('liveEtaText'),dist=document.getElementById('liveDistText'),stat=document.getElementById('liveStatusText');
  if(eta)eta.textContent=`ETA: ~${data.eta_min||'—'} minutes`;
  if(dist)dist.textContent=`${data.distance_km||'—'} km away · Live updating`;
  if(stat){const sm={confirmed:'✅ Confirmed',en_route:'🚛 On the Way',arrived:'📍 Arrived',completed:'✔️ Completed'};stat.textContent=sm[data.status]||data.status||'—';}
}

/* ══════════════════════════════════════════════════════════════
   TRACKING PAGE
══════════════════════════════════════════════════════════════ */
function renderTracking(){
  document.getElementById('noTrack').style.display='none';
  const card=document.getElementById('trackCard');card.style.display='block';
  document.getElementById('tName').textContent=S.item?.name||'Scrap Item';
  document.getElementById('tDealer').textContent='Sent to: '+(S.dealer?.name||'—');
  document.getElementById('tAmt').textContent=S.item?.est||'—';
  document.getElementById('confChip').classList.remove('on');buildTL(1);
  if(S.pickupId&&!document.getElementById('pickupIdChip')){const chip=document.createElement('div');chip.id='pickupIdChip';chip.style.cssText='background:rgba(46,125,50,.07);border:1px solid rgba(46,125,50,.2);border-radius:8px;padding:8px 14px;margin-bottom:14px;font-size:.8rem;font-weight:600;color:var(--g)';chip.textContent=`🆔 Pickup ID: ${S.pickupId}`;card.prepend(chip);}
  // Address chip
  if(S.userAddress){let ac=document.getElementById('userAddrChip');if(!ac){ac=document.createElement('div');ac.id='userAddrChip';ac.style.cssText='background:#f0f4f0;border:1px solid var(--border);border-radius:8px;padding:8px 14px;margin-bottom:14px;font-size:.78rem;color:var(--text2);display:flex;align-items:center;gap:6px';card.insertBefore(ac,card.firstChild);}ac.innerHTML=`<span class="material-symbols-rounded" style="font-size:15px;color:var(--g)">location_on</span> Pickup from: <b>${S.userAddress}</b>`;}
}

function buildTL(step){const steps=[{e:'send',t:'Request sent',s:'Successfully submitted'},{e:'hourglass_empty',t:'Awaiting dealer',s:'Dealer reviewing your request'},{e:'check_circle',t:'Dealer confirmed',s:S.requested&&S.dealer?`${S.dealer?.name} accepted`:'Pending…'},{e:'local_shipping',t:'On the way',s:`Pickup at ${S.slot||'—'}`},{e:'payments',t:'Pickup complete',s:'Payment at delivery'}];const tl=document.getElementById('timeline');tl.innerHTML='';steps.forEach((s,i)=>{const cls=i<step?'done':i===step?'act':'';const el=document.createElement('div');el.className='tl';el.innerHTML=`<div class="tl-dot ${cls}"><span class="material-symbols-rounded" style="font-size:1.2rem">${s.e}</span></div><div class="tl-body"><div class="tl-title">${s.t}</div><div class="tl-sub">${s.s}</div></div>`;tl.appendChild(el);});}

/* ══════════════════════════════════════════════════════════════
   DEALER PORTAL
══════════════════════════════════════════════════════════════ */
async function fetchDealerRequests() {
  const container = document.getElementById('dReqs');
  if(!container) return;

  const { ok, data } = await apiCall('GET', '/dealer/pickups');
  if(!ok || !data.success) return;

  if(!data.pickups || data.pickups.length === 0) {
    container.innerHTML = `<div id="noReqs" style="background:var(--bg);border-radius:var(--r);padding:32px;text-align:center;color:var(--text3);font-size:.88rem">No pending requests yet.</div>`;
    return;
  }

  container.innerHTML = '';
  data.pickups.forEach(p => {
    const el = document.createElement('div');
    el.className = 'req-card on';
    el.id = 'req-' + p.id;
    
    const statusClass = p.status === 'pending' ? 'rs-pend' : p.status === 'accepted' ? 'rs-acc' : 'rs-rej';
    const statusText = p.status.charAt(0).toUpperCase() + p.status.slice(1);
    const statusIcon = p.status === 'pending' ? 'hourglass_empty' : p.status === 'accepted' ? 'check_circle' : 'cancel';

    el.innerHTML = `
      <div class="req-head">
        <div>
          <div class="req-title"><span class="material-symbols-rounded" style="vertical-align:middle;margin-right:6px">package</span>${p.item_name}</div>
          <div style="color:var(--text3);font-size:.78rem;margin-top:2px">From ${p.user_name} · ID: ${p.id}</div>
        </div>
        <div class="rstatus ${statusClass}" id="rs-${p.id}">
          <span class="material-symbols-rounded" style="font-size:14px">${statusIcon}</span> ${statusText}
        </div>
      </div>
      <div class="req-row">💰 Price: <b>${p.price_per_kg}/kg</b></div>
      <div class="req-row">⚖️ Qty: <b>${p.weight_kg} kg</b> (Est. <b>${p.est_earning}</b>)</div>
      <div class="req-row" style="margin-top:4px;padding-top:4px;border-top:1px dashed var(--border)">
        <span class="material-symbols-rounded" style="font-size:14px;vertical-align:middle">location_on</span> <b>${p.user_address}</b>
      </div>
      <div class="req-row">🗓 Slot: <b>${p.slot_id}</b></div>
      ${p.status === 'pending' ? `
        <div class="req-actions" id="ract-${p.id}">
          <button class="btn-acc" onclick="acceptReq('${p.id}')">✅ Accept</button>
          <button class="btn-rej" onclick="rejectReq('${p.id}')">❌ Reject</button>
        </div>
      ` : `<div style="color:var(--g);font-size:.87rem;font-weight:600;margin-top:12px">${p.status === 'accepted' ? '✅ Confirmed' : '❌ Rejected'}</div>`}
    `;
    container.appendChild(el);
  });
}

function prepDealerReq(){
   // This was used for instant demo, we'll keep it but make it call fetchDealerRequests for consistency
   fetchDealerRequests();
}

function renderEarningsGraph() {
  const line = document.getElementById('graphLine'), area = document.getElementById('graphArea');
  const dots = document.getElementById('graphDots'), labels = document.getElementById('graphLabels');
  if(!line || !area) return;

  const data = [
    {m:'Oct',v:45}, {m:'Nov',v:62}, {m:'Dec',v:51},
    {m:'Jan',v:78}, {m:'Feb',v:84}, {m:'Mar',v:92}
  ];
  
  dots.innerHTML = ''; labels.innerHTML = '';
  const W=400, H=160, steps=data.length-1;
  let path = '', areaPath = `M 0 ${H}`;
  
  data.forEach((d, i) => {
    const x = (i / steps) * W;
    const y = H - (d.v / 100) * H;
    const cmd = i === 0 ? 'M' : 'L';
    path += `${cmd} ${x} ${y} `;
    areaPath += ` L ${x} ${y}`;
    
    // Dot
    const dot = document.createElement('div');
    dot.className = 'eview-dot';
    dot.style.left = `${(x/W)*100}%`;
    dot.style.top = `${(y/H)*100}%`;
    dots.appendChild(dot);
    
    // Label
    const lbl = document.createElement('div');
    lbl.className = 'ebar-label';
    lbl.style.left = `${(x/W)*100}%`;
    lbl.style.bottom = '-24px';
    lbl.style.transform = 'translateX(-50%)';
    lbl.textContent = d.m;
    labels.appendChild(lbl);
  });
  
  areaPath += ` L ${W} ${H} Z`;
  line.setAttribute('d', path);
  area.setAttribute('d', areaPath);
  
  // Update Month Earnings Total
  animCount(document.getElementById('dpMonthEarnings'), 48200, '');
}

async function toggleDealerStatus() {
  const btn = document.getElementById('statusToggle');
  if(!btn) return;
  
  toast('🔄 Updating status…');
  const { ok, data } = await apiCall('POST', '/auth/toggle-status');
  if(ok && data.success) {
    S.user.is_active = data.is_active;
    updateDealerUI();
    toast(data.is_active ? '🟢 You are now ONLINE & accepting pickups' : '⚪ You are now OFFLINE', 'ok');
  } else {
    toast('❌ Failed to update status', 'warn');
  }
}

function updateDealerUI() {
  if(!S.user || S.user.role !== 'dealer') return;
  
  const name = document.getElementById('dpName');
  if(name) name.textContent = S.user.name;
  
  const meta = document.getElementById('dpMeta');
  if(meta) meta.textContent = S.userAddress || S.user.address || 'Verified Partner';
  
  const toggle = document.getElementById('statusToggle');
  const label = document.getElementById('stLabel');
  const badge = document.getElementById('dealerStatusBadge');
  
  if(toggle && label) {
    if(S.user.is_active) {
      toggle.classList.add('on');
      label.textContent = 'ONLINE';
      if(badge) { badge.className = 'badge-online'; badge.textContent = 'ACTIVE'; }
    } else {
      toggle.classList.remove('on');
      label.textContent = 'OFFLINE';
      if(badge) { badge.className = 'badge-offline'; badge.textContent = 'BUSY / OFFLINE'; }
    }
  }

  // Load actual requests
  fetchDealerRequests();
}

/* ── Dealer Pricing Management ── */
async function renderDealerPricing() {
  const list = document.getElementById('dealerPricingList');
  if(!list) return;

  // 1. Get current prices from API
  const { ok, data } = await apiCall('GET', '/dealer/prices');
  const customPrices = ok ? data.prices : {};

  // 2. Use categories from MARKET_BASE
  list.innerHTML = '';
  MARKET_BASE.forEach(item => {
    const el = document.createElement('div');
    el.className = 'pricing-item';
    
    // Fallback to average of base price if no custom price
    const currentPrice = customPrices[item.name] || item.base;
    
    el.innerHTML = `
      <div class="pi-info">
        <div class="pi-ico"><span class="material-symbols-rounded">${_getIco(item.name)}</span></div>
        <div class="pi-name">${item.name}</div>
      </div>
      <div class="pi-input-wrap">
        <input type="number" class="pi-input" value="${currentPrice}" id="price-${item.name.replace(/\s+/g, '-')}" min="1">
      </div>
      <div>
        <button class="pi-btn" onclick="updateDealerPrice('${item.name}', this)">
          <span class="material-symbols-rounded" style="font-size:14px">save</span> Save
        </button>
      </div>
    `;
    list.appendChild(el);
  });
}

function _getIco(name) {
    const m = {
        'Iron Scrap': 'warehouse', 'Aluminium': 'recycled_water', 'Copper Wire': 'bolt',
        'PET Plastic': 'nest_eco_leaf', 'Cardboard': 'inventory_2', 'Newspaper': 'newspaper',
        'Glass': 'wine_bar', 'Brass': 'stars', 'E-Waste': 'devices', 'Steel': 'iron'
    };
    return m[name] || 'eco';
}

async function updateDealerPrice(itemName, btn) {
  const inputId = `price-${itemName.replace(/\s+/g, '-')}`;
  const input = document.getElementById(inputId);
  if(!input) return;

  const newPrice = parseFloat(input.value);
  if(isNaN(newPrice) || newPrice <= 0) {
    toast('⚠️ Please enter a valid price', 'warn');
    return;
  }

  btn.classList.add('loading');
  btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px;animation:spin 1s linear infinite">sync</span> Updating…';

  const { ok, data } = await apiCall('POST', '/dealer/update-price', {
    item_name: itemName,
    price: newPrice
  });

  btn.classList.remove('loading');
  if(ok) {
    btn.classList.add('success');
    btn.innerHTML = '✅ Saved';
    toast(`✅ ${itemName} updated to ₹${newPrice}`, 'ok');
    setTimeout(() => {
      btn.classList.remove('success');
      btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px">save</span> Save';
    }, 2000);
  } else {
    btn.innerHTML = '❌ Failed';
    toast('❌ Update failed: ' + (data?.error || 'Unknown error'), 'warn');
    setTimeout(() => {
      btn.innerHTML = '<span class="material-symbols-rounded" style="font-size:14px">save</span> Save';
    }, 2000);
  }
}

async function acceptReq(pickupId){
  if(!pickupId) {
     // Fallback for old local demo if needed
     document.getElementById('rs').textContent='✅ Accepted';document.getElementById('rs').className='rstatus rs-acc';
     document.getElementById('ract').innerHTML=`<div style="color:var(--g);font-size:.87rem;font-weight:600">✅ Confirmed – pickup soon</div>`;
     return;
  }
  
  toast('🔄 Confirming pickup…');
  const { ok } = await apiCall('POST', `/pickups/${pickupId}/advance`); // Assuming this exists or we create it
  
  // UI Update
  const rs = document.getElementById('rs-'+pickupId);
  if(rs) { rs.textContent = '✅ Accepted'; rs.className = 'rstatus rs-acc'; }
  const ra = document.getElementById('ract-'+pickupId);
  if(ra) ra.innerHTML = `<div style="color:var(--g);font-size:.87rem;font-weight:600">✅ Confirmed</div>`;
  
  const chip=document.getElementById('confChip');if(chip){chip.classList.add('on');document.getElementById('cName').textContent=S.dealer?.name||'—';document.getElementById('cPhone').textContent=S.dealer?.phone||'—';}
  buildTL(3);addPts(20);
  
  updateDMap();toast('✅ Request accepted! Dealer en route.','ok');
  setTimeout(()=>{if(pickupId)initLiveTracking(pickupId);},500);
}

function rejectReq(pickupId){
  if(pickupId) document.getElementById('req-'+pickupId)?.remove();
  else document.getElementById('req1')?.remove();
  
  toast('Request rejected.','warn');
  
  // If no cards left, show empty state
  if(document.getElementById('dReqs').children.length === 0) {
     document.getElementById('dReqs').innerHTML = `<div id="noReqs" style="background:var(--bg);border-radius:var(--r);padding:32px;text-align:center;color:var(--text3);font-size:.88rem">No pending requests yet.</div>`;
  }
}

/* ══════════════════════════════════════════════════════════════
   GAMIFICATION + TOAST + PARTICLES
══════════════════════════════════════════════════════════════ */
let pts=parseInt(localStorage.getItem('bingo_pts')||'0');
function addPts(n){pts+=n;localStorage.setItem('bingo_pts',pts);const el=document.getElementById('ptsDisplay');if(el)el.textContent='🏆 '+pts+' pts';if(n>0)toast(`+${n} BinGo Points! 🏅`,'ok');}

function toast(msg,type='info',dur=3200){const t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.className='toast on'+(type==='ok'?' tok':type==='warn'?' twarn':'');clearTimeout(t._tid);t._tid=setTimeout(()=>t.classList.remove('on'),dur);}

function spawnParticles(e){const colors=['#2e7d32','#43a047','#f9a825','#ffc107','#66bb6a'];for(let i=0;i<12;i++){const p=document.createElement('div');p.style.cssText=`position:fixed;pointer-events:none;width:${Math.random()*8+4}px;height:${Math.random()*8+4}px;border-radius:50%;background:${colors[Math.floor(Math.random()*colors.length)]};left:${e.clientX}px;top:${e.clientY}px;z-index:9999;transition:all .8s ease-out;opacity:1`;document.body.appendChild(p);requestAnimationFrame(()=>requestAnimationFrame(()=>{p.style.transform=`translate(${(Math.random()-.5)*160}px,${-Math.random()*120-40}px) scale(0)`;p.style.opacity='0';setTimeout(()=>p.remove(),900);}));}}

/* ══════════════════════════════════════════════════════════════
   GEMINI KEY BANNER
══════════════════════════════════════════════════════════════ */
function initApiKeyBanner(){updateApiKeyBannerState(getGeminiKey()?'active':'empty');}
function updateApiKeyBannerState(state){const banner=document.getElementById('apiKeyBanner');if(!banner)return;const input=document.getElementById('apiKeyInput'),clearBtn=document.getElementById('apiKeyClear');const title=banner.querySelector('#apiBannerTitle');if(state==='active'){banner.style.cssText='display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,#e8f5e9,#f1f8e9);border:1.5px solid #a5d6a7;border-radius:14px;padding:14px 18px;margin-bottom:24px;';if(title){title.textContent='✅ Gemini Vision AI Active';title.style.color='#2e7d32';}if(input)input.style.display='none';if(clearBtn)clearBtn.style.display='inline-flex';banner.querySelectorAll('button:not(#apiKeyClear)').forEach(b=>b.style.display='none');}else{banner.style.cssText='display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(135deg,#fff8e1,#fffde7);border:1.5px solid #ffe082;border-radius:14px;padding:14px 18px;margin-bottom:24px;';if(title){title.textContent='Gemini Key (optional — YOLO backend active)';title.style.color='#5d4037';}if(input){input.style.display='block';input.value='';}if(clearBtn)clearBtn.style.display='none';banner.querySelectorAll('button:not(#apiKeyClear)').forEach(b=>b.style.display='inline-flex');}}
function saveApiKey(){const v=(document.getElementById('apiKeyInput')?.value||'').trim();if(!v.startsWith('AIza')){toast('⚠️ Invalid key format','warn');return;}localStorage.setItem(GEMINI_KEY_STORAGE,v);updateApiKeyBannerState('active');toast('✅ Gemini key saved!','ok');}
function clearApiKey(){localStorage.removeItem(GEMINI_KEY_STORAGE);updateApiKeyBannerState('empty');toast('🗑️ Key cleared.','warn');}

/* ══════════════════════════════════════════════════════════════
   MARKET RATES
══════════════════════════════════════════════════════════════ */
const MARKET_BASE=[
  {name:'Iron Scrap',  base:28,  range:12, unit:'/kg', img:'assets/scrap/iron.png'},
  {name:'Aluminium',   base:68,  range:20, unit:'/kg', img:'assets/scrap/aluminium.png'},
  {name:'Copper Wire', base:510, range:70, unit:'/kg', img:'assets/scrap/copper.png'},
  {name:'PET Plastic', base:22,  range:8,  unit:'/kg', img:'assets/scrap/plastic.png'},
  {name:'Cardboard',   base:10,  range:4,  unit:'/kg', img:'assets/scrap/cardboard.png'},
  {name:'Newspaper',   base:7,   range:3,  unit:'/kg', img:'assets/scrap/cardboard.png'},
  {name:'Glass',       base:3,   range:2,  unit:'/kg', img:'assets/scrap/glass.png'},
  {name:'Brass',       base:295, range:35, unit:'/kg', img:'assets/scrap/brass.png'},
  {name:'E-Waste',     base:70,  range:40, unit:'/kg', img:'assets/scrap/ewaste.png'},
  {name:'Steel',       base:55,  range:15, unit:'/kg', img:'assets/scrap/stainless.png'}
];
function getDailyRate(base,range){const s=parseInt(new Date().toLocaleDateString('en-IN',{year:'numeric',month:'2-digit',day:'2-digit'}).replace(/[^0-9]/g,''))%100;return base+Math.floor(s%range);}
function getTrend(base,range){const t=getDailyRate(base,range),y=getDailyRate(base*.98,range);return t>y?'up':t<y?'down':'flat';}
function renderMarketRates(){const grid=document.getElementById('market-rates-grid');if(!grid)return;const today=new Date();const ds=today.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'});const de=document.getElementById('market-date');if(de)de.textContent=`Rates as of ${ds} · Nagpur Market`;const ha=MARKET_BASE.map(item=>{const rate=getDailyRate(item.base,item.range);const trend=getTrend(item.base,item.range);const ti=trend==='up'?'trending_up':trend==='down'?'trending_down':'trending_flat';const tc=trend==='up'?'trend-up':trend==='down'?'trend-dn':'trend-flat';const tt=trend==='up'?'+'+Math.round(item.range*.15):trend==='down'?'-'+Math.round(item.range*.15):'0';return`<div class="mkt-card"><div class="mkt-img-wrap"><img src="${item.img}" alt="${item.name}" onerror="this.src='https://via.placeholder.com/300x200?text=Scrap+Material'"></div><div class="mkt-content"><div class="mkt-header"><div><div class="mkt-name">${item.name}</div><div class="mkt-region">Nagpur Region</div></div><div class="mkt-trend ${tc}"><span class="material-symbols-rounded" style="font-size:14px">${ti}</span> ${tt}</div></div><div class="mkt-price-box"><div class="mkt-rate">₹${rate}<span>${item.unit}</span></div></div><button class="mkt-sell-btn" onclick="go('scan')"><span class="material-symbols-rounded" style="font-size:18px">local_shipping</span> Sell Now</button></div></div>`;});grid.innerHTML=[...ha,...ha,...ha].join('');startMarketAutoplay();}
let marketAnimId;
function startMarketAutoplay(){const grid=document.getElementById('market-rates-grid');if(!grid||marketAnimId)return;let h=false;grid.onmouseenter=()=>h=true;grid.onmouseleave=()=>h=false;function t(){if(!h){grid.scrollLeft+=1.2;if(grid.scrollLeft>=grid.scrollWidth/3)grid.scrollLeft=0;}marketAnimId=requestAnimationFrame(t);}marketAnimId=requestAnimationFrame(t);}

/* ══════════════════════════════════════════════════════════════
   ABOUT GALLERY
══════════════════════════════════════════════════════════════ */
let abtIdx=0;
function initAbtGallery(){const slides=document.querySelectorAll('.abt-slide');const dots=document.querySelectorAll('.adot');if(!slides.length)return;setInterval(()=>{slides[abtIdx].classList.remove('on');dots[abtIdx].classList.remove('on');abtIdx=(abtIdx+1)%slides.length;slides[abtIdx].classList.add('on');dots[abtIdx].classList.add('on');},4000);}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  renderMarketRates();
  initAbtGallery();
  initApiKeyBanner();
  checkApiHealth();
  restoreSession();   // ← restore saved login

  setTimeout(() => {
    document.querySelectorAll('.svc-card,.tcard,.proc,.acheck,.how-card,.hstat').forEach(el => {
      el.style.opacity='1'; el.style.transform='none';
    });
  }, 500);

  // Add shake keyframe for invalid auth
  const style = document.createElement('style');
  style.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}`;
  document.head.appendChild(style);

  setInterval(checkApiHealth, 30000);
});