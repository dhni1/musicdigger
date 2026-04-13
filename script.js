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

const DEFAULT_VISIBLE_GENRES = 4;

const BUILTIN_GENRES = [
  {
    id: 'hiphop',
    name: 'Hip-Hop',
    description: '리듬과 랩 중심의 장르',
    subgenres: ['jazz-hiphop', 'trap'],
    similar: ['rnb'],
    fusion: ['boom-bap'],
    tracks: [
      { title: 'SICKO MODE', artist: 'Travis Scott' },
      { title: 'HUMBLE.', artist: 'Kendrick Lamar' },
      { title: "God's Plan", artist: 'Drake' },
      { title: 'In Da Club', artist: '50 Cent' },
      { title: 'Lose Yourself', artist: 'Eminem' },
      { title: 'Stronger', artist: 'Kanye West' },
      { title: 'Empire State Of Mind', artist: 'JAY-Z feat. Alicia Keys' },
      { title: 'Hot In Herre', artist: 'Nelly' },
    ],
  },
  {
    id: 'jazz-hiphop',
    name: 'Jazz Hip-Hop',
    description: '재즈 화성과 힙합 비트가 결합된 부드러운 그루브',
    subgenres: [],
    similar: ['lofi'],
    fusion: [],
    tracks: [
      { title: 'Feather', artist: 'Nujabes' },
      { title: 'Luv(sic.) pt3', artist: 'Nujabes' },
      { title: 'Aruarian Dance', artist: 'Nujabes' },
      { title: 'Rebirth of Slick (Cool Like Dat)', artist: 'Digable Planets' },
      { title: 'Electric Relaxation', artist: 'A Tribe Called Quest' },
      { title: 'Award Tour', artist: 'A Tribe Called Quest' },
      { title: "Runnin'", artist: 'The Pharcyde' },
      { title: 'Passing Me By', artist: 'The Pharcyde' },
    ],
  },
  {
    id: 'trap',
    name: 'Trap',
    description: '강한 베이스와 하이햇이 특징인 현대 힙합',
    subgenres: [],
    similar: ['hiphop'],
    fusion: [],
    tracks: [
      { title: 'Mask Off', artist: 'Future' },
      { title: 'goosebumps', artist: 'Travis Scott' },
      { title: 'Bad and Boujee', artist: 'Migos feat. Lil Uzi Vert' },
      { title: 'XO TOUR Llif3', artist: 'Lil Uzi Vert' },
      { title: 'Life Is Good', artist: 'Future feat. Drake' },
      { title: 'pick up the phone', artist: 'Young Thug & Travis Scott feat. Quavo' },
      { title: 'Drip Too Hard', artist: 'Lil Baby & Gunna' },
      { title: 'FE!N', artist: 'Travis Scott feat. Playboi Carti' },
    ],
  },
  {
    id: 'boom-bap',
    name: 'Boom Bap',
    description: '킥과 스네어가 선명한 클래식 힙합 스타일',
    subgenres: [],
    similar: ['hiphop'],
    fusion: [],
    tracks: [
      { title: 'N.Y. State of Mind', artist: 'Nas' },
      { title: 'Mass Appeal', artist: 'Gang Starr' },
      { title: 'Shook Ones, Pt. II', artist: 'Mobb Deep' },
      { title: 'C.R.E.A.M.', artist: 'Wu-Tang Clan' },
      { title: 'Juicy', artist: 'The Notorious B.I.G.' },
      { title: 'The World Is Yours', artist: 'Nas' },
      { title: 'Protect Ya Neck', artist: 'Wu-Tang Clan' },
      { title: 'It Was A Good Day', artist: 'Ice Cube' },
    ],
  },
  {
    id: 'r-n-b',
    name: 'R&B',
    description: '보컬과 그루브 중심의 감각적인 장르',
    subgenres: [],
    similar: ['hiphop'],
    fusion: [],
    tracks: [
      { title: 'Blinding Lights', artist: 'The Weeknd' },
      { title: 'Location', artist: 'Khalid' },
      { title: 'Earned It', artist: 'The Weeknd' },
      { title: 'We Belong Together', artist: 'Mariah Carey' },
      { title: 'No Scrubs', artist: 'TLC' },
      { title: 'Say My Name', artist: "Destiny's Child" },
      { title: 'Adorn', artist: 'Miguel' },
      { title: 'U Remind Me', artist: 'Usher' },
    ],
  },
  {
    id: 'lofi',
    name: 'Lo-Fi',
    description: '편안하고 거친 질감의 비트 중심 장르',
    subgenres: [],
    similar: ['jazz-hiphop'],
    fusion: [],
    tracks: [
      { title: 'affection', artist: 'Jinsang' },
      { title: 'snowman', artist: 'WYS' },
      { title: 'day 7', artist: 'potsu' },
      { title: 'I wish it would never stop snowing', artist: 'sleepdealer' },
      { title: 'Luv Letter', artist: 'Jinsang' },
      { title: 'warm nights', artist: 'xander.' },
      { title: 'Monday Loop', artist: 'Tomppabeats' },
      { title: 'glow', artist: 'bsd.u' },
    ],
  },
];

