from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request
import base64
import json
import mimetypes
import os
import re
import threading
import time
import unicodedata


ROOT = Path(__file__).resolve().parent
GENRES_DATA_FILE = ROOT / "data" / "genres.json"
PORT = int(os.environ.get("PORT", "8000"))
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US")
TRACKS_PER_GENRE = 8
SEARCH_LIMIT = 10
TRACK_METADATA_SEARCH_LIMIT = 5
TRACK_METADATA_WORKERS = 8
SPOTIFY_REQUEST_TIMEOUT_SECONDS = 6
TRACK_METADATA_CACHE_TTL = 86400
TRACK_METADATA_MISS_TTL = 300
TRACK_METADATA_ERROR_TTL = 30
GENRE_DETAIL_CACHE_TTL = 1800
GENRE_DETAIL_PARTIAL_CACHE_TTL = 60
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
TRACK_METADATA_EXECUTOR = ThreadPoolExecutor(
    max_workers=TRACK_METADATA_WORKERS,
    thread_name_prefix="spotify-metadata",
)
TRACK_METADATA_TASK_SLOTS = threading.BoundedSemaphore(TRACK_METADATA_WORKERS * 2)


def submit_track_metadata_task(callback, *args):
    if not TRACK_METADATA_TASK_SLOTS.acquire(
        timeout=SPOTIFY_REQUEST_TIMEOUT_SECONDS
    ):
        return None

    try:
        return TRACK_METADATA_EXECUTOR.submit(run_track_metadata_task, callback, args)
    except RuntimeError:
        TRACK_METADATA_TASK_SLOTS.release()
        return None


