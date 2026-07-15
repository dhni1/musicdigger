import json
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import server


SPOTIFY_EMPIRE_STATE_OF_MIND = {
    "id": "69yVxyuRahEzs2taFMVVoO",
    "name": "Empire State Of Mind",
    "artists": [
        {"id": "jay-z", "name": "JAŸ-Z"},
        {"id": "alicia-keys", "name": "Alicia Keys"},
    ],
    "album": {
        "id": "40stnUGVKQhcaDbXkC8nKf",
        "name": "The Blueprint 3",
        "images": [{"url": "https://i.scdn.co/image/empire-state-of-mind"}],
        "external_urls": {
            "spotify": "https://open.spotify.com/album/40stnUGVKQhcaDbXkC8nKf"
        },
    },
    "duration_ms": 276920,
    "uri": "spotify:track:69yVxyuRahEzs2taFMVVoO",
    "external_urls": {
        "spotify": "https://open.spotify.com/track/69yVxyuRahEzs2taFMVVoO"
    },
}


def make_spotify_track(index, with_cover=True):
    track_id = f"{index:022d}"
    album_id = f"A{index:021d}"
    images = (
        [
            {"url": f"https://i.scdn.co/image/track-{index}-large"},
            {"url": f"https://i.scdn.co/image/track-{index}-small"},
        ]
        if with_cover
        else []
    )
    return {
        "id": track_id,
        "name": f"Track {index}",
        "artists": [{"id": f"artist-{index}", "name": f"Artist {index}"}],
        "album": {
            "id": album_id,
            "name": f"Album {index}",
            "images": images,
            "external_urls": {
                "spotify": f"https://open.spotify.com/album/{album_id}"
            },
        },
        "duration_ms": 180000,
        "uri": f"spotify:track:{track_id}",
        "external_urls": {"spotify": f"https://open.spotify.com/track/{track_id}"},
        "external_ids": {"isrc": f"USAAA26{index:05d}"},
        "popularity": index,
    }


