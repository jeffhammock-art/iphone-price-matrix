#!/usr/bin/env python3
"""
Amazon.co.uk iPhone price scraper using requests + stdlib HTML parsing.
Parallel-friendly, ~1-2s per URL with retries. Outputs JSONL rows.
"""
import re
import json
import time
import hashlib
import sys
import os
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs, quote
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def _decode(content: bytes) -> str:
    try:
        return content.decode("utf-8", "replace")
    except Exception:
        return content.decode("latin-1", "replace")


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _price_int(text: str):
    """Extract integer pounds from text like '£225.00' or '225.00'."""
    m = re.search(r"£\s*([0-9][0-9,\.]*)", text)
    if m:
        n = m.group(1).replace(",", "")
        try:
            return int(float(n))
        except ValueError:
            return None
    m2 = re.search(r"(?<!\d)([0-9]{2,3})(?:\s*\.\s*[0-9]{2})?(?!\d)", text)
    if m2:
        try:
            return int(float(m2.group(1)))
        except ValueError:
            return None
    return None
