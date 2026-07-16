const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SCOPES = ['user-read-private', 'user-read-email'];

const elements = {
  authState: document.getElementById('authState'),
  clientId: document.getElementById('clientId'),
  loginBtn: document.getElementById('loginBtn'),
  logoutBtn: document.getElementById('logoutBtn'),
  profileAvatar: document.getElementById('profileAvatar'),
  profileName: document.getElementById('profileName'),
  profileMeta: document.getElementById('profileMeta'),
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  quickSearches: document.getElementById('quickSearches'),
  statusBar: document.getElementById('statusBar'),
  featuredResults: document.getElementById('featuredResults'),
  featuredCount: document.getElementById('featuredCount'),
  trackResults: document.getElementById('trackResults'),
  artistResults: document.getElementById('artistResults'),
  albumResults: document.getElementById('albumResults'),
  trackCount: document.getElementById('trackCount'),
  artistCount: document.getElementById('artistCount'),
  albumCount: document.getElementById('albumCount'),
};

const storage = {
  clientId: 'spotify_client_id',
  verifier: 'spotify_pkce_verifier',
  accessToken: 'spotify_access_token',
  refreshToken: 'spotify_refresh_token',
  expiresAt: 'spotify_expires_at',
  profile: 'spotify_profile_cache',
};

const state = {
  clientId: localStorage.getItem(storage.clientId) || '',
  accessToken: localStorage.getItem(storage.accessToken) || '',
  refreshToken: localStorage.getItem(storage.refreshToken) || '',
  expiresAt: Number(localStorage.getItem(storage.expiresAt) || 0),
  profile: loadProfileCache(),
  busy: false,
};

initialize();

function initialize() {
  if (!state.clientId) {
    state.clientId = elements.clientId.value.trim();
  }

  elements.clientId.value = state.clientId;
  localStorage.setItem(storage.clientId, state.clientId);
  wireEvents();

  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    setStatus(`Spotify sign-in was cancelled or failed: ${error}`);
    cleanupOAuthParams();
    renderAuthState();
    renderProfile(state.profile);
    return;
  }

  if (code) {
    completeLogin(code).catch((err) => {
      setStatus(err.message || 'Unable to complete Spotify sign-in.');
      cleanupOAuthParams();
      renderAuthState();
    });
    return;
  }

  renderAuthState();
  renderProfile(state.profile);

  if (hasValidToken()) {
    loadProfile().catch(() => {
      setStatus('Connected, but Spotify profile could not be loaded yet.');
    });
  }
}

function wireEvents() {
  elements.clientId.addEventListener('input', () => {
    state.clientId = elements.clientId.value.trim();
    localStorage.setItem(storage.clientId, state.clientId);
  });

  elements.loginBtn.addEventListener('click', () => {
    startLogin().catch((err) => setStatus(err.message));
  });

  elements.logoutBtn.addEventListener('click', logout);

  elements.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchSpotify(elements.searchInput.value.trim()).catch((err) => setStatus(err.message));
  });

  elements.quickSearches.addEventListener('click', (event) => {
    const button = event.target.closest('[data-query]');
    if (!button) {
      return;
    }

    const query = button.dataset.query;
    elements.searchInput.value = query;
    searchSpotify(query).catch((err) => setStatus(err.message));
  });
}

function renderAuthState() {
  const connected = hasValidToken();
  elements.authState.textContent = connected ? 'Connected' : 'Not connected';
  elements.logoutBtn.disabled = !connected;
  elements.loginBtn.textContent = connected ? 'Reconnect Spotify' : 'Connect Spotify';
}

function hasValidToken() {
  return Boolean(state.accessToken) && Date.now() < state.expiresAt - 20_000;
}

async function startLogin() {
  if (!state.clientId) {
    setStatus('Add your Spotify client ID first.');
    elements.clientId.focus();
    return;
  }

  if (window.location.protocol === 'file:') {
    setStatus('Open the app with a local server, then try again.');
    return;
  }

  localStorage.setItem(storage.clientId, state.clientId);
  const verifier = generateCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  const stateToken = createRandomString(24);
  const redirectUri = getRedirectUri();

  localStorage.setItem(storage.verifier, verifier);

  const authUrl = new URL(SPOTIFY_AUTH_URL);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: state.clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: stateToken,
  }).toString();

  window.location.assign(authUrl.toString());
}

