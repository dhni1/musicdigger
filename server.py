from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request
import base64
import json
import os
import re
import time


ROOT = Path(__file__).resolve().parent
GENRES_DATA_FILE = ROOT / "data" / "genres.json"
PORT = int(os.environ.get("PORT", "8000"))
SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_MARKET = os.environ.get("SPOTIFY_MARKET", "US")


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

        local_genres = load_local_genres(spotify_backed=self.configured())
        genres = local_genres

        if self.configured():
            try:
                data = self._spotify_get("/recommendations/available-genre-seeds")
                seeds = data.get("genres", [])
                if seeds:
                    genres = merge_seed_genres(local_genres, seeds)
            except RuntimeError:
                genres = local_genres

        self._genres_cache = genres
        self._genres_cache_time = time.time()
        return genres

    def get_genre_details(self, genre):
        cache_key = genre.lower()
        cached = self._genre_detail_cache.get(cache_key)

        if cached and time.time() - cached["time"] < 1800:
            return cached["data"]

        local_genre = find_local_genre(genre, spotify_backed=self.configured())
        seed_genres = get_seed_genres(local_genre, genre)
        search_terms = get_search_terms(local_genre, genre)

        tracks = []

        if self.configured():
            try:
                tracks = self._recommend_tracks_for_genre(seed_genres)
            except RuntimeError:
                try:
                    tracks = self._search_tracks_for_genre(search_terms)
                except RuntimeError:
                    tracks = []

        if not tracks and local_genre:
            tracks = local_genre.get("tracks", [])

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

    def _recommend_tracks_for_genre(self, seed_genres):
        seed_values = ",".join(seed_genres[:5])
        data = self._spotify_get(
            "/recommendations",
            {
                "limit": "8",
                "market": SPOTIFY_MARKET,
                "seed_genres": seed_values,
            },
        )
        items = data.get("tracks", [])
        return [map_track(item) for item in items]

    def _search_tracks_for_genre(self, search_terms):
        for term in search_terms:
            if not term:
                continue

            query = f'genre:"{term}"'
            data = self._spotify_get(
                "/search",
                {
                    "q": query,
                    "type": "track",
                    "limit": "8",
                    "market": SPOTIFY_MARKET,
                },
            )
            items = data.get("tracks", {}).get("items", [])

            if items:
                return [map_track(item) for item in items]

        for term in search_terms:
            if not term:
                continue

            fallback = self._spotify_get(
                "/search",
                {
                    "q": term,
                    "type": "track",
                    "limit": "8",
                    "market": SPOTIFY_MARKET,
                },
            )
            items = fallback.get("tracks", {}).get("items", [])

            if items:
                return [map_track(item) for item in items]

        return []

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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = parse.urlparse(self.path)

        if parsed.path == "/api/genres":
            self._handle_genres()
            return

        if parsed.path == "/api/genre-details":
            self._handle_genre_details(parsed.query)
            return

        super().do_GET()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

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
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
        self.wfile.write(data)


def map_track(item):
    artist = item.get("artists", [{}])[0]
    return {
        "title": item.get("name", "Unknown Track"),
        "artist": artist.get("name", "Unknown Artist"),
        "artistId": artist.get("id"),
        "album": item.get("album", {}).get("name", ""),
        "spotifyUri": item.get("uri"),
        "spotifyUrl": item.get("external_urls", {}).get("spotify"),
    }


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


def genre_to_seed(value):
    return normalize_genre_name(value).replace(" ", "-")


def format_search_label(value):
    return re.sub(r"\s+", " ", str(value or "").replace("_", " ").replace("-", " ")).strip()


def format_genre_name(name):
    return " ".join(part.capitalize() for part in name.replace("_", " ").replace("-", " ").split())


def normalize_genre_name(name):
    return re.sub(r"[^a-z0-9]+", " ", str(name or "").lower()).strip()


def build_description(genre, artist_names, tracks):
    display = genre.get("name") or format_genre_name(genre.get("id", ""))
    if artist_names:
        names = ", ".join(artist_names[:3])
        return f"Spotify 추천을 기준으로 {display} 분위기에 맞는 곡을 골랐습니다. {names} 같은 아티스트를 중심으로 탐색합니다."
    if tracks:
        return f"Spotify 추천을 기준으로 {display} 장르에 맞는 곡을 불러왔습니다."
    return f"Spotify에서 {display} 장르 추천 곡을 찾지 못했습니다."


def main():
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f"MusicDigger server running at http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
