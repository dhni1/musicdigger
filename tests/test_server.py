import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest import mock
import time

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