const state = {
  genres: [],
  filteredGenres: [],
  currentGenreId: null,
  currentView: 'home',
  genreListExpanded: false,
  isDarkMode: true,
  searchQuery: '',
  usingBackendGenres: false,
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
  homeView: document.getElementById('home-view'),
  libraryView: document.getElementById('library-view'),
  profileView: document.getElementById('profile-view'),
  settingsView: document.getElementById('settings-view'),
  genreList: document.getElementById('genre-list'),
  genreToggle: document.getElementById('genre-toggle'),
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
  menuSettings: document.getElementById('menu-settings'),
  sidebarRandom: document.getElementById('sidebar-random'),
  playerTrackTitle: document.getElementById('player-track-title'),
  playerTrackArtist: document.getElementById('player-track-artist'),
  playerBarTitle: document.getElementById('player-bar-title'),
  playerBarSubtitle: document.getElementById('player-bar-subtitle'),
  navHome: document.getElementById('nav-home'),
  navLibrary: document.getElementById('nav-library'),
  navPlaylists: document.getElementById('nav-playlists'),
  navProfile: document.getElementById('nav-profile'),
  profileSlot: document.getElementById('profile-slot'),
  profileAvatar: document.getElementById('profile-avatar'),
  spotifyLibrary: document.getElementById('spotify-library'),
  spotifyAuthButton: document.getElementById('spotify-auth-button'),
  spotifyRefreshButton: document.getElementById('spotify-refresh-button'),
  spotifyProfileCard: document.getElementById('spotify-profile-card'),
  playlistSection: document.getElementById('playlist-section'),
  likedSection: document.getElementById('liked-section'),
  playlistList: document.getElementById('playlist-list'),
  likedTrackList: document.getElementById('liked-track-list'),
  profileScreenCard: document.getElementById('profile-screen-card'),
  profileSummary: document.getElementById('profile-summary'),
  profileSettingsBlock: document.getElementById('profile-settings-block'),
  profileThemeToggle: document.getElementById('profile-theme-toggle'),
  profileMoreSettings: document.getElementById('profile-more-settings'),
  profileSettingsNote: document.getElementById('profile-settings-note'),
  settingsThemeToggle: document.getElementById('settings-theme-toggle'),
  settingsOpenProfile: document.getElementById('settings-open-profile'),
  settingsOpenHome: document.getElementById('settings-open-home'),
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
  await Promise.all([loadGenres(), initializeSpotify()]);
}

