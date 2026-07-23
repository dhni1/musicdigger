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
GENRES_EXPANSION_FILE = ROOT / "data" / "genre-expansion.json"
PORT = int(os.environ.get("PORT", "8000"))
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US")
TRACKS_PER_GENRE = 8
SEARCH_LIMIT = 10
TRACK_METADATA_SEARCH_LIMIT = 10
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
    "apple-touch-icon.png",
    "favicon.ico",
    "favicon.svg",
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
SPOTIFY_TRACK_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")


class SpotifyRateLimitError(RuntimeError):
    def __init__(self, message, retry_after_seconds=0):
        super().__init__(message)
        self.retry_after_seconds = max(0, int(retry_after_seconds or 0))


def parse_retry_after_seconds(value, default=1):
    try:
        return max(1, int(float(value)))
    except (TypeError, ValueError):
        return max(1, int(default))


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
        self._rate_limit_lock = threading.Lock()
        self._rate_limited_until = 0

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
        tracks_complete = (
            len(tracks) >= TRACKS_PER_GENRE
            and enriched_track_count == len(tracks)
        )

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
        track_id = extract_spotify_track_id(track)
        if track.get("albumImage") and track.get("album") and track_id:
            return apply_track_metadata(
                track,
                {"spotifyTrackId": track_id},
            )

        cache_key = make_track_identity(track)
        if not cache_key:
            return track

        metadata_lock = self._get_track_metadata_lock(cache_key)
        with metadata_lock:
            cached = self._track_metadata_cache.get(cache_key)
            if cached and time.time() < cached["expiresAt"]:
                return apply_track_metadata(track, cached["metadata"])

            try:
                metadata = self._fetch_local_track_metadata(track)
            except SpotifyRateLimitError as exc:
                retry_ttl = max(
                    TRACK_METADATA_ERROR_TTL,
                    exc.retry_after_seconds,
                )
                self._track_metadata_cache[cache_key] = {
                    "expiresAt": time.time() + retry_ttl,
                    "metadata": {},
                }
                return track
            except RuntimeError:
                self._track_metadata_cache[cache_key] = {
                    "expiresAt": time.time() + TRACK_METADATA_ERROR_TTL,
                    "metadata": {},
                }
                return track
            ttl = (
                TRACK_METADATA_CACHE_TTL
                if metadata.get("albumImage")
                else TRACK_METADATA_MISS_TTL
            )
            self._track_metadata_cache[cache_key] = {
                "expiresAt": time.time() + ttl,
                "metadata": metadata,
            }
            return apply_track_metadata(track, metadata)

    def _get_track_metadata_lock(self, cache_key):
        with self._track_metadata_locks_guard:
            return self._track_metadata_locks.setdefault(cache_key, threading.Lock())

    def _fetch_local_track_metadata(self, track):
        title = str(track.get("title", "")).strip()
        artist = str(track.get("artist", "")).strip()

        if not title or not artist:
            return {}

        track_id = extract_spotify_track_id(track)
        if track_id:
            return self._fetch_track_metadata_by_id(track, track_id)

        candidates = []

        for query in build_track_search_queries(track):
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

            candidates = merge_spotify_candidates(candidates, items)
            strict_candidates = [
                item
                for item in candidates
                if is_strict_track_match(track, item)
            ]
            if strict_candidates:
                best_match = max(
                    strict_candidates,
                    key=lambda item: rank_track_match(track, item),
                )
                # Strict identity checks already exclude covers, sequels and
                # unrequested versions. Stop at the first relevant Spotify
                # result page instead of issuing every fallback query.
                return self._metadata_from_spotify_track(best_match)

        return {}

    def _fetch_track_metadata_by_id(self, track, track_id):
        item = self._spotify_get(
            f"/tracks/{track_id}",
            {"market": SPOTIFY_MARKET},
        )
        if not is_strict_track_match(track, item):
            return {}
        metadata = self._metadata_from_spotify_track(
            item,
            canonical_track_id=track_id,
        )
        return metadata

    def _metadata_from_spotify_track(self, item, canonical_track_id=None):
        mapped = map_track(item)
        canonical_track_id = (
            canonical_track_id
            if SPOTIFY_TRACK_ID_RE.fullmatch(str(canonical_track_id or ""))
            else None
        )
        canonical_spotify_url = (
            f"https://open.spotify.com/track/{canonical_track_id}"
            if canonical_track_id
            else None
        )
        album_image_urls = list(mapped.get("albumImages", []))
        album_name = mapped.get("album", "")
        album_url = mapped.get("albumUrl")

        if not album_image_urls and mapped.get("albumId"):
            try:
                album = self._spotify_get(
                    f"/albums/{mapped['albumId']}",
                    {"market": SPOTIFY_MARKET},
                )
            except RuntimeError:
                album = {}

            album_image_urls = get_album_image_urls(album)
            album_name = album.get("name") or album_name
            album_url = (album.get("external_urls") or {}).get("spotify") or album_url

        oembed_url = canonical_spotify_url or mapped.get("spotifyUrl")
        if not album_image_urls and oembed_url:
            thumbnail_url = self._fetch_oembed_thumbnail(oembed_url)
            if thumbnail_url:
                album_image_urls = [thumbnail_url]

        metadata = {
            "spotifyTrackId": canonical_track_id or mapped.get("spotifyTrackId"),
            "spotifyUri": mapped.get("spotifyUri"),
            "spotifyUrl": canonical_spotify_url or mapped.get("spotifyUrl"),
            "album": album_name,
            "albumId": mapped.get("albumId"),
            "albumUrl": album_url,
            "albumImage": album_image_urls[0] if album_image_urls else None,
            "albumImages": album_image_urls,
            "durationMs": mapped.get("durationMs"),
            "isrc": mapped.get("isrc"),
        }
        return compact_track_metadata(metadata)

    def _fetch_oembed_thumbnail(self, spotify_url):
        if not is_spotify_track_url(spotify_url):
            return None

        query = parse.urlencode({"url": spotify_url})
        req = request.Request(
            f"https://open.spotify.com/oembed?{query}",
            headers={"Accept": "application/json"},
        )
        try:
            with request.urlopen(
                req,
                timeout=SPOTIFY_REQUEST_TIMEOUT_SECONDS,
            ) as response:
                data = json.loads(response.read().decode("utf-8"))
        except (error.HTTPError, error.URLError, TimeoutError, json.JSONDecodeError):
            return None

        thumbnail_url = data.get("thumbnail_url")
        return thumbnail_url if is_https_url(thumbnail_url) else None

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
            except SpotifyRateLimitError:
                raise
            except RuntimeError:
                continue
            items = data.get("tracks", {}).get("items", [])

            if items:
                candidates = merge_spotify_candidates(candidates, items)
                if len(candidates) >= TRACKS_PER_GENRE:
                    return self._finalize_genre_tracks(candidates)

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
            except SpotifyRateLimitError:
                raise
            except RuntimeError:
                continue
            items = fallback.get("tracks", {}).get("items", [])

            if items:
                candidates = merge_spotify_candidates(candidates, items)
                if len(candidates) >= TRACKS_PER_GENRE:
                    return self._finalize_genre_tracks(candidates)

        return self._finalize_genre_tracks(candidates)

    def _finalize_genre_tracks(self, candidates):
        selected_items = rank_genre_tracks(candidates)[:TRACKS_PER_GENRE]
        selected_tracks = []
        for item in selected_items:
            mapped = map_track(item)
            if not mapped.get("albumImage"):
                metadata = self._metadata_from_spotify_track(item)
                mapped = apply_track_metadata(mapped, metadata)
            selected_tracks.append(mapped)
        return selected_tracks

    def _spotify_get(self, path, params=None):
        with self._rate_limit_lock:
            retry_after = self._rate_limited_until - time.time()
        if retry_after > 0:
            raise SpotifyRateLimitError(
                "Spotify API rate limit is active.",
                retry_after,
            )

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
            if exc.code == 429:
                retry_after = parse_retry_after_seconds(
                    (exc.headers or {}).get("Retry-After"),
                )
                with self._rate_limit_lock:
                    self._rate_limited_until = max(
                        self._rate_limited_until,
                        time.time() + retry_after,
                    )
                raise SpotifyRateLimitError(
                    payload or "Spotify API rate limit exceeded.",
                    retry_after,
                ) from exc
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
                "https://open.spotify.com "
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
    album_image_urls = get_album_image_urls(album)
    album_image = album_image_urls[0] if album_image_urls else None
    return {
        "title": item.get("name", "Unknown Track"),
        "artist": artist.get("name", "Unknown Artist"),
        "artistId": artist.get("id"),
        "spotifyTrackId": item.get("id"),
        "album": album.get("name", ""),
        "albumId": album.get("id"),
        "albumUrl": (album.get("external_urls") or {}).get("spotify"),
        "albumImage": album_image,
        "albumImages": album_image_urls,
        "durationMs": item.get("duration_ms"),
        "spotifyUri": item.get("uri"),
        "spotifyUrl": (item.get("external_urls") or {}).get("spotify"),
        "isrc": (item.get("external_ids") or {}).get("isrc"),
        "popularity": item.get("popularity", 0),
    }


