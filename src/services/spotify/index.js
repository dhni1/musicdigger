import {
  SPOTIFY_SCOPES,
  SPOTIFY_STORAGE_KEYS,
  elements,
  state,
} from '../../shared/context.js';
import { clearChildren, createEmptyState, sanitizeHttpUrl } from '../../shared/dom.js';
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

const PLAYBACK_POLL_INTERVAL_MS = 12000;
const PLAYBACK_BUSY_RETRY_MS = 1200;
const PLAYBACK_RATE_LIMIT_FALLBACK_MS = 30000;

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
  let playbackPollTimer = null;
  let playbackRequestInFlight = false;
  let playbackPollingActive = false;
  let playbackPollingBlocked = false;
  let playbackVisibilityBound = false;
  let playbackSessionVersion = 0;
  let progressAnimationFrame = null;
  let spotifyRefreshPromise = null;

  state.spotify.configured = isSpotifyConfigured(spotifyConfig);

  async function initializeSpotify() {
    bindPlaybackVisibility();
    hydrateSpotifyToken();
    await handleSpotifyCallback();

    if (state.spotify.accessToken) {
      await syncSpotifyData();
      if (!state.spotify.playbackNeedsReconnect) {
        startPlaybackPolling();
      }
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

    disconnectSpotify();
  }

  async function handleSpotifyRefreshButton() {
    if (!state.spotify.accessToken) {
      return;
    }

    await syncSpotifyData();
    if (!state.spotify.playbackNeedsReconnect) {
      startPlaybackPolling();
    }
  }

  async function handleVinylPlayerAction() {
    if (!state.spotify.configured) {
      updateSpotifyMessage(
        'spotify-config.js 파일에 Spotify Client ID를 넣은 뒤 다시 시도해주세요.',
      );
      return;
    }

    if (!state.spotify.accessToken || state.spotify.playbackNeedsReconnect) {
      await loginToSpotify();
      return;
    }

    const spotifyUrl = sanitizeHttpUrl(state.spotify.currentPlayback?.spotifyUrl);
    if (spotifyUrl) {
      window.open(spotifyUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    startPlaybackPolling();
  }

  function disconnectSpotify() {
    stopPlaybackPolling();
    [
      SPOTIFY_STORAGE_KEYS.token,
      SPOTIFY_STORAGE_KEYS.returnPath,
      SPOTIFY_STORAGE_KEYS.verifier,
      SPOTIFY_STORAGE_KEYS.state,
    ].forEach(key => storage.removeItem(key));

    state.spotify.accessToken = null;
    state.spotify.refreshToken = null;
    state.spotify.expiresAt = 0;
    state.spotify.profile = null;
    state.spotify.playlists = [];
    state.spotify.likedTracks = [];
    state.spotify.likedTrackKeys = new Set();
    state.spotify.trackUriCache = new Map();
    state.spotify.currentPlayback = null;
    state.spotify.playbackNeedsReconnect = false;

    renderSpotifyState();
    renderTracksForCurrentGenre();
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
    try {
      if (!(await ensureSpotifyReady(false))) {
        renderSpotifyState();
        return;
      }

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
      if (error.status === 401) {
        state.spotify.currentPlayback = null;
        state.spotify.playbackNeedsReconnect = true;
        playbackPollingBlocked = true;
        clearPlaybackPollTimer();
        renderVinylPlayer();
      }
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
        ? 'Disconnect Spotify'
        : 'Connect Spotify';
    }
    if (elements.profileSpotifyDisconnect) {
      elements.profileSpotifyDisconnect.textContent = hasAccessToken
        ? 'Disconnect Spotify'
        : 'Connect Spotify';
      elements.profileSpotifyDisconnect.disabled = false;
    }
    if (elements.profileSettingsNote) {
      elements.profileSettingsNote.textContent = hasAccessToken
        ? 'Spotify 연결 상태는 위 프로필 요약과 라이브러리 화면에서 확인할 수 있습니다.'
        : 'Spotify를 연결하면 프로필과 라이브러리 정보를 더 자세히 볼 수 있습니다.';
    }

    renderVinylPlayer();
  }

  function renderVinylPlayer() {
    if (!elements.vinylPlayer) {
      return;
    }

    const playback = state.spotify.currentPlayback;
    let playerState = 'idle';
    let status = 'VINYL PLAYER';
    let title = '재생 중인 곡 없음';
    let secondary = 'Spotify에서 음악을 재생해보세요';
    let ariaLabel = '현재 재생곡 새로고침';

    if (!state.spotify.configured) {
      playerState = 'setup';
      title = 'Spotify 설정 필요';
      secondary = 'Client ID를 확인해주세요';
      ariaLabel = 'Spotify 설정 필요';
    } else if (!state.spotify.accessToken) {
      playerState = 'connect';
      title = 'Spotify 연결';
      secondary = '현재 곡을 LP로 표시해요';
      ariaLabel = 'Spotify 연결';
    } else if (state.spotify.playbackNeedsReconnect) {
      playerState = 'reconnect';
      status = 'RECONNECT';
      title = 'Spotify 다시 연결';
      secondary = '현재 재생곡 권한이 필요해요';
      ariaLabel = '현재 재생곡 권한을 위해 Spotify 다시 연결';
    } else if (playback) {
      playerState = playback.isPlaying ? 'playing' : 'paused';
      status = playback.isPlaying ? 'PLAYING' : 'PAUSED';
      title = playback.title;
      secondary = [playback.artist, playback.album].filter(Boolean).join(' · ');
      ariaLabel = `${playback.isPlaying ? '재생 중' : '일시정지'}: ${playback.title}. Spotify에서 열기`;
    }

    elements.vinylPlayer.dataset.state = playerState;
    if (elements.vinylPlayer.getAttribute('aria-label') !== ariaLabel) {
      elements.vinylPlayer.setAttribute('aria-label', ariaLabel);
    }
    elements.vinylPlayer.title = ariaLabel;
    setTextIfChanged(elements.vinylPlayerStatus, status);
    setTextIfChanged(elements.vinylPlayerTitle, title);
    setTextIfChanged(elements.vinylPlayerArtist, secondary);

    renderVinylArtwork(playback?.albumImage);
    renderVinylProgress(playback);
  }

  function renderVinylArtwork(imageUrl) {
    const image = elements.vinylAlbumArt;
    const fallback = elements.vinylLabelFallback;
    if (!image || !fallback) {
      return;
    }

    const safeImageUrl = sanitizeHttpUrl(imageUrl);
    if (!safeImageUrl) {
      image.hidden = true;
      image.removeAttribute('src');
      delete image.dataset.source;
      fallback.hidden = false;
      return;
    }

    if (image.dataset.source === safeImageUrl) {
      const imageReady = image.complete && image.naturalWidth > 0;
      image.hidden = !imageReady;
      fallback.hidden = imageReady;
      return;
    }

    image.hidden = true;
    fallback.hidden = false;
    image.dataset.source = safeImageUrl;
    image.onload = () => {
      if (image.dataset.source !== safeImageUrl) {
        return;
      }
      image.hidden = false;
      fallback.hidden = true;
    };
    image.onerror = () => {
      if (image.dataset.source !== safeImageUrl) {
        return;
      }
      image.hidden = true;
      fallback.hidden = false;
    };
    image.src = safeImageUrl;
  }

  function renderVinylProgress(playback) {
    const fill = elements.vinylProgressFill;
    if (!fill) {
      return;
    }

    if (progressAnimationFrame !== null) {
      window.cancelAnimationFrame(progressAnimationFrame);
      progressAnimationFrame = null;
    }

    const durationMs = Math.max(0, Number(playback?.durationMs) || 0);
    const observedAt = Number(playback?.observedAt) || Date.now();
    const elapsedMs = playback?.isPlaying ? Math.max(0, Date.now() - observedAt) : 0;
    const progressMs = Math.min(
      durationMs,
      Math.max(0, Number(playback?.progressMs) || 0) + elapsedMs,
    );
    const progressPercent = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;

    fill.style.transition = 'none';
    fill.style.width = `${progressPercent}%`;

    if (!playback?.isPlaying || durationMs <= progressMs || document.hidden) {
      return;
    }

    progressAnimationFrame = window.requestAnimationFrame(() => {
      if (state.spotify.currentPlayback !== playback) {
        return;
      }
      fill.style.transition = `width ${durationMs - progressMs}ms linear`;
      fill.style.width = '100%';
      progressAnimationFrame = null;
    });
  }

  function bindPlaybackVisibility() {
    if (playbackVisibilityBound) {
      return;
    }

    document.addEventListener('visibilitychange', () => {
      clearPlaybackPollTimer();
      if (!document.hidden && playbackPollingActive && !playbackPollingBlocked) {
        void runPlaybackPoll();
      }
    });
    playbackVisibilityBound = true;
  }

  function startPlaybackPolling() {
    playbackPollingActive = true;
    playbackPollingBlocked = false;
    clearPlaybackPollTimer();

    if (!document.hidden) {
      void runPlaybackPoll();
    }
  }

  function stopPlaybackPolling() {
    playbackPollingActive = false;
    playbackPollingBlocked = false;
    playbackSessionVersion += 1;
    clearPlaybackPollTimer();
  }

  function clearPlaybackPollTimer() {
    if (playbackPollTimer !== null) {
      window.clearTimeout(playbackPollTimer);
      playbackPollTimer = null;
    }
  }

  function schedulePlaybackPoll(delayMs = PLAYBACK_POLL_INTERVAL_MS) {
    clearPlaybackPollTimer();
    if (
      !playbackPollingActive ||
      playbackPollingBlocked ||
      !state.spotify.accessToken ||
      document.hidden
    ) {
      return;
    }

    playbackPollTimer = window.setTimeout(() => {
      playbackPollTimer = null;
      void runPlaybackPoll();
    }, delayMs);
  }

  async function runPlaybackPoll() {
    if (
      !playbackPollingActive ||
      playbackPollingBlocked ||
      !state.spotify.accessToken ||
      document.hidden
    ) {
      return;
    }

    if (playbackRequestInFlight) {
      schedulePlaybackPoll(PLAYBACK_BUSY_RETRY_MS);
      return;
    }

    playbackRequestInFlight = true;
    const sessionVersion = playbackSessionVersion;
    let nextPollDelay = PLAYBACK_POLL_INTERVAL_MS;

    try {
      if (!(await ensureSpotifyReady(false))) {
        return;
      }

      const payload = await requestCurrentlyPlaying();
      if (sessionVersion !== playbackSessionVersion || !playbackPollingActive) {
        return;
      }

      state.spotify.currentPlayback = normalizeCurrentlyPlaying(payload);
      state.spotify.playbackNeedsReconnect = false;
      renderVinylPlayer();
    } catch (error) {
      if (sessionVersion !== playbackSessionVersion) {
        return;
      }

      if (error.status === 401 || error.status === 403) {
        state.spotify.currentPlayback = null;
        state.spotify.playbackNeedsReconnect = true;
        playbackPollingBlocked = true;
        renderVinylPlayer();
      } else if (error.status === 429) {
        nextPollDelay = Math.max(
          PLAYBACK_RATE_LIMIT_FALLBACK_MS,
          Number(error.retryAfterMs) || 0,
        );
      }
    } finally {
      playbackRequestInFlight = false;
      if (sessionVersion === playbackSessionVersion) {
        schedulePlaybackPoll(nextPollDelay);
      }
    }
  }

  async function requestCurrentlyPlaying() {
    try {
      return await spotifyRequest('/me/player/currently-playing?additional_types=episode');
    } catch (error) {
      if (error.status !== 401 || !state.spotify.refreshToken) {
        throw error;
      }

      let refreshed;
      try {
        refreshed = await refreshSpotifyToken();
      } catch (refreshError) {
        refreshError.status ??= 401;
        throw refreshError;
      }

      if (!refreshed) {
        throw error;
      }

      return spotifyRequest('/me/player/currently-playing?additional_types=episode');
    }
  }

  function normalizeCurrentlyPlaying(payload) {
    const item = payload?.item;
    if (!item || (item.type !== 'track' && item.type !== 'episode')) {
      return null;
    }

    const isEpisode = item.type === 'episode';
    const artist = isEpisode
      ? item.show?.publisher || item.show?.name || 'Spotify Podcast'
      : (item.artists ?? []).map(entry => entry.name).filter(Boolean).join(', ') || 'Unknown Artist';
    const album = isEpisode ? item.show?.name || 'Podcast' : item.album?.name || '';
    const images = isEpisode && item.images?.length
      ? item.images
      : isEpisode ? item.show?.images : item.album?.images;
    const durationMs = Math.max(0, Number(item.duration_ms) || 0);

    return {
      type: item.type,
      title: item.name || 'Unknown Track',
      artist,
      album,
      albumImage: images?.[0]?.url ?? '',
      durationMs,
      progressMs: Math.min(durationMs, Math.max(0, Number(payload.progress_ms) || 0)),
      isPlaying: Boolean(payload.is_playing),
      observedAt: Date.now(),
      spotifyUrl: item.external_urls?.spotify ?? '',
      spotifyUri: item.uri ?? '',
    };
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

  function setTextIfChanged(element, value) {
    if (element && element.textContent !== value) {
      element.textContent = value;
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
    if (spotifyRefreshPromise) {
      return spotifyRefreshPromise;
    }

    spotifyRefreshPromise = performSpotifyTokenRefresh();
    try {
      return await spotifyRefreshPromise;
    } finally {
      spotifyRefreshPromise = null;
    }
  }

  async function performSpotifyTokenRefresh() {
    const refreshToken = state.spotify.refreshToken;
    if (!refreshToken) {
      return false;
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: spotifyConfig.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const error = new Error('Spotify 토큰을 갱신하지 못했습니다.');
      error.status = 401;
      throw error;
    }

    const token = await response.json();
    if (state.spotify.refreshToken !== refreshToken) {
      return false;
    }

    saveSpotifyToken(token);
    return true;
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
      const responseBody = await safeJson(response);
      const error = new Error(
        responseBody?.error?.message ?? 'Spotify 요청에 실패했습니다.',
      );
      error.status = response.status;
      error.retryAfterMs = Number(response.headers.get('Retry-After')) * 1000 || 0;
      throw error;
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
    disconnectSpotify,
    handleSpotifyAuthButton,
    handleSpotifyRefreshButton,
    handleVinylPlayerAction,
    initializeSpotify,
    likeTrack,
    openPlaylistComposer,
    renderSpotifyState,
    submitPlaylistForm,
  };
}

export { createSpotifyService };
