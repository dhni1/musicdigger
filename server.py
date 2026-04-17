from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request
import base64
import json
import mimetypes
import os
import re
import time


ROOT = Path(__file__).resolve().parent
GENRES_DATA_FILE = ROOT / "data" / "genres.json"
PORT = int(os.environ.get("PORT", "8000"))
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US")
TRACKS_PER_GENRE = 8
SEARCH_LIMIT = 50
ARTIST_SEARCH_LIMIT = 12
ARTIST_POOL_SIZE = 12
GENRE_DETAIL_CACHE_TTL = 1800
GENRE_DETAIL_CACHE_MAX_ITEMS = 256
GENRE_QUERY_MAX_LENGTH = 80
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_MAX_REQUESTS = 120
ALLOWED_ORIGINS = {
    origin.strip()
    for origin in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://musicdigger.vercel.app,http://127.0.0.1:8000,http://localhost:8000",
    ).split(",")
    if origin.strip()
}
PUBLIC_ROOT_FILES = {
    "index.html",
    "design.css",
    "script.js",
    "config.js",
    "spotify-config.js",
}
PUBLIC_PREFIXES = ("src/", "styles/", "data/")
CLIENT_ROUTES = {
    "/",
    "/feed/playlists",
    "/library",
    "/map",
    "/profile",
    "/settings",
}
GENRE_QUERY_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9 &'(),./-]{0,79}$")


