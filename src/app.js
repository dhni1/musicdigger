import { MAP_ZOOM_STEP, elements, state } from './shared/context.js';
import {
  openLibraryView,
  openProfileView,
  openSettingsView,
  resolveRouteKey,
  setActiveNav,
  setMenuOpen,
  showView,
  toggleTheme,
  updateThemeUI,
} from './shared/navigation.js';
import { createHomePage } from './pages/home/index.js';
import { createMapPage } from './pages/map/index.js';
import { createSpotifyService } from './services/spotify/index.js';

let homePage;
let spotifyService;

const mapPage = createMapPage({
  setActiveNav,
  showGenre: genreId => homePage.showGenre(genreId),
  showView,
});

homePage = createHomePage({
  likeTrack: (track, button) => spotifyService.likeTrack(track, button),
  renderGenreMap: () => mapPage.renderGenreMap(),
  renderMapSelection: genre => mapPage.renderMapSelection(genre),
  setActiveNav,
  showView,
});

spotifyService = createSpotifyService({
  getCurrentGenreName: () => homePage.getCurrentGenreName(),
  openLibraryView,
  renderTracksForCurrentGenre: () => homePage.renderTracksForCurrentGenre(),
  setActiveNav,
});

void initialize();

async function initialize() {
  bindEvents();
  updateThemeUI();
  spotifyService.renderSpotifyState();
  await Promise.all([homePage.loadGenres(), spotifyService.initializeSpotify()]);
  applyRouteFromLocation();
}

function bindEvents() {
  addClick(elements.menuToggle, () => {
    setMenuOpen(!elements.dock.classList.contains('is-open'));
  });

  addClick(elements.sidebarRandom, () => {
    void homePage.showRandomGenre();
  });
  addClick(elements.profileThemeToggle, toggleTheme);
  addClick(elements.profileSpotifyDisconnect, () => {
    spotifyService.disconnectSpotify();
  });
  addClick(elements.profileMoreSettings, openSettingsView);
  addClick(elements.settingsThemeToggle, toggleTheme);
  addClick(elements.settingsOpenProfile, openProfileView);
  addClick(elements.settingsOpenHome, () => {
    homePage.focusHome();
  });
  addClick(elements.navHome, () => {
    homePage.focusHome();
  });
  addClick(elements.navMap, mapPage.openMapView);
  addClick(elements.navLibrary, () => {
    openLibraryView(elements.navLibrary);
  });
  addClick(elements.navPlaylists, () => {
    setMenuOpen(false);
    void spotifyService.openPlaylistComposer();
  });
  addClick(elements.navProfile, openProfileView);
  addClick(elements.profileSlot, openProfileView);
  addClick(elements.playlistCreateButton, () => {
    void spotifyService.openPlaylistComposer();
  });
  addClick(elements.mapOpenHome, () => {
    homePage.focusHome();
  });
  addClick(elements.mapZoomIn, () => {
    mapPage.adjustMapZoom('main', MAP_ZOOM_STEP);
  });
  addClick(elements.mapZoomOut, () => {
    mapPage.adjustMapZoom('main', -MAP_ZOOM_STEP);
  });
  addClick(elements.mapZoomReset, () => {
    mapPage.setMapZoom('main', 1);
  });
  addClick(elements.mapOpenModal, mapPage.openMapModal);
  addClick(elements.mapModalClose, mapPage.closeMapModal);
  addClick(elements.mapModalZoomIn, () => {
    mapPage.adjustMapZoom('modal', MAP_ZOOM_STEP);
  });
  addClick(elements.mapModalZoomOut, () => {
    mapPage.adjustMapZoom('modal', -MAP_ZOOM_STEP);
  });
  addClick(elements.mapModalZoomReset, () => {
    mapPage.setMapZoom('modal', 1);
  });
  addClick(elements.spotifyAuthButton, () => {
    void spotifyService.handleSpotifyAuthButton();
  });
  addClick(elements.spotifyRefreshButton, () => {
    void spotifyService.handleSpotifyAuthButton();
  });
  addClick(elements.genreToggle, () => {
    homePage.toggleGenreListExpansion();
  });
  addClick(elements.playlistModalClose, spotifyService.closePlaylistModal);
  addClick(elements.playlistModal, event => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.dataset.closeModal === 'true') {
      spotifyService.closePlaylistModal();
    }
  });
  addClick(elements.mapModal, event => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.dataset.closeMapModal === 'true') {
      mapPage.closeMapModal();
    }
  });
  addClick(elements.dockBackdrop, () => {
    setMenuOpen(false);
  });

  mapPage.bindMapViewport(elements.mapCanvas, 'main');
  mapPage.bindMapViewport(elements.mapModalCanvas, 'modal');

  if (elements.searchInput) {
    elements.searchInput.addEventListener('input', event => {
      const nextView = state.currentView === 'map' ? 'map' : 'home';
      showView(nextView);
      setActiveNav(nextView === 'map' ? elements.navMap : elements.navHome);
      homePage.applySearch(event.target.value);
    });
  }

  if (elements.playlistForm) {
    elements.playlistForm.addEventListener('submit', event => {
      event.preventDefault();
      void spotifyService.submitPlaylistForm();
    });
  }

  document.addEventListener('click', event => {
    const clickedInsideMenu = elements.dock?.contains(event.target);
    const clickedToggle = elements.menuToggle?.contains(event.target);

    if (!clickedInsideMenu && !clickedToggle) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      setMenuOpen(false);
    }
  });

  window.addEventListener('popstate', () => {
    applyRouteFromLocation();
  });
}

function applyRouteFromLocation() {
  const routeKey = resolveRouteKey(window.location.pathname);

  switch (routeKey) {
    case 'map':
      mapPage.openMapView({ updateHistory: false });
      break;
    case 'library':
      openLibraryView(elements.navLibrary, null, { updateHistory: false });
      break;
    case 'profile':
      openProfileView({ updateHistory: false });
      break;
    case 'settings':
      openSettingsView({ updateHistory: false });
      break;
    case 'home':
      homePage.focusHome({ updateHistory: false });
      break;
    default:
      homePage.focusHome({ replaceHistory: true });
      break;
  }
}

function addClick(element, handler) {
  if (element) {
    element.addEventListener('click', handler);
  }
}