TRACK_METADATA_FIELDS = {
    "spotifyTrackId",
    "spotifyUri",
    "spotifyUrl",
    "album",
    "albumId",
    "albumUrl",
    "albumImage",
    "albumImages",
    "durationMs",
    "isrc",
}


def compact_track_metadata(metadata):
    compact = {}
    for key, value in metadata.items():
        if key not in TRACK_METADATA_FIELDS:
            continue
        if value is None or value == "" or value == []:
            continue
        compact[key] = value
    return compact


def apply_track_metadata(track, metadata):
    enriched = dict(track)
    enriched.update(compact_track_metadata(metadata))
    return enriched


def get_album_image_urls(album):
    return [
        image.get("url")
        for image in (album.get("images", []) or [])
        if is_https_url(image.get("url"))
    ]


def is_https_url(value):
    try:
        parsed_url = parse.urlparse(str(value or ""))
    except ValueError:
        return False
    return parsed_url.scheme == "https" and bool(parsed_url.netloc)


def is_spotify_track_url(value):
    if not is_https_url(value):
        return False
    parsed_url = parse.urlparse(value)
    if parsed_url.netloc.lower() != "open.spotify.com":
        return False
    parts = [part for part in parsed_url.path.split("/") if part]
    return any(
        part == "track"
        and index + 1 < len(parts)
        and SPOTIFY_TRACK_ID_RE.fullmatch(parts[index + 1])
        for index, part in enumerate(parts)
    )