async function completeLogin(code) {
  if (!state.clientId) {
    throw new Error('Missing Spotify client ID.');
  }

  const verifier = localStorage.getItem(storage.verifier);
  if (!verifier) {
    throw new Error('Missing PKCE verifier. Start the login flow again.');
  }

  const redirectUri = getRedirectUri();

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    throw new Error('Spotify did not accept the authorization code.');
  }

  const tokenData = await response.json();
  persistTokenData(tokenData);
  cleanupOAuthParams();
  renderAuthState();
  setStatus('Spotify connected. Loading your profile...');
  await loadProfile();
}

function persistTokenData(tokenData) {
  state.accessToken = tokenData.access_token;
  state.refreshToken = tokenData.refresh_token || state.refreshToken;
  state.expiresAt = Date.now() + tokenData.expires_in * 1000;

  localStorage.setItem(storage.accessToken, state.accessToken);
  if (state.refreshToken) {
    localStorage.setItem(storage.refreshToken, state.refreshToken);
  }
  localStorage.setItem(storage.expiresAt, String(state.expiresAt));
}

async function loadProfile() {
  if (!state.accessToken) {
    return;
  }

  const profile = await spotifyFetch(`${SPOTIFY_API_BASE}/me`);
  state.profile = profile;
  localStorage.setItem(storage.profile, JSON.stringify(profile));
  renderProfile(profile);
  setStatus(`Connected as ${profile.display_name || profile.id}. Search to explore Spotify content.`);
  loadFeaturedSongs().catch(() => {
    setStatus(`Connected as ${profile.display_name || profile.id}. Search to explore Spotify content.`);
  });
}

async function loadFeaturedSongs() {
  if (!state.accessToken) {
    return;
  }

  const url = new URL(`${SPOTIFY_API_BASE}/search`);
  url.search = new URLSearchParams({
    q: 'top hits',
    type: 'track',
    limit: '6',
  }).toString();

  const data = await spotifyFetch(url.toString());
  const tracks = data.tracks?.items || [];
  elements.featuredCount.textContent = `${tracks.length} song${tracks.length === 1 ? '' : 's'}`;
  renderCards(elements.featuredResults, tracks, 'track');
}

async function searchSpotify(query) {
  if (!query) {
    setStatus('Enter a search term first.');
    return;
  }

  if (!state.accessToken) {
    setStatus('Connect Spotify first, then search.');
    return;
  }

  setBusy(true);
  setStatus(`Searching for "${query}"...`);

  try {
    const url = new URL(`${SPOTIFY_API_BASE}/search`);
    url.search = new URLSearchParams({
      q: query,
      type: 'track,artist,album',
      limit: '8',
    }).toString();

    const data = await spotifyFetch(url.toString());
    renderSearchResults(data);
    setStatus(`Showing Spotify results for "${query}".`);
  } finally {
    setBusy(false);
  }
}

function renderSearchResults(data) {
  const tracks = data.tracks?.items || [];
  const artists = data.artists?.items || [];
  const albums = data.albums?.items || [];

  elements.trackCount.textContent = `${tracks.length} result${tracks.length === 1 ? '' : 's'}`;
  elements.artistCount.textContent = `${artists.length} result${artists.length === 1 ? '' : 's'}`;
  elements.albumCount.textContent = `${albums.length} result${albums.length === 1 ? '' : 's'}`;

  renderCards(elements.trackResults, tracks, 'track');
  renderCards(elements.artistResults, artists, 'artist');
  renderCards(elements.albumResults, albums, 'album');
}

function renderCards(container, items, type) {
  if (!items.length) {
    container.innerHTML = '<div class="empty-state">No results yet. Try a different search.</div>';
    return;
  }

  container.innerHTML = items.map((item) => createCardMarkup(item, type)).join('');
}

function createCardMarkup(item, type) {
  const image = getItemImage(item, type);
  const title = escapeHtml(item.name || 'Untitled');
  const subtitle = escapeHtml(getSubtitle(item, type));
  const details = escapeHtml(getDetailLine(item, type));

  return `
    <article class="card">
      <img src="${image}" alt="${title}">
      <div>
        <h4>${title}</h4>
        <p>${subtitle}</p>
        <span class="badge">${details}</span>
      </div>
    </article>
  `;
}

function getItemImage(item, type) {
  if (type === 'track') {
    return item.album?.images?.[0]?.url || placeholderImage();
  }

  return item.images?.[0]?.url || placeholderImage();
}

function getSubtitle(item, type) {
  if (type === 'track') {
    return `${item.artists?.map((artist) => artist.name).join(', ') || 'Unknown artist'} · ${item.album?.name || 'Unknown album'}`;
  }

  if (type === 'artist') {
    const genres = item.genres?.slice(0, 2).join(', ');
    return genres || `${formatNumber(item.followers?.total || 0)} followers`;
  }

  return `${item.artists?.map((artist) => artist.name).join(', ') || 'Unknown artist'} · ${item.release_date || 'Release date unavailable'}`;
}