class SpotifyCatalog:
    def __init__(self):
        self._token = None
        self._expires_at = 0
        self._genres_cache = None
        self._genres_cache_time = 0
        self._genre_detail_cache = {}

    def configured(self):
        return bool(SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)

    def get_genres(self):
        if self._genres_cache and time.time() - self._genres_cache_time < 3600:
            return self._genres_cache

        genres = load_local_genres(spotify_backed=self.configured())
        self._genres_cache = genres
        self._genres_cache_time = time.time()
        return genres

    def get_genre_details(self, genre):
        cache_key = genre.lower()
        self._prune_genre_detail_cache()
        cached = self._genre_detail_cache.get(cache_key)

        if cached and time.time() - cached["time"] < GENRE_DETAIL_CACHE_TTL:
            return cached["data"]

        local_genre = find_local_genre(genre, spotify_backed=self.configured())
        seed_genres = get_seed_genres(local_genre, genre)
        search_terms = get_search_terms(local_genre, genre)
        local_tracks = local_genre.get("tracks", []) if local_genre else []

        tracks = []

        if self.configured():
            try:
                tracks = self._popular_tracks_for_genre(seed_genres, search_terms)
            except RuntimeError:
                tracks = []

        if not tracks:
            tracks = local_tracks[:TRACKS_PER_GENRE]

        artist_ids = []
        artist_names = []

        for track in tracks:
            artist_id = track.get("artistId")
            artist_name = track.get("artist")

            if artist_id and artist_id not in artist_ids:
                artist_ids.append(artist_id)

            if artist_name and artist_name not in artist_names:
                artist_names.append(artist_name)

            if len(artist_ids) >= 4:
                break

        related_pool = []
        for artist_id in artist_ids:
            try:
                artist = self._spotify_get(f"/artists/{artist_id}")
            except RuntimeError:
                continue
            related_pool.extend(artist.get("genres", []))

        related_names = []
        current = normalize_genre_name(genre)
        for name in related_pool:
            normalized = normalize_genre_name(name)
            if normalized == current:
                continue
            if name not in related_names:
                related_names.append(name)

        description = build_description(local_genre or {"id": genre}, artist_names, tracks)
        data = {
            "id": local_genre.get("id", genre) if local_genre else genre,
            "name": local_genre.get("name", format_genre_name(genre)) if local_genre else format_genre_name(genre),
            "description": description,
            "subgenres": local_genre.get("subgenres", []) if local_genre else [],
            "similar": local_genre.get("similar", []) if local_genre else [],
            "fusion": local_genre.get("fusion", []) if local_genre else [],
            "tracks": tracks,
            "spotifyBacked": self.configured(),
            "aliases": local_genre.get("aliases", []) if local_genre else [],
            "spotifySeedGenres": seed_genres,
            "spotifySearchTerms": search_terms,
            "relatedNames": related_names[:8],
        }

        self._genre_detail_cache[cache_key] = {
            "time": time.time(),
            "data": data,
        }
        return data

    def _prune_genre_detail_cache(self):
        now = time.time()
        expired_keys = [
            key
            for key, cached in self._genre_detail_cache.items()
            if now - cached["time"] >= GENRE_DETAIL_CACHE_TTL
        ]

        for key in expired_keys:
            self._genre_detail_cache.pop(key, None)

        if len(self._genre_detail_cache) <= GENRE_DETAIL_CACHE_MAX_ITEMS:
            return

        overflow = len(self._genre_detail_cache) - GENRE_DETAIL_CACHE_MAX_ITEMS
        oldest_keys = sorted(
            self._genre_detail_cache,
            key=lambda key: self._genre_detail_cache[key]["time"],
        )[:overflow]

        for key in oldest_keys:
            self._genre_detail_cache.pop(key, None)

    def _popular_tracks_for_genre(self, seed_genres, search_terms):
        ranked_tracks = []

        try:
            ranked_tracks = self._search_tracks_for_genre(search_terms)
        except RuntimeError:
            ranked_tracks = []

        if len(ranked_tracks) >= TRACKS_PER_GENRE:
            return ranked_tracks[:TRACKS_PER_GENRE]

        recommended_tracks = []

        try:
            recommended_tracks = self._recommend_tracks_for_genre(seed_genres)
        except RuntimeError:
            recommended_tracks = []

        artist_top_tracks = []

        try:
            artist_top_tracks = self._artist_top_tracks_for_genre(search_terms, seed_genres)
        except RuntimeError:
            artist_top_tracks = []

        merged = merge_tracks(ranked_tracks, recommended_tracks)
        merged = merge_tracks(merged, artist_top_tracks)
        return rank_tracks(merged)[:TRACKS_PER_GENRE]

    def _recommend_tracks_for_genre(self, seed_genres):
        seed_values = ",".join(seed_genres[:5])
        data = self._spotify_get(
            "/recommendations",
            {
                "limit": str(TRACKS_PER_GENRE),
                "market": SPOTIFY_MARKET,
                "seed_genres": seed_values,
            },
        )
        items = data.get("tracks", [])
        tracks = [map_track(item) for item in items]
        return rank_tracks(tracks)

    def _search_tracks_for_genre(self, search_terms):
        candidates = []

        for term in search_terms:
            if not term:
                continue

            query = f'genre:"{term}"'
            data = self._spotify_get(
                "/search",
                {
                    "q": query,
                    "type": "track",
                    "limit": str(SEARCH_LIMIT),
                    "market": SPOTIFY_MARKET,
                },
            )
            items = data.get("tracks", {}).get("items", [])

            if items:
                candidates.extend(map_track(item) for item in items)
                ranked = rank_tracks(candidates)
                if len(ranked) >= TRACKS_PER_GENRE:
                    return ranked[:TRACKS_PER_GENRE]

        for term in search_terms:
            if not term:
                continue

            fallback = self._spotify_get(
                "/search",
                {
                    "q": term,
                    "type": "track",
                    "limit": str(SEARCH_LIMIT),
                    "market": SPOTIFY_MARKET,
                },
            )
            items = fallback.get("tracks", {}).get("items", [])

            if items:
                candidates.extend(map_track(item) for item in items)
                ranked = rank_tracks(candidates)
                if len(ranked) >= TRACKS_PER_GENRE:
                    return ranked[:TRACKS_PER_GENRE]

        return rank_tracks(candidates)[:TRACKS_PER_GENRE]

    def _artist_top_tracks_for_genre(self, search_terms, seed_genres):
        artist_ids = []
        targets = build_genre_targets(search_terms, seed_genres)

        for term in search_terms:
            if not term:
                continue

            data = self._spotify_get(
                "/search",
                {
                    "q": term,
                    "type": "artist",
                    "limit": str(ARTIST_SEARCH_LIMIT),
                    "market": SPOTIFY_MARKET,
                },
            )
            items = data.get("artists", {}).get("items", [])

            for artist in items:
                artist_id = artist.get("id")
                if not artist_id or artist_id in artist_ids:
                    continue
                if not artist_matches_genre(artist, targets):
                    continue

                artist_ids.append(artist_id)
                if len(artist_ids) >= ARTIST_POOL_SIZE:
                    break

            if len(artist_ids) >= ARTIST_POOL_SIZE:
                break

        tracks = []

        for artist_id in artist_ids:
            data = self._spotify_get(
                f"/artists/{artist_id}/top-tracks",
                {"market": SPOTIFY_MARKET},
            )
            tracks.extend(map_track(item) for item in data.get("tracks", []))
            ranked = rank_tracks(tracks)
            if len(ranked) >= TRACKS_PER_GENRE:
                return ranked[:TRACKS_PER_GENRE]

        return rank_tracks(tracks)

    def _spotify_get(self, path, params=None):
        token = self._get_token()
        query = ""
        if params:
            query = "?" + parse.urlencode(params)

        req = request.Request(
            f"https://api.spotify.com/v1{path}{query}",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
        )

        try:
            with request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(payload or f"Spotify API error: {exc.code}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Spotify API connection failed: {exc.reason}") from exc

    def _get_token(self):
        if self._token and time.time() < self._expires_at - 60:
            return self._token

        raw = f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode("utf-8")
        basic = base64.b64encode(raw).decode("utf-8")
        body = parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
        req = request.Request(
            "https://accounts.spotify.com/api/token",
            data=body,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )

        try:
            with request.urlopen(req, timeout=20) as response:
                data = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(payload or "Failed to fetch Spotify token") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Spotify token request failed: {exc.reason}") from exc

        self._token = data["access_token"]
        self._expires_at = time.time() + int(data.get("expires_in", 3600))
        return self._token


