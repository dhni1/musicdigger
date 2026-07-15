function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  return Array.from(String(value)).reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) >>> 0;
  }, 7);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getSpotifyTrackId(track) {
  const explicitId = String(
    track?.spotifyTrackId ?? track?.spotifyId ?? track?.id ?? '',
  ).trim();
  if (/^[a-zA-Z0-9]{22}$/.test(explicitId)) {
    return explicitId;
  }

  const uriMatch = String(track?.spotifyUri ?? '').match(
    /^spotify:track:([a-zA-Z0-9]{22})$/,
  );
  if (uriMatch) {
    return uriMatch[1];
  }

  try {
    const url = new URL(track?.spotifyUrl ?? '');
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
      return '';
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const trackIndex = parts.indexOf('track');
    const urlId = parts[trackIndex + 1] ?? '';
    return /^[a-zA-Z0-9]{22}$/.test(urlId) ? urlId : '';
  } catch {
    return '';
  }
}

function makeTrackKey(track) {
  const spotifyTrackId = getSpotifyTrackId(track);
  if (spotifyTrackId) {
    return `spotify:${spotifyTrackId}`;
  }
  return `${track.title}::${track.artist}`.toLowerCase();
}

function makeTrackKeyFromSpotify(track) {
  const spotifyTrackId = getSpotifyTrackId(track);
  if (spotifyTrackId) {
    return `spotify:${spotifyTrackId}`;
  }
  const artist = track.artists?.[0]?.name ?? '';
  return `${track.name}::${artist}`.toLowerCase();
}

function createRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, byte => chars[byte % chars.length]).join('');
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export {
  clamp,
  createRandomString,
  getSpotifyTrackId,
  hashString,
  makeTrackKey,
  makeTrackKeyFromSpotify,
  safeJson,
  slugify,
};