function getDetailLine(item, type) {
  if (type === 'track') {
    return `${formatDuration(item.duration_ms)} · ${formatNumber(item.popularity || 0)} popularity`;
  }

  if (type === 'artist') {
    return `${formatNumber(item.followers?.total || 0)} followers · ${formatNumber(item.popularity || 0)} popularity`;
  }

  return `${item.total_tracks || 0} tracks · ${formatDate(item.release_date)}`;
}

async function spotifyFetch(url, options = {}) {
  await ensureValidToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401 && state.refreshToken) {
    await refreshAccessToken();
    return spotifyFetch(url, options);
  }

  if (!response.ok) {
    throw new Error(`Spotify request failed with status ${response.status}.`);
  }

  return response.json();
}

async function ensureValidToken() {
  if (hasValidToken()) {
    return;
  }

  if (!state.refreshToken) {
    throw new Error('Your Spotify session expired. Connect again to continue.');
  }

  await refreshAccessToken();
}

async function refreshAccessToken() {
  if (!state.clientId || !state.refreshToken) {
    throw new Error('Cannot refresh Spotify session.');
  }

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.clientId,
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error('Spotify session refresh failed.');
  }

  const tokenData = await response.json();
  persistTokenData(tokenData);
  renderAuthState();
}

function renderProfile(profile) {
  if (!profile) {
    elements.profileAvatar.textContent = 'S';
    elements.profileName.textContent = 'No account connected';
    elements.profileMeta.textContent = 'Authorize to load your Spotify profile.';
    return;
  }

  elements.profileAvatar.textContent = (profile.display_name || profile.id || 'S').charAt(0).toUpperCase();
  elements.profileName.textContent = profile.display_name || profile.id || 'Spotify user';
  elements.profileMeta.textContent = `${profile.product || 'Free'} account · ${profile.country || 'Unknown region'} · ${formatNumber(profile.followers?.total || 0)} followers`;
}

function logout() {
  state.accessToken = '';
  state.refreshToken = '';
  state.expiresAt = 0;
  state.profile = null;

  [storage.accessToken, storage.refreshToken, storage.expiresAt, storage.profile, storage.verifier].forEach((key) => {
    localStorage.removeItem(key);
  });

  renderAuthState();
  renderProfile(null);
  setStatus('Disconnected.');
  clearResults();
  clearFeaturedSongs();
}

function clearResults() {
  elements.trackResults.innerHTML = '';
  elements.artistResults.innerHTML = '';
  elements.albumResults.innerHTML = '';
  elements.trackCount.textContent = '0 results';
  elements.artistCount.textContent = '0 results';
  elements.albumCount.textContent = '0 results';
}

function clearFeaturedSongs() {
  elements.featuredResults.innerHTML = '';
  elements.featuredCount.textContent = '0 songs';
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.loginBtn.disabled = isBusy;
  elements.logoutBtn.disabled = isBusy || !hasValidToken();
  elements.searchInput.disabled = isBusy;
}

function setStatus(message) {
  elements.statusBar.textContent = message;
}

function cleanupOAuthParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  window.history.replaceState({}, document.title, url.pathname + url.hash);
  localStorage.removeItem(storage.verifier);
}

function getRedirectUri() {
  if (window.location.protocol === 'file:') {
    return '';
  }

  return `${window.location.origin}${window.location.pathname}`;
}

function loadProfileCache() {
  const cached = localStorage.getItem(storage.profile);
  if (!cached) {
    return null;
  }

  try {
    return JSON.parse(cached);
  } catch {
    return null;
  }
}

function generateCodeVerifier() {
  return createRandomString(96);
}

function createRandomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (value) => alphabet(value % alphabet.length)).join('');
}

function alphabet(index) {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'.charAt(index);
}

async function createCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes) {
  let string = '';
  bytes.forEach((byte) => {
    string += String.fromCharCode(byte);
  });

  return btoa(string)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function placeholderImage() {
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop stop-color="#1db954" offset="0%" />
          <stop stop-color="#0b1712" offset="100%" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="26" fill="url(#g)"/>
      <circle cx="60" cy="60" r="24" fill="rgba(255,255,255,0.16)"/>
      <path d="M46 47h28v6H46zm0 15h22v6H46zm0 15h14v6H46z" fill="white" fill-opacity="0.7"/>
    </svg>
  `);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatDate(value) {
  if (!value) {
    return 'Unknown date';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cleanupSearchResultsIfEmpty() {
  if (!elements.trackResults.innerHTML) {
    clearResults();
  }
}