const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-modify-private',
  'playlist-modify-public',
];

const SPOTIFY_STORAGE_KEYS = {
  token: 'musicdigger.spotify.token',
  verifier: 'musicdigger.spotify.verifier',
  state: 'musicdigger.spotify.state',
};

const spotifyConfig = {
  clientId: window.SPOTIFY_CONFIG?.clientId ?? '',
  redirectUri: window.SPOTIFY_CONFIG?.redirectUri ?? getDefaultRedirectUri(),
  scopes: window.SPOTIFY_CONFIG?.scopes ?? SPOTIFY_SCOPES,
};

const state = {
  genres: [],
  filteredGenres: [],
  currentGenreId: null,
  isDarkMode: true,
  spotify: {
    configured: isSpotifyConfigured(),
    accessToken: null,
    refreshToken: null,
    expiresAt: 0,
    profile: null,
    playlists: [],
    likedTracks: [],
    likedTrackKeys: new Set(),
    trackUriCache: new Map(),
  },
};

const elements = {
  body: document.body,
  genreList: document.getElementById('genre-list'),
  genreTitle: document.getElementById('genre-title'),
  genreDesc: document.getElementById('genre-desc'),
  trackList: document.getElementById('track-list'),
  subgenres: document.getElementById('subgenres'),
  similar: document.getElementById('similar'),
  fusion: document.getElementById('fusion'),
  genreCount: document.getElementById('genre-count'),
  trackCount: document.getElementById('track-count'),
  relationCount: document.getElementById('relation-count'),
  searchStatus: document.getElementById('search-status'),
  heroSearchStatus: document.getElementById('hero-search-status'),
  heroTag: document.getElementById('hero-tag'),
  currentGenreChip: document.getElementById('current-genre-chip'),
  searchInput: document.getElementById('genre-search'),
  menuToggle: document.getElementById('menu-toggle'),
  menuPanel: document.getElementById('menu-panel'),
  menuHome: document.getElementById('menu-home'),
  menuRandom: document.getElementById('menu-random'),
  menuSearch: document.getElementById('menu-search'),
  heroTheme: document.getElementById('hero-theme'),
  sidebarRandom: document.getElementById('sidebar-random'),
  playerTrackTitle: document.getElementById('player-track-title'),
  playerTrackArtist: document.getElementById('player-track-artist'),
  playerBarTitle: document.getElementById('player-bar-title'),
  playerBarSubtitle: document.getElementById('player-bar-subtitle'),
  navHome: document.getElementById('nav-home'),
  navLibrary: document.getElementById('nav-library'),
  navPlaylists: document.getElementById('nav-playlists'),
  navLiked: document.getElementById('nav-liked'),
  navSearch: document.getElementById('nav-search'),
  profileSlot: document.getElementById('profile-slot'),
  profileAvatar: document.getElementById('profile-avatar'),
  spotifyLibrary: document.getElementById('spotify-library'),
  spotifyAuthButton: document.getElementById('spotify-auth-button'),
  spotifyRefreshButton: document.getElementById('spotify-refresh-button'),
  spotifyProfileCard: document.getElementById('spotify-profile-card'),
  playlistList: document.getElementById('playlist-list'),
  likedTrackList: document.getElementById('liked-track-list'),
  playlistModal: document.getElementById('playlist-modal'),
  playlistModalClose: document.getElementById('playlist-modal-close'),
  playlistForm: document.getElementById('playlist-form'),
  playlistName: document.getElementById('playlist-name'),
  playlistDescription: document.getElementById('playlist-description'),
  playlistPrivate: document.getElementById('playlist-private'),
  playlistSubmit: document.getElementById('playlist-submit'),
};

void initialize();

async function initialize() {
  bindEvents();
  updateThemeUI();
  renderSpotifyState();
  loadGenres();
  await initializeSpotify();
}

