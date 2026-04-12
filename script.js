const state = {
  genres: [],
  filteredGenres: [],
  currentGenreId: null,
  isDarkMode: true,
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
};

initialize();

function initialize() {
  bindEvents();
  updateThemeUI();
  loadGenres();
}

function bindEvents() {
  elements.searchInput.addEventListener('input', event => {
    applySearch(event.target.value);
  });

  elements.menuToggle.addEventListener('click', () => {
    const willOpen = !elements.menuPanel.classList.contains('is-open');
    setMenuOpen(willOpen);
  });

  elements.menuHome.addEventListener('click', () => {
    focusHome();
    setMenuOpen(false);
  });

  elements.menuRandom.addEventListener('click', () => {
    showRandomGenre();
    setMenuOpen(false);
  });

  elements.menuSearch.addEventListener('click', () => {
    elements.searchInput.focus();
    setMenuOpen(false);
  });

  addClick(elements.sidebarRandom, showRandomGenre);
  addClick(elements.heroTheme, toggleTheme);

  document.addEventListener('click', event => {
    const clickedInsideMenu = elements.menuPanel.contains(event.target);
    const clickedToggle = elements.menuToggle.contains(event.target);

    if (!clickedInsideMenu && !clickedToggle) {
      setMenuOpen(false);
    }
  });
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
        <span class="genre-index">0${index + 1}</span>
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
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="track-order">${String(index + 1).padStart(2, '0')}</span>
      <div>
        <span class="track-title">${track.title}</span>
        <span class="track-artist">${track.artist}</span>
      </div>
      <span class="track-duration">${makeDuration(index)}</span>
    `;

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