def run_track_metadata_task(callback, args):
    try:
        return callback(*args)
    finally:
        TRACK_METADATA_TASK_SLOTS.release()
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
        self._genre_detail_cache_guard = threading.Lock()
        self._genre_detail_locks = tuple(threading.Lock() for _ in range(32))
        self._track_metadata_cache = {}
        self._track_metadata_locks = {}
        self._track_metadata_locks_guard = threading.Lock()
        self._token_lock = threading.Lock()

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
        detail_lock = self._get_genre_detail_lock(cache_key)

        with detail_lock:
            return self._get_genre_details_locked(genre, cache_key)

    def _get_genre_details_locked(self, genre, cache_key):
        self._prune_genre_detail_cache()
        with self._genre_detail_cache_guard:
            cached = self._genre_detail_cache.get(cache_key)

        if cached and time.time() - cached["time"] < cached.get(
            "ttl", GENRE_DETAIL_CACHE_TTL
        ):
            return cached["data"]

        local_genre = find_local_genre(genre, spotify_backed=self.configured())
        seed_genres = get_seed_genres(local_genre, genre)
        search_terms = get_search_terms(local_genre, genre)
        local_tracks = local_genre.get("tracks", []) if local_genre else []

        tracks = []

        if self.configured():
            try:
                tracks = (
                    self._enrich_local_tracks(local_tracks)
                    if local_tracks
                    else self._popular_tracks_for_genre(search_terms)
                )
            except RuntimeError:
                tracks = []

        if not tracks:
            tracks = local_tracks[:TRACKS_PER_GENRE]

        enriched_track_count = sum(bool(track.get("albumImage")) for track in tracks)
        if enriched_track_count == len(tracks) and tracks:
            tracks_source = "spotify"
        elif enriched_track_count:
            tracks_source = "spotify-partial"
        else:
            tracks_source = "local"
        tracks_complete = bool(tracks) and enriched_track_count == len(tracks)

        artist_names = []

        for track in tracks:
            artist_name = track.get("artist")

            if artist_name and artist_name not in artist_names:
                artist_names.append(artist_name)

            if len(artist_names) >= 4:
                break

        related_names = []

        description = build_description(local_genre or {"id": genre}, artist_names, tracks)
        data = {
            "id": local_genre.get("id", genre) if local_genre else genre,
            "name": local_genre.get("name", format_genre_name(genre)) if local_genre else format_genre_name(genre),
            "description": description,
            "subgenres": local_genre.get("subgenres", []) if local_genre else [],
            "similar": local_genre.get("similar", []) if local_genre else [],
            "fusion": local_genre.get("fusion", []) if local_genre else [],
            "tracks": tracks,
            "tracksSource": tracks_source,
            "tracksComplete": tracks_complete,
            "spotifyBacked": self.configured(),
            "aliases": local_genre.get("aliases", []) if local_genre else [],
            "spotifySeedGenres": seed_genres,
            "spotifySearchTerms": search_terms,
            "relatedNames": related_names[:8],
        }

        with self._genre_detail_cache_guard:
            self._genre_detail_cache[cache_key] = {
                "time": time.time(),
                "ttl": (
                    GENRE_DETAIL_CACHE_TTL
                    if tracks_complete or not self.configured()
                    else GENRE_DETAIL_PARTIAL_CACHE_TTL
                ),
                "data": data,
            }
        return data

    def _prune_genre_detail_cache(self):
        with self._genre_detail_cache_guard:
            self._prune_genre_detail_cache_locked()

    def _prune_genre_detail_cache_locked(self):
        now = time.time()
        expired_keys = [
            key
            for key, cached in self._genre_detail_cache.items()
            if now - cached["time"] >= cached.get("ttl", GENRE_DETAIL_CACHE_TTL)
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

    def _get_genre_detail_lock(self, cache_key):
        return self._genre_detail_locks[hash(cache_key) % len(self._genre_detail_locks)]

    def _popular_tracks_for_genre(self, search_terms):
        return self._search_tracks_for_genre(search_terms)

    def _enrich_local_tracks(self, local_tracks):
        tracks = [dict(track) for track in local_tracks[:TRACKS_PER_GENRE]]
        if not tracks:
            return []

        self._get_token()
        enriched_tracks = list(tracks)
        pending = []

        for index, track in enumerate(tracks):
            future = submit_track_metadata_task(self._enrich_local_track, track)
            if future is not None:
                pending.append((index, future))

        for index, future in pending:
            enriched_tracks[index] = future.result()

        return enriched_tracks

    def _enrich_local_track(self, track):
        if track.get("albumImage") and track.get("album"):
            return track

        cache_key = make_track_identity(track)
        if not cache_key:
            return track

        metadata_lock = self._get_track_metadata_lock(cache_key)
        with metadata_lock:
            cached = self._track_metadata_cache.get(cache_key)
            if cached and time.time() < cached["expiresAt"]:
                return {**track, **cached["metadata"]}

            try:
                metadata = self._fetch_local_track_metadata(track)
            except RuntimeError:
                self._track_metadata_cache[cache_key] = {
                    "expiresAt": time.time() + TRACK_METADATA_ERROR_TTL,
                    "metadata": {},
                }
                return track
            ttl = TRACK_METADATA_CACHE_TTL if metadata else TRACK_METADATA_MISS_TTL
            self._track_metadata_cache[cache_key] = {
                "expiresAt": time.time() + ttl,
                "metadata": metadata,
            }
            return {**track, **metadata}

    def _get_track_metadata_lock(self, cache_key):
        with self._track_metadata_locks_guard:
            return self._track_metadata_locks.setdefault(cache_key, threading.Lock())

    def _fetch_local_track_metadata(self, track):
        title = str(track.get("title", "")).strip()
        artist = str(track.get("artist", "")).strip()
        primary_artist = get_primary_artist_name(artist)

        if not title or not primary_artist:
            return {}

        clean_title = spotify_search_phrase(title)
        clean_artist = spotify_search_phrase(primary_artist)
        queries = [
            f'track:"{clean_title}" artist:"{clean_artist}"',
            f'"{clean_title}" {clean_artist}',
        ]

        for query in queries:
            data = self._spotify_get(
                "/search",
                {
                    "q": query,
                    "type": "track",
                    "limit": str(TRACK_METADATA_SEARCH_LIMIT),
                    "market": SPOTIFY_MARKET,
                },
            )

            items = data.get("tracks", {}).get("items", [])
            if not items:
                continue

            scored_items = [(score_track_match(track, item), item) for item in items]
            best_score, best_match = max(scored_items, key=lambda pair: pair[0])
            if best_score >= 10:
                mapped = map_track(best_match)
                return {
                    "album": mapped.get("album", ""),
                    "albumImage": mapped.get("albumImage"),
                    "durationMs": mapped.get("durationMs"),
                    "spotifyUri": mapped.get("spotifyUri"),
                    "spotifyUrl": mapped.get("spotifyUrl"),
                }

        return {}

    def _search_tracks_for_genre(self, search_terms):
        candidates = []

        for term in search_terms:
            if not term:
                continue

            query = f'genre:"{term}"'
            try:
                data = self._spotify_get(
                    "/search",
                    {
                        "q": query,
                        "type": "track",
                        "limit": str(SEARCH_LIMIT),
                        "market": SPOTIFY_MARKET,
                    },
                )
            except RuntimeError:
                continue
            items = data.get("tracks", {}).get("items", [])

            if items:
                candidates = merge_tracks(candidates, [map_track(item) for item in items])
                if len(candidates) >= TRACKS_PER_GENRE:
                    return candidates[:TRACKS_PER_GENRE]

        for term in search_terms:
            if not term:
                continue

            try:
                fallback = self._spotify_get(
                    "/search",
                    {
                        "q": term,
                        "type": "track",
                        "limit": str(SEARCH_LIMIT),
                        "market": SPOTIFY_MARKET,
                    },
                )
            except RuntimeError:
                continue
            items = fallback.get("tracks", {}).get("items", [])

            if items:
                candidates = merge_tracks(candidates, [map_track(item) for item in items])
                if len(candidates) >= TRACKS_PER_GENRE:
                    return candidates[:TRACKS_PER_GENRE]

        return candidates[:TRACKS_PER_GENRE]

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
            with request.urlopen(req, timeout=SPOTIFY_REQUEST_TIMEOUT_SECONDS) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(payload or f"Spotify API error: {exc.code}") from exc
        except (error.URLError, TimeoutError) as exc:
            reason = getattr(exc, "reason", str(exc))
            raise RuntimeError(f"Spotify API connection failed: {reason}") from exc

    def _get_token(self):
        if self._token and time.time() < self._expires_at - 60:
            return self._token

        with self._token_lock:
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
                with request.urlopen(req, timeout=SPOTIFY_REQUEST_TIMEOUT_SECONDS) as response:
                    data = json.loads(response.read().decode("utf-8"))
            except error.HTTPError as exc:
                payload = exc.read().decode("utf-8", errors="ignore")
                raise RuntimeError(payload or "Failed to fetch Spotify token") from exc
            except (error.URLError, TimeoutError) as exc:
                reason = getattr(exc, "reason", str(exc))
                raise RuntimeError(f"Spotify token request failed: {reason}") from exc

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

        return self._send_json(
            200,
            {"genres": genres},
            cache_control="public, max-age=3600, stale-while-revalidate=86400",
        )

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

        cache_control = (
            f"public, max-age={GENRE_DETAIL_CACHE_TTL}, stale-while-revalidate=86400"
            if detail.get("tracksComplete")
            else (
                f"public, max-age={GENRE_DETAIL_PARTIAL_CACHE_TTL}, "
                f"stale-while-revalidate={GENRE_DETAIL_PARTIAL_CACHE_TTL}"
            )
        )
        return self._send_json(
            200,
            {"genre": detail},
            cache_control=cache_control,
        )

    def _send_json(self, status, payload, cache_control=None):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if cache_control:
            self.send_header("Cache-Control", cache_control)
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
    album = item.get("album", {}) or {}
    album_images = album.get("images", []) or []
    album_image = album_images[0].get("url") if album_images else None
    return {
        "title": item.get("name", "Unknown Track"),
        "artist": artist.get("name", "Unknown Artist"),
        "artistId": artist.get("id"),
        "album": album.get("name", ""),
        "albumImage": album_image,
        "durationMs": item.get("duration_ms"),
        "spotifyUri": item.get("uri"),
        "spotifyUrl": item.get("external_urls", {}).get("spotify"),
        "popularity": item.get("popularity", 0),
    }


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
        for candidate in [genre.get("id", ""), genre.get("name", "")]:
            key = normalize_genre_name(candidate)
            if key:
                index[key] = genre

    for genre in local_genres:
        for alias in genre.get("aliases", []):
            key = normalize_genre_name(alias)
            if key:
                index.setdefault(key, genre)

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


def genre_to_seed(value):
    return normalize_genre_name(value).replace(" ", "-")


def format_search_label(value):
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ").replace("-", " ")).strip()


def format_genre_name(name):
    return " ".join(part.capitalize() for part in name.replace("_", " ").replace("-", " ").split())


def get_primary_artist_name(name):
    parts = re.split(
        r"\s+(?:feat(?:uring)?\.?|ft\.?)\s+",
        str(name or ""),
        maxsplit=1,
        flags=re.IGNORECASE,
    )
    return parts[0].strip() if parts else ""


def spotify_search_phrase(value):
    return re.sub(r"\s+", " ", re.sub(r'["\\]+', " ", str(value or ""))).strip()


def normalize_track_text(value):
    decomposed = unicodedata.normalize("NFKD", str(value or "").casefold())
    without_marks = "".join(
        character
        for character in decomposed
        if unicodedata.category(character) != "Mn"
    )
    normalized = unicodedata.normalize("NFC", without_marks)
    return re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE).strip()


