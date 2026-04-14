import {
  clearChildren,
  createElement,
  createEmptyState,
  sanitizeHttpUrl,
  createTextBlock,
} from '../../shared/dom.js';

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
  const compactCard = buildCompactProfileCard({
    displayName: state.spotify.profile.display_name,
    getProfileInitial,
    imageUrl,
    product,
  });

  if (elements.spotifyProfileCard) {
    clearChildren(elements.spotifyProfileCard);
    elements.spotifyProfileCard.appendChild(compactCard.cloneNode(true));
  }

  if (elements.profileScreenCard) {
    const detailStack = createElement('div', { className: 'profile-detail-stack' });
    const detailGrid = createElement('div', { className: 'profile-detail-grid' });

    detailGrid.appendChild(
      createDetailChip('Plan', product),
    );
    detailGrid.appendChild(
      createDetailChip('Followers', String(followers)),
    );

    clearChildren(elements.profileScreenCard);
    detailStack.appendChild(compactCard);
    detailStack.appendChild(detailGrid);
    elements.profileScreenCard.appendChild(detailStack);
  }
}

function buildCompactProfileCard({ displayName, getProfileInitial, imageUrl, product }) {
  const profile = createElement('div', { className: 'spotify-profile' });
  const safeImageUrl = sanitizeHttpUrl(imageUrl);
  const media = safeImageUrl
    ? createElement('img', {
        className: 'spotify-profile-image',
        attributes: {
          src: safeImageUrl,
          alt: 'Spotify profile',
        },
      })
    : createTextBlock('div', getProfileInitial(), 'spotify-profile-fallback');
  const textWrap = createElement('div');

  textWrap.appendChild(createTextBlock('strong', displayName ?? 'Spotify User'));
  textWrap.appendChild(createTextBlock('p', `${product} account connected`));

  profile.appendChild(media);
  profile.appendChild(textWrap);
  return profile;
}

function createDetailChip(label, value) {
  const item = createElement('article', { className: 'detail-chip' });
  item.appendChild(createTextBlock('span', label));
  item.appendChild(createTextBlock('strong', value));
  return item;
}

function renderProfileSummary({ elements, getCurrentGenreName, state }) {
  if (!elements.profileSummary) {
    return;
  }

  clearChildren(elements.profileSummary);

  if (!state.spotify.accessToken) {
    elements.profileSummary.appendChild(
      createEmptyState(
        'Spotify를 연결하면 플레이리스트 수와 좋아요한 곡 수를 이 화면에서 바로 확인할 수 있습니다.',
      ),
    );
    return;
  }

  elements.profileSummary.appendChild(
    createSummaryCard('Playlists', String(state.spotify.playlists.length)),
  );
  elements.profileSummary.appendChild(
    createSummaryCard('Liked Tracks', String(state.spotify.likedTracks.length)),
  );
  elements.profileSummary.appendChild(
    createSummaryCard('Current Focus', getCurrentGenreName()),
  );
}

function createSummaryCard(label, value) {
  const item = createElement('article', { className: 'summary-card' });
  item.appendChild(createTextBlock('span', label));
  item.appendChild(createTextBlock('strong', value));
  return item;
}

function updateProfileSlot({ elements, state }) {
  if (!elements.profileSlot || !elements.profileAvatar) {
    return;
  }

  const imageUrl = state.spotify.profile?.images?.[0]?.url;
  elements.profileSlot.title = state.spotify.profile?.display_name ?? '프로필 화면 열기';
  const safeImageUrl = sanitizeHttpUrl(imageUrl);
  elements.profileAvatar.style.backgroundImage = safeImageUrl ? `url("${safeImageUrl}")` : '';
  elements.profileAvatar.classList.toggle('has-image', Boolean(safeImageUrl));
}

export { renderProfileCard, renderProfileSummary, updateProfileSlot };
