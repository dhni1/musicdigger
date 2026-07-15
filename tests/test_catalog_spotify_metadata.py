import json
from pathlib import Path
import unittest

from scripts import backfill_spotify_metadata as backfill


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATHS = (
    ROOT / "data" / "genres.json",
    ROOT / "data" / "genre-expansion.json",
)


def metadata_problems(track):
    """Describe incomplete Spotify fields for an actionable test failure."""

    problems = []
    track_id = str(track.get("spotifyTrackId", ""))
    album_id = str(track.get("albumId", ""))
    album_images = track.get("albumImages")
    duration_ms = track.get("durationMs")

    if not backfill.SPOTIFY_ID_PATTERN.fullmatch(track_id):
        problems.append("spotifyTrackId")
    if not backfill.SPOTIFY_ID_PATTERN.fullmatch(album_id):
        problems.append("albumId")
    if track.get("spotifyUri") != f"spotify:track:{track_id}":
        problems.append("spotifyUri")
    if not backfill.is_spotify_entity_url(
        track.get("spotifyUrl"), "track", track_id
    ):
        problems.append("spotifyUrl")
    if not str(track.get("album", "")).strip():
        problems.append("album")
    if not backfill.is_spotify_entity_url(
        track.get("albumUrl"), "album", album_id
    ):
        problems.append("albumUrl")
    if not isinstance(album_images, list) or not album_images:
        problems.append("albumImages")
    else:
        if any(not backfill.server.is_https_url(image) for image in album_images):
            problems.append("albumImages(https)")
        if track.get("albumImage") != album_images[0]:
            problems.append("albumImage")
    if (
        not isinstance(duration_ms, int)
        or isinstance(duration_ms, bool)
        or duration_ms <= 0
    ):
        problems.append("durationMs")

    return problems


class CatalogSpotifyMetadataTests(unittest.TestCase):
    def test_every_track_placement_has_complete_spotify_metadata(self):
        invalid = []
        placement_count = 0

        for path in CATALOG_PATHS:
            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(document.get("genres"), list, path.name)

            for genre in document["genres"]:
                self.assertIsInstance(genre.get("tracks"), list, genre.get("name"))
                for track in genre["tracks"]:
                    placement_count += 1
                    if backfill.validate_metadata(track):
                        continue
                    invalid.append(
                        {
                            "file": path.name,
                            "genre": genre.get("name", "<unnamed>"),
                            "track": (
                                f"{track.get('title', '<untitled>')} — "
                                f"{track.get('artist', '<unknown>')}"
                            ),
                            "problems": metadata_problems(track),
                        }
                    )

        self.assertGreater(placement_count, 0)
        if invalid:
            preview = "\n".join(
                (
                    f"- {item['file']} / {item['genre']} / {item['track']}: "
                    f"{', '.join(item['problems'])}"
                )
                for item in invalid[:25]
            )
            remaining = len(invalid) - 25
            if remaining > 0:
                preview += f"\n- ... and {remaining} more"
            self.fail(
                f"{len(invalid)} of {placement_count} track placements have "
                f"incomplete Spotify metadata:\n{preview}"
            )


if __name__ == "__main__":
    unittest.main()
