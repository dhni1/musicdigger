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


if __name__ == "__main__":
    unittest.main()