function bindEvents() {
  addClick(elements.menuToggle, () => {
    const willOpen = !elements.menuPanel.classList.contains('is-open');
    setMenuOpen(willOpen);
  });

  addClick(elements.menuHome, () => {
    focusHome();
    setActiveNav(elements.navHome);
    setMenuOpen(false);
  });

  addClick(elements.menuRandom, () => {
    showRandomGenre();
    setMenuOpen(false);
  });

  addClick(elements.menuSearch, () => {
    elements.searchInput.focus();
    setActiveNav(elements.navSearch);
    setMenuOpen(false);
  });

  addClick(elements.sidebarRandom, showRandomGenre);
  addClick(elements.heroTheme, toggleTheme);
  addClick(elements.navHome, () => {
    focusHome();
    setActiveNav(elements.navHome);
  });
  addClick(elements.navLibrary, () => {
    focusSection(elements.spotifyLibrary);
    setActiveNav(elements.navLibrary);
  });
  addClick(elements.navPlaylists, () => {
    void handlePlaylistNav();
  });
  addClick(elements.navLiked, () => {
    focusSection(elements.spotifyLibrary);
    setActiveNav(elements.navLiked);
  });
  addClick(elements.navSearch, () => {
    elements.searchInput.focus();
    setActiveNav(elements.navSearch);
  });
  addClick(elements.profileSlot, () => {
    if (state.spotify.accessToken) {
      focusSection(elements.spotifyLibrary);
      setActiveNav(elements.navLibrary);
      return;
    }

    void loginToSpotify();
  });
  addClick(elements.spotifyAuthButton, () => {
    void handleSpotifyAuthButton();
  });
  addClick(elements.spotifyRefreshButton, () => {
    void syncSpotifyData();
  });
  addClick(elements.playlistModalClose, closePlaylistModal);
  addClick(elements.playlistModal, event => {
    if (event.target.dataset.closeModal === 'true') {
      closePlaylistModal();
    }
  });

  elements.searchInput.addEventListener('input', event => {
    applySearch(event.target.value);
  });

  elements.playlistForm.addEventListener('submit', event => {
    event.preventDefault();
    void submitPlaylistForm();
  });

  document.addEventListener('click', event => {
    const clickedInsideMenu = elements.menuPanel.contains(event.target);
    const clickedToggle = elements.menuToggle.contains(event.target);

    if (!clickedInsideMenu && !clickedToggle) {
      setMenuOpen(false);
    }
  });
}

async function initializeSpotify() {
  hydrateSpotifyToken();
  await handleSpotifyCallback();

  if (state.spotify.accessToken) {
    await syncSpotifyData();
  } else {
    renderSpotifyState();
  }
}

function loadGenres() {
  fetch('data/genres.json')
    .then(response => response.json())
    .then(data => {
      state.genres = data.genres ?? [];
      state.filteredGenres = [...state.genres];

      elements.genreCount.textContent = String(state.genres.length);
      updateSearchStatus('');
      renderGenreList();

      if (state.filteredGenres.length > 0) {
        showGenre(state.filteredGenres[0].id);
      }
    })
    .catch(() => {
      elements.genreList.innerHTML =
        '<div class="empty-state">장르 데이터를 불러오지 못했습니다. 파일 경로를 확인해주세요.</div>';
    });
}

function applySearch(query) {
  const keyword = query.trim().toLowerCase();

  state.filteredGenres = state.genres.filter(genre => {
    const trackText = genre.tracks
      .map(track => `${track.title} ${track.artist}`)
      .join(' ')
      .toLowerCase();

    return `${genre.name} ${genre.description} ${trackText}`.toLowerCase().includes(keyword);
  });

  updateSearchStatus(keyword);
  renderGenreList();

  if (state.filteredGenres.length === 0) {
    renderEmptyGenre();
    return;
  }

  const currentVisible = state.filteredGenres.some(
    genre => genre.id === state.currentGenreId,
  );

  if (!currentVisible) {
    showGenre(state.filteredGenres[0].id);
  }
}

function updateSearchStatus(keyword) {
  const message = keyword ? `${state.filteredGenres.length} Results` : 'All Results';
  elements.searchStatus.textContent = message;
  elements.heroSearchStatus.textContent = message;
}

