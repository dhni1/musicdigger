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

function makeTrackKey(track) {
  return `${track.title}::${track.artist}`.toLowerCase();
}

function makeTrackKeyFromSpotify(track) {
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
  hashString,
  makeTrackKey,
  makeTrackKeyFromSpotify,
  safeJson,
  slugify,
};