class TrackMatchingTests(unittest.TestCase):
    def test_artist_diacritics_normalize_to_same_name(self):
        self.assertEqual(
            server.normalize_track_text("JAY-Z"),
            server.normalize_track_text("JAŸ-Z"),
        )

    def test_empire_state_of_mind_candidate_passes_match_threshold(self):
        score = server.score_track_match(
            {
                "title": "Empire State Of Mind",
                "artist": "JAY-Z feat. Alicia Keys",
            },
            SPOTIFY_EMPIRE_STATE_OF_MIND,
        )

        self.assertGreaterEqual(score, 10)

    def test_album_metadata_is_mapped_from_spotify_match(self):
        catalog = server.SpotifyCatalog()
        response = {"tracks": {"items": [SPOTIFY_EMPIRE_STATE_OF_MIND]}}

        with mock.patch.object(catalog, "_spotify_get", return_value=response):
            metadata = catalog._fetch_local_track_metadata(
                {
                    "title": "Empire State Of Mind",
                    "artist": "JAY-Z feat. Alicia Keys",
                }
            )

        self.assertEqual(metadata["album"], "The Blueprint 3")
        self.assertEqual(
            metadata["albumImage"],
            "https://i.scdn.co/image/empire-state-of-mind",
        )

    def test_track_mapping_keeps_multiple_cover_sizes(self):
        mapped = server.map_track(make_spotify_track(1))

        self.assertEqual(mapped["spotifyTrackId"], f"{1:022d}")
        self.assertEqual(mapped["albumId"], f"A{1:021d}")
        self.assertEqual(
            mapped["albumImages"],
            [
                "https://i.scdn.co/image/track-1-large",
                "https://i.scdn.co/image/track-1-small",
            ],
        )

    def test_genre_search_selects_representative_before_recovering_its_cover(self):
        catalog = server.SpotifyCatalog()
        representative = make_spotify_track(99, with_cover=False)
        items = [representative] + [
            make_spotify_track(index)
            for index in range(1, 9)
        ]
        recovered_cover = "https://i.scdn.co/image/recovered-representative"

        with (
            mock.patch.object(
                catalog,
                "_spotify_get",
                return_value={"tracks": {"items": items}},
            ),
            mock.patch.object(
                catalog,
                "_metadata_from_spotify_track",
                return_value={
                    "albumImage": recovered_cover,
                    "albumImages": [recovered_cover],
                },
            ) as recover_cover,
        ):
            tracks = catalog._search_tracks_for_genre(["test genre"])

        self.assertEqual(len(tracks), 8)
        self.assertEqual(tracks[0]["spotifyTrackId"], representative["id"])
        self.assertEqual(tracks[0]["title"], representative["name"])
        self.assertEqual(tracks[0]["albumImage"], recovered_cover)
        self.assertTrue(all(track["albumImage"] for track in tracks))
        recover_cover.assert_called_once_with(representative)

    def test_missing_curated_cover_never_replaces_representative_track(self):
        catalog = server.SpotifyCatalog()
        genre = server.find_local_genre("hip-hop", spotify_backed=False)
        curated = [dict(track) for track in genre["tracks"]]
        curated[1].pop("albumImage", None)

        with (
            mock.patch.object(catalog, "configured", return_value=True),
            mock.patch.object(
                catalog,
                "_enrich_local_tracks",
                return_value=curated,
            ),
            mock.patch.object(
                catalog,
                "_search_tracks_for_genre",
                return_value=[server.map_track(make_spotify_track(index)) for index in range(1, 9)],
            ) as genre_search,
        ):
            detail = catalog.get_genre_details("hip-hop")

        self.assertEqual(
            [(track["title"], track["artist"]) for track in detail["tracks"]],
            [(track["title"], track["artist"]) for track in curated],
        )
        self.assertFalse(detail["tracksComplete"])
        genre_search.assert_not_called()

    def test_exact_spotify_id_lookup_runs_before_search(self):
        catalog = server.SpotifyCatalog()
        spotify_track = make_spotify_track(7)
        target = {
            "title": spotify_track["name"],
            "artist": spotify_track["artists"][0]["name"],
            "spotifyTrackId": spotify_track["id"],
        }

        with mock.patch.object(
            catalog,
            "_spotify_get",
            return_value=spotify_track,
        ) as spotify_get:
            metadata = catalog._fetch_local_track_metadata(target)

        self.assertEqual(metadata["spotifyTrackId"], spotify_track["id"])
        self.assertTrue(metadata["albumImage"])
        spotify_get.assert_called_once_with(
            f"/tracks/{spotify_track['id']}",
            {"market": server.SPOTIFY_MARKET},
        )

    def test_exact_track_without_images_recovers_same_album_cover(self):
        catalog = server.SpotifyCatalog()
        spotify_track = make_spotify_track(8, with_cover=False)
        album_cover = "https://i.scdn.co/image/recovered-album"

        def spotify_get(path, _params):
            if path.startswith("/tracks/"):
                return spotify_track
            if path.startswith("/albums/"):
                return {
                    "id": spotify_track["album"]["id"],
                    "name": spotify_track["album"]["name"],
                    "images": [{"url": album_cover}],
                    "external_urls": spotify_track["album"]["external_urls"],
                }
            raise AssertionError(path)

        with mock.patch.object(catalog, "_spotify_get", side_effect=spotify_get):
            metadata = catalog._fetch_local_track_metadata(
                {
                    "title": spotify_track["name"],
                    "artist": spotify_track["artists"][0]["name"],
                    "spotifyTrackId": spotify_track["id"],
                }
            )

        self.assertEqual(metadata["spotifyTrackId"], spotify_track["id"])
        self.assertEqual(metadata["albumId"], spotify_track["album"]["id"])
        self.assertEqual(metadata["albumImage"], album_cover)

    def test_exact_lookup_rejects_a_different_response_id(self):
        catalog = server.SpotifyCatalog()
        requested_id = f"{7:022d}"
        different_track = make_spotify_track(8)

        with mock.patch.object(
            catalog,
            "_spotify_get",
            return_value=different_track,
        ) as spotify_get:
            metadata = catalog._fetch_local_track_metadata(
                {
                    "title": "Expected Track",
                    "artist": "Expected Artist",
                    "spotifyTrackId": requested_id,
                }
            )

        self.assertEqual(metadata, {})
        spotify_get.assert_called_once()

    def test_market_relinked_track_keeps_requested_id_when_identity_matches(self):
        catalog = server.SpotifyCatalog()
        requested_id = f"{7:022d}"
        relinked_track = make_spotify_track(8)
        target = {
            "title": relinked_track["name"],
            "artist": relinked_track["artists"][0]["name"],
            "spotifyTrackId": requested_id,
        }

        with mock.patch.object(catalog, "_spotify_get", return_value=relinked_track):
            metadata = catalog._fetch_local_track_metadata(target)

        self.assertEqual(metadata["spotifyTrackId"], requested_id)
        self.assertEqual(metadata["spotifyUri"], relinked_track["uri"])

    def test_relinked_track_oembed_uses_the_canonical_representative_id(self):
        catalog = server.SpotifyCatalog()
        requested_id = f"{7:022d}"
        relinked_track = make_spotify_track(8, with_cover=False)
        target = {
            "title": relinked_track["name"],
            "artist": relinked_track["artists"][0]["name"],
            "spotifyTrackId": requested_id,
        }
        canonical_url = f"https://open.spotify.com/track/{requested_id}"

        def spotify_get(path, _params):
            if path.startswith("/tracks/"):
                return relinked_track
            if path.startswith("/albums/"):
                return {}
            raise AssertionError(path)

        with (
            mock.patch.object(catalog, "_spotify_get", side_effect=spotify_get),
            mock.patch.object(
                catalog,
                "_fetch_oembed_thumbnail",
                return_value="https://i.scdn.co/image/canonical-oembed",
            ) as oembed,
        ):
            metadata = catalog._fetch_local_track_metadata(target)

        self.assertEqual(metadata["spotifyTrackId"], requested_id)
        self.assertEqual(metadata["spotifyUrl"], canonical_url)
        oembed.assert_called_once_with(canonical_url)

    def test_oembed_recovers_cover_for_the_same_spotify_url(self):
        catalog = server.SpotifyCatalog()
        spotify_track = make_spotify_track(9, with_cover=False)
        oembed_cover = "https://i.scdn.co/image/oembed-cover"

        with (
            mock.patch.object(catalog, "_spotify_get", return_value={}),
            mock.patch.object(
                catalog,
                "_fetch_oembed_thumbnail",
                return_value=oembed_cover,
            ) as oembed,
        ):
            metadata = catalog._metadata_from_spotify_track(spotify_track)

        self.assertEqual(metadata["spotifyTrackId"], spotify_track["id"])
        self.assertEqual(metadata["albumImage"], oembed_cover)
        oembed.assert_called_once_with(
            spotify_track["external_urls"]["spotify"]
        )

    def test_metadata_enrichment_cannot_override_representative_identity(self):
        original = {"title": "Representative", "artist": "Original Artist"}
        enriched = server.apply_track_metadata(
            original,
            {
                "title": "Unrelated Replacement",
                "artist": "Different Artist",
                "albumImage": "https://i.scdn.co/image/correct-cover",
            },
        )

        self.assertEqual(enriched["title"], original["title"])
        self.assertEqual(enriched["artist"], original["artist"])
        self.assertTrue(enriched["albumImage"])

    def test_track_identity_prefers_spotify_id(self):
        spotify_id = f"{5:022d}"
        left = {"title": "Title A", "artist": "Artist A", "spotifyTrackId": spotify_id}
        right = {"title": "Title B", "artist": "Artist B", "spotifyTrackId": spotify_id}

        self.assertEqual(
            server.make_track_identity(left),
            server.make_track_identity(right),
        )

    def test_reversed_collaborator_order_still_matches_body(self):
        score = server.score_track_match(
            {"title": "Body", "artist": "Tion Wayne & Russ Millions"},
            {
                "name": "Body",
                "artists": [{"name": "Russ Millions"}, {"name": "Tion Wayne"}],
            },
        )

        self.assertGreaterEqual(score, 10)

    def test_keisha_title_suffix_and_artist_connector_still_match(self):
        score = server.score_track_match(
            {"title": "KEISHA & BECKY", "artist": "Russ Millions x Tion Wayne"},
            {
                "name": "Keisha & Becky - Russ Millions x Tion Wayne",
                "artists": [{"name": "Russ Millions"}, {"name": "Tion Wayne"}],
            },
        )

        self.assertGreaterEqual(score, 10)

    def test_know_better_matches_feature_credit_but_not_longer_song_title(self):
        target = {"title": "Know Better", "artist": "Headie One"}
        correct = {
            "name": "Know Better (feat. Rv)",
            "artists": [{"name": "Headie One"}, {"name": "Rv"}],
        }
        incorrect = {
            "name": "I Still Know Better",
            "artists": [{"name": "Headie One"}],
        }

        self.assertGreaterEqual(server.score_track_match(target, correct), 10)
        self.assertLess(server.score_track_match(target, incorrect), 10)

    def test_strict_feature_match_stops_after_first_search_page(self):
        catalog = server.SpotifyCatalog()
        candidate = make_spotify_track(4)
        candidate["name"] = "Know Better (feat. Rv)"
        candidate["artists"] = [{"name": "Headie One"}, {"name": "Rv"}]

        with mock.patch.object(
            catalog,
            "_spotify_get",
            return_value={"tracks": {"items": [candidate]}},
        ) as spotify_get:
            metadata = catalog._fetch_local_track_metadata(
                {"title": "Know Better", "artist": "Headie One"}
            )

        self.assertTrue(metadata["albumImage"])
        spotify_get.assert_called_once()

    def test_search_rejects_sequel_and_unrequested_remix_versions(self):
        target = {"title": "Know Better", "artist": "Headie One"}
        sequel = {
            "name": "Know Better Pt. 2",
            "artists": [{"name": "Headie One"}],
        }
        remix = {
            "name": "Know Better - Club Remix",
            "artists": [{"name": "Headie One"}],
        }

        self.assertFalse(server.is_strict_track_match(target, sequel))
        self.assertFalse(server.is_strict_track_match(target, remix))

    def test_feature_suffix_does_not_hide_a_numbered_sequel(self):
        target = {"title": "Tech Noir", "artist": "Gunship"}
        sequel = {
            "name": "Tech Noir 2 (feat. John Carpenter, Charlie Simpson)",
            "artists": [
                {"name": "Gunship"},
                {"name": "Charlie Simpson"},
                {"name": "John Carpenter"},
            ],
        }

        self.assertFalse(server.track_titles_match(target, sequel))
        self.assertFalse(server.is_strict_track_match(target, sequel))

    def test_search_rejects_tribute_artist(self):
        target = {"title": "Representative Song", "artist": "Original Artist"}
        tribute = {
            "name": "Representative Song",
            "artists": [{"name": "Original Artist Tribute Band"}],
        }

        self.assertFalse(server.is_strict_track_match(target, tribute))

    def test_version_markers_use_word_boundaries(self):
        self.assertEqual(server.get_track_version_markers("Alive"), set())
        self.assertEqual(server.get_track_version_markers("Deluxe Edition"), set())

    def test_featured_artist_credit_rejects_a_different_guest(self):
        target = {
            "title": "Representative Song",
            "artist": "Artist A feat. Guest B",
        }
        wrong_guest = {
            "name": "Representative Song",
            "artists": [{"name": "Artist A"}, {"name": "Guest C"}],
        }

        self.assertFalse(server.is_strict_track_match(target, wrong_guest))

    def test_artist_names_do_not_become_track_version_markers(self):
        live = {
            "name": "Lightning Crashes",
            "artists": [{"name": "Live"}],
        }
        mix_master_mike = {
            "name": "Bangzilla",
            "artists": [{"name": "Mix Master Mike"}],
        }

        self.assertTrue(
            server.is_strict_track_match(
                {"title": "Lightning Crashes", "artist": "Live"},
                live,
            )
        )
        self.assertTrue(
            server.is_strict_track_match(
                {"title": "Bangzilla", "artist": "Mix Master Mike"},
                mix_master_mike,
            )
        )

    def test_artist_parenthetical_can_request_a_specific_remix(self):
        target = {
            "title": "Silence",
            "artist": "Delerium feat. Sarah McLachlan (Tiësto Remix)",
        }
        candidate = {
            "name": "Silence - Tiësto Remix",
            "artists": [{"name": "Delerium"}, {"name": "Sarah McLachlan"}],
        }

        self.assertTrue(server.is_strict_track_match(target, candidate))

    def test_retry_after_parser_falls_back_for_malformed_headers(self):
        self.assertEqual(server.parse_retry_after_seconds("tomorrow"), 1)
        self.assertEqual(server.parse_retry_after_seconds("2.9"), 2)

    def test_partial_metadata_without_cover_is_retried_after_short_ttl(self):
        catalog = server.SpotifyCatalog()
        track = {"title": "Representative", "artist": "Original Artist"}
        partial = {
            "spotifyTrackId": f"{1:022d}",
            "album": "Known Album",
        }

        with mock.patch.object(
            catalog,
            "_fetch_local_track_metadata",
            return_value=partial,
        ) as fetch:
            with mock.patch.object(server.time, "time", return_value=1000):
                first = catalog._enrich_local_track(track)
            with mock.patch.object(
                server.time,
                "time",
                return_value=1000 + server.TRACK_METADATA_MISS_TTL + 1,
            ):
                second = catalog._enrich_local_track(track)

        self.assertEqual(first["title"], track["title"])
        self.assertEqual(second["title"], track["title"])
        self.assertNotIn("albumImage", first)
        self.assertEqual(fetch.call_count, 2)


