import copy
import json
from pathlib import Path
import tempfile
import unittest

import server
from scripts import backfill_spotify_metadata as backfill


def spotify_track(
    *,
    title="Alpha",
    artist="Artist One",
    track_id="T" * 22,
    album_id="A" * 22,
    with_cover=True,
    release_date="",
):
    images = (
        [
            {"url": f"https://i.scdn.co/image/{track_id}-large"},
            {"url": f"https://i.scdn.co/image/{track_id}-small"},
        ]
        if with_cover
        else []
    )
    return {
        "id": track_id,
        "name": title,
        "artists": [{"id": "artist-one", "name": artist}],
        "album": {
            "id": album_id,
            "name": "Album One",
            "images": images,
            "external_urls": {
                "spotify": f"https://open.spotify.com/album/{album_id}"
            },
            "release_date": release_date,
        },
        "duration_ms": 190000,
        "uri": f"spotify:track:{track_id}",
        "external_urls": {
            "spotify": f"https://open.spotify.com/track/{track_id}"
        },
        "external_ids": {"isrc": "USAAA2600001"},
    }


def verified_metadata(**overrides):
    item = spotify_track(**overrides)
    track_id = item["id"]
    album_id = item["album"]["id"]
    images = [image["url"] for image in item["album"]["images"]]
    return {
        "spotifyTrackId": track_id,
        "spotifyUri": f"spotify:track:{track_id}",
        "spotifyUrl": f"https://open.spotify.com/track/{track_id}",
        "album": item["album"]["name"],
        "albumId": album_id,
        "albumUrl": f"https://open.spotify.com/album/{album_id}",
        "albumImage": images[0],
        "albumImages": images,
        "durationMs": item["duration_ms"],
        "isrc": item["external_ids"]["isrc"],
    }


def public_page_html(
    *,
    title="Alpha",
    artists=("Artist One",),
    album="Album One",
    album_id="A" * 22,
    image="https://i.scdn.co/image/public-cover",
    duration="190",
    release_date="2026-01-02",
):
    artist_meta = "\n".join(
        f'<meta name="music:musician_description" content="{artist}">'
        for artist in artists
    )
    return f"""
    <html><head>
      <meta property="og:title" content="{title}">
      {artist_meta}
      <meta property="og:description" content="{artists[0]} · {album} · Song · 2026">
      <meta property="og:image" content="{image}">
      <meta property="music:album" content="https://open.spotify.com/album/{album_id}">
      <meta property="music:duration" content="{duration}">
      <meta property="music:release_date" content="{release_date}">
    </head></html>
    """


class FakeClient:
    def __init__(self, callback):
        self.callback = callback
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        return self.callback(path, params)


