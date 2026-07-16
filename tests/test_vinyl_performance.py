import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class VinylAnimationPerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.layout_css = (ROOT / "styles/shared/layout.css").read_text(
            encoding="utf-8"
        )
        cls.modal_css = (ROOT / "styles/shared/vinyl-modal.css").read_text(
            encoding="utf-8"
        )
        cls.spotify_js = (ROOT / "src/services/spotify/index.js").read_text(
            encoding="utf-8"
        )
        cls.home_js = (ROOT / "src/pages/home/index.js").read_text(
            encoding="utf-8"
        )
        cls.utils_js = (ROOT / "src/shared/utils.js").read_text(
            encoding="utf-8"
        )
        cls.index_html = (ROOT / "index.html").read_text(encoding="utf-8")

    def test_progress_animation_is_compositor_only(self):
        self.assertNotIn("fill.style.width", self.spotify_js)
        self.assertNotIn("transition = `width", self.spotify_js)
        self.assertIn("fill.style.transform", self.spotify_js)
        self.assertIn("transform: scaleX(0)", self.layout_css)
        self.assertIn("transform: scaleX(0)", self.modal_css)

    def test_spinning_record_is_isolated_as_a_composited_layer(self):
        self.assertIn("contain: layout paint", self.layout_css)
        self.assertIn("will-change: transform", self.layout_css)
        self.assertIn("backface-visibility: hidden", self.layout_css)
        self.assertIn("translate3d(0, 0, 0) rotate(1turn)", self.layout_css)

    def test_tonearm_has_stationary_base_arm_cartridge_and_stylus(self):
        self.assertEqual(self.index_html.count('class="vinyl-tonearm-base"'), 2)
        self.assertEqual(self.index_html.count('class="vinyl-tonearm-arm"'), 2)
        self.assertEqual(self.index_html.count('class="vinyl-tonearm-head"'), 2)
        self.assertIn(".vinyl-tonearm-head::before", self.layout_css)
        self.assertIn(".vinyl-tonearm-head::after", self.layout_css)

    def test_tonearm_keeps_playing_angle_and_parks_immediately(self):
        self.assertGreaterEqual(self.layout_css.count("rotate(-10deg)"), 2)
        self.assertIn("rotate(-10deg)", self.modal_css)
        self.assertRegex(
            self.layout_css,
            r'data-state="playing"\]\s+\.vinyl-tonearm-arm\s*\{[^}]*'
            r'rotate\(12deg\)',
        )
        paused = re.search(
            r'data-state="paused"\]\s+\.vinyl-tonearm-arm\s*\{(?P<body>[^}]*)\}',
            self.layout_css,
        )
        self.assertIsNotNone(paused)
        self.assertIn("rotate(-10deg)", paused.group("body"))
        self.assertIn("transition-duration: 0ms", paused.group("body"))

    def test_modal_tonearm_uses_reference_style_pivot_and_cartridge(self):
        self.assertIn(".vinyl-deck--modal .vinyl-tonearm-base", self.modal_css)
        self.assertIn(".vinyl-deck--modal .vinyl-tonearm-arm", self.modal_css)
        self.assertIn(".vinyl-deck--modal .vinyl-tonearm-head", self.modal_css)
        self.assertIn("width: 25px", self.modal_css)

    def test_modal_does_not_blur_or_animate_hidden_header_record(self):
        backdrop = re.search(
            r"\.vinyl-player-modal::backdrop\s*\{(?P<body>[^}]*)\}",
            self.modal_css,
        )
        self.assertIsNotNone(backdrop)
        self.assertNotIn("backdrop-filter", backdrop.group("body"))
        self.assertRegex(
            self.modal_css,
            r"body\.is-vinyl-modal-open[\s\S]+?\.vinyl-player"
            r"\[data-state=\"playing\"\][\s\S]+?animation-play-state:\s*paused",
        )

    def test_reduced_motion_disables_spin_and_long_progress_transition(self):
        reduced_motion = re.search(
            r"@media\s*\(prefers-reduced-motion:\s*reduce\)\s*"
            r"\{(?P<body>[\s\S]+)\}\s*$",
            self.modal_css,
        )
        self.assertIsNotNone(reduced_motion)
        self.assertIn("animation: none !important", reduced_motion.group("body"))
        self.assertIn("transition: none !important", reduced_motion.group("body"))
        self.assertIn("reducedMotion", self.spotify_js)

    def test_album_art_uses_all_spotify_sizes_and_retries_transient_errors(self):
        self.assertIn("albumImages: (images ?? [])", self.spotify_js)
        self.assertIn("playback?.albumImages?.length", self.spotify_js)
        self.assertIn("getOptimizedSpotifyImageUrls", self.spotify_js)
        self.assertIn("'small',", self.spotify_js)
        self.assertIn("'medium',", self.spotify_js)
        self.assertIn("VINYL_ARTWORK_RETRY_MS", self.spotify_js)
        self.assertIn("image.dataset.loadState = 'error'", self.spotify_js)

    def test_spotify_album_images_use_display_sized_cdn_variants(self):
        self.assertIn("ab67616d00004851", self.utils_js)
        self.assertIn("ab67616d00001e02", self.utils_js)
        self.assertIn("getTrackImageUrls(track, 'small')", self.home_js)
        self.assertIn("getTrackImageUrls(track, 'medium')", self.home_js)

    def test_hidden_vinyl_modal_does_not_compete_for_large_artwork(self):
        self.assertRegex(
            self.spotify_js,
            r"if \(elements\.vinylModal\?\.open\) \{[\s\S]+?"
            r"elements\.vinylModalAlbumArt[\s\S]+?'medium'",
        )

    def test_catalogue_is_versioned_and_reuses_browser_cache(self):
        self.assertIn("GENRE_CATALOG_VERSION", self.home_js)
        self.assertIn("cache: 'force-cache'", self.home_js)
        self.assertNotIn("cache: 'no-cache'", self.home_js)

    def test_pause_state_is_polled_quickly_and_modal_open_polls_immediately(self):
        self.assertIn("const PLAYBACK_POLL_INTERVAL_MS = 1000;", self.spotify_js)
        self.assertIn("const PLAYBACK_MODAL_POLL_INTERVAL_MS = 500;", self.spotify_js)
        modal_open = re.search(
            r"function openVinylPlayerModal\(\)\s*\{(?P<body>[\s\S]+?)\n  \}",
            self.spotify_js,
        )
        self.assertIsNotNone(modal_open)
        self.assertIn("requestImmediatePlaybackPoll();", modal_open.group("body"))

    def test_all_eight_genre_covers_start_loading_and_get_one_retry(self):
        self.assertIn("loading: 'eager'", self.home_js)
        self.assertIn("COVER_IMAGE_RETRY_DELAY_MS", self.home_js)
        self.assertIn("retryAttempted", self.home_js)


if __name__ == "__main__":
    unittest.main()
