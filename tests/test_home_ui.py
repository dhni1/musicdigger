import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HomeUIStyleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home_css = (ROOT / "styles/pages/home.css").read_text(encoding="utf-8")
        cls.index_html = (ROOT / "index.html").read_text(encoding="utf-8")
        cls.server_py = (ROOT / "server.py").read_text(encoding="utf-8")

    def test_track_like_heart_is_font_independent_and_wider_than_tall(self):
        self.assertNotIn('content: "♡"', self.home_css)
        self.assertNotIn('content: "♥"', self.home_css)
        self.assertIn("width: 20px", self.home_css)
        self.assertIn("height: 17px", self.home_css)
        self.assertIn("-webkit-mask:", self.home_css)
        self.assertIn("mask-image:", self.home_css)

    def test_brand_favicon_is_declared_and_publicly_served(self):
        self.assertIn('rel="icon" type="image/svg+xml"', self.index_html)
        self.assertIn('rel="alternate icon" type="image/x-icon"', self.index_html)
        self.assertIn('rel="apple-touch-icon"', self.index_html)
        for filename in ("favicon.svg", "favicon.ico", "apple-touch-icon.png"):
            self.assertTrue((ROOT / filename).is_file())
            self.assertIn(f'"{filename}"', self.server_py)


if __name__ == "__main__":
    unittest.main()
