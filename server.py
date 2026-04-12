from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, parse, request
import base64
import json
import os
import time


ROOT = Path(__file__).resolve().parent
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

        data = self._spotify_get("/recommendations/available-genre-seeds")
        seeds = data.get("genres", [])
        genres = [
            {
                "id": seed,
                "name": format_genre_name(seed),
                "description": f"Spotify genre seed: {format_genre_name(seed)}",
                "subgenres": [],
                "similar": [],
                "fusion": [],
                "tracks": [],
                "spotifyBacked": True,
            }
            for seed in sorted(seeds)
        ]

        self._genres_cache = genres
        self._genres_cache_time = time.time()
        return genres

    def get_genre_details(self, genre):
        cache_key = genre.lower()
        cached = self._genre_detail_cache.get(cache_key)

        if cached and time.time() - cached["time"] < 1800:
            return cached["data"]

        tracks = self._search_tracks_for_genre(genre)
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
            artist = self._spotify_get(f"/artists/{artist_id}")
            related_pool.extend(artist.get("genres", []))

        related_names = []
        current = normalize_genre_name(genre)
        for name in related_pool:
            normalized = normalize_genre_name(name)
            if normalized == current:
                continue
            if name not in related_names:
                related_names.append(name)

        description = build_description(genre, artist_names, tracks)
        data = {
            "id": genre,
            "name": format_genre_name(genre),
            "description": description,
            "subgenres": [],
            "similar": [],
            "fusion": [],
            "tracks": tracks,
            "spotifyBacked": True,
            "relatedNames": related_names[:8],
        }

        self._genre_detail_cache[cache_key] = {
            "time": time.time(),
            "data": data,
        }
        return data

    def _search_tracks_for_genre(self, genre):
        query = f'genre:"{genre}"'
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

        if not items:
            fallback = self._spotify_get(
                "/search",
                {
                    "q": genre,
                    "type": "track",
                    "limit": "8",
                    "market": SPOTIFY_MARKET,
                },
            )
            items = fallback.get("tracks", {}).get("items", [])

        return [map_track(item) for item in items]

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
        if not catalog.configured():
            return self._send_json(
                503,
                {"error": "Spotify server credentials are not configured."},
            )

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


def format_genre_name(name):
    return " ".join(part.capitalize() for part in name.replace("-", " ").split())


def normalize_genre_name(name):
    return name.replace("-", " ").strip().lower()


def build_description(genre, artist_names, tracks):
    display = format_genre_name(genre)
    if artist_names:
        names = ", ".join(artist_names[:3])
        return f"Spotify에서 {display} 관련 결과를 불러왔습니다. {names} 같은 아티스트를 중심으로 탐색합니다."
    if tracks:
        return f"Spotify에서 {display} 장르 기준으로 검색한 대표 트랙입니다."
    return f"Spotify에서 {display} 장르 결과를 찾지 못했습니다."


def main():
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f"MusicDigger server running at http://127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
