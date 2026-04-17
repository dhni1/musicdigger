import { elements, state } from './context.js';

const ROUTE_PATHS = {
  home: '/',
  map: '/map',
  library: '/library',
  profile: '/profile',
  settings: '/settings',
};

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') {
    return '/';
  }

  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return normalized || '/';
}

function resolveRouteKey(pathname) {
  const normalizedPathname = normalizePathname(pathname);

  return (
    Object.entries(ROUTE_PATHS).find(([, routePath]) => routePath === normalizedPathname)?.[0] ??
    null
  );
}

function syncRouteHistory(routeKey, replaceHistory) {
  const nextPath = ROUTE_PATHS[routeKey] ?? ROUTE_PATHS.home;

  if (normalizePathname(window.location.pathname) === nextPath) {
    return;
  }

  const method = replaceHistory ? 'replaceState' : 'pushState';
  window.history[method]({ routeKey }, document.title, nextPath);
}

function focusSection(element, behavior = 'smooth') {
  if (element) {
    element.scrollIntoView({ behavior, block: 'start' });
  }
}

function showView(view, options = {}) {
  const previousView = state.currentView;
  const routeKey = options.routeKey ?? view;
  const updateHistory = options.updateHistory ?? true;
  const replaceHistory = options.replaceHistory ?? false;
  const scrollBehavior =
    options.scrollBehavior ?? (previousView === view || !updateHistory ? 'auto' : 'smooth');

  state.currentView = view;
  state.currentRoute = routeKey;
  setMenuOpen(false);

  if (updateHistory) {
    syncRouteHistory(routeKey, replaceHistory);
  }

  [
    ['home', elements.homeView],
    ['map', elements.mapView],
    ['library', elements.libraryView],
    ['profile', elements.profileView],
    ['settings', elements.settingsView],
  ].forEach(([name, element]) => {
    element?.classList.toggle('is-active', name === view);
  });

  window.scrollTo({ top: 0, behavior: scrollBehavior });
}

function openLibraryView(navButton = elements.navLibrary, targetSection = null, options = {}) {
  const routeKey = options.routeKey ?? 'library';
  const updateHistory = options.updateHistory ?? true;

  showView('library', {
    ...options,
    routeKey,
    updateHistory,
  });
  setActiveNav(navButton);

  if (targetSection) {
    window.requestAnimationFrame(() => {
      focusSection(targetSection, options.focusBehavior ?? (updateHistory ? 'smooth' : 'auto'));
    });
  }
}

function openProfileView(options = {}) {
  showView('profile', {
    ...options,
    routeKey: options.routeKey ?? 'profile',
  });
  setActiveNav(elements.navProfile);
}

function openSettingsView(options = {}) {
  showView('settings', {
    ...options,
    routeKey: options.routeKey ?? 'settings',
  });
  setActiveNav(null);
}

function toggleTheme() {
  state.isDarkMode = !state.isDarkMode;
  updateThemeUI();
}

function setMenuOpen(isOpen) {
  elements.dock?.classList.toggle('is-open', isOpen);
  elements.dock?.setAttribute('aria-hidden', String(!isOpen));
  elements.dockBackdrop?.classList.toggle('is-open', isOpen);
  elements.dockBackdrop?.setAttribute('aria-hidden', String(!isOpen));
  elements.menuToggle?.setAttribute('aria-expanded', String(isOpen));
  elements.body?.classList.toggle('is-nav-open', isOpen);
}

function updateThemeUI() {
  const themeClass = state.isDarkMode ? 'theme-dark' : 'theme-light';
  const oldThemeClass = state.isDarkMode ? 'theme-light' : 'theme-dark';

  elements.body.classList.remove(oldThemeClass);
  elements.body.classList.add(themeClass);

  if (elements.profileThemeToggle) {
    elements.profileThemeToggle.textContent = state.isDarkMode ? 'Light Mode' : 'Dark Mode';
  }

  if (elements.profileSpotifyDisconnect) {
    elements.profileSpotifyDisconnect.disabled = !state.spotify.accessToken;
  }

  if (elements.settingsThemeToggle) {
    elements.settingsThemeToggle.textContent = state.isDarkMode ? 'Light Mode' : 'Dark Mode';
  }
}

function setActiveNav(target) {
  [
    elements.navHome,
    elements.navMap,
    elements.navLibrary,
    elements.navPlaylists,
    elements.navProfile,
  ].forEach(button => {
    button?.classList.toggle('is-current', button === target);
  });
}

export {
  focusSection,
  openLibraryView,
  openProfileView,
  openSettingsView,
  resolveRouteKey,
  setActiveNav,
  setMenuOpen,
  showView,
  toggleTheme,
  updateThemeUI,
};
