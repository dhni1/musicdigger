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
  searchStatus: document.getElementById('search-status'),
  themeBadge: document.getElementById('theme-badge'),
  themeStatus: document.getElementById('theme-status'),
  searchInput: document.getElementById('genre-search'),
  menuToggle: document.getElementById('menu-toggle'),
  menuPanel: document.getElementById('menu-panel'),
  menuHome: document.getElementById('menu-home'),
  menuRandom: document.getElementById('menu-random'),
  menuTheme: document.getElementById('menu-theme'),
};

initialize();

function initialize() {
  bindEvents();
  loadGenres();
  updateThemeUI();
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
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (state.filteredGenres.length > 0) {
      showGenre(state.filteredGenres[0].id);
    }

    setMenuOpen(false);
  });

  elements.menuRandom.addEventListener('click', () => {
    if (state.filteredGenres.length === 0) {
      return;
    }

    const randomGenre =
      state.filteredGenres[Math.floor(Math.random() * state.filteredGenres.length)];

    showGenre(randomGenre.id);
    setMenuOpen(false);
  });

  elements.menuTheme.addEventListener('click', () => {
    state.isDarkMode = !state.isDarkMode;
    updateThemeUI();
    setMenuOpen(false);
  });

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
    const tracks = genre.tracks.map(track => `${track.title} ${track.artist}`).join(' ');
    const searchableText = `${genre.name} ${genre.description} ${tracks}`.toLowerCase();

    return searchableText.includes(keyword);
  });

  elements.searchStatus.textContent = keyword
    ? `${state.filteredGenres.length}개 결과`
    : '전체 보기';

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

function renderGenreList() {
  elements.genreList.innerHTML = '';

  if (state.filteredGenres.length === 0) {
    elements.genreList.innerHTML =
      '<div class="empty-state">검색 결과가 없습니다. 다른 키워드로 찾아보세요.</div>';
    return;
  }

  state.filteredGenres.forEach(genre => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'genre-btn';

    if (genre.id === state.currentGenreId) {
      button.classList.add('is-active');
    }

    button.innerHTML = `
      <strong>${genre.name}</strong>
      <small>${genre.description}</small>
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
  elements.genreTitle.textContent = genre.name;
  elements.genreDesc.textContent = genre.description;

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
      '<li class="empty-state">표시할 대표 곡이 아직 없습니다.</li>';
    return;
  }

  tracks.forEach(track => {
    const item = document.createElement('li');
    item.innerHTML = `
      <span class="track-title">${track.title}</span>
      <span class="track-artist">${track.artist}</span>
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
  elements.genreDesc.textContent =
    '장르명, 설명, 대표 곡 제목으로 다시 검색해보세요.';
  elements.trackList.innerHTML =
    '<li class="empty-state">표시할 결과가 없습니다.</li>';
  elements.subgenres.innerHTML =
    '<div class="empty-state">표시할 결과가 없습니다.</div>';
  elements.similar.innerHTML =
    '<div class="empty-state">표시할 결과가 없습니다.</div>';
  elements.fusion.innerHTML =
    '<div class="empty-state">표시할 결과가 없습니다.</div>';
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

  elements.themeBadge.textContent = state.isDarkMode ? 'Dark First' : 'Light Preview';
  elements.themeStatus.textContent = state.isDarkMode ? 'Dark Mode' : 'Light Mode';
  elements.menuTheme.textContent = state.isDarkMode
    ? '라이트 모드로 보기'
    : '다크 모드로 보기';
}
