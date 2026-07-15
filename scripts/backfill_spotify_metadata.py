#!/usr/bin/env python3
"""Backfill curated MusicDigger tracks with verified Spotify metadata.

The default mode uses Spotify's documented Web API with client credentials.
The optional public-page mode reads only Open Graph/music meta tags from public
Spotify track pages.  Both modes verify every result with the server's strict
matcher and only write records that include a real album cover.
"""

from __future__ import annotations

import argparse
import copy
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
from typing import Any, Callable, Iterable
from urllib import error, parse, request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server  # noqa: E402  (repo root is added above for direct execution)


DEFAULT_DATA_FILES = (
    ROOT / "data" / "genres.json",
    ROOT / "data" / "genre-expansion.json",
)
DEFAULT_CHECKPOINT = ROOT / "data" / ".spotify-metadata-backfill.checkpoint.json"
DEFAULT_PUBLIC_CACHE = ROOT / "data" / ".spotify-public-page-cache.json"
DEFAULT_PUBLIC_REPORT = ROOT / "data" / "spotify-public-backfill-report.json"
DEFAULT_PREFERRED_IDS = ROOT / "data" / "spotify-track-overrides.json"
CHECKPOINT_VERSION = 1
PUBLIC_CACHE_VERSION = 2
SPOTIFY_ID_PATTERN = server.SPOTIFY_TRACK_ID_RE
METADATA_FIELDS = tuple(sorted(server.TRACK_METADATA_FIELDS))
PUBLIC_META_KEYS = {
    "og:title",
    "og:description",
    "og:image",
    "music:musician_description",
    "music:album",
    "music:duration",
    "music:release_date",
}
PUBLIC_RETRYABLE_HTTP_CODES = {408, 425, 429, 500, 502, 503, 504}
PUBLIC_PAGE_MAX_BYTES = 4 * 1024 * 1024


def normalized_track_key(track: dict[str, Any]) -> str:
    """Return the title+artist identity used across both catalogue files."""

    title = server.normalize_track_text(track.get("title", ""))
    artist = server.normalize_track_text(track.get("artist", ""))
    return f"{title}::{artist}" if title and artist else ""


def load_documents(paths: Iterable[Path]) -> list[dict[str, Any]]:
    documents = []
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise RuntimeError(f"Could not read data file: {path}") from exc
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid JSON data file: {path}: {exc}") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("genres"), list):
            raise RuntimeError(f"Expected a top-level genres array: {path}")
        documents.append(payload)
    return documents