def get_artist_tokens(value):
    connector_tokens = {"and", "feat", "featuring", "ft", "vs", "with", "x", "×"}
    return {
        token
        for token in normalize_track_text(value).split()
        if token not in connector_tokens
    }


def score_track_match(target, candidate):
    target_title = normalize_track_text(target.get("title", ""))
    candidate_title = normalize_track_text(candidate.get("name", ""))
    target_artist = normalize_track_text(get_primary_artist_name(target.get("artist", "")))
    candidate_artist = normalize_track_text(
        " ".join(artist.get("name", "") for artist in (candidate.get("artists", []) or []))
    )

    title_score = 0
    if target_title and candidate_title:
        if target_title == candidate_title:
            title_score = 8
        elif (
            candidate_title.startswith(f"{target_title} ")
            or target_title.startswith(f"{candidate_title} ")
        ):
            title_score = 5
        elif target_title in candidate_title or candidate_title in target_title:
            title_score = 2

    artist_score = 0
    if target_artist and candidate_artist:
        target_artist_tokens = get_artist_tokens(target_artist)
        candidate_artist_tokens = get_artist_tokens(candidate_artist)
        if target_artist == candidate_artist:
            artist_score = 5
        elif (
            target_artist_tokens
            and candidate_artist_tokens
            and (
                target_artist_tokens.issubset(candidate_artist_tokens)
                or candidate_artist_tokens.issubset(target_artist_tokens)
            )
        ):
            artist_score = 5
        elif target_artist in candidate_artist or candidate_artist in target_artist:
            artist_score = 3

    return title_score + artist_score


def normalize_genre_name(name):
    return re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()


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
