function renderProfileCard({ elements, getProfileInitial, state, updateSpotifyMessage }) {
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
  const compactMarkup = buildCompactProfileMarkup({
    displayName: state.spotify.profile.display_name,
    getProfileInitial,
    imageUrl,
    product,
  });

  if (elements.spotifyProfileCard) {
    elements.spotifyProfileCard.innerHTML = compactMarkup;
  }

  if (elements.profileScreenCard) {
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
}

function buildCompactProfileMarkup({ displayName, getProfileInitial, imageUrl, product }) {
  return `
    <div class="spotify-profile">
      ${
        imageUrl
          ? `<img class="spotify-profile-image" src="${imageUrl}" alt="Spotify profile">`
          : `<div class="spotify-profile-fallback">${getProfileInitial()}</div>`
      }
      <div>
        <strong>${displayName ?? 'Spotify User'}</strong>
        <p>${product} account connected</p>
      </div>
    </div>
  `;
}

function renderProfileSummary({ elements, getCurrentGenreName, state }) {
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

function updateProfileSlot({ elements, state }) {
  if (!elements.profileSlot || !elements.profileAvatar) {
    return;
  }

  const imageUrl = state.spotify.profile?.images?.[0]?.url;
  elements.profileSlot.title = state.spotify.profile?.display_name ?? '프로필 화면 열기';
  elements.profileAvatar.style.backgroundImage = imageUrl ? `url("${imageUrl}")` : '';
  elements.profileAvatar.classList.toggle('has-image', Boolean(imageUrl));
}

export { renderProfileCard, renderProfileSummary, updateProfileSlot };