def collect_track_groups(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group placements without changing their source order or text."""

    groups: dict[str, dict[str, Any]] = {}
    ordinal = 0
    for document_index, document in enumerate(documents):
        for genre_index, genre in enumerate(document.get("genres", [])):
            tracks = genre.get("tracks", []) if isinstance(genre, dict) else []
            if not isinstance(tracks, list):
                continue
            for track_index, track in enumerate(tracks):
                if not isinstance(track, dict):
                    continue
                key = normalized_track_key(track)
                if not key:
                    continue
                if key not in groups:
                    groups[key] = {
                        "key": key,
                        "ordinal": ordinal,
                        "title": track.get("title", ""),
                        "artist": track.get("artist", ""),
                        "placements": [],
                        "source_tracks": [],
                        "existing_ids": [],
                    }
                    ordinal += 1
                group = groups[key]
                group["placements"].append(
                    (document_index, genre_index, track_index)
                )
                group["source_tracks"].append(track)
                track_id = server.extract_spotify_track_id(track)
                if track_id and track_id not in group["existing_ids"]:
                    group["existing_ids"].append(track_id)

    for group in groups.values():
        target = {"title": group["title"], "artist": group["artist"]}
        for field in ("isrc",):
            for source_track in group["source_tracks"]:
                value = source_track.get(field)
                if value:
                    target[field] = value
                    break
        group["target"] = target
    return list(groups.values())


def load_preferred_track_overrides(
    path: Path | None,
) -> dict[str, list[dict[str, str]]]:
    if path is None or not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not read preferred Spotify IDs: {path}") from exc
    records = payload.get("tracks") if isinstance(payload, dict) else None
    if not isinstance(records, list):
        raise RuntimeError(f"Expected a tracks array in preferred Spotify IDs: {path}")

    preferred: dict[str, list[dict[str, str]]] = {}
    for record in records:
        if not isinstance(record, dict):
            raise RuntimeError(f"Invalid preferred Spotify ID record: {record!r}")
        key = normalized_track_key(record)
        track_id = str(record.get("spotifyTrackId") or "").strip()
        if not key or not SPOTIFY_ID_PATTERN.fullmatch(track_id):
            raise RuntimeError(f"Invalid preferred Spotify ID record: {record!r}")
        override = {"spotifyTrackId": track_id}
        for field in ("matchTitle", "matchArtist"):
            if field not in record:
                continue
            value = record[field]
            if not isinstance(value, str) or not value.strip():
                raise RuntimeError(
                    f"Invalid preferred Spotify ID record: {record!r}"
                )
            override[field] = value.strip()

        overrides = preferred.setdefault(key, [])
        duplicate = next(
            (
                existing
                for existing in overrides
                if existing["spotifyTrackId"] == track_id
            ),
            None,
        )
        if duplicate is not None:
            if duplicate != override:
                raise RuntimeError(
                    f"Conflicting preferred Spotify ID record: {record!r}"
                )
            continue
        overrides.append(override)
    return preferred


def load_preferred_track_ids(path: Path | None) -> dict[str, list[str]]:
    """Load only preferred IDs for callers that do not need match aliases."""

    return {
        key: [override["spotifyTrackId"] for override in overrides]
        for key, overrides in load_preferred_track_overrides(path).items()
    }


def is_spotify_entity_url(value: Any, entity: str, entity_id: str) -> bool:
    return str(value or "") == f"https://open.spotify.com/{entity}/{entity_id}"


def validate_metadata(metadata: Any) -> bool:
    """Accept only a complete, internally consistent Spotify album record."""

    if not isinstance(metadata, dict):
        return False
    track_id = str(metadata.get("spotifyTrackId", ""))
    album_id = str(metadata.get("albumId", ""))
    images = metadata.get("albumImages")
    duration = metadata.get("durationMs")
    if not SPOTIFY_ID_PATTERN.fullmatch(track_id):
        return False
    if not SPOTIFY_ID_PATTERN.fullmatch(album_id):
        return False
    if not str(metadata.get("album", "")).strip():
        return False
    if not isinstance(images, list) or not images:
        return False
    if any(not server.is_https_url(image) for image in images):
        return False
    if metadata.get("albumImage") != images[0]:
        return False
    if not isinstance(duration, int) or isinstance(duration, bool) or duration <= 0:
        return False
    if metadata.get("spotifyUri") != f"spotify:track:{track_id}":
        return False
    if not is_spotify_entity_url(metadata.get("spotifyUrl"), "track", track_id):
        return False
    if not is_spotify_entity_url(metadata.get("albumUrl"), "album", album_id):
        return False
    return True


def compact_verified_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    compact = server.compact_track_metadata(metadata)
    return compact if validate_metadata(compact) else {}


class SpotifyMetaTagParser(HTMLParser):
    """Collect only the public meta fields used by this backfill."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.values: dict[str, list[str]] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() != "meta":
            return
        attributes = {
            str(name).casefold(): str(value or "").strip()
            for name, value in attrs
        }
        key = (attributes.get("property") or attributes.get("name") or "").casefold()
        content = attributes.get("content", "").strip()
        if key in PUBLIC_META_KEYS and content:
            self.values.setdefault(key, []).append(content)

    def handle_startendtag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        self.handle_starttag(tag, attrs)


def first_meta_value(values: dict[str, list[str]], key: str) -> str:
    return next((value for value in values.get(key, []) if value), "")


def spotify_entity_id(value: Any, entity: str) -> str:
    raw = str(value or "").strip()
    uri_match = re.fullmatch(
        rf"spotify:{re.escape(entity)}:([A-Za-z0-9]{{22}})",
        raw,
    )
    if uri_match:
        return uri_match.group(1)
    try:
        parsed = parse.urlparse(raw)
    except ValueError:
        return ""
    if parsed.scheme != "https" or parsed.netloc.casefold() != "open.spotify.com":
        return ""
    parts = [part for part in parsed.path.split("/") if part]
    for index, part in enumerate(parts):
        if part == entity and index + 1 < len(parts):
            entity_id = parts[index + 1]
            return entity_id if SPOTIFY_ID_PATTERN.fullmatch(entity_id) else ""
    return ""


def parse_public_duration_ms(value: Any) -> int | None:
    try:
        seconds = float(str(value or "").strip())
    except (TypeError, ValueError):
        return None
    if seconds <= 0 or seconds > 24 * 60 * 60:
        return None
    return int(round(seconds * 1000))


def parse_public_release_date(value: Any) -> str:
    raw = str(value or "").strip()
    match = re.fullmatch(r"(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?", raw)
    if not match:
        return ""
    year = int(match.group(1))
    month = int(match.group(2) or 1)
    day = int(match.group(3) or 1)
    if not 1000 <= year <= 2100 or not 1 <= month <= 12 or not 1 <= day <= 31:
        return ""
    return raw


def unique_artist_names(values: Iterable[str]) -> list[str]:
    names = []
    seen = set()
    for value in values:
        name = str(value or "").strip()
        key = server.normalize_track_text(name)
        if name and key and key not in seen:
            names.append(name)
            seen.add(key)
    return names


def parse_public_track_page(track_id: str, html: str) -> dict[str, Any] | None:
    """Convert a Spotify public page's meta tags into an API-shaped track."""

    if not SPOTIFY_ID_PATTERN.fullmatch(str(track_id or "")):
        return None
    parser = SpotifyMetaTagParser()
    try:
        parser.feed(str(html or ""))
        parser.close()
    except Exception:
        return None

    title = first_meta_value(parser.values, "og:title").strip()
    description = first_meta_value(parser.values, "og:description")
    description_parts = [part.strip() for part in description.split("·")]
    album_name = description_parts[1] if len(description_parts) >= 3 else ""
    artist_names = unique_artist_names(
        parser.values.get("music:musician_description", [])
    )
    if not artist_names and description_parts:
        artist_names = unique_artist_names([description_parts[0]])

    image_url = first_meta_value(parser.values, "og:image")
    album_id = spotify_entity_id(
        first_meta_value(parser.values, "music:album"),
        "album",
    )
    duration_ms = parse_public_duration_ms(
        first_meta_value(parser.values, "music:duration")
    )
    release_date = parse_public_release_date(
        first_meta_value(parser.values, "music:release_date")
    )
    if (
        not title
        or not artist_names
        or not album_name
        or not album_id
        or not server.is_https_url(image_url)
        or not duration_ms
    ):
        return None

    return {
        "id": track_id,
        "name": title,
        "artists": [{"id": None, "name": name} for name in artist_names],
        "album": {
            "id": album_id,
            "name": album_name,
            "images": [{"url": image_url}],
            "external_urls": {
                "spotify": f"https://open.spotify.com/album/{album_id}"
            },
            "release_date": release_date,
        },
        "duration_ms": duration_ms,
        "uri": f"spotify:track:{track_id}",
        "external_urls": {
            "spotify": f"https://open.spotify.com/track/{track_id}"
        },
        "external_ids": {},
        "popularity": 0,
    }


def metadata_from_public_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    mapped = server.map_track(candidate)
    track_id = str(mapped.get("spotifyTrackId") or "")
    album_id = str(mapped.get("albumId") or "")
    images = list(mapped.get("albumImages") or [])
    return compact_verified_metadata(
        {
            "spotifyTrackId": track_id,
            "spotifyUri": f"spotify:track:{track_id}",
            "spotifyUrl": f"https://open.spotify.com/track/{track_id}",
            "album": mapped.get("album"),
            "albumId": album_id,
            "albumUrl": f"https://open.spotify.com/album/{album_id}",
            "albumImage": images[0] if images else None,
            "albumImages": images,
            "durationMs": mapped.get("durationMs"),
            "isrc": mapped.get("isrc"),
        }
    )


class SpotifyPublicPageClient:
    def __init__(
        self,
        *,
        timeout: float = 12.0,
        retries: int = 3,
        min_request_interval: float = 0.0,
        sleep: Callable[[float], None] = time.sleep,
        urlopen: Callable[..., Any] = request.urlopen,
    ) -> None:
        self.timeout = max(1.0, timeout)
        self.retries = max(0, retries)
        self.min_request_interval = max(0.0, min_request_interval)
        self.sleep = sleep
        self.urlopen = urlopen
        self._pace_lock = threading.Lock()
        self._next_request_at = 0.0

    def _wait_for_request_slot(self) -> None:
        if not self.min_request_interval:
            return
        with self._pace_lock:
            now = time.monotonic()
            delay = max(0.0, self._next_request_at - now)
            if delay:
                self.sleep(delay)
                now = time.monotonic()
            self._next_request_at = now + self.min_request_interval

    def fetch(self, track_id: str) -> dict[str, Any] | None:
        if not SPOTIFY_ID_PATTERN.fullmatch(str(track_id or "")):
            return None
        page_url = f"https://open.spotify.com/track/{track_id}"
        page_request = request.Request(
            page_url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
                "User-Agent": "Mozilla/5.0 MusicDigger/1.0",
            },
        )
        for attempt in range(self.retries + 1):
            try:
                self._wait_for_request_slot()
                with self.urlopen(page_request, timeout=self.timeout) as response:
                    payload = response.read(PUBLIC_PAGE_MAX_BYTES + 1)
                    if len(payload) > PUBLIC_PAGE_MAX_BYTES:
                        raise RuntimeError(f"Spotify page is too large: {track_id}")
                    charset = response.headers.get_content_charset() or "utf-8"
                    html = payload.decode(charset, errors="replace")
                    return parse_public_track_page(track_id, html)
            except error.HTTPError as exc:
                if exc.code == 404:
                    return None
                if exc.code not in PUBLIC_RETRYABLE_HTTP_CODES or attempt >= self.retries:
                    raise RuntimeError(
                        f"Spotify public page HTTP {exc.code}: {track_id}"
                    ) from exc
                retry_after = server.parse_retry_after_seconds(
                    (exc.headers or {}).get("Retry-After"),
                    default=min(30, 2**attempt),
                )
                self.sleep(max(retry_after, min(30, 2**attempt)))
            except (error.URLError, TimeoutError, OSError) as exc:
                if attempt >= self.retries:
                    raise RuntimeError(
                        f"Spotify public page request failed: {track_id}: {exc}"
                    ) from exc
                self.sleep(min(30, 2**attempt))
        return None


