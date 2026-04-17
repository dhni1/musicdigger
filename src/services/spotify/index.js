import {
  SPOTIFY_SCOPES,
  SPOTIFY_STORAGE_KEYS,
  elements,
  state,
} from '../../shared/context.js';
import { clearChildren, createEmptyState } from '../../shared/dom.js';
import {
  createRandomString,
  makeTrackKey,
  makeTrackKeyFromSpotify,
  safeJson,
} from '../../shared/utils.js';
import { renderLikedTracks, renderPlaylistList } from '../../pages/library/index.js';
import {
  renderProfileCard,
  renderProfileSummary,
  updateProfileSlot,
} from '../../pages/profile/index.js';

function createSpotifyService({
  getCurrentGenreName,
  openLibraryView,
  renderTracksForCurrentGenre,
  setActiveNav,
}) {
  const spotifyConfig = {
    clientId: window.SPOTIFY_CONFIG?.clientId ?? '',
    redirectUri: window.SPOTIFY_CONFIG?.redirectUri ?? getDefaultRedirectUri(),
    scopes: window.SPOTIFY_CONFIG?.scopes ?? SPOTIFY_SCOPES,
  };
  const storage = window.sessionStorage;

  state.spotify.configured = isSpotifyConfigured(spotifyConfig);

  async function initializeSpotify() {
    hydrateSpotifyToken();
    await handleSpotifyCallback();

    if (state.spotify.accessToken) {
      await syncSpotifyData();
    } else {
      renderSpotifyState();
    }
  }

  async function openPlaylistComposer() {
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
    if (!elements.playlistModal) {
      return;
    }

    elements.playlistModal.classList.add('is-open');
    elements.playlistModal.setAttribute('aria-hidden', 'false');
    elements.playlistName?.focus();
  }

  function closePlaylistModal() {
    if (!elements.playlistModal) {
      return;
    }

    elements.playlistModal.classList.remove('is-open');
    elements.playlistModal.setAttribute('aria-hidden', 'true');
    elements.playlistForm?.reset();
  }

  async function submitPlaylistForm() {
    if (!(await ensureSpotifyReady(true))) {
      return;
    }

    const name = elements.playlistName?.value.trim();
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
    renderLikedTracks({ elements, state });
    renderProfileSummary({ elements, getCurrentGenreName, state });
  }

  function renderSpotifyState() {
    renderProfileCard({
      elements,
      getProfileInitial,
      state,
      updateSpotifyMessage,
    });
    renderProfileSummary({ elements, getCurrentGenreName, state });
    renderPlaylistList({ elements, state });
    renderLikedTracks({ elements, state });
    updateProfileSlot({ elements, state });

    const hasAccessToken = Boolean(state.spotify.accessToken);

    if (elements.spotifyRefreshButton) {
      elements.spotifyRefreshButton.disabled = !hasAccessToken;
    }
    if (elements.spotifyAuthButton) {
      elements.spotifyAuthButton.textContent = hasAccessToken
        ? 'Refresh Library'
        : 'Connect Spotify';
    }
    if (elements.profileSettingsNote) {
      elements.profileSettingsNote.textContent = hasAccessToken
        ? 'Spotify 연결 상태는 위 프로필 요약과 라이브러리 화면에서 확인할 수 있습니다.'
        : 'Spotify를 연결하면 프로필과 라이브러리 정보를 더 자세히 볼 수 있습니다.';
    }
  }

  function updateSpotifyMessage(message) {
    if (elements.spotifyProfileCard) {
      clearChildren(elements.spotifyProfileCard);
      elements.spotifyProfileCard.appendChild(createEmptyState(message));
    }

    if (elements.profileScreenCard) {
      clearChildren(elements.profileScreenCard);
      elements.profileScreenCard.appendChild(createEmptyState(message));
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

    storage.setItem(SPOTIFY_STORAGE_KEYS.verifier, verifier);
    storage.setItem(SPOTIFY_STORAGE_KEYS.returnPath, window.location.pathname);
    storage.setItem(SPOTIFY_STORAGE_KEYS.state, stateValue);
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

    const expectedState = storage.getItem(SPOTIFY_STORAGE_KEYS.state);
    const verifier = storage.getItem(SPOTIFY_STORAGE_KEYS.verifier);

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
    storage.removeItem(SPOTIFY_STORAGE_KEYS.verifier);
    storage.removeItem(SPOTIFY_STORAGE_KEYS.state);
    clearSpotifyQueryParams(consumeSpotifyReturnPath());
  }

  function hydrateSpotifyToken() {
    const raw = storage.getItem(SPOTIFY_STORAGE_KEYS.token);

    if (!raw) {
      return;
    }

    try {
      const token = JSON.parse(raw);
      state.spotify.accessToken = token.accessToken ?? null;
      state.spotify.refreshToken = token.refreshToken ?? null;
      state.spotify.expiresAt = token.expiresAt ?? 0;
    } catch {
      storage.removeItem(SPOTIFY_STORAGE_KEYS.token);
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

    storage.setItem(
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

  function clearSpotifyQueryParams(targetPath = window.location.pathname) {
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    window.history.replaceState({}, document.title, `${targetPath}${url.search}`);
  }

  function consumeSpotifyReturnPath() {
    const returnPath = storage.getItem(SPOTIFY_STORAGE_KEYS.returnPath) || '/';
    storage.removeItem(SPOTIFY_STORAGE_KEYS.returnPath);
    return returnPath;
  }

  function getDefaultRedirectUri() {
    if (window.location.origin === 'null') {
      return '';
    }

    return window.location.origin;
  }

  function isSpotifyConfigured(config) {
    return Boolean(
      config.clientId &&
      config.clientId !== 'YOUR_SPOTIFY_CLIENT_ID' &&
      config.redirectUri,
    );
  }

  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    const base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  return {
    closePlaylistModal,
    handleSpotifyAuthButton,
    initializeSpotify,
    likeTrack,
    openPlaylistComposer,
    renderSpotifyState,
    submitPlaylistForm,
  };
}

export { createSpotifyService };
