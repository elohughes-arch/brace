"""
Brace pipeline - Stage 1: discovery.

Searches YouTube Data API for candidate first-person shooting footage and
writes shortlisted videos to Supabase with status='discovered'.

Usage:
    python discover.py                 # run all default queries
    python discover.py --query "shotkam sporting clays"

Env (.env): YOUTUBE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import os

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

DEFAULT_QUERIES = [
    "clay shooting POV",
    "sporting clays first person",
    "shotkam clay",
    "clay pigeon shooting gopro",
    "simulated game day shooting",
    "skeet shooting POV",
    "compak sporting POV",
]

MIN_DURATION_S = 30
MAX_DURATION_S = 3600
REJECT_TITLE_WORDS = [
    "review", "unboxing", "compilation", "vs", "reaction",
    "cleaning", "reload", "airsoft", "video game", "gameplay",
]

YT_SEARCH = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS = "https://www.googleapis.com/youtube/v3/videos"


def iso8601_to_seconds(dur: str) -> int:
    import re
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", dur or "")
    if not m:
        return 0
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def search(api_key: str, query: str, max_results: int = 50) -> list[dict]:
    r = requests.get(YT_SEARCH, params={
        "key": api_key, "q": query, "part": "snippet", "type": "video",
        "maxResults": max_results, "videoDuration": "medium",
    }, timeout=30)
    r.raise_for_status()
    items = r.json().get("items", [])
    ids = [i["id"]["videoId"] for i in items]
    if not ids:
        return []

    r2 = requests.get(YT_VIDEOS, params={
        "key": api_key, "id": ",".join(ids),
        "part": "contentDetails,statistics,snippet",
    }, timeout=30)
    r2.raise_for_status()

    out = []
    for v in r2.json().get("items", []):
        title = v["snippet"]["title"]
        dur = iso8601_to_seconds(v["contentDetails"]["duration"])
        if not (MIN_DURATION_S <= dur <= MAX_DURATION_S):
            continue
        if any(w in title.lower() for w in REJECT_TITLE_WORDS):
            continue
        out.append({
            "video_id": v["id"],
            "source": "youtube",
            "title": title,
            "channel": v["snippet"]["channelTitle"],
            "url": f"https://www.youtube.com/watch?v={v['id']}",
            "duration_s": dur,
            "view_count": int(v.get("statistics", {}).get("viewCount", 0)),
            "status": "discovered",
        })
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", help="override default queries")
    args = ap.parse_args()

    api_key = os.environ["YOUTUBE_API_KEY"]
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    queries = args.query or DEFAULT_QUERIES
    total = 0
    for q in queries:
        rows = search(api_key, q)
        if rows:
            # upsert so re-runs don't duplicate or reset status
            sb.table("pipeline_videos").upsert(
                rows, on_conflict="video_id", ignore_duplicates=True
            ).execute()
        print(f"'{q}': {len(rows)} candidates")
        total += len(rows)
    print(f"Done. {total} candidates written (duplicates ignored).")


if __name__ == "__main__":
    main()
