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

const SPOTIFY_ALBUM_IMAGE_VARIANTS = {
  small: 'ab67616d00004851',
  medium: 'ab67616d00001e02',
  large: 'ab67616d0000b273',
};
const SPOTIFY_ALBUM_IMAGE_PATH_RE =
  /^\/image\/ab67616d(?:00004851|00001e02|0000b273)([a-z0-9]{24})$/i;

function getOptimizedSpotifyImageUrls(imageSources, preferredSize = 'medium') {
  const originals = [...new Set(
    (Array.isArray(imageSources) ? imageSources : [imageSources])
      .map(value => String(value ?? '').trim())
      .filter(Boolean),
  )];
  const variantOrder = {
    small: ['small', 'medium', 'large'],
    medium: ['medium', 'large', 'small'],
    large: ['large', 'medium', 'small'],
  }[preferredSize] ?? ['medium', 'large', 'small'];
  const optimized = [];

  originals.forEach(source => {
    try {
      const url = new URL(source);
      const match =
        url.protocol === 'https:' && url.hostname === 'i.scdn.co'
          ? url.pathname.match(SPOTIFY_ALBUM_IMAGE_PATH_RE)
          : null;

      if (!match) {
        return;
      }

      variantOrder.forEach(size => {
        const variantUrl = new URL(url.href);
        variantUrl.pathname = `/image/${SPOTIFY_ALBUM_IMAGE_VARIANTS[size]}${match[1]}`;
        optimized.push(variantUrl.href);
      });
    } catch {
      // Keep unknown providers unchanged and use their original URL below.
    }
  });

  return [...new Set([...optimized, ...originals])];
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
  getOptimizedSpotifyImageUrls,
  getSpotifyTrackId,
  hashString,
  makeTrackKey,
  makeTrackKeyFromSpotify,
  safeJson,
  slugify,
};
