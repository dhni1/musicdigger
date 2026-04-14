import {
  clearChildren,
  createElement,
  createEmptyState,
  createExternalLink,
  createTextBlock,
} from '../../shared/dom.js';

function renderPlaylistList({ elements, state }) {
  if (!state.spotify.accessToken) {
    clearChildren(elements.playlistList);
    elements.playlistList.appendChild(
      createEmptyState('Spotify에 로그인하면 플레이리스트를 여기서 확인할 수 있습니다.'),
    );
    return;
  }

  if (state.spotify.playlists.length === 0) {
    clearChildren(elements.playlistList);
    elements.playlistList.appendChild(
      createEmptyState('Spotify 플레이리스트가 아직 없습니다.'),
    );
    return;
  }

  clearChildren(elements.playlistList);

  state.spotify.playlists.forEach(playlist => {
    const item = createElement('article', { className: 'playlist-item' });
    const total = playlist.items?.total ?? playlist.tracks?.total ?? 0;

    item.appendChild(createTextBlock('strong', playlist.name ?? 'Untitled Playlist'));
    item.appendChild(createTextBlock('span', `${total} tracks`));
    item.appendChild(
      createExternalLink(
        playlist.external_urls?.spotify,
        'Open in Spotify',
        'playlist-link',
      ),
    );

    elements.playlistList.appendChild(item);
  });
}

function renderLikedTracks({ elements, state }) {
  if (!state.spotify.accessToken) {
    clearChildren(elements.likedTrackList);
    elements.likedTrackList.appendChild(
      createEmptyState('Spotify에 로그인하면 좋아요한 곡을 여기서 확인할 수 있습니다.'),
    );
    return;
  }

  if (state.spotify.likedTracks.length === 0) {
    clearChildren(elements.likedTrackList);
    elements.likedTrackList.appendChild(
      createEmptyState('좋아요한 Spotify 트랙이 아직 없습니다.'),
    );
    return;
  }

  clearChildren(elements.likedTrackList);

  state.spotify.likedTracks.forEach(track => {
    const artist = track.artists?.map(item => item.name).join(', ') ?? 'Unknown Artist';
    const item = createElement('article', { className: 'liked-track-item' });
    item.appendChild(createTextBlock('strong', track.name ?? 'Unknown Track'));
    item.appendChild(createTextBlock('span', artist));
    item.appendChild(
      createExternalLink(
        track.external_urls?.spotify,
        'Open in Spotify',
        'liked-track-link',
      ),
    );
    elements.likedTrackList.appendChild(item);
  });
}

export { renderLikedTracks, renderPlaylistList };
