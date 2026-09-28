"""ISP Watchdog bot.

Runs a real speed test on speedtest.net with Selenium, compares the result with
the speed you pay for, logs it to a CSV file and (optionally) calls out your
internet provider on X when it under-delivers.

Usage:
    python main.py                  # run a test and print the verdict
    python main.py --headless       # same, without opening a visible window
    python main.py --post browser   # open a pre-filled post on X in your browser
    python main.py --post api       # post straight to X with the X API (keys in .env)

Settings live in a .env file next to this script (see .env.example).
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import sys
import urllib.parse
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from selenium import webdriver
from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

BASE_DIR = Path(__file__).resolve().parent
HISTORY_FILE = BASE_DIR / "speed_history.csv"
DEFAULT_SPEEDTEST_URL = "https://www.speedtest.net/"
X_INTENT_URL = "https://x.com/intent/tweet?text="

# speedtest.net selectors (kept in one place so they are easy to update)
COOKIE_BUTTONS = [
    (By.ID, "onetrust-accept-btn-handler"),
    (By.ID, "_evidon-banner-acceptbutton"),
]
GO_BUTTON = (By.CSS_SELECTOR, ".start-button a")
DOWNLOAD_VALUE = "span.download-speed"
UPLOAD_VALUE = "span.upload-speed"
PING_VALUE = "span.ping-speed"

log = logging.getLogger("isp-watchdog")


@dataclass
class Config:
    promised_down: float
    promised_up: float
    isp_handle: str
    tolerance: float

    @classmethod
    def from_env(cls) -> "Config":
        load_dotenv(BASE_DIR / ".env")

        def number(name: str, default: float) -> float:
            raw = os.getenv(name, str(default))
            try:
                return float(raw)
            except ValueError:
                raise SystemExit(f"{name} must be a number, got {raw!r}")

        handle = os.getenv("ISP_HANDLE", "").strip()
        if handle and not handle.startswith("@"):
            handle = "@" + handle
        return cls(
            promised_down=number("PROMISED_DOWN", 150),
            promised_up=number("PROMISED_UP", 10),
            isp_handle=handle or "my internet provider",
            tolerance=number("TOLERANCE", 0.8),
        )


@dataclass
class SpeedResult:
    download: float
    upload: float
    ping: float | None
    result_url: str
    tested_at: str

    def is_below_plan(self, cfg: Config) -> bool:
        return (
            self.download < cfg.promised_down * cfg.tolerance
            or self.upload < cfg.promised_up * cfg.tolerance
        )


class InternetSpeedBot:
    """Drives speedtest.net in Chrome and reads the result."""

    def __init__(self, headless: bool = False, timeout: int = 120,
                 speedtest_url: str = DEFAULT_SPEEDTEST_URL) -> None:
        options = webdriver.ChromeOptions()
        if headless:
            options.add_argument("--headless=new")
        options.add_argument("--window-size=1366,900")
        options.add_argument("--disable-notifications")
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            # Chrome refuses to start as root (Docker / CI) without these flags.
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
        if os.getenv("CHROME_BINARY"):
            options.binary_location = os.environ["CHROME_BINARY"]

        # Selenium Manager downloads the matching chromedriver automatically.
        # CHROMEDRIVER_PATH is only needed if you want to use your own copy.
        driver_path = os.getenv("CHROMEDRIVER_PATH")
        service = Service(executable_path=driver_path) if driver_path else Service()

        self.driver = webdriver.Chrome(options=options, service=service)
        self.timeout = timeout
        self.speedtest_url = speedtest_url

    def __enter__(self) -> "InternetSpeedBot":
        return self

    def __exit__(self, *exc) -> None:
        self.driver.quit()

    def _dismiss_cookie_banner(self) -> None:
        for locator in COOKIE_BUTTONS:
            try:
                WebDriverWait(self.driver, 4).until(EC.element_to_be_clickable(locator)).click()
                log.info("Accepted cookie banner")
                return
            except TimeoutException:
                continue
        log.info("No cookie banner shown")

    def _read_metric(self, css: str, required: bool = True) -> float | None:
        """Wait until the element shows a number, then return it."""

        def has_number(driver):
            try:
                text = driver.find_element(By.CSS_SELECTOR, css).text.strip().replace(",", "")
                float(text)
                return text  # a non-empty string is truthy, even for "0"
            except (NoSuchElementException, StaleElementReferenceException, ValueError):
                return False

        try:
            return float(WebDriverWait(self.driver, 15).until(has_number))
        except TimeoutException:
            if required:
                raise
            return None

    def get_internet_speed(self) -> SpeedResult:
        log.info("Opening %s", self.speedtest_url)
        self.driver.get(self.speedtest_url)
        self._dismiss_cookie_banner()

        WebDriverWait(self.driver, 20).until(EC.element_to_be_clickable(GO_BUTTON)).click()
        log.info("Test started, waiting for it to finish (up to %ss)...", self.timeout)

        # speedtest.net moves to /result/<id> once download and upload are both done.
        WebDriverWait(self.driver, self.timeout).until(EC.url_contains("/result/"))

        return SpeedResult(
            download=self._read_metric(DOWNLOAD_VALUE),
            upload=self._read_metric(UPLOAD_VALUE),
            ping=self._read_metric(PING_VALUE, required=False),
            result_url=self.driver.current_url,
            tested_at=datetime.now().isoformat(timespec="seconds"),
        )


def build_complaint(result: SpeedResult, cfg: Config) -> str:
    return (
        f"Hey {cfg.isp_handle}, why is my internet speed "
        f"{result.download:.1f} Mbps down / {result.upload:.1f} Mbps up "
        f"when I pay for {cfg.promised_down:g} down / {cfg.promised_up:g} up? "
        f"{result.result_url}"
    )


def save_history(result: SpeedResult, cfg: Config) -> None:
    new_file = not HISTORY_FILE.exists()
    with HISTORY_FILE.open("a", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        if new_file:
            writer.writerow(["tested_at", "download_mbps", "upload_mbps", "ping_ms",
                             "promised_down", "promised_up", "below_plan", "result_url"])
        writer.writerow([result.tested_at, result.download, result.upload, result.ping,
                         cfg.promised_down, cfg.promised_up, result.is_below_plan(cfg),
                         result.result_url])


def post_with_browser(message: str) -> None:
    """Open X's compose window with the message filled in. No password needed."""
    url = X_INTENT_URL + urllib.parse.quote(message, safe="")
    log.info("Opening X compose window: %s", url)
    webbrowser.open(url)


