import { elements, state } from './context.js';

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
    ['map', elements.mapView],
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
  elements.menuPanel?.classList.toggle('is-open', isOpen);
  elements.menuPanel?.setAttribute('aria-hidden', String(!isOpen));
  elements.menuToggle?.setAttribute('aria-expanded', String(isOpen));
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
  setActiveNav,
  setMenuOpen,
  showView,
  toggleTheme,
  updateThemeUI,
};
