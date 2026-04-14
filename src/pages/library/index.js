function renderPlaylistList({ elements, state }) {
  if (!state.spotify.accessToken) {
    elements.playlistList.innerHTML =
      '<div class="empty-state">Spotify에 로그인하면 플레이리스트를 여기서 확인할 수 있습니다.</div>';
    return;
  }

  if (state.spotify.playlists.length === 0) {
    elements.playlistList.innerHTML =
      '<div class="empty-state">Spotify 플레이리스트가 아직 없습니다.</div>';
    return;
  }

  elements.playlistList.innerHTML = '';

  state.spotify.playlists.forEach(playlist => {
    const item = document.createElement('article');
    item.className = 'playlist-item';
    const total = playlist.items?.total ?? playlist.tracks?.total ?? 0;

    item.innerHTML = `
      <strong>${playlist.name}</strong>
      <span>${total} tracks</span>
      <a class="playlist-link" href="${playlist.external_urls?.spotify ?? '#'}" target="_blank" rel="noreferrer">
        Open in Spotify
      </a>
    `;

    elements.playlistList.appendChild(item);
  });
}

function renderLikedTracks({ elements, state }) {
  if (!state.spotify.accessToken) {
    elements.likedTrackList.innerHTML =
      '<div class="empty-state">Spotify에 로그인하면 좋아요한 곡을 여기서 확인할 수 있습니다.</div>';
    return;
  }

  if (state.spotify.likedTracks.length === 0) {
    elements.likedTrackList.innerHTML =
      '<div class="empty-state">좋아요한 Spotify 트랙이 아직 없습니다.</div>';
    return;
  }

  elements.likedTrackList.innerHTML = '';

  state.spotify.likedTracks.forEach(track => {
    const artist = track.artists?.map(item => item.name).join(', ') ?? 'Unknown Artist';
    const item = document.createElement('article');
    item.className = 'liked-track-item';
    item.innerHTML = `
      <strong>${track.name}</strong>
      <span>${artist}</span>
      <a class="liked-track-link" href="${track.external_urls?.spotify ?? '#'}" target="_blank" rel="noreferrer">
        Open in Spotify
      </a>
    `;
    elements.likedTrackList.appendChild(item);
  });
}

export { renderLikedTracks, renderPlaylistList };