def post_with_api(message: str) -> None:
    """Post directly with the official X API (needs API keys with write access)."""
    try:
        import tweepy
    except ImportError:
        raise SystemExit("Install tweepy first: pip install tweepy")

    keys = {k: os.getenv(k) for k in
            ("X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET")}
    missing = [k for k, v in keys.items() if not v]
    if missing:
        raise SystemExit(f"Missing in .env: {', '.join(missing)}")

    client = tweepy.Client(
        consumer_key=keys["X_API_KEY"],
        consumer_secret=keys["X_API_SECRET"],
        access_token=keys["X_ACCESS_TOKEN"],
        access_token_secret=keys["X_ACCESS_TOKEN_SECRET"],
    )
    response = client.create_tweet(text=message)
    log.info("Posted: https://x.com/i/web/status/%s", response.data["id"])


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Check your internet speed and call out your ISP.")
    parser.add_argument("--headless", action="store_true", help="run Chrome without a window")
    parser.add_argument("--post", choices=["none", "browser", "api"], default="none",
                        help="how to post the complaint when speed is below plan (default: none)")
    parser.add_argument("--always-post", action="store_true",
                        help="post even when the speed is within your plan")
    parser.add_argument("--timeout", type=int, default=120,
                        help="seconds to wait for the test to finish (default: 120)")
    parser.add_argument("--url", default=os.getenv("SPEEDTEST_URL", DEFAULT_SPEEDTEST_URL),
                        help=argparse.SUPPRESS)  # used by the automated tests
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    args = parse_args(argv)
    cfg = Config.from_env()

    try:
        with InternetSpeedBot(headless=args.headless, timeout=args.timeout,
                              speedtest_url=args.url) as bot:
            result = bot.get_internet_speed()
    except TimeoutException:
        log.error("speedtest.net did not finish in time. Try a larger --timeout, "
                  "or the page layout may have changed (see the selectors at the top of main.py).")
        return 1
    except WebDriverException as exc:
        log.error("Chrome could not start or crashed: %s", exc.msg or exc)
        return 1

    save_history(result, cfg)

    down_pct = result.download / cfg.promised_down * 100
    up_pct = result.upload / cfg.promised_up * 100
    ping = f"{result.ping:g} ms" if result.ping is not None else "n/a"
    print()
    print(f"  Download : {result.download:>8.2f} Mbps  ({down_pct:.0f}% of {cfg.promised_down:g})")
    print(f"  Upload   : {result.upload:>8.2f} Mbps  ({up_pct:.0f}% of {cfg.promised_up:g})")
    print(f"  Ping     : {ping:>8}")
    print(f"  Result   : {result.result_url}")
    print()

    below = result.is_below_plan(cfg)
    if below:
        print(f"  Verdict  : below {cfg.tolerance:.0%} of what you pay for.")
    else:
        print("  Verdict  : your ISP is delivering. No complaint needed.")

    if args.post != "none" and (below or args.always_post):
        message = build_complaint(result, cfg)
        print(f"\n  Post     : {message}\n")
        if args.post == "browser":
            post_with_browser(message)
        else:
            post_with_api(message)

    return 0


if __name__ == "__main__":
    sys.exit(main())