function bindEvents() {
  addClick(elements.menuToggle, () => {
    setMenuOpen(!elements.menuPanel.classList.contains('is-open'));
  });

  addClick(elements.menuSettings, () => {
    openSettingsView();
    setMenuOpen(false);
  });

  addClick(elements.sidebarRandom, () => {
    void showRandomGenre();
  });
  addClick(elements.profileThemeToggle, toggleTheme);
  addClick(elements.profileMoreSettings, openSettingsView);
  addClick(elements.settingsThemeToggle, toggleTheme);
  addClick(elements.settingsOpenProfile, openProfileView);
  addClick(elements.settingsOpenHome, () => {
    focusHome();
    setActiveNav(elements.navHome);
  });
  addClick(elements.navHome, () => {
    focusHome();
    setActiveNav(elements.navHome);
  });
  addClick(elements.navLibrary, () => {
    openLibraryView(elements.navLibrary);
  });
  addClick(elements.navPlaylists, () => {
    handlePlaylistNav();
  });
  addClick(elements.navProfile, openProfileView);
  addClick(elements.profileSlot, () => {
    openProfileView();
  });
  addClick(elements.spotifyAuthButton, () => {
    void handleSpotifyAuthButton();
  });
  addClick(elements.spotifyRefreshButton, () => {
    void syncSpotifyData();
  });
  addClick(elements.genreToggle, () => {
    state.genreListExpanded = !state.genreListExpanded;
    renderGenreList();
    updateSearchStatus(buildSearchToken(state.searchQuery));
  });
  addClick(elements.playlistModalClose, closePlaylistModal);
  addClick(elements.playlistModal, event => {
    if (event.target.dataset.closeModal === 'true') {
      closePlaylistModal();
    }
  });

  elements.searchInput.addEventListener('input', event => {
    showView('home');
    setActiveNav(elements.navHome);
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

async function loadGenres() {
  try {
    const backendGenres = await fetchBackendGenres();
    state.genres = backendGenres;
    state.filteredGenres = [...backendGenres];
    state.usingBackendGenres = true;
  } catch {
    try {
      const response = await fetch('data/genres.json');
      const data = await response.json();
      state.genres = data.genres ?? [];
      state.filteredGenres = [...state.genres];
      state.usingBackendGenres = false;
    } catch {
      state.genres = BUILTIN_GENRES.map(genre => ({
        ...genre,
        subgenres: [...genre.subgenres],
        similar: [...genre.similar],
        fusion: [...genre.fusion],
        tracks: genre.tracks.map(track => ({ ...track })),
      }));
      state.filteredGenres = [...state.genres];
      state.usingBackendGenres = false;
      elements.searchStatus.textContent = 'Offline Fallback';
      elements.heroSearchStatus.textContent = 'Offline Fallback';
    }
  }

  elements.genreCount.textContent = String(state.genres.length);
  if (elements.searchStatus.textContent !== 'Offline Fallback') {
    updateSearchStatus(buildSearchToken(''));
  }
  renderGenreList();

  if (state.filteredGenres.length > 0) {
    await showGenre(state.filteredGenres[0].id);
  }
}

async function fetchBackendGenres() {
  const response = await fetch(`${window.APP_CONFIG.backendBaseUrl}/api/genres`);

  if (!response.ok) {
    throw new Error('backend unavailable');
  }

  const data = await response.json();
  return data.genres ?? [];
}

async function fetchGenreDetails(genreId) {
  const response = await fetch(`${window.APP_CONFIG.backendBaseUrl}/api/genre-details?genre=${encodeURIComponent(genreId)}`);

  if (!response.ok) {
    throw new Error('genre details unavailable');
  }

  const data = await response.json();
  return data.genre;
}

function applySearch(query) {
  state.searchQuery = query;
  const keyword = buildSearchToken(query);

  if (!keyword.normalized) {
    state.genreListExpanded = false;
    state.filteredGenres = [...state.genres];
  } else {
    state.genreListExpanded = true;
    state.filteredGenres = state.genres
      .map((genre, index) => ({
        genre,
        index,
        score: getGenreSearchScore(genre, keyword),
      }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(item => item.genre);
  }

  updateSearchStatus(keyword);
  renderGenreList();

  if (state.filteredGenres.length === 0) {
    renderEmptyGenre();
    return;
  }

  if (!state.filteredGenres.some(genre => genre.id === state.currentGenreId)) {
    void showGenre(state.filteredGenres[0].id);
  }
}

function updateSearchStatus(keyword) {
  const isSearching = Boolean(keyword.normalized);
  const heroMessage = isSearching ? `${state.filteredGenres.length}개 결과` : 'All Genres';
  if (elements.searchStatus) {
    elements.searchStatus.hidden = !isSearching;
    elements.searchStatus.textContent = isSearching ? `${state.filteredGenres.length}개 결과` : '';
  }
  elements.heroSearchStatus.textContent = heroMessage;
  updateGenreToggle(isSearching);
}

function getGenreSearchScore(genre, keyword) {
  const primaryTerms = [genre.name, genre.id];
  const secondaryTerms = [
    genre.description,
    ...(genre.aliases ?? []),
    ...(genre.spotifySeedGenres ?? []),
    ...(genre.spotifySearchTerms ?? []),
    ...(genre.subgenres ?? []).map(resolveGenreSearchLabel),
    ...(genre.similar ?? []).map(resolveGenreSearchLabel),
    ...(genre.fusion ?? []).map(resolveGenreSearchLabel),
    ...(genre.relatedNames ?? []),
  ];

  let score = 0;

  primaryTerms.forEach(value => {
    score = Math.max(score, scoreSearchValue(value, keyword, 120, 90, 70));
  });

  secondaryTerms.forEach(value => {
    score = Math.max(score, scoreSearchValue(value, keyword, 45, 30, 15));
  });

  return score;
}

function resolveGenreSearchLabel(value) {
  const normalizedValue = normalizeSearchText(value);
  const relatedGenre = state.genres.find(genre => {
    return (
      normalizeSearchText(genre.id) === normalizedValue ||
      normalizeSearchText(genre.name) === normalizedValue
    );
  });

  return relatedGenre?.name ?? value;
}

function scoreSearchValue(value, keyword, exactScore, prefixScore, includeScore) {
  const normalizedValue = normalizeSearchText(value);
  if (!normalizedValue) {
    return 0;
  }

  const compactValue = compactSearchText(normalizedValue);

  if (normalizedValue === keyword.normalized || compactValue === keyword.compact) {
    return exactScore;
  }

  if (
    normalizedValue.startsWith(keyword.normalized) ||
    compactValue.startsWith(keyword.compact)
  ) {
    return prefixScore;
  }

  if (
    normalizedValue.includes(keyword.normalized) ||
    compactValue.includes(keyword.compact)
  ) {
    return includeScore;
  }

  return 0;
}

function buildSearchToken(value) {
  const normalized = normalizeSearchText(value);
  return {
    normalized,
    compact: compactSearchText(normalized),
  };
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSearchText(value) {
  return value.replace(/[^a-z0-9]+/g, '');
}

function getVisibleGenres() {
  if (
    state.genreListExpanded ||
    state.filteredGenres.length <= DEFAULT_VISIBLE_GENRES ||
    buildSearchToken(state.searchQuery).normalized
  ) {
    return state.filteredGenres;
  }

  const visibleGenres = state.filteredGenres.slice(0, DEFAULT_VISIBLE_GENRES);

  if (
    state.currentGenreId &&
    !visibleGenres.some(genre => genre.id === state.currentGenreId)
  ) {
    const currentGenre = state.filteredGenres.find(genre => genre.id === state.currentGenreId);
    if (currentGenre) {
      visibleGenres[visibleGenres.length - 1] = currentGenre;
    }
  }

  return visibleGenres;
}

function updateGenreToggle(isSearching) {
  if (!elements.genreToggle) {
    return;
  }

  const shouldShow = !isSearching && state.filteredGenres.length > DEFAULT_VISIBLE_GENRES;
  elements.genreToggle.hidden = !shouldShow;

  if (!shouldShow) {
    return;
  }

  elements.genreToggle.textContent = state.genreListExpanded ? 'Show Less' : 'Show More';
}

function renderGenreList() {
  elements.genreList.innerHTML = '';

  if (state.filteredGenres.length === 0) {
    elements.genreList.innerHTML =
      '<div class="empty-state">검색된 장르가 없습니다. 다른 장르 이름으로 다시 찾아보세요.</div>';
    return;
  }

  getVisibleGenres().forEach(genre => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'genre-card';
    const genreIndex = state.filteredGenres.findIndex(item => item.id === genre.id) + 1;

    if (genre.id === state.currentGenreId) {
      button.classList.add('is-active');
    }

    button.innerHTML = `
      <div class="genre-card-content">
        <span class="genre-index">${String(genreIndex).padStart(2, '0')}</span>
        <h4>${genre.name}</h4>
        <p>${genre.description ?? 'Spotify 장르 데이터를 불러오는 중입니다.'}</p>
      </div>
    `;

    button.addEventListener('click', () => {
      showView('home');
      setActiveNav(elements.navHome);
      void showGenre(genre.id);
    });
    elements.genreList.appendChild(button);
  });
}

async function showGenre(id) {
  const genre = state.genres.find(item => item.id === id);

  if (!genre) {
    return;
  }

  state.currentGenreId = genre.id;

  if (genre.spotifyBacked && !genre.detailsLoaded && !genre.detailsLoading) {
    genre.detailsLoading = true;
    if (
      !genre.description ||
      genre.description.startsWith('Spotify genre seed') ||
      genre.description.startsWith('Spotify 추천 장르 seed')
    ) {
      genre.description = `${genre.name} 관련 Spotify 데이터를 불러오는 중입니다.`;
    }
  }

  applyGenreToUI(genre);
  renderGenreList();

  if (!genre.spotifyBacked || genre.detailsLoaded || !state.usingBackendGenres) {
    return;
  }

  try {
    const detail = await fetchGenreDetails(genre.id);
    Object.assign(genre, detail, {
      detailsLoaded: true,
      detailsLoading: false,
    });

    if (detail.relatedNames?.length) {
      genre.similar = detail.relatedNames.slice(0, 6).map(name => ensureGenreStub(name));
    }
  } catch {
    genre.detailsLoading = false;
    genre.detailsLoaded = true;
    if (!genre.description) {
      genre.description = `${genre.name} 장르 상세 정보를 불러오지 못했습니다.`;
    }
  }

  if (state.currentGenreId === genre.id) {
    applyGenreToUI(genre);
    renderGenreList();
  }
}

function applyGenreToUI(genre) {
  const tracks = genre.tracks ?? [];
  const relationTotal =
    (genre.subgenres?.length ?? 0) +
    (genre.similar?.length ?? 0) +
    (genre.fusion?.length ?? 0);
  const leadTrack = tracks[0];

  elements.genreTitle.textContent = genre.name;
  elements.genreDesc.textContent = genre.description ?? '';
  elements.heroTag.textContent = `${genre.name} Focus`;
  elements.currentGenreChip.textContent = genre.name;
  elements.trackCount.textContent = String(tracks.length);
  elements.relationCount.textContent = String(relationTotal);
  elements.playerTrackTitle.textContent = leadTrack ? leadTrack.title : 'No track available';
  elements.playerTrackArtist.textContent = leadTrack
    ? `${leadTrack.artist} · ${genre.name}`
    : 'Track information will appear here.';
  elements.playerBarTitle.textContent = leadTrack ? leadTrack.title : genre.name;
  elements.playerBarSubtitle.textContent = leadTrack
    ? `${leadTrack.artist} · ${genre.name}`
    : 'MUSICDIGGER queue';

  if (genre.detailsLoading) {
    renderTrackLoading();
  } else {
    renderTracks(tracks);
  }

  renderButtons(elements.subgenres, genre.subgenres ?? []);
  renderButtons(elements.similar, genre.similar ?? []);
  renderButtons(elements.fusion, genre.fusion ?? []);
}

function renderTrackLoading() {
  elements.trackList.innerHTML =
    '<li class="empty-state">Spotify에서 대표 트랙을 불러오는 중입니다.</li>';
}

function renderTracks(tracks) {
  elements.trackList.innerHTML = '';

  if (!tracks.length) {
    elements.trackList.innerHTML =
      '<li class="empty-state">대표 트랙이 아직 등록되지 않았습니다.</li>';
    return;
  }

  tracks.forEach((track, index) => {
    const saved = state.spotify.likedTrackKeys.has(makeTrackKey(track));
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

    item.querySelector('.track-action').addEventListener('click', () => {
      void likeTrack(track, item.querySelector('.track-action'));
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
    button.addEventListener('click', () => {
      showView('home');
      setActiveNav(elements.navHome);
      void showGenre(genre.id);
    });
    container.appendChild(button);
  });
}

function renderEmptyGenre() {
  state.currentGenreId = null;
  elements.genreTitle.textContent = '검색된 장르가 없습니다';
  elements.genreDesc.textContent = '다른 장르 이름이나 스타일 키워드로 다시 찾아보세요.';
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

async function showRandomGenre() {
  if (state.filteredGenres.length === 0) {
    return;
  }

  const randomGenre =
    state.filteredGenres[Math.floor(Math.random() * state.filteredGenres.length)];

  showView('home');
  setActiveNav(elements.navHome);
  await showGenre(randomGenre.id);
}

function focusHome() {
  showView('home');

  if (!state.currentGenreId && state.filteredGenres.length > 0) {
    void showGenre(state.filteredGenres[0].id);
  }
}

function focusSection(element) {
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showView(view) {
  const previousView = state.currentView;
  state.currentView = view;
  setMenuOpen(false);

  [
    ['home', elements.homeView],
    ['library', elements.libraryView],
    ['profile', elements.profileView],
    ['settings', elements.settingsView],
  ].forEach(([name, element]) => {
    element?.classList.toggle('is-active', name === view);
  });

  window.scrollTo({ top: 0, behavior: previousView === view ? 'auto' : 'smooth' });
}

function openLibraryView(navButton = elements.navLibrary, targetSection = null) {
  showView('library');
  setActiveNav(navButton);

  if (targetSection) {
    window.requestAnimationFrame(() => {
      focusSection(targetSection);
    });
  }
}

function openProfileView() {
  showView('profile');
  setActiveNav(elements.navProfile);
}

function openSettingsView() {
  showView('settings');
  setActiveNav(null);
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

  if (elements.profileThemeToggle) {
    elements.profileThemeToggle.textContent = state.isDarkMode ? 'Light Mode' : 'Dark Mode';
  }
  if (elements.settingsThemeToggle) {
    elements.settingsThemeToggle.textContent = state.isDarkMode ? 'Light Mode' : 'Dark Mode';
  }
}

function setActiveNav(target) {
  [
    elements.navHome,
    elements.navLibrary,
    elements.navPlaylists,
    elements.navProfile,
  ].forEach(button => {
    button?.classList.toggle('is-current', button === target);
  });
}

function addClick(element, handler) {
  if (element) {
    element.addEventListener('click', handler);
  }
}

function makeDuration(index) {
  const minutes = 3 + (index % 3);
  const seconds = 10 + index * 17;
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ensureGenreStub(name) {
  const id = slugify(name);
  const existing = state.genres.find(item => item.id === id);

  if (existing) {
    return existing.id;
  }

  const genre = {
    id,
    name,
    description: `${name} 관련 Spotify 장르입니다.`,
    subgenres: [],
    similar: [],
    fusion: [],
    tracks: [],
    spotifyBacked: true,
  };

  state.genres.push(genre);
  return genre.id;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function makeTrackKey(track) {
  return `${track.title}::${track.artist}`.toLowerCase();
}

function makeTrackKeyFromSpotify(track) {
  const artist = track.artists?.[0]?.name ?? '';
  return `${track.name}::${artist}`.toLowerCase();
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

  const name = elements.playlistName.value.trim();
  if (!name) {
    return;
  }

  elements.playlistSubmit.disabled = true;
  elements.playlistSubmit.textContent = 'Creating...';

  try {
    const playlist = await spotifyRequest('/me/playlists', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: elements.playlistDescription.value.trim(),
        public: !elements.playlistPrivate.checked,
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
    openLibraryView(elements.navLibrary, elements.playlistSection);
  } catch (error) {
    updateSpotifyMessage(error.message);
  } finally {
    elements.playlistSubmit.disabled = false;
    elements.playlistSubmit.textContent = 'Create';
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
    await syncLikedTracks();
  } catch (error) {
    updateSpotifyMessage(error.message);
  } finally {
    button.disabled = false;
    renderTracksForCurrentGenre();
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

  const liked = await spotifyRequest('/me/tracks?limit=8');
  state.spotify.likedTracks = (liked.items ?? []).map(item => item.track).filter(Boolean);
  state.spotify.likedTrackKeys = new Set(
    state.spotify.likedTracks.map(track => makeTrackKeyFromSpotify(track)),
  );
  renderLikedTracks();
  renderProfileSummary();
}

function renderTracksForCurrentGenre() {
  if (!state.currentGenreId) {
    return;
  }

  const genre = state.genres.find(item => item.id === state.currentGenreId);
  if (genre) {
    applyGenreToUI(genre);
  }
}

function renderSpotifyState() {
  renderProfileCard();
  renderProfileSummary();
  renderPlaylistList();
  renderLikedTracks();
  updateProfileSlot();

  const hasAccessToken = Boolean(state.spotify.accessToken);

  if (elements.spotifyRefreshButton) {
    elements.spotifyRefreshButton.disabled = !hasAccessToken;
  }
  if (elements.spotifyAuthButton) {
    elements.spotifyAuthButton.textContent = hasAccessToken ? 'Refresh Library' : 'Connect Spotify';
  }
  if (elements.profileSettingsNote) {
    elements.profileSettingsNote.textContent = hasAccessToken
      ? 'Spotify 연결 상태는 위 프로필 요약과 라이브러리 화면에서 확인할 수 있습니다.'
      : 'Spotify를 연결하면 프로필과 라이브러리 정보를 더 자세히 볼 수 있습니다.';
  }
}

function renderProfileCard() {
  if (!state.spotify.profile) {
    const message = state.spotify.configured
      ? 'Spotify에 로그인하면 프로필과 플레이리스트를 여기서 불러옵니다.'
      : 'Spotify 로그인 기능을 쓰려면 spotify-config.js에 Client ID를 넣어주세요.';
    updateSpotifyMessage(message);
    return;
  }

  const imageUrl = state.spotify.profile.images?.[0]?.url;
  const product = state.spotify.profile.product ?? 'spotify';
  const followers = state.spotify.profile.followers?.total ?? 0;
  const compactMarkup = buildCompactProfileMarkup(imageUrl, product);

  elements.spotifyProfileCard.innerHTML = compactMarkup;
  elements.profileScreenCard.innerHTML = `
    <div class="profile-detail-stack">
      ${compactMarkup}
      <div class="profile-detail-grid">
        <article class="detail-chip">
          <span>Plan</span>
          <strong>${product}</strong>
        </article>
        <article class="detail-chip">
          <span>Followers</span>
          <strong>${followers}</strong>
        </article>
      </div>
    </div>
  `;
}

function buildCompactProfileMarkup(imageUrl, product) {
  return `
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

function renderProfileSummary() {
  if (!elements.profileSummary) {
    return;
  }

  if (!state.spotify.accessToken) {
    elements.profileSummary.innerHTML = `
      <div class="empty-state">
        Spotify를 연결하면 플레이리스트 수와 좋아요한 곡 수를 이 화면에서 바로 확인할 수 있습니다.
      </div>
    `;
    return;
  }

  elements.profileSummary.innerHTML = `
    <article class="summary-card">
      <span>Playlists</span>
      <strong>${state.spotify.playlists.length}</strong>
    </article>
    <article class="summary-card">
      <span>Liked Tracks</span>
      <strong>${state.spotify.likedTracks.length}</strong>
    </article>
    <article class="summary-card">
      <span>Current Focus</span>
      <strong>${getCurrentGenreName()}</strong>
    </article>
  `;
}

function renderPlaylistList() {
  if (!state.spotify.accessToken) {
    elements.playlistList.innerHTML =
      '<div class="empty-state">Spotify에 로그인하면 플레이리스트를 여기서 확인할 수 있습니다.</div>';
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
    const total = playlist.items?.total ?? playlist.tracks?.total ?? 0;

    item.innerHTML = `
      <strong>${playlist.name}</strong>
      <span>${total} tracks</span>
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
  elements.profileSlot.title = state.spotify.profile?.display_name ?? '프로필 화면 열기';
  elements.profileAvatar.style.backgroundImage = imageUrl ? `url("${imageUrl}")` : '';
  elements.profileAvatar.classList.toggle('has-image', Boolean(imageUrl));
}

function updateSpotifyMessage(message) {
  elements.spotifyProfileCard.innerHTML = `<div class="empty-state">${message}</div>`;
  if (elements.profileScreenCard) {
    elements.profileScreenCard.innerHTML = `<div class="empty-state">${message}</div>`;
  }
}

async function ensureSpotifyReady(promptLogin) {
  if (!state.spotify.configured) {
    if (promptLogin) {
      updateSpotifyMessage(
        'spotify-config.js 파일에 Spotify Client ID를 넣은 뒤 다시 시도해주세요.',
      );
    }
    return false;
  }

  if (!state.spotify.accessToken) {
    if (promptLogin) {
      await loginToSpotify();
    }
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

  saveSpotifyToken(await response.json());
  localStorage.removeItem(SPOTIFY_STORAGE_KEYS.verifier);
  localStorage.removeItem(SPOTIFY_STORAGE_KEYS.state);
  clearSpotifyQueryParams();
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

  saveSpotifyToken(await response.json());
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
  if (track.spotifyUri) {
    return track.spotifyUri;
  }

  const key = makeTrackKey(track);
  if (state.spotify.trackUriCache.has(key)) {
    return state.spotify.trackUriCache.get(key);
  }

  const query = encodeURIComponent(`track:${track.title} artist:${track.artist}`);
  const result = await spotifyRequest(`/search?q=${query}&type=track&limit=1`);
  const uri = result?.tracks?.items?.[0]?.uri ?? null;
  state.spotify.trackUriCache.set(key, uri);
  return uri;
}

async function getCurrentGenreSpotifyUris() {
  const genre = state.genres.find(item => item.id === state.currentGenreId);
  if (!genre) {
    return [];
  }

  const uris = await Promise.all((genre.tracks ?? []).slice(0, 5).map(resolveTrackUri));
  return uris.filter(Boolean);
}

function getProfileInitial() {
  return state.spotify.profile?.display_name?.trim()?.[0]?.toUpperCase() ?? 'S';
}

function getCurrentGenreName() {
  const genre = state.genres.find(item => item.id === state.currentGenreId);
  return genre?.name ?? 'No Genre';
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
  const data = new TextEncoder().encode(verifier);
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