def extract_spotify_track_id(track):
    for key in ("spotifyTrackId", "spotifyId"):
        candidate = str(track.get(key, "")).strip()
        if SPOTIFY_TRACK_ID_RE.fullmatch(candidate):
            return candidate

    uri_match = re.fullmatch(
        r"spotify:track:([A-Za-z0-9]{22})",
        str(track.get("spotifyUri", "")).strip(),
    )
    if uri_match:
        return uri_match.group(1)

    spotify_url = str(track.get("spotifyUrl", "")).strip()
    if is_spotify_track_url(spotify_url):
        parts = [part for part in parse.urlparse(spotify_url).path.split("/") if part]
        track_index = parts.index("track")
        return parts[track_index + 1]

    return ""


def merge_spotify_candidates(primary_items, secondary_items):
    merged = []
    seen = set()
    for item in [*primary_items, *secondary_items]:
        item_id = str(item.get("id", "")).strip()
        artists = " ".join(
            artist.get("name", "")
            for artist in (item.get("artists", []) or [])
        )
        key = item_id or make_track_identity(
            {"title": item.get("name", ""), "artist": artists}
        )
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return merged


def rank_genre_tracks(tracks):
    # Spotify search already returns relevance order. Preserve it so a removed
    # or absent popularity field cannot reshuffle the representative selection.
    return list(tracks)


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
    track_id = extract_spotify_track_id(track)
    if track_id:
        return f"spotify:{track_id}"

    title = normalize_genre_name(track.get("title", ""))
    artist = normalize_genre_name(track.get("artist", ""))

    if not title and not artist:
        return ""

    return f"{title}::{artist}"