class GenreIdentityTests(unittest.TestCase):
    def test_expanded_catalog_has_unique_connected_genres(self):
        genres = server.load_local_genres(spotify_backed=False)
        genre_ids = {genre["id"] for genre in genres}

        self.assertGreaterEqual(len(genres), 100)
        self.assertEqual(len(genre_ids), len(genres))

        for genre in genres:
            self.assertEqual(len(genre["tracks"]), server.TRACKS_PER_GENRE)
            self.assertTrue(
                all(
                    track.get("title", "").strip()
                    and track.get("artist", "").strip()
                    for track in genre["tracks"]
                )
            )
            track_keys = {
                (
                    server.normalize_track_text(track.get("title", "")),
                    server.normalize_track_text(track.get("artist", "")),
                )
                for track in genre["tracks"]
            }
            self.assertEqual(len(track_keys), server.TRACKS_PER_GENRE)
            if genre.get("parent"):
                self.assertIn(genre["parent"], genre_ids)
            for relation in ["subgenres", "similar", "fusion"]:
                self.assertTrue(set(genre.get(relation, [])).issubset(genre_ids))

    def test_expansion_genres_have_curated_tracks_and_search_terms(self):
        expansion = json.loads(
            server.GENRES_EXPANSION_FILE.read_text(encoding="utf-8")
        )["genres"]

        self.assertEqual(len(expansion), 61)
        self.assertTrue(all(genre["spotifySearchTerms"] for genre in expansion))
        self.assertTrue(
            all(
                len(genre["tracks"]) == server.TRACKS_PER_GENRE
                for genre in expansion
            )
        )

    def test_genre_names_and_aliases_do_not_point_to_multiple_genres(self):
        owners = {}

        for genre in server.load_local_genres(spotify_backed=False):
            candidates = [genre["id"], genre["name"], *genre.get("aliases", [])]
            for candidate in candidates:
                normalized = server.normalize_genre_name(candidate)
                existing_owner = owners.setdefault(normalized, genre["id"])
                self.assertEqual(existing_owner, genre["id"], normalized)

    def test_neo_soul_canonical_id_wins_over_other_genre_aliases(self):
        genre = server.find_local_genre("neo-soul", spotify_backed=False)

        self.assertIsNotNone(genre)
        self.assertEqual(genre["id"], "neo-soul")

    def test_drill_curated_fallbacks_have_album_art(self):
        genre = server.find_local_genre("drill", spotify_backed=False)
        tracks = {track["title"]: track for track in genre["tracks"]}

        for title in ["Body", "KEISHA & BECKY", "Know Better"]:
            self.assertTrue(tracks[title]["album"])
            self.assertTrue(tracks[title]["albumImage"])

    def test_corrected_representative_tracks_keep_verified_spotify_ids(self):
        expected = {
            "house": ("Turn Me On (feat. Vula)", "0qaWEvPkts34WF68r8Dzx9"),
            "reggaeton": ("Mayor Que Yo", "7pMWE6h8thBOq9YnFzBEpy"),
            "bossa-nova": (
                "The Girl From Ipanema",
                "6gfKHUGFBRiGe3bqmnOqFR",
            ),
            "soundtrack": ("Now We Are Free", "1ucCVtG5dKmgvCnXHAnhR9"),
            "amapiano": ("Dalie (feat. Baby S.O.N)", "4URabg9AGHasjFEVdTbWcC"),
        }

        for genre_id, (title, spotify_id) in expected.items():
            genre = server.find_local_genre(genre_id, spotify_backed=False)
            track = next(item for item in genre["tracks"] if item["title"] == title)
            self.assertEqual(track["spotifyTrackId"], spotify_id)


