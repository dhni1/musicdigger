import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

import server


SPOTIFY_EMPIRE_STATE_OF_MIND = {
    "name": "Empire State Of Mind",
    "artists": [
        {"id": "jay-z", "name": "JAŸ-Z"},
        {"id": "alicia-keys", "name": "Alicia Keys"},
    ],
    "album": {
        "name": "The Blueprint 3",
        "images": [{"url": "https://i.scdn.co/image/empire-state-of-mind"}],
    },
    "duration_ms": 276920,
    "uri": "spotify:track:69yVxyuRahEzs2taFMVVoO",
    "external_urls": {
        "spotify": "https://open.spotify.com/track/69yVxyuRahEzs2taFMVVoO"
    },
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


class GenreIdentityTests(unittest.TestCase):
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
