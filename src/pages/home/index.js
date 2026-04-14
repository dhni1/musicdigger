import {
  BACKEND_REQUEST_TIMEOUT_MS,
  BUILTIN_GENRES,
  DEFAULT_VISIBLE_GENRES,
  elements,
  state,
} from '../../shared/context.js';
import {
  clearChildren,
  createElement,
  createEmptyState,
  createTextBlock,
} from '../../shared/dom.js';
import { makeTrackKey, slugify } from '../../shared/utils.js';

function createHomePage({ likeTrack, renderGenreMap, renderMapSelection, setActiveNav, showView }) {
  async function loadGenres() {
    try {
      const bootstrapGenres = await fetchLocalGenres();
      commitGenreCatalog(bootstrapGenres, { usingBackendGenres: false });
    } catch {
      commitGenreCatalog(cloneGenres(BUILTIN_GENRES), {
        usingBackendGenres: false,
      });
    }

    if (state.filteredGenres.length > 0) {
      void showGenre(state.filteredGenres[0].id);
    }

    void refreshGenresFromBackend();
  }

  async function fetchLocalGenres() {
    const response = await fetch('data/genres.json');

    if (!response.ok) {
      throw new Error('local genres unavailable');
    }

    const data = await response.json();
    return cloneGenres(data.genres ?? []);
  }

  function cloneGenres(genres) {
    return genres.map(genre => ({
      ...genre,
      subgenres: [...(genre.subgenres ?? [])],
      similar: [...(genre.similar ?? [])],
      fusion: [...(genre.fusion ?? [])],
      aliases: [...(genre.aliases ?? [])],
      spotifySeedGenres: [...(genre.spotifySeedGenres ?? [])],
      spotifySearchTerms: [...(genre.spotifySearchTerms ?? [])],
      relatedNames: [...(genre.relatedNames ?? [])],
      tracks: (genre.tracks ?? []).map(track => ({ ...track })),
    }));
  }

  function commitGenreCatalog(genres, options = {}) {
    const { usingBackendGenres = false } = options;
    state.genres = cloneGenres(genres);
    state.usingBackendGenres = usingBackendGenres;
    elements.genreCount.textContent = String(state.genres.length);
    applySearch(state.searchQuery);
  }

  async function refreshGenresFromBackend() {
    try {
      const backendGenres = await fetchBackendGenres();
      commitGenreCatalog(backendGenres, { usingBackendGenres: true });

      const targetGenreId =
        state.currentGenreId && state.genres.some(genre => genre.id === state.currentGenreId)
          ? state.currentGenreId
          : state.filteredGenres[0]?.id;

      if (targetGenreId) {
        void showGenre(targetGenreId);
      }
    } catch {
      updateSearchStatus(buildSearchToken(state.searchQuery));
    }
  }

  async function fetchBackendGenres() {
    const response = await fetchWithTimeout(
      `${window.APP_CONFIG.backendBaseUrl}/api/genres`,
      BACKEND_REQUEST_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error('backend unavailable');
    }

    const data = await response.json();
    return data.genres ?? [];
  }

  async function fetchGenreDetails(genreId) {
    const response = await fetchWithTimeout(
      `${window.APP_CONFIG.backendBaseUrl}/api/genre-details?genre=${encodeURIComponent(genreId)}`,
      BACKEND_REQUEST_TIMEOUT_MS,
    );

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
    renderGenreMap();

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
    clearChildren(elements.genreList);

    if (state.filteredGenres.length === 0) {
      elements.genreList.appendChild(
        createEmptyState('검색된 장르가 없습니다. 다른 장르 이름으로 다시 찾아보세요.'),
      );
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

      const content = createElement('div', { className: 'genre-card-content' });
      content.appendChild(
        createTextBlock('span', String(genreIndex).padStart(2, '0'), 'genre-index'),
      );
      content.appendChild(createTextBlock('h4', genre.name));
      content.appendChild(
        createTextBlock('p', genre.description ?? 'Spotify 장르 데이터를 불러오는 중입니다.'),
      );
      button.appendChild(content);

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

    if (genre.detailsLoading && tracks.length) {
      renderTracks(tracks);
    } else if (genre.detailsLoading) {
      renderTrackLoading();
    } else {
      renderTracks(tracks);
    }

    renderButtons(elements.subgenres, genre.subgenres ?? []);
    renderButtons(elements.similar, genre.similar ?? []);
    renderButtons(elements.fusion, genre.fusion ?? []);
    renderMapSelection(genre);
    renderGenreMap();
  }

  function renderTrackLoading() {
    clearChildren(elements.trackList);
    elements.trackList.appendChild(
      createEmptyState('Spotify에서 대표 트랙을 불러오는 중입니다.', {
        tagName: 'li',
      }),
    );
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }

  function renderTracks(tracks) {
    clearChildren(elements.trackList);

    if (!tracks.length) {
      elements.trackList.appendChild(
        createEmptyState('대표 트랙이 아직 등록되지 않았습니다.', {
          tagName: 'li',
        }),
      );
      return;
    }

    tracks.forEach((track, index) => {
      const saved = state.spotify.likedTrackKeys.has(makeTrackKey(track));
      const item = document.createElement('li');
      const info = createElement('div');
      const actionButton = createElement('button', {
        className: `track-action${saved ? ' is-saved' : ''}`,
        text: saved ? 'Liked' : 'Like',
      });
      actionButton.type = 'button';

      item.appendChild(
        createTextBlock('span', String(index + 1).padStart(2, '0'), 'track-order'),
      );
      info.appendChild(createTextBlock('span', track.title, 'track-title'));
      info.appendChild(createTextBlock('span', track.artist, 'track-artist'));
      item.appendChild(info);
      item.appendChild(createTextBlock('span', makeDuration(index), 'track-duration'));
      item.appendChild(actionButton);

      actionButton.addEventListener('click', () => {
        void likeTrack(track, actionButton);
      });

      elements.trackList.appendChild(item);
    });
  }

  function renderButtons(container, ids) {
    clearChildren(container);

    if (!ids.length) {
      container.appendChild(createEmptyState('연결된 장르가 아직 없습니다.'));
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
    clearChildren(elements.trackList);
    elements.trackList.appendChild(
      createEmptyState('표시할 트랙이 없습니다.', {
        tagName: 'li',
      }),
    );
    clearChildren(elements.subgenres);
    clearChildren(elements.similar);
    clearChildren(elements.fusion);
    elements.subgenres.appendChild(createEmptyState('표시할 결과가 없습니다.'));
    elements.similar.appendChild(createEmptyState('표시할 결과가 없습니다.'));
    elements.fusion.appendChild(createEmptyState('표시할 결과가 없습니다.'));
    renderMapSelection(null);
    renderGenreMap();
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

  function renderTracksForCurrentGenre() {
    if (!state.currentGenreId) {
      return;
    }

    const genre = state.genres.find(item => item.id === state.currentGenreId);
    if (genre) {
      applyGenreToUI(genre);
    }
  }

  function toggleGenreListExpansion() {
    state.genreListExpanded = !state.genreListExpanded;
    renderGenreList();
    updateSearchStatus(buildSearchToken(state.searchQuery));
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

  function makeDuration(index) {
    const minutes = 3 + (index % 3);
    const seconds = 10 + index * 17;
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function getCurrentGenreName() {
    const genre = state.genres.find(item => item.id === state.currentGenreId);
    return genre?.name ?? 'No Genre';
  }

  return {
    applySearch,
    focusHome,
    getCurrentGenreName,
    loadGenres,
    renderTracksForCurrentGenre,
    showGenre,
    showRandomGenre,
    toggleGenreListExpansion,
  };
}

export { createHomePage };