class SpotifyAPIClient:
    """Rate-limit-aware adapter around the server's official Web API client."""

    def __init__(
        self,
        catalog: server.SpotifyCatalog | None = None,
        *,
        max_rate_limit_retries: int = 8,
        request_delay: float = 0.1,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.catalog = catalog or server.SpotifyCatalog()
        self.max_rate_limit_retries = max(0, max_rate_limit_retries)
        self.request_delay = max(0.0, request_delay)
        self.sleep = sleep

    def get(self, path: str, params: dict[str, str] | None = None) -> dict[str, Any]:
        attempt = 0
        while True:
            try:
                response = self.catalog._spotify_get(path, params)
            except server.SpotifyRateLimitError as exc:
                if attempt >= self.max_rate_limit_retries:
                    raise
                exponential_delay = min(60, 2**attempt)
                self.sleep(max(float(exc.retry_after_seconds), exponential_delay))
                attempt += 1
                continue
            if self.request_delay:
                self.sleep(self.request_delay)
            if not isinstance(response, dict):
                raise RuntimeError(f"Spotify returned an invalid response for {path}")
            return response


class SpotifyTrackResolver:
    def __init__(
        self,
        client: SpotifyAPIClient,
        *,
        market: str = "US",
        search_limit: int = server.TRACK_METADATA_SEARCH_LIMIT,
    ) -> None:
        self.client = client
        self.market = market
        self.search_limit = max(1, min(50, search_limit))

    def resolve(self, group: dict[str, Any]) -> dict[str, Any] | None:
        target = group["target"]

        # A curated ID is the strongest hint, but it is never trusted without
        # checking title and the complete artist credit first.
        for track_id in group.get("existing_ids", []):
            item = self.client.get(
                f"/tracks/{track_id}",
                {"market": self.market},
            )
            metadata = self._metadata_if_valid_match(
                target,
                item,
                canonical_track_id=track_id,
            )
            if metadata:
                return metadata

        candidates: list[dict[str, Any]] = []
        for query in server.build_track_search_queries(target):
            response = self.client.get(
                "/search",
                {
                    "q": query,
                    "type": "track",
                    "limit": str(self.search_limit),
                    "market": self.market,
                },
            )
            items = (response.get("tracks") or {}).get("items", [])
            candidates = server.merge_spotify_candidates(candidates, items)
            strict_candidates = [
                item for item in candidates if server.is_strict_track_match(target, item)
            ]
            if not strict_candidates:
                continue
            best_match = max(
                strict_candidates,
                key=lambda item: server.rank_track_match(target, item),
            )
            metadata = self._metadata_if_valid_match(target, best_match)
            if metadata:
                return metadata
        return None

    def _metadata_if_valid_match(
        self,
        target: dict[str, Any],
        item: Any,
        *,
        canonical_track_id: str | None = None,
    ) -> dict[str, Any] | None:
        if not isinstance(item, dict) or not server.is_strict_track_match(target, item):
            return None

        mapped = server.map_track(item)
        album = item.get("album") or {}
        album_id = str(mapped.get("albumId") or "")
        album_images = list(mapped.get("albumImages") or [])

        if not album_images and SPOTIFY_ID_PATTERN.fullmatch(album_id):
            album = self.client.get(
                f"/albums/{album_id}",
                {"market": self.market},
            )
            album_images = server.get_album_image_urls(album)

        requested_id = str(canonical_track_id or "")
        track_id = (
            requested_id
            if SPOTIFY_ID_PATTERN.fullmatch(requested_id)
            else str(mapped.get("spotifyTrackId") or "")
        )
        album_name = str(album.get("name") or mapped.get("album") or "").strip()
        metadata = {
            "spotifyTrackId": track_id,
            "spotifyUri": f"spotify:track:{track_id}",
            "spotifyUrl": f"https://open.spotify.com/track/{track_id}",
            "album": album_name,
            "albumId": album_id,
            "albumUrl": f"https://open.spotify.com/album/{album_id}",
            "albumImage": album_images[0] if album_images else None,
            "albumImages": album_images,
            "durationMs": mapped.get("durationMs"),
            "isrc": mapped.get("isrc"),
        }
        verified = compact_verified_metadata(metadata)
        return verified or None


def load_public_candidate_ids(path: Path) -> tuple[list[str], list[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RuntimeError(f"Could not read public candidate file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid public candidate JSON: {path}: {exc}") from exc
    raw_ids = payload.get("trackIds") if isinstance(payload, dict) else payload
    if not isinstance(raw_ids, list):
        raise RuntimeError(f"Expected a trackIds array: {path}")
    track_ids = []
    invalid = []
    seen = set()
    for value in raw_ids:
        track_id = str(value or "").strip()
        if not SPOTIFY_ID_PATTERN.fullmatch(track_id):
            invalid.append(track_id)
            continue
        if track_id not in seen:
            track_ids.append(track_id)
            seen.add(track_id)
    return track_ids, invalid


def load_public_cache(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if payload.get("version") != PUBLIC_CACHE_VERSION:
        return {}
    entries = payload.get("entries")
    if not isinstance(entries, dict):
        return {}
    return {
        track_id: record
        for track_id, record in entries.items()
        if SPOTIFY_ID_PATTERN.fullmatch(str(track_id or ""))
        and isinstance(record, dict)
        and record.get("status") in {"ok", "invalid", "error"}
    }


def public_cache_payload(entries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": PUBLIC_CACHE_VERSION,
        "entries": entries,
    }


def is_reusable_public_cache_record(record: Any) -> bool:
    if not isinstance(record, dict):
        return False
    if record.get("status") != "ok":
        return False
    candidate = record.get("candidate")
    return isinstance(candidate, dict) and bool(metadata_from_public_candidate(candidate))


def fetch_public_page_candidates(
    track_ids: list[str],
    client: SpotifyPublicPageClient,
    *,
    cache_path: Path,
    workers: int = 8,
    checkpoint_every: int = 20,
    write_cache: bool = True,
    progress: Callable[[str], None] | None = print,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch public pages concurrently and checkpoint parsed candidates."""

    entries = load_public_cache(cache_path)
    reusable_ids = {
        track_id
        for track_id in track_ids
        if is_reusable_public_cache_record(entries.get(track_id))
    }
    pending_ids = [track_id for track_id in track_ids if track_id not in reusable_ids]
    worker_count = max(1, min(16, int(workers)))
    checkpoint_every = max(1, checkpoint_every)
    completed = 0

    try:
        with ThreadPoolExecutor(
            max_workers=worker_count,
            thread_name_prefix="spotify-public-page",
        ) as executor:
            futures = {
                executor.submit(client.fetch, track_id): track_id
                for track_id in pending_ids
            }
            for future in as_completed(futures):
                track_id = futures[future]
                try:
                    candidate = future.result()
                except Exception as exc:
                    entries[track_id] = {
                        "status": "error",
                        "error": str(exc),
                    }
                else:
                    if candidate and metadata_from_public_candidate(candidate):
                        entries[track_id] = {
                            "status": "ok",
                            "candidate": candidate,
                        }
                    else:
                        entries[track_id] = {
                            "status": "invalid",
                            "error": "Required Spotify meta tags were missing or invalid.",
                        }
                completed += 1
                if progress and (completed == 1 or completed % checkpoint_every == 0):
                    progress(
                        f"[public pages {completed}/{len(pending_ids)}] "
                        f"cached {len(reusable_ids)}"
                    )
                if write_cache and completed % checkpoint_every == 0:
                    atomic_write_json(cache_path, public_cache_payload(entries))
    finally:
        if write_cache and entries:
            atomic_write_json(cache_path, public_cache_payload(entries))

    candidates = []
    invalid_pages = []
    fetch_errors = []
    for track_id in track_ids:
        record = entries.get(track_id, {})
        if record.get("status") == "ok" and isinstance(record.get("candidate"), dict):
            candidates.append(record["candidate"])
        elif record.get("status") == "invalid":
            invalid_pages.append(track_id)
        elif record.get("status") == "error":
            fetch_errors.append(
                {"spotifyTrackId": track_id, "error": record.get("error", "")}
            )
    return candidates, {
        "requested": len(track_ids),
        "cacheHits": len(reusable_ids),
        "fetched": completed,
        "validCandidates": len(candidates),
        "invalidPages": invalid_pages,
        "fetchErrors": fetch_errors,
    }


def public_candidate_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "spotifyTrackId": candidate.get("id"),
        "title": candidate.get("name"),
        "artists": [
            artist.get("name", "")
            for artist in (candidate.get("artists") or [])
            if isinstance(artist, dict)
        ],
        "album": (candidate.get("album") or {}).get("name"),
        "releaseDate": (candidate.get("album") or {}).get("release_date"),
    }


def combined_public_artist_credit_matches(
    target: dict[str, Any],
    candidate: dict[str, Any],
) -> bool:
    """Match Spotify's single comma-joined public artist-credit meta value."""

    artists = candidate.get("artists") or []
    if len(artists) != 1 or not isinstance(artists[0], dict):
        return False
    public_artist = artists[0]
    combined_credit = str(public_artist.get("name") or "").strip()
    if public_artist.get("id") is not None or "," not in combined_credit:
        return False

    target_credit = server.strip_artist_version_notes(target.get("artist", ""))
    target_lead = re.split(
        r"\s*(?:,|&|\bx\b|×|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b)\s*",
        target_credit,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]

    def normalize_lead(value: Any) -> str:
        normalized = server.normalize_track_text(value)
        return re.sub(r"^(?:the|ms|mr|mrs)\s+", "", normalized)

    target_primary = normalize_lead(target_lead)
    combined_normalized = server.normalize_track_text(combined_credit)
    target_tokens = server.get_artist_tokens(target_credit)
    combined_tokens = server.get_artist_tokens(combined_credit)
    if (
        not target_primary
        or not target_tokens
        or not target_tokens.issubset(combined_tokens)
    ):
        return False
    first_credited_artist = normalize_lead(combined_credit.split(",", 1)[0])
    return normalize_lead(combined_normalized) == target_primary or (
        first_credited_artist == target_primary
    )


def is_public_track_match(
    target: dict[str, Any],
    candidate: dict[str, Any],
) -> bool:
    if server.is_strict_track_match(target, candidate):
        return True
    return server.track_titles_match(
        target,
        candidate,
    ) and combined_public_artist_credit_matches(target, candidate)


def rank_public_track_match(
    target: dict[str, Any],
    candidate: dict[str, Any],
) -> tuple[int, int, int, int]:
    if server.is_strict_track_match(target, candidate):
        title_artist_score, album_score = server.rank_track_match(target, candidate)
    else:
        target_title = server.normalize_track_text(target.get("title", ""))
        candidate_title = server.normalize_track_text(candidate.get("name", ""))
        title_score = 8 if target_title == candidate_title else 5
        title_artist_score = title_score + 5
        target_album = server.normalize_track_text(target.get("album", ""))
        candidate_album = server.normalize_track_text(
            (candidate.get("album") or {}).get("name", "")
        )
        album_score = int(bool(target_album and target_album == candidate_album))

    release_date = parse_public_release_date(
        (candidate.get("album") or {}).get("release_date")
    )
    date_digits = re.sub(r"\D", "", release_date)
    if len(date_digits) == 4:
        date_digits += "0101"
    elif len(date_digits) == 6:
        date_digits += "01"
    has_release_date = int(len(date_digits) == 8)
    earliest_release_score = -int(date_digits) if has_release_date else -99999999
    return (
        album_score,
        has_release_date,
        earliest_release_score,
        title_artist_score,
    )


class SpotifyPublicCandidateResolver:
    """Resolve verified public matches, preserving source order for final ties."""

    def __init__(self, candidates: Iterable[dict[str, Any]]) -> None:
        self.candidates = []
        self.candidates_by_title_token: dict[str, list[dict[str, Any]]] = {}
        self.candidates_by_id: dict[str, dict[str, Any]] = {}
        seen = set()
        for candidate in candidates:
            track_id = str(candidate.get("id", "")) if isinstance(candidate, dict) else ""
            if (
                not SPOTIFY_ID_PATTERN.fullmatch(track_id)
                or track_id in seen
                or not metadata_from_public_candidate(candidate)
            ):
                continue
            self.candidates.append(candidate)
            self.candidates_by_id[track_id] = candidate
            title_token = next(
                iter(server.normalize_track_text(candidate.get("name", "")).split()),
                "",
            )
            if title_token:
                self.candidates_by_title_token.setdefault(title_token, []).append(candidate)
            seen.add(track_id)
        self.matched: list[dict[str, Any]] = []
        self.missing: list[dict[str, Any]] = []
        self.review: list[dict[str, Any]] = []

    def resolve(self, group: dict[str, Any]) -> dict[str, Any] | None:
        target = group["target"]
        preferred_ids = set(group.get("preferred_ids", []))
        if preferred_ids:
            preferred_candidates = [
                self.candidates_by_id[track_id]
                for track_id in preferred_ids
                if track_id in self.candidates_by_id
            ]
            overrides_by_id: dict[str, list[dict[str, Any]]] = {}
            for override in group.get("preferred_overrides", []):
                if not isinstance(override, dict):
                    continue
                track_id = str(override.get("spotifyTrackId") or "")
                if track_id not in preferred_ids:
                    continue
                alias_target = dict(target)
                if override.get("matchTitle"):
                    alias_target["title"] = override["matchTitle"]
                if override.get("matchArtist"):
                    alias_target["artist"] = override["matchArtist"]
                overrides_by_id.setdefault(track_id, []).append(alias_target)
            preferred_matches = [
                candidate
                for candidate in preferred_candidates
                if any(
                    is_public_track_match(alias_target, candidate)
                    for alias_target in overrides_by_id.get(
                        str(candidate.get("id") or ""),
                        [target],
                    )
                )
            ]
            if len(preferred_matches) == 1:
                return self._accept(group, preferred_matches[0], "preferred-id")
            self._add_review(
                group,
                preferred_candidates,
                "preferred-id-unavailable-or-mismatch",
            )
            self.missing.append(
                self._target_summary(group, "preferred-id-unavailable-or-mismatch")
            )
            return None

        target_title_token = next(
            iter(server.normalize_track_text(target.get("title", "")).split()),
            "",
        )
        candidate_pool = self.candidates_by_title_token.get(target_title_token, [])
        strict_candidates = [
            candidate
            for candidate in candidate_pool
            if is_public_track_match(target, candidate)
        ]
        if not strict_candidates:
            self.missing.append(self._target_summary(group, "no-strict-match"))
            return None

        existing_ids = set(group.get("existing_ids", []))
        exact_id_candidates = [
            candidate
            for candidate in strict_candidates
            if candidate.get("id") in existing_ids
        ]
        if len(exact_id_candidates) == 1:
            return self._accept(group, exact_id_candidates[0], "existing-id")
        if len(exact_id_candidates) > 1:
            self._add_review(group, exact_id_candidates, "multiple-existing-ids")
            return None

        ranked = [
            (rank_public_track_match(target, candidate), candidate)
            for candidate in strict_candidates
        ]
        best_rank = max(rank for rank, _ in ranked)
        best_candidates = [candidate for rank, candidate in ranked if rank == best_rank]
        if len(best_candidates) > 1:
            selected = best_candidates[0]
            self._add_review(
                group,
                best_candidates,
                "source-order-tiebreak",
                best_rank,
                selected=selected,
            )
            return self._accept(group, selected, "source-order-tiebreak")
        return self._accept(group, best_candidates[0], "unique-top-rank")

    def _accept(
        self,
        group: dict[str, Any],
        candidate: dict[str, Any],
        reason: str,
    ) -> dict[str, Any] | None:
        metadata = metadata_from_public_candidate(candidate)
        if not metadata:
            self.missing.append(self._target_summary(group, "invalid-metadata"))
            return None
        self.matched.append(
            {
                **self._target_summary(group, reason),
                "candidate": public_candidate_summary(candidate),
            }
        )
        return metadata

    def _add_review(
        self,
        group: dict[str, Any],
        candidates: list[dict[str, Any]],
        reason: str,
        rank: tuple[int, ...] | None = None,
        selected: dict[str, Any] | None = None,
    ) -> None:
        record = self._target_summary(group, reason)
        record["rank"] = list(rank) if rank is not None else None
        record["selected"] = (
            public_candidate_summary(selected) if selected is not None else None
        )
        record["candidates"] = [
            public_candidate_summary(candidate) for candidate in candidates
        ]
        self.review.append(record)

    @staticmethod
    def _target_summary(group: dict[str, Any], reason: str) -> dict[str, Any]:
        return {
            "key": group["key"],
            "title": group["title"],
            "artist": group["artist"],
            "reason": reason,
        }


def load_checkpoint(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if payload.get("version") != CHECKPOINT_VERSION:
        return {}
    raw_results = payload.get("results")
    if not isinstance(raw_results, dict):
        return {}
    results = {}
    for key, record in raw_results.items():
        metadata = record.get("metadata") if isinstance(record, dict) else None
        if isinstance(key, str) and validate_metadata(metadata):
            results[key] = compact_verified_metadata(metadata)
    return results


def checkpoint_payload(
    groups_by_key: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    return {
        "version": CHECKPOINT_VERSION,
        "results": {
            key: {
                "title": groups_by_key[key]["title"],
                "artist": groups_by_key[key]["artist"],
                "metadata": results[key],
            }
            for key in results
            if key in groups_by_key and validate_metadata(results[key])
        },
    }


def serialize_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def stage_text(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        text=True,
    )
    temp_path = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            os.chmod(temp_path, path.stat().st_mode)
        return temp_path
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def atomic_write_json(path: Path, payload: Any) -> None:
    temp_path = stage_text(path, serialize_json(payload))
    try:
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def atomic_write_documents(paths: list[Path], documents: list[dict[str, Any]]) -> None:
    if len(paths) != len(documents):
        raise ValueError("Each data file must have one loaded document.")
    staged: list[tuple[Path, Path]] = []
    try:
        for path, document in zip(paths, documents):
            staged.append((path, stage_text(path, serialize_json(document))))
        for path, temp_path in staged:
            os.replace(temp_path, path)
    finally:
        for _, temp_path in staged:
            temp_path.unlink(missing_ok=True)


def apply_metadata_to_group(
    documents: list[dict[str, Any]],
    group: dict[str, Any],
    metadata: dict[str, Any],
) -> int:
    if not validate_metadata(metadata):
        return 0
    changed = 0
    for document_index, genre_index, track_index in group["placements"]:
        track = documents[document_index]["genres"][genre_index]["tracks"][track_index]
        original = copy.deepcopy(track)
        for field in METADATA_FIELDS:
            track.pop(field, None)
        track.update(metadata)
        if track != original:
            changed += 1
    return changed


def run_backfill(
    paths: list[Path],
    resolver: SpotifyTrackResolver,
    *,
    checkpoint_path: Path,
    dry_run: bool = False,
    limit: int | None = None,
    reset_checkpoint: bool = False,
    checkpoint_every: int = 10,
    preferred_track_ids: dict[str, list[str]] | None = None,
    preferred_track_overrides: dict[str, list[dict[str, str]]] | None = None,
    ignore_catalogue_ids: bool = False,
    progress: Callable[[str], None] | None = print,
) -> dict[str, int]:
    documents = load_documents(paths)
    original_documents = copy.deepcopy(documents)
    groups = collect_track_groups(documents)
    preferred_track_ids = preferred_track_ids or {}
    preferred_track_overrides = preferred_track_overrides or {}
    for group in groups:
        overrides = [
            dict(override)
            for override in preferred_track_overrides.get(group["key"], [])
        ]
        preferred_ids = [
            override["spotifyTrackId"]
            for override in overrides
            if SPOTIFY_ID_PATTERN.fullmatch(override.get("spotifyTrackId", ""))
        ]
        for track_id in preferred_track_ids.get(group["key"], []):
            if track_id not in preferred_ids:
                preferred_ids.append(track_id)
                overrides.append({"spotifyTrackId": track_id})
        group["preferred_ids"] = preferred_ids
        group["preferred_overrides"] = overrides
        catalogue_ids = [] if ignore_catalogue_ids else group["existing_ids"]
        group["existing_ids"] = preferred_ids + [
            track_id for track_id in catalogue_ids if track_id not in preferred_ids
        ]
    if ignore_catalogue_ids:
        for document in documents:
            for genre in document.get("genres", []):
                for track in genre.get("tracks", []):
                    if not isinstance(track, dict):
                        continue
                    for field in METADATA_FIELDS:
                        track.pop(field, None)
    groups_by_key = {group["key"]: group for group in groups}
    results = {} if reset_checkpoint else load_checkpoint(checkpoint_path)
    results = {key: value for key, value in results.items() if key in groups_by_key}

    changed_placements = 0
    checkpoint_hits = 0
    for key, metadata in results.items():
        changed_placements += apply_metadata_to_group(
            documents,
            groups_by_key[key],
            metadata,
        )
        checkpoint_hits += 1

    pending = [group for group in groups if group["key"] not in results]
    pending.sort(key=lambda group: (not bool(group["existing_ids"]), group["ordinal"]))
    selected = pending if limit is None else pending[: max(0, limit)]
    resolved_now = 0
    unresolved_now = 0
    checkpoint_every = max(1, checkpoint_every)

    try:
        for index, group in enumerate(selected, start=1):
            metadata = resolver.resolve(group)
            if not metadata or not validate_metadata(metadata):
                unresolved_now += 1
                if progress:
                    progress(
                        f"[{index}/{len(selected)}] no strict Spotify match: "
                        f"{group['title']} — {group['artist']}"
                    )
                continue
            results[group["key"]] = metadata
            changed_placements += apply_metadata_to_group(documents, group, metadata)
            resolved_now += 1
            if progress:
                progress(
                    f"[{index}/{len(selected)}] matched: "
                    f"{group['title']} — {group['artist']}"
                )
            if not dry_run and resolved_now % checkpoint_every == 0:
                atomic_write_json(
                    checkpoint_path,
                    checkpoint_payload(groups_by_key, results),
                )
    finally:
        if not dry_run and (results or reset_checkpoint):
            atomic_write_json(
                checkpoint_path,
                checkpoint_payload(groups_by_key, results),
            )

    if not dry_run and documents != original_documents:
        atomic_write_documents(paths, documents)

    return {
        "trackPlacements": sum(len(group["placements"]) for group in groups),
        "uniqueTracks": len(groups),
        "selected": len(selected),
        "resolvedNow": resolved_now,
        "unresolvedNow": unresolved_now,
        "checkpointHits": checkpoint_hits,
        "resolvedTotal": len(results),
        "remaining": max(0, len(groups) - len(results)),
        "changedPlacements": changed_placements,
    }


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def build_public_report(
    *,
    source_path: Path,
    cache_path: Path,
    invalid_source_ids: list[str],
    fetch_summary: dict[str, Any],
    resolver: SpotifyPublicCandidateResolver,
    stats: dict[str, int],
) -> dict[str, Any]:
    return {
        "mode": "spotify-public-meta",
        "source": str(source_path),
        "cache": str(cache_path),
        "invalidSourceIds": invalid_source_ids,
        "pages": fetch_summary,
        "backfill": stats,
        "matched": resolver.matched,
        "missing": resolver.missing,
        "reviewRequired": resolver.review,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Backfill all curated MusicDigger tracks from Spotify Web API.",
    )
    parser.add_argument(
        "--data-files",
        nargs="+",
        type=Path,
        default=list(DEFAULT_DATA_FILES),
        help="Catalogue JSON files (defaults to both MusicDigger data files).",
    )
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--preferred-ids", type=Path, default=DEFAULT_PREFERRED_IDS)
    parser.add_argument(
        "--ignore-catalogue-ids",
        action="store_true",
        help="Ignore previously generated catalogue IDs, while keeping preferred IDs.",
    )
    parser.add_argument("--reset-checkpoint", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--limit",
        type=non_negative_int,
        help="Process at most this many unresolved unique tracks.",
    )
    parser.add_argument("--market", default=os.environ.get("SPOTIFY_MARKET", "US"))
    parser.add_argument("--search-limit", type=int, default=10)
    parser.add_argument("--request-delay", type=float, default=0.1)
    parser.add_argument("--max-rate-limit-retries", type=non_negative_int, default=8)
    parser.add_argument("--checkpoint-every", type=non_negative_int, default=10)
    parser.add_argument(
        "--public-candidates",
        type=Path,
        help="Use Spotify public track-page IDs instead of Web API credentials.",
    )
    parser.add_argument("--public-cache", type=Path, default=DEFAULT_PUBLIC_CACHE)
    parser.add_argument("--public-report", type=Path, default=DEFAULT_PUBLIC_REPORT)
    parser.add_argument("--public-workers", type=int, choices=range(1, 17), default=8)
    parser.add_argument("--public-timeout", type=float, default=12.0)
    parser.add_argument("--public-retries", type=non_negative_int, default=3)
    parser.add_argument(
        "--public-request-interval",
        type=float,
        default=0.25,
        help="Minimum interval in seconds between all public Spotify requests.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    public_context = None
    preferred_track_overrides = load_preferred_track_overrides(args.preferred_ids)

    if args.public_candidates:
        track_ids, invalid_source_ids = load_public_candidate_ids(
            args.public_candidates
        )
        seen_track_ids = set(track_ids)
        for overrides in preferred_track_overrides.values():
            for override in overrides:
                track_id = override["spotifyTrackId"]
                if track_id not in seen_track_ids:
                    track_ids.append(track_id)
                    seen_track_ids.add(track_id)
        page_client = SpotifyPublicPageClient(
            timeout=args.public_timeout,
            retries=args.public_retries,
            min_request_interval=args.public_request_interval,
        )
        candidates, fetch_summary = fetch_public_page_candidates(
            track_ids,
            page_client,
            cache_path=args.public_cache,
            workers=args.public_workers,
            checkpoint_every=max(1, args.checkpoint_every),
            write_cache=not args.dry_run,
        )
        resolver = SpotifyPublicCandidateResolver(candidates)
        public_context = (invalid_source_ids, fetch_summary)
    else:
        if not os.environ.get("SPOTIFY_CLIENT_ID") or not os.environ.get(
            "SPOTIFY_CLIENT_SECRET"
        ):
            raise SystemExit(
                "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in the "
                "environment, or use --public-candidates."
            )
        client = SpotifyAPIClient(
            max_rate_limit_retries=args.max_rate_limit_retries,
            request_delay=args.request_delay,
        )
        resolver = SpotifyTrackResolver(
            client,
            market=args.market,
            search_limit=args.search_limit,
        )

    stats = run_backfill(
        list(args.data_files),
        resolver,
        checkpoint_path=args.checkpoint,
        dry_run=args.dry_run,
        limit=args.limit,
        reset_checkpoint=args.reset_checkpoint,
        checkpoint_every=max(1, args.checkpoint_every),
        preferred_track_overrides=preferred_track_overrides,
        ignore_catalogue_ids=args.ignore_catalogue_ids,
    )

    output: dict[str, Any] = stats
    if public_context is not None:
        invalid_source_ids, fetch_summary = public_context
        report = build_public_report(
            source_path=args.public_candidates,
            cache_path=args.public_cache,
            invalid_source_ids=invalid_source_ids,
            fetch_summary=fetch_summary,
            resolver=resolver,
            stats=stats,
        )
        if not args.dry_run:
            atomic_write_json(args.public_report, report)
        output = {
            "backfill": stats,
            "publicPages": {
                **fetch_summary,
                "matched": len(resolver.matched),
                "missing": len(resolver.missing),
                "reviewRequired": len(resolver.review),
                "report": str(args.public_report),
            },
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