class GenreCacheTests(unittest.TestCase):
    def test_partial_results_are_reused_during_short_cache_window(self):
        catalog = server.SpotifyCatalog()
        partial_tracks = [{"title": "Unavailable Cover", "artist": "Test Artist"}]

        configured = mock.patch.object(catalog, "configured", return_value=True)
        enrichment = mock.patch.object(
            catalog,
            "_enrich_local_tracks",
            return_value=partial_tracks,
        )

        with configured, enrichment as enrich:
            first = catalog.get_genre_details("hiphop")
            second = catalog.get_genre_details("hiphop")

        self.assertFalse(first["tracksComplete"])
        self.assertIs(first, second)
        enrich.assert_called_once()

    def test_same_genre_requests_share_one_inflight_enrichment(self):
        catalog = server.SpotifyCatalog()
        partial_tracks = [{"title": "Shared Result", "artist": "Test Artist"}]

        def slow_enrichment(_tracks):
            time.sleep(0.03)
            return partial_tracks

        configured = mock.patch.object(catalog, "configured", return_value=True)
        enrichment = mock.patch.object(
            catalog,
            "_enrich_local_tracks",
            side_effect=slow_enrichment,
        )

        with configured, enrichment as enrich, ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(catalog.get_genre_details, ["hiphop", "hiphop"]))

        self.assertIs(results[0], results[1])
        enrich.assert_called_once()


if __name__ == "__main__":
    unittest.main()