def load_local_genres(spotify_backed):
    genres = []
    for data_file in (GENRES_DATA_FILE, GENRES_EXPANSION_FILE):
        try:
            payload = json.loads(data_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        genres.extend(payload.get("genres", []))

    genres = attach_parent_genres(genres)
    normalized = []

    for genre in genres:
        normalized.append(
            {
                "id": genre.get("id", ""),
                "name": genre.get("name") or format_genre_name(genre.get("id", "")),
                "description": genre.get("description", ""),
                "parent": genre.get("parent", ""),
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


def attach_parent_genres(genres):
    normalized_genres = [{**genre} for genre in genres]
    by_id = {
        genre.get("id"): genre
        for genre in normalized_genres
        if genre.get("id")
    }

    for genre in normalized_genres:
        parent = by_id.get(genre.get("parent"))
        if not parent:
            continue

        subgenres = list(parent.get("subgenres", []))
        if genre.get("id") not in subgenres:
            subgenres.append(genre["id"])
        parent["subgenres"] = subgenres

    return normalized_genres


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


def get_search_artist_names(value):
    primary = get_primary_artist_name(value)
    candidates = [primary]
    candidates.extend(
        part.strip()
        for part in re.split(
            r"\s+(?:&|x|×|vs\.?|with)\s+",
            primary,
            flags=re.IGNORECASE,
        )
        if part.strip()
    )

    names = []
    seen = set()
    for candidate in candidates:
        clean = spotify_search_phrase(candidate)
        key = normalize_track_text(clean)
        if clean and key and key not in seen:
            names.append(clean)
            seen.add(key)
        if len(names) >= 2:
            break
    return names


def build_track_search_queries(track):
    title = spotify_search_phrase(track.get("title", ""))
    artist_names = get_search_artist_names(track.get("artist", ""))
    candidates = []

    isrc = re.sub(r"[^A-Za-z0-9]", "", str(track.get("isrc", ""))).upper()
    if isrc:
        candidates.append(f"isrc:{isrc}")

    for artist_name in artist_names:
        candidates.append(f'track:"{title}" artist:"{artist_name}"')
    for artist_name in artist_names:
        candidates.append(f'"{title}" "{artist_name}"')
    if title:
        candidates.append(f'track:"{title}"')

    queries = []
    seen = set()
    for candidate in candidates:
        key = candidate.casefold()
        if candidate and key not in seen:
            queries.append(candidate)
            seen.add(key)
    return queries


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


UNSAFE_TRACK_VERSION_MARKERS = {
    "acoustic",
    "demo",
    "edit",
    "instrumental",
    "karaoke",
    "live",
    "mix",
    "remix",
    "re edit",
    "slowed",
    "sped up",
}
SAFE_RELEASE_QUALIFIERS = {
    "anniversary",
    "deluxe",
    "edition",
    "mono",
    "remaster",
    "remastered",
    "stereo",
    "version",
}


def get_track_version_markers(value):
    normalized = normalize_track_text(value)
    markers = set()
    for marker in UNSAFE_TRACK_VERSION_MARKERS:
        marker_pattern = re.escape(marker).replace(r"\ ", r"\s+")
        if re.search(rf"(?:^|\s){marker_pattern}(?:$|\s)", normalized):
            markers.add(marker)
    return markers


def get_artist_version_markers(value):
    markers = set()
    for round_note, square_note in re.findall(
        r"\(([^)]*)\)|\[([^]]*)\]",
        str(value or ""),
    ):
        markers.update(get_track_version_markers(round_note or square_note))
    return markers


def strip_artist_version_notes(value):
    def replace_note(match):
        note = match.group(1) or match.group(2) or ""
        return " " if get_track_version_markers(note) else match.group(0)

    return re.sub(
        r"\(([^)]*)\)|\[([^]]*)\]",
        replace_note,
        str(value or ""),
    ).strip()


def strip_feature_suffix(value):
    return re.split(
        r"\b(?:feat|featuring|ft|with)\b",
        value,
        maxsplit=1,
    )[0].strip()


def track_titles_match(target, candidate):
    target_title = normalize_track_text(target.get("title", ""))
    candidate_title = normalize_track_text(candidate.get("name", ""))
    if not target_title or not candidate_title:
        return False

    target_versions = get_track_version_markers(target.get("title", ""))
    target_versions.update(get_artist_version_markers(target.get("artist", "")))
    candidate_versions = get_track_version_markers(candidate.get("name", ""))
    if candidate_versions - target_versions or target_versions - candidate_versions:
        return False

    if target_title == candidate_title:
        return True

    if strip_feature_suffix(target_title) == strip_feature_suffix(candidate_title):
        return True

    if not candidate_title.startswith(f"{target_title} "):
        return False

    suffix = candidate_title[len(target_title):].strip()
    suffix_tokens = set(suffix.split())
    if not suffix_tokens:
        return True
    if candidate_versions and candidate_versions == target_versions:
        return True
    feature_connectors = {"feat", "featuring", "ft", "with"}
    if suffix.split(maxsplit=1)[0] in feature_connectors:
        return True

    candidate_artist_tokens = get_artist_tokens(
        " ".join(
            artist.get("name", "")
            for artist in (candidate.get("artists", []) or [])
        )
    )
    if suffix_tokens.issubset(candidate_artist_tokens | {"and", "x", "vs"}):
        return True

    release_tokens = {
        token
        for token in suffix_tokens
        if not token.isdigit()
    }
    return bool(release_tokens) and release_tokens.issubset(SAFE_RELEASE_QUALIFIERS)


def track_artists_match(target, candidate):
    target_artist_credit = strip_artist_version_notes(target.get("artist", ""))
    target_artist = normalize_track_text(get_primary_artist_name(target_artist_credit))
    candidate_artists = [
        normalize_track_text(artist.get("name", ""))
        for artist in (candidate.get("artists", []) or [])
        if normalize_track_text(artist.get("name", ""))
    ]
    if not target_artist or not candidate_artists:
        return False
    target_tokens = get_artist_tokens(target_artist_credit)
    candidate_tokens = get_artist_tokens(" ".join(candidate_artists))
    if not target_tokens or not target_tokens.issubset(candidate_tokens):
        return False

    primary_artist_matches = target_artist in candidate_artists
    complete_credit_matches = target_tokens == candidate_tokens
    return primary_artist_matches or complete_credit_matches


def is_strict_track_match(target, candidate):
    return track_titles_match(target, candidate) and track_artists_match(
        target,
        candidate,
    )


def score_track_match(target, candidate):
    if not is_strict_track_match(target, candidate):
        return 0

    target_title = normalize_track_text(target.get("title", ""))
    candidate_title = normalize_track_text(candidate.get("name", ""))
    return (8 if target_title == candidate_title else 5) + 5


def rank_track_match(target, candidate):
    target_album = normalize_track_text(target.get("album", ""))
    candidate_album = normalize_track_text((candidate.get("album") or {}).get("name", ""))
    album_score = 1 if target_album and target_album == candidate_album else 0
    return (
        score_track_match(target, candidate),
        album_score,
    )


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
