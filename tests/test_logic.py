"""Unit tests for the parts of the bot that don't need a browser.

Run with:  python -m pytest
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from main import Config, SpeedResult, build_complaint  # noqa: E402

CFG = Config(promised_down=100, promised_up=10, isp_handle="@MyISP", tolerance=0.8)


def result(down, up):
    return SpeedResult(download=down, upload=up, ping=20, result_url="https://www.speedtest.net/result/1",
                       tested_at="2026-01-01T00:00:00")


def test_within_plan():
    assert not result(95, 9).is_below_plan(CFG)


def test_slow_download_is_flagged():
    assert result(40, 10).is_below_plan(CFG)


def test_slow_upload_is_flagged():
    assert result(100, 2).is_below_plan(CFG)


def test_exactly_at_tolerance_is_ok():
    assert not result(80, 8).is_below_plan(CFG)


def test_complaint_mentions_handle_speeds_and_link():
    text = build_complaint(result(12.34, 1.5), CFG)
    assert text.startswith("Hey @MyISP")
    assert "12.3 Mbps down / 1.5 Mbps up" in text
    assert "pay for 100 down / 10 up" in text
    assert text.endswith("https://www.speedtest.net/result/1")
    assert len(text) <= 280