class ResolverTests(unittest.TestCase):
    def test_existing_id_is_looked_up_before_search(self):
        track_id = "E" * 22
        item = spotify_track(track_id=track_id)
        client = FakeClient(lambda _path, _params: item)
        resolver = backfill.SpotifyTrackResolver(client)
        group = {
            "target": {"title": "Alpha", "artist": "Artist One"},
            "existing_ids": [track_id],
        }

        metadata = resolver.resolve(group)

        self.assertTrue(backfill.validate_metadata(metadata))
        self.assertEqual(client.calls[0][0], f"/tracks/{track_id}")
        self.assertFalse(any(path == "/search" for path, _ in client.calls))

    def test_market_relink_keeps_the_curated_track_id(self):
        requested_id = "R" * 22
        relinked = spotify_track(track_id="L" * 22)
        client = FakeClient(lambda _path, _params: relinked)
        resolver = backfill.SpotifyTrackResolver(client)

        metadata = resolver.resolve(
            {
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [requested_id],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], requested_id)
        self.assertEqual(metadata["spotifyUri"], f"spotify:track:{requested_id}")
        self.assertEqual(
            metadata["spotifyUrl"],
            f"https://open.spotify.com/track/{requested_id}",
        )

    def test_mismatched_existing_id_falls_back_to_strict_search(self):
        old_id = "O" * 22
        correct = spotify_track(track_id="C" * 22)
        wrong = spotify_track(
            title="Alpha Tribute",
            artist="Cover Band",
            track_id=old_id,
        )

        def respond(path, _params):
            if path == f"/tracks/{old_id}":
                return wrong
            if path == "/search":
                return {"tracks": {"items": [wrong, correct]}}
            raise AssertionError(path)

        client = FakeClient(respond)
        resolver = backfill.SpotifyTrackResolver(client)
        metadata = resolver.resolve(
            {
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [old_id],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], correct["id"])
        self.assertEqual(client.calls[0][0], f"/tracks/{old_id}")
        self.assertEqual(client.calls[1][0], "/search")

    def test_track_without_embedded_images_fetches_its_album(self):
        item = spotify_track(with_cover=False)
        cover = "https://i.scdn.co/image/recovered-cover"

        def respond(path, _params):
            if path == "/search":
                return {"tracks": {"items": [item]}}
            if path == f"/albums/{item['album']['id']}":
                album = copy.deepcopy(item["album"])
                album["images"] = [{"url": cover}]
                return album
            raise AssertionError(path)

        resolver = backfill.SpotifyTrackResolver(FakeClient(respond))
        metadata = resolver.resolve(
            {
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["albumImage"], cover)
        self.assertTrue(backfill.validate_metadata(metadata))

    def test_rate_limit_retries_after_retry_after_or_exponential_delay(self):
        class RateLimitedCatalog:
            def __init__(self):
                self.calls = 0

            def _spotify_get(self, _path, _params):
                self.calls += 1
                if self.calls == 1:
                    raise server.SpotifyRateLimitError("slow down", 3)
                return {"ok": True}

        catalog = RateLimitedCatalog()
        sleeps = []
        client = backfill.SpotifyAPIClient(
            catalog,
            max_rate_limit_retries=2,
            request_delay=0,
            sleep=sleeps.append,
        )

        self.assertEqual(client.get("/test"), {"ok": True})
        self.assertEqual(catalog.calls, 2)
        self.assertEqual(sleeps, [3.0])


class PublicPageTests(unittest.TestCase):
    def test_html_parser_builds_api_candidate_from_repeated_meta(self):
        track_id = "P" * 22
        album_id = "B" * 22
        candidate = backfill.parse_public_track_page(
            track_id,
            public_page_html(
                title="Alpha &amp; Omega",
                artists=("Artist One", "Guest Two"),
                album="Public Album",
                album_id=album_id,
                duration="190.25",
            ),
        )

        self.assertEqual(candidate["name"], "Alpha & Omega")
        self.assertEqual(
            [artist["name"] for artist in candidate["artists"]],
            ["Artist One", "Guest Two"],
        )
        self.assertEqual(candidate["album"]["name"], "Public Album")
        self.assertEqual(candidate["album"]["id"], album_id)
        self.assertEqual(candidate["album"]["release_date"], "2026-01-02")
        self.assertEqual(candidate["duration_ms"], 190250)
        metadata = backfill.metadata_from_public_candidate(candidate)
        self.assertTrue(backfill.validate_metadata(metadata))
        self.assertEqual(metadata["albumImages"], [metadata["albumImage"]])

    def test_html_parser_refuses_a_page_without_a_cover(self):
        html = public_page_html().replace(
            '<meta property="og:image" content="https://i.scdn.co/image/public-cover">',
            "",
        )
        self.assertIsNone(backfill.parse_public_track_page("P" * 22, html))

    def test_public_resolver_accepts_only_a_unique_top_rank(self):
        exact = spotify_track(track_id="E" * 22)
        lower_rank = spotify_track(
            title="Alpha Remastered",
            track_id="R" * 22,
            album_id="B" * 22,
        )
        resolver = backfill.SpotifyPublicCandidateResolver([lower_rank, exact])
        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], exact["id"])
        self.assertEqual(len(resolver.matched), 1)
        self.assertFalse(resolver.review)

    def test_public_resolver_title_index_keeps_safe_suffix_candidates(self):
        candidate = spotify_track(
            title="Alpha Remastered",
            track_id="R" * 22,
            release_date="2001-01-01",
        )
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], candidate["id"])

    def test_public_resolver_accepts_a_primary_first_combined_credit(self):
        candidate = spotify_track(
            title="Feather (feat. Cise Starr & Akin from CYNE)",
            artist="Nujabes, Cise Starr, Akin",
        )
        candidate["artists"][0]["id"] = None
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "feather::nujabes",
                "title": "Feather",
                "artist": "Nujabes",
                "target": {"title": "Feather", "artist": "Nujabes"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], candidate["id"])

    def test_public_resolver_does_not_relax_an_api_style_artist_entry(self):
        candidate = spotify_track(
            title="Feather (feat. Cise Starr & Akin from CYNE)",
            artist="Nujabes, Cise Starr, Akin",
        )
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "feather::nujabes",
                "title": "Feather",
                "artist": "Nujabes",
                "target": {"title": "Feather", "artist": "Nujabes"},
                "existing_ids": [],
            }
        )

        self.assertIsNone(metadata)

    def test_public_resolver_rejects_a_combined_credit_missing_the_guest(self):
        candidate = spotify_track(
            title="That's Not Me",
            artist="Skepta, D Double E, Tempa T",
        )
        candidate["artists"][0]["id"] = None
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "thats not me::skepta jme",
                "title": "That's Not Me",
                "artist": "Skepta feat. Jme",
                "target": {
                    "title": "That's Not Me",
                    "artist": "Skepta feat. Jme",
                },
                "existing_ids": [],
            }
        )

        self.assertIsNone(metadata)

    def test_public_resolver_rejects_a_target_artist_listed_second(self):
        candidate = spotify_track(
            title="Ex-Factor",
            artist="Pollie Pop, Ms. Lauryn Hill",
        )
        candidate["artists"][0]["id"] = None
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "ex factor::lauryn hill",
                "title": "Ex-Factor",
                "artist": "Lauryn Hill",
                "target": {"title": "Ex-Factor", "artist": "Lauryn Hill"},
                "existing_ids": [],
            }
        )

        self.assertIsNone(metadata)

    def test_public_resolver_rejects_a_primary_name_prefix_tribute_credit(self):
        candidate = spotify_track(
            title="Alpha",
            artist="Artist One Tribute, Guest Two",
        )
        candidate["artists"][0]["id"] = None
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertIsNone(metadata)

    def test_public_resolver_accepts_safe_lead_artist_credit_variants(self):
        cases = (
            (
                "Corcovado",
                "Stan Getz & Astrud Gilberto",
                "Stan Getz, João Gilberto, Astrud Gilberto, Antônio Carlos Jobim",
            ),
            ("Ex-Factor", "Lauryn Hill", "Ms. Lauryn Hill, Guest Artist"),
            ("Iris", "Goo Goo Dolls", "The Goo Goo Dolls, Guest Artist"),
        )
        for index, (title, target_artist, public_credit) in enumerate(cases):
            with self.subTest(title=title):
                candidate = spotify_track(
                    title=title,
                    artist=public_credit,
                    track_id=(str(index + 1) * 22),
                )
                candidate["artists"][0]["id"] = None
                resolver = backfill.SpotifyPublicCandidateResolver([candidate])
                metadata = resolver.resolve(
                    {
                        "key": f"case-{index}",
                        "title": title,
                        "artist": target_artist,
                        "target": {"title": title, "artist": target_artist},
                        "existing_ids": [],
                    }
                )
                self.assertIsNotNone(metadata)

    def test_public_resolver_uses_source_order_and_reports_equal_top_matches(self):
        first = spotify_track(track_id="F" * 22, album_id="A" * 22)
        second = spotify_track(track_id="S" * 22, album_id="B" * 22)
        resolver = backfill.SpotifyPublicCandidateResolver([first, second])
        group = {
            "key": "alpha::artist one",
            "title": "Alpha",
            "artist": "Artist One",
            "target": {"title": "Alpha", "artist": "Artist One"},
            "existing_ids": [],
        }

        metadata = resolver.resolve(group)

        self.assertEqual(metadata["spotifyTrackId"], first["id"])
        self.assertEqual(len(resolver.review), 1)
        self.assertEqual(resolver.review[0]["reason"], "source-order-tiebreak")
        self.assertEqual(
            resolver.review[0]["selected"]["spotifyTrackId"],
            first["id"],
        )
        self.assertEqual(len(resolver.review[0]["candidates"]), 2)

    def test_public_resolver_prefers_the_earliest_original_release(self):
        compilation = spotify_track(
            track_id="C" * 22,
            album_id="B" * 22,
            release_date="2019-01-01",
        )
        compilation["album"]["name"] = "NOW That's What I Call Hits"
        original = spotify_track(
            track_id="O" * 22,
            album_id="D" * 22,
            release_date="2003-02-06",
        )
        original["album"]["name"] = "Original Album"
        resolver = backfill.SpotifyPublicCandidateResolver([compilation, original])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], original["id"])
        self.assertEqual(metadata["album"], "Original Album")

    def test_earliest_release_beats_a_later_exact_title_compilation(self):
        compilation = spotify_track(
            title="Alpha",
            track_id="C" * 22,
            album_id="B" * 22,
            release_date="2019-01-01",
        )
        original = spotify_track(
            title="Alpha - Remastered 2003",
            track_id="O" * 22,
            album_id="D" * 22,
            release_date="2003-01-01",
        )
        resolver = backfill.SpotifyPublicCandidateResolver([compilation, original])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], original["id"])

    def test_existing_id_disambiguates_equal_public_matches(self):
        first = spotify_track(track_id="F" * 22, album_id="A" * 22)
        second = spotify_track(track_id="S" * 22, album_id="B" * 22)
        resolver = backfill.SpotifyPublicCandidateResolver([first, second])
        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "existing_ids": [second["id"]],
            }
        )

        self.assertEqual(metadata["spotifyTrackId"], second["id"])
        self.assertFalse(resolver.review)

    def test_preferred_id_mismatch_does_not_silently_choose_another_track(self):
        preferred = spotify_track(
            title="Wrong Song",
            track_id="P" * 22,
            album_id="P" * 22,
        )
        alternative = spotify_track(track_id="A" * 22, album_id="A" * 22)
        resolver = backfill.SpotifyPublicCandidateResolver([preferred, alternative])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "preferred_ids": [preferred["id"]],
                "existing_ids": [preferred["id"]],
            }
        )

        self.assertIsNone(metadata)
        self.assertEqual(
            resolver.review[0]["reason"],
            "preferred-id-unavailable-or-mismatch",
        )

    def test_preferred_alias_mismatch_rejects_even_catalogue_identity_match(self):
        preferred = spotify_track(
            title="Alpha",
            artist="Artist One",
            track_id="P" * 22,
            album_id="P" * 22,
        )
        resolver = backfill.SpotifyPublicCandidateResolver([preferred])

        metadata = resolver.resolve(
            {
                "key": "alpha::artist one",
                "title": "Alpha",
                "artist": "Artist One",
                "target": {"title": "Alpha", "artist": "Artist One"},
                "preferred_ids": [preferred["id"]],
                "preferred_overrides": [
                    {
                        "spotifyTrackId": preferred["id"],
                        "matchTitle": "Different Spotify Title",
                    }
                ],
                "existing_ids": [preferred["id"]],
            }
        )

        self.assertIsNone(metadata)
        self.assertEqual(
            resolver.review[0]["reason"],
            "preferred-id-unavailable-or-mismatch",
        )

    def test_public_page_client_retries_and_passes_timeout(self):
        class Headers:
            @staticmethod
            def get_content_charset():
                return "utf-8"

        class Response:
            headers = Headers()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            @staticmethod
            def read(_limit):
                return public_page_html().encode("utf-8")

        calls = []

        def urlopen(_request, timeout):
            calls.append(timeout)
            if len(calls) == 1:
                raise backfill.error.URLError("temporary")
            return Response()

        sleeps = []
        client = backfill.SpotifyPublicPageClient(
            timeout=7,
            retries=1,
            sleep=sleeps.append,
            urlopen=urlopen,
        )
        candidate = client.fetch("P" * 22)

        self.assertEqual(candidate["name"], "Alpha")
        self.assertEqual(calls, [7, 7])
        self.assertEqual(sleeps, [1])


class BackfillFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        root = Path(self.temporary_directory.name)
        self.first_path = root / "genres.json"
        self.second_path = root / "genre-expansion.json"
        self.checkpoint_path = root / "checkpoint.json"

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_catalogues(self, first_tracks, second_tracks):
        first = {
            "genres": [
                {"id": "one", "name": "One", "tracks": copy.deepcopy(first_tracks)}
            ]
        }
        second = {
            "genres": [
                {"id": "two", "name": "Two", "tracks": copy.deepcopy(second_tracks)}
            ]
        }
        self.first_path.write_text(backfill.serialize_json(first), encoding="utf-8")
        self.second_path.write_text(backfill.serialize_json(second), encoding="utf-8")

    def read_tracks(self, path):
        return json.loads(path.read_text(encoding="utf-8"))["genres"][0]["tracks"]

    def test_duplicate_placements_receive_identical_metadata_without_reordering(self):
        self.write_catalogues(
            [
                {"title": "First", "artist": "Artist A"},
                {"title": "Alpha", "artist": "Artist One"},
            ],
            [
                {"title": "Alpha", "artist": "Artist One"},
                {"title": "Last", "artist": "Artist Z"},
            ],
        )
        alpha_metadata = verified_metadata()

        class StubResolver:
            def resolve(self, group):
                return alpha_metadata if group["title"] == "Alpha" else None

        paths = [self.first_path, self.second_path]
        before_identity = [
            [(track["title"], track["artist"]) for track in self.read_tracks(path)]
            for path in paths
        ]
        stats = backfill.run_backfill(
            paths,
            StubResolver(),
            checkpoint_path=self.checkpoint_path,
            progress=None,
        )
        after_tracks = [self.read_tracks(path) for path in paths]

        self.assertEqual(
            [[(track["title"], track["artist"]) for track in tracks] for tracks in after_tracks],
            before_identity,
        )
        self.assertEqual(
            {key: after_tracks[0][1].get(key) for key in backfill.METADATA_FIELDS},
            {key: after_tracks[1][0].get(key) for key in backfill.METADATA_FIELDS},
        )
        self.assertEqual(after_tracks[0][1]["albumImage"], alpha_metadata["albumImage"])
        self.assertEqual(stats["resolvedNow"], 1)
        self.assertEqual(stats["changedPlacements"], 2)

    def test_invalid_result_does_not_change_track(self):
        original = {
            "title": "Alpha",
            "artist": "Artist One",
            "note": "preserve me",
        }
        self.write_catalogues([original], [])

        class InvalidResolver:
            def resolve(self, _group):
                return {"spotifyTrackId": "bad", "albumImage": "http://invalid"}

        backfill.run_backfill(
            [self.first_path, self.second_path],
            InvalidResolver(),
            checkpoint_path=self.checkpoint_path,
            progress=None,
        )

        self.assertEqual(self.read_tracks(self.first_path)[0], original)
        self.assertFalse(self.checkpoint_path.exists())

    def test_dry_run_writes_neither_catalogue_nor_checkpoint(self):
        self.write_catalogues([{"title": "Alpha", "artist": "Artist One"}], [])
        before = self.first_path.read_bytes()

        class StubResolver:
            def resolve(self, _group):
                return verified_metadata()

        stats = backfill.run_backfill(
            [self.first_path, self.second_path],
            StubResolver(),
            checkpoint_path=self.checkpoint_path,
            dry_run=True,
            progress=None,
        )

        self.assertEqual(self.first_path.read_bytes(), before)
        self.assertFalse(self.checkpoint_path.exists())
        self.assertEqual(stats["resolvedNow"], 1)

    def test_checkpoint_resume_applies_metadata_without_an_api_lookup(self):
        self.write_catalogues([{"title": "Alpha", "artist": "Artist One"}], [])
        documents = backfill.load_documents([self.first_path, self.second_path])
        group = backfill.collect_track_groups(documents)[0]
        metadata = verified_metadata()
        backfill.atomic_write_json(
            self.checkpoint_path,
            backfill.checkpoint_payload(
                {group["key"]: group},
                {group["key"]: metadata},
            ),
        )

        class MustNotResolve:
            def resolve(self, _group):
                raise AssertionError("checkpointed tracks must not call Spotify")

        stats = backfill.run_backfill(
            [self.first_path, self.second_path],
            MustNotResolve(),
            checkpoint_path=self.checkpoint_path,
            progress=None,
        )

        self.assertEqual(stats["checkpointHits"], 1)
        self.assertEqual(stats["selected"], 0)
        self.assertEqual(
            self.read_tracks(self.first_path)[0]["albumImage"],
            metadata["albumImage"],
        )

    def test_limit_counts_unique_tracks_and_existing_ids_are_processed_first(self):
        existing_id = "E" * 22
        self.write_catalogues(
            [
                {"title": "No ID", "artist": "Artist A"},
                {
                    "title": "Has ID",
                    "artist": "Artist B",
                    "spotifyTrackId": existing_id,
                },
            ],
            [],
        )
        seen = []

        class RecordingResolver:
            def resolve(self, group):
                seen.append(group["title"])
                return None

        stats = backfill.run_backfill(
            [self.first_path, self.second_path],
            RecordingResolver(),
            checkpoint_path=self.checkpoint_path,
            limit=1,
            progress=None,
        )

        self.assertEqual(seen, ["Has ID"])
        self.assertEqual(stats["selected"], 1)

    def test_preferred_ids_replace_generated_catalogue_ids_when_ignored(self):
        generated_id = "G" * 22
        preferred_id = "P" * 22
        self.write_catalogues(
            [
                {
                    "title": "Alpha",
                    "artist": "Artist One",
                    "spotifyTrackId": generated_id,
                }
            ],
            [],
        )
        seen = []

        class RecordingResolver:
            def resolve(self, group):
                seen.extend(group["existing_ids"])
                return None

        backfill.run_backfill(
            [self.first_path, self.second_path],
            RecordingResolver(),
            checkpoint_path=self.checkpoint_path,
            preferred_track_ids={"alpha::artist one": [preferred_id]},
            ignore_catalogue_ids=True,
            progress=None,
        )

        self.assertEqual(seen, [preferred_id])

    def test_preferred_alias_matches_variant_without_changing_catalogue_identity(self):
        preferred_id = "P" * 22
        candidate = spotify_track(
            title="Spotify Title Variant",
            artist="Spotify Artist Credit",
            track_id=preferred_id,
            album_id="V" * 22,
        )
        resolver = backfill.SpotifyPublicCandidateResolver([candidate])
        self.write_catalogues(
            [{"title": "Display Title", "artist": "Display Artist"}],
            [],
        )

        stats = backfill.run_backfill(
            [self.first_path, self.second_path],
            resolver,
            checkpoint_path=self.checkpoint_path,
            preferred_track_overrides={
                "display title::display artist": [
                    {
                        "spotifyTrackId": preferred_id,
                        "matchTitle": "Spotify Title Variant",
                        "matchArtist": "Spotify Artist Credit",
                    }
                ]
            },
            progress=None,
        )

        track = self.read_tracks(self.first_path)[0]
        self.assertEqual(track["title"], "Display Title")
        self.assertEqual(track["artist"], "Display Artist")
        self.assertEqual(track["spotifyTrackId"], preferred_id)
        self.assertEqual(stats["resolvedNow"], 1)

    def test_preferred_override_loader_keeps_optional_match_identity(self):
        preferred_id = "P" * 22
        preferred_path = self.checkpoint_path.parent / "preferred-alias.json"
        preferred_path.write_text(
            backfill.serialize_json(
                {
                    "tracks": [
                        {
                            "title": "Display Title",
                            "artist": "Display Artist",
                            "spotifyTrackId": preferred_id,
                            "matchTitle": "Spotify Title Variant",
                            "matchArtist": "Spotify Artist Credit",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        overrides = backfill.load_preferred_track_overrides(preferred_path)

        self.assertEqual(
            overrides["display title::display artist"],
            [
                {
                    "spotifyTrackId": preferred_id,
                    "matchTitle": "Spotify Title Variant",
                    "matchArtist": "Spotify Artist Credit",
                }
            ],
        )
        self.assertEqual(
            backfill.load_preferred_track_ids(preferred_path),
            {"display title::display artist": [preferred_id]},
        )

    def test_ignoring_catalogue_ids_clears_stale_unresolved_metadata(self):
        stale = {
            "title": "Alpha",
            "artist": "Artist One",
            **verified_metadata(),
        }
        self.write_catalogues([stale], [])

        class NoMatchResolver:
            def resolve(self, _group):
                return None

        backfill.run_backfill(
            [self.first_path, self.second_path],
            NoMatchResolver(),
            checkpoint_path=self.checkpoint_path,
            ignore_catalogue_ids=True,
            progress=None,
        )

        track = self.read_tracks(self.first_path)[0]
        self.assertEqual(track["title"], "Alpha")
        self.assertEqual(track["artist"], "Artist One")
        self.assertNotIn("spotifyTrackId", track)
        self.assertNotIn("albumImage", track)

    def test_invalid_public_cache_record_is_retried(self):
        self.assertFalse(
            backfill.is_reusable_public_cache_record({"status": "invalid"})
        )

    def test_public_page_cache_is_reused_without_fetching_again(self):
        track_ids = ["P" * 22, "Q" * 22]

        class PageClient:
            def __init__(self):
                self.calls = []

            def fetch(self, track_id):
                self.calls.append(track_id)
                return spotify_track(
                    title=f"Track {track_id[0]}",
                    track_id=track_id,
                    album_id=track_id[0] * 22,
                )

        cache_path = self.checkpoint_path.parent / "public-cache.json"
        client = PageClient()
        first, first_summary = backfill.fetch_public_page_candidates(
            track_ids,
            client,
            cache_path=cache_path,
            workers=6,
            checkpoint_every=1,
            progress=None,
        )

        class MustNotFetch:
            def fetch(self, _track_id):
                raise AssertionError("valid cache entries must be reused")

        second, second_summary = backfill.fetch_public_page_candidates(
            track_ids,
            MustNotFetch(),
            cache_path=cache_path,
            workers=6,
            progress=None,
        )

        self.assertEqual(len(first), 2)
        self.assertEqual(len(second), 2)
        self.assertCountEqual(client.calls, track_ids)
        self.assertEqual(first_summary["fetched"], 2)
        self.assertEqual(second_summary["cacheHits"], 2)
        self.assertEqual(second_summary["fetched"], 0)

    def test_preferred_public_ids_are_added_to_the_candidate_fetch(self):
        preferred_id = "Z" * 22
        preferred_path = self.checkpoint_path.parent / "preferred.json"
        candidate_path = self.checkpoint_path.parent / "candidates.json"
        cache_path = self.checkpoint_path.parent / "public-cache.json"
        report_path = self.checkpoint_path.parent / "public-report.json"
        self.write_catalogues(
            [{"title": "Alpha", "artist": "Artist One"}],
            [],
        )
        preferred_path.write_text(
            backfill.serialize_json(
                {
                    "tracks": [
                        {
                            "title": "Alpha",
                            "artist": "Artist One",
                            "spotifyTrackId": preferred_id,
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        candidate_path.write_text(
            backfill.serialize_json({"trackIds": []}),
            encoding="utf-8",
        )

        original_fetch = backfill.fetch_public_page_candidates
        seen_ids = []

        def fake_fetch(track_ids, *_args, **_kwargs):
            seen_ids.extend(track_ids)
            candidate = spotify_track(track_id=preferred_id)
            candidate["artists"][0]["id"] = None
            return [candidate], {
                "requested": 1,
                "cacheHits": 0,
                "fetched": 1,
                "validCandidates": 1,
                "invalidPages": [],
                "fetchErrors": [],
            }

        backfill.fetch_public_page_candidates = fake_fetch
        try:
            exit_code = backfill.main(
                [
                    "--data-files",
                    str(self.first_path),
                    str(self.second_path),
                    "--checkpoint",
                    str(self.checkpoint_path),
                    "--preferred-ids",
                    str(preferred_path),
                    "--public-candidates",
                    str(candidate_path),
                    "--public-cache",
                    str(cache_path),
                    "--public-report",
                    str(report_path),
                    "--ignore-catalogue-ids",
                ]
            )
        finally:
            backfill.fetch_public_page_candidates = original_fetch

        self.assertEqual(exit_code, 0)
        self.assertEqual(seen_ids, [preferred_id])
        self.assertEqual(
            self.read_tracks(self.first_path)[0]["spotifyTrackId"],
            preferred_id,
        )


if __name__ == "__main__":
    unittest.main()