catalog = SpotifyCatalog()
RATE_LIMIT_BUCKETS = {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = parse.urlparse(self.path)

        if parsed.path.startswith("/api/"):
            if not self._allow_rate_limited_request():
                return self._send_json(429, {"error": "Too many requests. Please try again later."})

        if parsed.path == "/api/genres":
            self._handle_genres()
            return

        if parsed.path == "/api/genre-details":
            self._handle_genre_details(parsed.query)
            return

        self._serve_public_asset(parsed.path)

    def do_OPTIONS(self):
        if not self.path.startswith("/api/"):
            self.send_response(204)
            self.end_headers()
            return

        self.send_response(204)
        self._apply_cors_headers()
        self.end_headers()

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=()",
        )
        self.send_header(
            "Content-Security-Policy",
            (
                "default-src 'self'; "
                "base-uri 'self'; "
                "object-src 'none'; "
                "frame-ancestors 'none'; "
                "img-src 'self' https: data: blob:; "
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
                "font-src 'self' https://fonts.gstatic.com data:; "
                "script-src 'self'; "
                "connect-src 'self' https://api.spotify.com https://accounts.spotify.com "
                "https://musicdigger.onrender.com http://127.0.0.1:8000 http://localhost:8000"
            ),
        )
        super().end_headers()

    def _handle_genres(self):
        try:
            genres = catalog.get_genres()
        except RuntimeError as exc:
            return self._send_json(502, {"error": str(exc)})

        return self._send_json(200, {"genres": genres})

    def _handle_genre_details(self, query):
        if not catalog.configured():
            return self._send_json(
                503,
                {"error": "Spotify server credentials are not configured."},
            )

        params = parse.parse_qs(query)
        genre = params.get("genre", [""])[0].strip()

        if not genre:
            return self._send_json(400, {"error": "genre query parameter is required."})

        if not self._is_valid_genre_query(genre):
            return self._send_json(400, {"error": "genre query parameter is invalid."})

        try:
            detail = catalog.get_genre_details(genre)
        except RuntimeError as exc:
            return self._send_json(502, {"error": str(exc)})

        return self._send_json(200, {"genre": detail})

    def _send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._apply_cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def _apply_cors_headers(self):
        origin = self.headers.get("Origin")
        if origin and origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _allow_rate_limited_request(self):
        now = time.time()
        client_ip = self.client_address[0]
        requests = RATE_LIMIT_BUCKETS.get(client_ip, [])
        recent = [timestamp for timestamp in requests if now - timestamp < RATE_LIMIT_WINDOW_SECONDS]

        if len(recent) >= RATE_LIMIT_MAX_REQUESTS:
            RATE_LIMIT_BUCKETS[client_ip] = recent
            return False

        recent.append(now)
        RATE_LIMIT_BUCKETS[client_ip] = recent
        return True

    def _is_valid_genre_query(self, genre):
        if len(genre) > GENRE_QUERY_MAX_LENGTH:
            return False

        return bool(GENRE_QUERY_RE.fullmatch(genre))

    def _serve_public_asset(self, request_path):
        asset_path = resolve_public_asset_path(request_path)

        if asset_path is None:
            self.send_error(404)
            return

        try:
            data = asset_path.read_bytes()
        except OSError:
            self.send_error(404)
            return

        content_type, _ = mimetypes.guess_type(str(asset_path))
        self.send_response(200)
        self.send_header(
            "Content-Type",
            content_type or "application/octet-stream",
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def resolve_public_asset_path(request_path):
    normalized_path = parse.unquote(request_path or "/")
    normalized_path = normalized_path.rstrip("/") or "/"

    if normalized_path in {"", "/"}:
        relative_path = "index.html"
    else:
        relative_path = normalized_path.lstrip("/")

    if not is_public_asset(relative_path):
        if normalized_path in CLIENT_ROUTES:
            return ROOT / "index.html"
        return None

    asset_path = (ROOT / relative_path).resolve()

    if ROOT != asset_path and ROOT not in asset_path.parents:
        return None

    if not asset_path.is_file():
        return None

    return asset_path


def is_public_asset(relative_path):
    if relative_path in PUBLIC_ROOT_FILES:
        return True

    return any(relative_path.startswith(prefix) for prefix in PUBLIC_PREFIXES)


def map_track(item):
    artist = item.get("artists", [{}])[0]
    return {
        "title": item.get("name", "Unknown Track"),
        "artist": artist.get("name", "Unknown Artist"),
        "artistId": artist.get("id"),
        "album": item.get("album", {}).get("name", ""),
        "spotifyUri": item.get("uri"),
        "spotifyUrl": item.get("external_urls", {}).get("spotify"),
        "popularity": item.get("popularity", 0),
    }


def rank_tracks(tracks):
    unique = merge_tracks(tracks, [])
    return sorted(
        unique,
        key=lambda track: (
            -int(track.get("popularity", 0) or 0),
            normalize_genre_name(track.get("title", "")),
            normalize_genre_name(track.get("artist", "")),
        ),
    )


def merge_tracks(primary_tracks, secondary_tracks):
    merged = []
    seen = set()

    for track in [*primary_tracks, *secondary_tracks]:
        key = make_track_identity(track)
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(track)

    return merged


def make_track_identity(track):
    title = normalize_genre_name(track.get("title", ""))
    artist = normalize_genre_name(track.get("artist", ""))

    if not title and not artist:
        return ""

    return f"{title}::{artist}"


def load_local_genres(spotify_backed):
    try:
        payload = json.loads(GENRES_DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    genres = payload.get("genres", [])
    normalized = []

    for genre in genres:
        normalized.append(
            {
                "id": genre.get("id", ""),
                "name": genre.get("name") or format_genre_name(genre.get("id", "")),
                "description": genre.get("description", ""),
                "subgenres": genre.get("subgenres", []),
                "similar": genre.get("similar", []),
                "fusion": genre.get("fusion", []),
                "tracks": genre.get("tracks", []),
                "aliases": genre.get("aliases", []),
                "spotifySeedGenres": genre.get("spotifySeedGenres", []),
                "spotifySearchTerms": genre.get("spotifySearchTerms", []),
                "spotifyBacked": spotify_backed,
            }
        )

    return normalized


def merge_seed_genres(local_genres, seeds):
    local_index = build_local_genre_index(local_genres)
    merged = []
    seen = set()

    for seed in sorted(seeds):
        key = normalize_genre_name(seed)
        local = local_index.get(key, {})
        merged.append(
            {
                "id": seed,
                "name": local.get("name") or format_genre_name(seed),
                "description": local.get("description")
                or f"Spotify 추천 장르 seed: {format_genre_name(seed)}",
                "subgenres": local.get("subgenres", []),
                "similar": local.get("similar", []),
                "fusion": local.get("fusion", []),
                "tracks": local.get("tracks", []),
                "aliases": local.get("aliases", []),
                "spotifySeedGenres": local.get("spotifySeedGenres", [seed]),
                "spotifySearchTerms": local.get("spotifySearchTerms", [format_genre_name(seed)]),
                "spotifyBacked": True,
            }
        )
        seen.add(key)

    for genre in local_genres:
        key = normalize_genre_name(genre.get("id", ""))
        if key and key not in seen:
            merged.append({**genre, "spotifyBacked": True})

    return merged


def find_local_genre(query, spotify_backed):
    target = normalize_genre_name(query)

    return build_local_genre_index(load_local_genres(spotify_backed=spotify_backed)).get(target)


def build_local_genre_index(local_genres):
    index = {}

    for genre in local_genres:
        for candidate in [genre.get("id", ""), genre.get("name", ""), *genre.get("aliases", [])]:
            key = normalize_genre_name(candidate)
            if key:
                index[key] = genre

    return index


def get_seed_genres(local_genre, fallback_value):
    candidates = []

    if local_genre:
        candidates.extend(local_genre.get("spotifySeedGenres", []))
        candidates.append(local_genre.get("id", ""))
        candidates.extend(local_genre.get("aliases", []))

    candidates.append(fallback_value)

    seeds = []
    seen = set()

    for candidate in candidates:
        seed = genre_to_seed(candidate)
        if seed and seed not in seen:
            seeds.append(seed)
            seen.add(seed)

    return seeds


def get_search_terms(local_genre, fallback_value):
    candidates = []

    if local_genre:
        candidates.extend(local_genre.get("spotifySearchTerms", []))
        candidates.append(local_genre.get("name", ""))
        candidates.append(local_genre.get("id", ""))
        candidates.extend(local_genre.get("aliases", []))

    candidates.append(fallback_value)

    terms = []
    seen = set()

    for candidate in candidates:
        label = format_search_label(candidate)
        key = normalize_genre_name(label)
        if key and key not in seen:
            terms.append(label)
            seen.add(key)

    return terms


def build_genre_targets(search_terms, seed_genres):
    targets = []
    seen = set()

    for candidate in [*search_terms, *seed_genres]:
        normalized = normalize_genre_name(format_search_label(candidate))
        if normalized and normalized not in seen:
            targets.append(normalized)
            seen.add(normalized)

    return targets


def genre_to_seed(value):
    return normalize_genre_name(value).replace(" ", "-")


def format_search_label(value):
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ").replace("-", " ")).strip()


def format_genre_name(name):
    return " ".join(part.capitalize() for part in name.replace("_", " ").replace("-", " ").split())


def normalize_genre_name(name):
    return re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()


def artist_matches_genre(artist, targets):
    artist_genres = [normalize_genre_name(item) for item in artist.get("genres", [])]

    if not artist_genres or not targets:
        return False

    for artist_genre in artist_genres:
        for target in targets:
            if (
                artist_genre == target
                or target in artist_genre
                or artist_genre in target
            ):
                return True

    return False


def build_description(genre, artist_names, tracks):
    display = genre.get("name") or format_genre_name(genre.get("id", ""))
    if genre.get("description"):
        return genre["description"]
    if artist_names or tracks:
        return f"Spotify 추천을 바탕으로 {display}의 대표적인 분위기와 결을 살펴볼 수 있습니다."
    return f"Spotify에서 {display} 장르 추천 곡을 찾지 못했습니다."


def main():
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f"MusicDigger server running at http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