function renderGenreList() {
  elements.genreList.innerHTML = '';

  if (state.filteredGenres.length === 0) {
    elements.genreList.innerHTML =
      '<div class="empty-state">검색 결과가 없습니다. 다른 키워드로 다시 찾아보세요.</div>';
    return;
  }

  state.filteredGenres.forEach((genre, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'genre-card';

    if (genre.id === state.currentGenreId) {
      button.classList.add('is-active');
    }

    button.innerHTML = `
      <div class="genre-card-content">
        <span class="genre-index">${String(index + 1).padStart(2, '0')}</span>
        <h4>${genre.name}</h4>
        <p>${genre.description}</p>
        <span class="genre-meta">${genre.tracks.length} tracks ready</span>
      </div>
    `;

    button.addEventListener('click', () => showGenre(genre.id));
    elements.genreList.appendChild(button);
  });
}

function showGenre(id) {
  const genre = state.genres.find(item => item.id === id);

  if (!genre) {
    return;
  }

  state.currentGenreId = genre.id;

  const relationTotal =
    genre.subgenres.length + genre.similar.length + genre.fusion.length;
  const leadTrack = genre.tracks[0];

  elements.genreTitle.textContent = genre.name;
  elements.genreDesc.textContent = genre.description;
  elements.heroTag.textContent = `${genre.name} Focus`;
  elements.currentGenreChip.textContent = genre.name;
  elements.trackCount.textContent = String(genre.tracks.length);
  elements.relationCount.textContent = String(relationTotal);
  elements.playerTrackTitle.textContent = leadTrack ? leadTrack.title : 'No track available';
  elements.playerTrackArtist.textContent = leadTrack
    ? `${leadTrack.artist} · ${genre.name}`
    : 'Track information will appear here.';
  elements.playerBarTitle.textContent = leadTrack ? leadTrack.title : genre.name;
  elements.playerBarSubtitle.textContent = leadTrack
    ? `${leadTrack.artist} · ${genre.name}`
    : 'MUSICDIGGER queue';

  renderGenreList();
  renderTracks(genre.tracks);
  renderButtons(elements.subgenres, genre.subgenres);
  renderButtons(elements.similar, genre.similar);
  renderButtons(elements.fusion, genre.fusion);
}

function renderTracks(tracks) {
  elements.trackList.innerHTML = '';

  if (!tracks.length) {
    elements.trackList.innerHTML =
      '<li class="empty-state">대표 트랙이 아직 등록되지 않았습니다.</li>';
    return;
  }

  tracks.forEach((track, index) => {
    const trackKey = makeTrackKey(track);
    const saved = state.spotify.likedTrackKeys.has(trackKey);
    const item = document.createElement('li');

    item.innerHTML = `
      <span class="track-order">${String(index + 1).padStart(2, '0')}</span>
      <div>
        <span class="track-title">${track.title}</span>
        <span class="track-artist">${track.artist}</span>
      </div>
      <span class="track-duration">${makeDuration(index)}</span>
      <button class="track-action${saved ? ' is-saved' : ''}" type="button">
        ${saved ? 'Liked' : 'Like'}
      </button>
    `;

    const action = item.querySelector('.track-action');
    action.addEventListener('click', () => {
      void likeTrack(track, action);
    });

    elements.trackList.appendChild(item);
  });
}

function renderButtons(container, ids) {
  container.innerHTML = '';

  if (!ids.length) {
    container.innerHTML = '<div class="empty-state">연결된 장르가 아직 없습니다.</div>';
    return;
  }

  ids.forEach(id => {
    const genre = state.genres.find(item => item.id === id);

    if (!genre) {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pill-btn';
    button.textContent = genre.name;
    button.addEventListener('click', () => showGenre(genre.id));
    container.appendChild(button);
  });
}

function renderEmptyGenre() {
  state.currentGenreId = null;
  elements.genreTitle.textContent = '검색 결과가 없습니다';
  elements.genreDesc.textContent = '다른 키워드로 장르, 분위기, 트랙 이름을 다시 찾아보세요.';
  elements.heroTag.textContent = 'Search Empty';
  elements.currentGenreChip.textContent = 'No Match';
  elements.trackCount.textContent = '0';
  elements.relationCount.textContent = '0';
  elements.playerTrackTitle.textContent = 'No track available';
  elements.playerTrackArtist.textContent = 'Track information will appear here.';
  elements.playerBarTitle.textContent = 'No results';
  elements.playerBarSubtitle.textContent = 'Try another search';
  elements.trackList.innerHTML = '<li class="empty-state">표시할 트랙이 없습니다.</li>';
  elements.subgenres.innerHTML = '<div class="empty-state">표시할 결과가 없습니다.</div>';
  elements.similar.innerHTML = '<div class="empty-state">표시할 결과가 없습니다.</div>';
  elements.fusion.innerHTML = '<div class="empty-state">표시할 결과가 없습니다.</div>';
}

function showRandomGenre() {
  if (state.filteredGenres.length === 0) {
    return;
  }

  const randomGenre =
    state.filteredGenres[Math.floor(Math.random() * state.filteredGenres.length)];

  showGenre(randomGenre.id);
}

function focusHome() {
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (state.filteredGenres.length > 0) {
    showGenre(state.filteredGenres[0].id);
  }
}

function focusSection(element) {
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function toggleTheme() {
  state.isDarkMode = !state.isDarkMode;
  updateThemeUI();
}

function setMenuOpen(isOpen) {
  elements.menuPanel.classList.toggle('is-open', isOpen);
  elements.menuPanel.setAttribute('aria-hidden', String(!isOpen));
  elements.menuToggle.setAttribute('aria-expanded', String(isOpen));
}

function updateThemeUI() {
  const themeClass = state.isDarkMode ? 'theme-dark' : 'theme-light';
  const oldThemeClass = state.isDarkMode ? 'theme-light' : 'theme-dark';

  elements.body.classList.remove(oldThemeClass);
  elements.body.classList.add(themeClass);

  if (elements.heroTheme) {
    elements.heroTheme.textContent = state.isDarkMode ? 'Light Mode' : 'Dark Mode';
  }
}

function makeDuration(index) {
  const minutes = 3 + (index % 3);
  const seconds = 10 + index * 17;
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function addClick(element, handler) {
  if (element) {
    element.addEventListener('click', handler);
  }
}

function setActiveNav(target) {
  [
    elements.navHome,
    elements.navLibrary,
    elements.navPlaylists,
    elements.navLiked,
    elements.navSearch,
  ].forEach(button => {
    button?.classList.toggle('is-current', button === target);
  });
}

async function handlePlaylistNav() {
  setActiveNav(elements.navPlaylists);

  if (!(await ensureSpotifyReady(true))) {
    return;
  }

  openPlaylistModal();
}

async function handleSpotifyAuthButton() {
  if (!state.spotify.accessToken) {
    await loginToSpotify();
    return;
  }

  await syncSpotifyData();
}

function openPlaylistModal() {
  elements.playlistModal.classList.add('is-open');
  elements.playlistModal.setAttribute('aria-hidden', 'false');
  elements.playlistName.focus();
}

function closePlaylistModal() {
  elements.playlistModal.classList.remove('is-open');
  elements.playlistModal.setAttribute('aria-hidden', 'true');
  elements.playlistForm.reset();
}

async function submitPlaylistForm() {
  if (!(await ensureSpotifyReady(true))) {
    return;
  }

  const submitButton = elements.playlistSubmit;
  submitButton.disabled = true;
  submitButton.textContent = 'Creating...';

  try {
    const name = elements.playlistName.value.trim();
    const description = elements.playlistDescription.value.trim();
    const isPrivate = elements.playlistPrivate.checked;

    const playlist = await spotifyRequest('/me/playlists', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        public: !isPrivate,
      }),
    });

    const uris = await getCurrentGenreSpotifyUris();

    if (uris.length > 0) {
      await spotifyRequest(`/playlists/${playlist.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris }),
      });
    }

    closePlaylistModal();
    await syncSpotifyData();
    focusSection(elements.spotifyLibrary);
    setActiveNav(elements.navLibrary);
  } catch (error) {
    updateSpotifyMessage(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Create';
  }
}

async function likeTrack(track, button) {
  if (!(await ensureSpotifyReady(true))) {
    return;
  }

  button.disabled = true;

  try {
    const uri = await resolveTrackUri(track);

    if (!uri) {
      throw new Error('Spotify에서 이 곡을 찾지 못했습니다.');
    }

    await spotifyRequest('/me/library', {
      method: 'PUT',
      body: JSON.stringify({ uris: [uri] }),
    });

    state.spotify.likedTrackKeys.add(makeTrackKey(track));
    button.textContent = 'Liked';
    button.classList.add('is-saved');
    await syncLikedTracks();
  } catch (error) {
    updateSpotifyMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

async function syncSpotifyData() {
  if (!(await ensureSpotifyReady(false))) {
    renderSpotifyState();
    return;
  }

  try {
    const [profile, playlists, liked] = await Promise.all([
      spotifyRequest('/me'),
      spotifyRequest('/me/playlists?limit=8'),
      spotifyRequest('/me/tracks?limit=8'),
    ]);

    state.spotify.profile = profile;
    state.spotify.playlists = playlists.items ?? [];
    state.spotify.likedTracks = (liked.items ?? []).map(item => item.track).filter(Boolean);
    state.spotify.likedTrackKeys = new Set(
      state.spotify.likedTracks.map(track => makeTrackKeyFromSpotify(track)),
    );

    renderSpotifyState();
    renderTracksForCurrentGenre();
  } catch (error) {
    updateSpotifyMessage(error.message);
  }
}

async function syncLikedTracks() {
  if (!state.spotify.accessToken) {
    return;
  }

  try {
    const liked = await spotifyRequest('/me/tracks?limit=8');
    state.spotify.likedTracks = (liked.items ?? []).map(item => item.track).filter(Boolean);
    state.spotify.likedTrackKeys = new Set(
      state.spotify.likedTracks.map(track => makeTrackKeyFromSpotify(track)),
    );
    renderLikedTracks();
    renderTracksForCurrentGenre();
  } catch (error) {
    updateSpotifyMessage(error.message);
  }
}

function renderTracksForCurrentGenre() {
  if (!state.currentGenreId) {
    return;
  }

  const genre = state.genres.find(item => item.id === state.currentGenreId);

  if (genre) {
    renderTracks(genre.tracks);
  }
}

function renderSpotifyState() {
  renderProfileCard();
  renderPlaylistList();
  renderLikedTracks();
  updateProfileSlot();
  elements.spotifyRefreshButton.disabled = !state.spotify.accessToken;

  if (!state.spotify.configured) {
    elements.spotifyAuthButton.textContent = 'Setup Needed';
    elements.spotifyRefreshButton.disabled = true;
    return;
  }

  elements.spotifyAuthButton.textContent = state.spotify.accessToken
    ? 'Refresh Library'
    : 'Connect Spotify';
}

function renderProfileCard() {
  if (!state.spotify.configured) {
    updateSpotifyMessage(
      'spotify-config.js 파일에 Spotify Client ID를 넣어야 연결할 수 있습니다.',
    );
    return;
  }

  if (!state.spotify.profile) {
    updateSpotifyMessage(
      'Spotify에 로그인하면 프로필과 플레이리스트를 여기서 불러옵니다.',
    );
    return;
  }

  const imageUrl = state.spotify.profile.images?.[0]?.url;
  const product = state.spotify.profile.product ?? 'spotify';

  elements.spotifyProfileCard.innerHTML = `
    <div class="spotify-profile">
      ${
        imageUrl
          ? `<img class="spotify-profile-image" src="${imageUrl}" alt="Spotify profile">`
          : `<div class="spotify-profile-fallback">${getProfileInitial()}</div>`
      }
      <div>
        <strong>${state.spotify.profile.display_name ?? 'Spotify User'}</strong>
        <p>${product} account connected</p>
      </div>
    </div>
  `;
}

function renderPlaylistList() {
  if (!state.spotify.accessToken) {
    elements.playlistList.innerHTML =
      '<div class="empty-state">Playlists 메뉴를 누르면 Spotify 플레이리스트를 만들 수 있습니다.</div>';
    return;
  }

  if (state.spotify.playlists.length === 0) {
    elements.playlistList.innerHTML =
      '<div class="empty-state">Spotify 플레이리스트가 아직 없습니다.</div>';
    return;
  }

  elements.playlistList.innerHTML = '';

  state.spotify.playlists.forEach(playlist => {
    const item = document.createElement('article');
    item.className = 'playlist-item';
    const trackTotal = playlist.items?.total ?? playlist.tracks?.total ?? 0;

    item.innerHTML = `
      <strong>${playlist.name}</strong>
      <span>${trackTotal} tracks</span>
      <a class="playlist-link" href="${playlist.external_urls?.spotify ?? '#'}" target="_blank" rel="noreferrer">
        Open in Spotify
      </a>
    `;

    elements.playlistList.appendChild(item);
  });
}

function renderLikedTracks() {
  if (!state.spotify.accessToken) {
    elements.likedTrackList.innerHTML =
      '<div class="empty-state">Spotify에 로그인하면 좋아요한 곡을 여기서 확인할 수 있습니다.</div>';
    return;
  }

  if (state.spotify.likedTracks.length === 0) {
    elements.likedTrackList.innerHTML =
      '<div class="empty-state">좋아요한 Spotify 트랙이 아직 없습니다.</div>';
    return;
  }

  elements.likedTrackList.innerHTML = '';

  state.spotify.likedTracks.forEach(track => {
    const artist = track.artists?.map(item => item.name).join(', ') ?? 'Unknown Artist';
    const item = document.createElement('article');
    item.className = 'liked-track-item';

    item.innerHTML = `
      <strong>${track.name}</strong>
      <span>${artist}</span>
      <a class="liked-track-link" href="${track.external_urls?.spotify ?? '#'}" target="_blank" rel="noreferrer">
        Open in Spotify
      </a>
    `;

    elements.likedTrackList.appendChild(item);
  });
}

function updateProfileSlot() {
  const imageUrl = state.spotify.profile?.images?.[0]?.url;
  const displayName = state.spotify.profile?.display_name;

  elements.profileSlot.title = displayName ?? 'Spotify 로그인';
  elements.profileAvatar.style.backgroundImage = imageUrl ? `url("${imageUrl}")` : '';
  elements.profileAvatar.classList.toggle('has-image', Boolean(imageUrl));
}

function updateSpotifyMessage(message) {
  elements.spotifyProfileCard.innerHTML = `<div class="empty-state">${message}</div>`;
}

async function ensureSpotifyReady(promptLogin) {
  if (!state.spotify.configured) {
    updateSpotifyMessage(
      'spotify-config.js 파일에 Spotify Client ID를 넣은 뒤 다시 시도해주세요.',
    );
    return false;
  }

  if (!state.spotify.accessToken && promptLogin) {
    await loginToSpotify();
    return false;
  }

  if (!state.spotify.accessToken) {
    return false;
  }

  if (Date.now() > state.spotify.expiresAt - 60000) {
    await refreshSpotifyToken();
  }

  return Boolean(state.spotify.accessToken);
}

async function loginToSpotify() {
  if (!state.spotify.configured) {
    updateSpotifyMessage(
      'spotify-config.js 파일에 Spotify Client ID를 넣어야 Spotify 로그인이 동작합니다.',
    );
    return;
  }

  const stateValue = createRandomString(16);
  const verifier = createRandomString(64);
  const challenge = await generateCodeChallenge(verifier);
  const params = new URLSearchParams({
    client_id: spotifyConfig.clientId,
    response_type: 'code',
    redirect_uri: spotifyConfig.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: stateValue,
    scope: spotifyConfig.scopes.join(' '),
  });

  localStorage.setItem(SPOTIFY_STORAGE_KEYS.verifier, verifier);
  localStorage.setItem(SPOTIFY_STORAGE_KEYS.state, stateValue);
  window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
}

async function handleSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const error = params.get('error');

  if (error) {
    updateSpotifyMessage(`Spotify 로그인 중 오류가 발생했습니다: ${error}`);
    clearSpotifyQueryParams();
    return;
  }

  if (!code) {
    return;
  }

  const expectedState = localStorage.getItem(SPOTIFY_STORAGE_KEYS.state);
  const verifier = localStorage.getItem(SPOTIFY_STORAGE_KEYS.verifier);

  if (!expectedState || expectedState !== returnedState || !verifier) {
    updateSpotifyMessage('Spotify 인증 상태를 확인하지 못했습니다. 다시 로그인해주세요.');
    clearSpotifyQueryParams();
    return;
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: spotifyConfig.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: spotifyConfig.redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    updateSpotifyMessage('Spotify 토큰 교환에 실패했습니다.');
    clearSpotifyQueryParams();
    return;
  }

  const token = await response.json();
  saveSpotifyToken(token);
  clearSpotifyQueryParams();
  localStorage.removeItem(SPOTIFY_STORAGE_KEYS.verifier);
  localStorage.removeItem(SPOTIFY_STORAGE_KEYS.state);
}

function hydrateSpotifyToken() {
  const raw = localStorage.getItem(SPOTIFY_STORAGE_KEYS.token);

  if (!raw) {
    return;
  }

  try {
    const token = JSON.parse(raw);
    state.spotify.accessToken = token.accessToken ?? null;
    state.spotify.refreshToken = token.refreshToken ?? null;
    state.spotify.expiresAt = token.expiresAt ?? 0;
  } catch {
    localStorage.removeItem(SPOTIFY_STORAGE_KEYS.token);
  }
}

async function refreshSpotifyToken() {
  if (!state.spotify.refreshToken) {
    return;
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: spotifyConfig.clientId,
      grant_type: 'refresh_token',
      refresh_token: state.spotify.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error('Spotify 토큰을 갱신하지 못했습니다.');
  }

  const token = await response.json();
  saveSpotifyToken(token);
}

function saveSpotifyToken(token) {
  state.spotify.accessToken = token.access_token ?? state.spotify.accessToken;
  state.spotify.refreshToken = token.refresh_token ?? state.spotify.refreshToken;
  state.spotify.expiresAt = Date.now() + (token.expires_in ?? 0) * 1000;

  localStorage.setItem(
    SPOTIFY_STORAGE_KEYS.token,
    JSON.stringify({
      accessToken: state.spotify.accessToken,
      refreshToken: state.spotify.refreshToken,
      expiresAt: state.spotify.expiresAt,
    }),
  );
}

async function spotifyRequest(path, init = {}) {
  await ensureSpotifyReady(false);

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${state.spotify.accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const error = await safeJson(response);
    throw new Error(error?.error?.message ?? 'Spotify 요청에 실패했습니다.');
  }

  return response.json();
}

async function resolveTrackUri(track) {
  const trackKey = makeTrackKey(track);

  if (state.spotify.trackUriCache.has(trackKey)) {
    return state.spotify.trackUriCache.get(trackKey);
  }

  const query = encodeURIComponent(`track:${track.title} artist:${track.artist}`);
  const result = await spotifyRequest(`/search?q=${query}&type=track&limit=1`);
  const uri = result?.tracks?.items?.[0]?.uri ?? null;

  state.spotify.trackUriCache.set(trackKey, uri);
  return uri;
}

async function getCurrentGenreSpotifyUris() {
  const genre = state.genres.find(item => item.id === state.currentGenreId);

  if (!genre) {
    return [];
  }

  const candidates = await Promise.all(
    genre.tracks.slice(0, 5).map(track => resolveTrackUri(track)),
  );

  return candidates.filter(Boolean);
}

function makeTrackKey(track) {
  return `${track.title}::${track.artist}`.toLowerCase();
}

function makeTrackKeyFromSpotify(track) {
  const artist = track.artists?.[0]?.name ?? '';
  return `${track.name}::${artist}`.toLowerCase();
}

function getProfileInitial() {
  return state.spotify.profile?.display_name?.trim()?.[0]?.toUpperCase() ?? 'S';
}

function clearSpotifyQueryParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  window.history.replaceState({}, document.title, url.pathname + url.search);
}

function getDefaultRedirectUri() {
  if (window.location.origin === 'null') {
    return '';
  }

  return `${window.location.origin}${window.location.pathname}`;
}

function isSpotifyConfigured() {
  return Boolean(
    spotifyConfig.clientId &&
    spotifyConfig.clientId !== 'YOUR_SPOTIFY_CLIENT_ID' &&
    spotifyConfig.redirectUri,
  );
}

function createRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => chars[byte % chars.length]).join('');
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
