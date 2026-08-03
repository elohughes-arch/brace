"""
Brace pipeline - Stage 1: discovery.

Searches YouTube Data API for candidate first-person shooting footage and
writes shortlisted videos to Supabase with status='discovered'.

Usage:
    python discover.py                 # run all default queries
    python discover.py --query "shotkam sporting clays"

Env (.env): YOUTUBE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import re
import argparse
import os

import requests
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

DEFAULT_QUERIES = [
    '"clay shooting" POV camera',
    '"sporting clays" first person camera',
    "shotkam clay pigeon",
    '"clay pigeon shooting" gopro',
    "simulated game shooting day gun camera",
    '"skeet shooting" POV camera',
    '"compak sporting" POV',
    "shooting ground POV chest cam",
    '"down the line" shooting POV',
    "clay shooting school lesson POV",
]

# Channels worth crawling in full rather than hoping a keyword search
# surfaces them: camera makers and shooting schools whose uploads are
# almost entirely POV clay footage. Handle is the '@name' in the channel's
# URL. A wrong or renamed handle just returns zero videos — safe to grow;
# add real ones as they're found, e.g. with --channel @SomeShootingSchool.
DEFAULT_CHANNELS: list[str] = []

MIN_DURATION_S = 30
MAX_DURATION_S = 3600
REJECT_TITLE_WORDS = [
    "review", "unboxing", "compilation", "vs", "reaction",
    "cleaning", "reload", "airsoft", "video game", "gameplay",
    "roblox", "minecraft", "fortnite", "gta", "simulator 19", "simulator 20",
    "simulator 21", "simulator 22", "simulator 23", "farming simulator",
    "let's play", "walkthrough", "protest", "manifestation", "riot",
]

YT_SEARCH = "https://www.googleapis.com/youtube/v3/search"
YT_VIDEOS = "https://www.googleapis.com/youtube/v3/videos"
YT_CHANNELS = "https://www.googleapis.com/youtube/v3/channels"
YT_PLAYLIST_ITEMS = "https://www.googleapis.com/youtube/v3/playlistItems"


def iso8601_to_seconds(dur: str) -> int:
    import re
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", dur or "")
    if not m:
        return 0
    h, mi, s = (int(x) if x else 0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def _enrich(api_key: str, ids: list[str]) -> list[dict]:
    """Video IDs to shortlisted rows: duration and title filters, once."""
    out = []
    for i in range(0, len(ids), 50):   # videos.list caps at 50 ids per call
        batch = ids[i:i + 50]
        r2 = requests.get(YT_VIDEOS, params={
            "key": api_key, "id": ",".join(batch),
            "part": "contentDetails,statistics,snippet",
        }, timeout=30)
        r2.raise_for_status()
        for v in r2.json().get("items", []):
            title = v["snippet"]["title"]
            dur = iso8601_to_seconds(v["contentDetails"]["duration"])
            if not (MIN_DURATION_S <= dur <= MAX_DURATION_S):
                continue
            # word boundaries, not substrings — bare 'vs' matched Elvis and canvas
            if any(re.search(rf"\b{re.escape(w)}\b", title.lower())
                   for w in REJECT_TITLE_WORDS):
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


def search(api_key: str, query: str, max_results: int = 50) -> list[dict]:
    r = requests.get(YT_SEARCH, params={
        "key": api_key, "q": query, "part": "snippet", "type": "video",
        "maxResults": max_results, "videoDuration": "medium",
    }, timeout=30)
    r.raise_for_status()
    ids = [i["id"]["videoId"] for i in r.json().get("items", [])]
    return _enrich(api_key, ids) if ids else []


def channel_uploads(api_key: str, handle: str, max_results: int = 50) -> list[dict]:
    """Every recent upload from one channel, by handle (the '@name' from its
    URL) — for a camera maker or shooting school whose uploads are almost
    entirely the footage this project wants, rather than hoping a keyword
    search happens to surface them. Same filters as search(), just fed by
    the channel's own upload history instead of a ranked guess.
    """
    h = handle if handle.startswith("@") else f"@{handle}"
    r = requests.get(YT_CHANNELS, params={
        "key": api_key, "forHandle": h, "part": "contentDetails",
    }, timeout=30)
    r.raise_for_status()
    items = r.json().get("items", [])
    if not items:
        return []
    uploads_id = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]

    ids: list[str] = []
    page_token = None
    while len(ids) < max_results:
        params = {
            "key": api_key, "playlistId": uploads_id, "part": "contentDetails",
            "maxResults": min(50, max_results - len(ids)),
        }
        if page_token:
            params["pageToken"] = page_token
        r2 = requests.get(YT_PLAYLIST_ITEMS, params=params, timeout=30)
        r2.raise_for_status()
        data = r2.json()
        ids += [i["contentDetails"]["videoId"] for i in data.get("items", [])]
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return _enrich(api_key, ids) if ids else []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", action="append", help="override default queries")
    ap.add_argument("--channel", action="append",
                     help="crawl this channel's uploads too (repeatable, e.g. @ShotKam)")
    args = ap.parse_args()

    api_key = os.environ["YOUTUBE_API_KEY"]
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    def write(rows: list[dict]) -> None:
        if rows:
            # upsert so re-runs don't duplicate or reset status
            sb.table("pipeline_videos").upsert(
                rows, on_conflict="video_id", ignore_duplicates=True
            ).execute()

    queries = args.query or DEFAULT_QUERIES
    channels = args.channel or DEFAULT_CHANNELS
    total = 0
    for q in queries:
        rows = search(api_key, q)
        write(rows)
        print(f"'{q}': {len(rows)} candidates")
        total += len(rows)
    for c in channels:
        rows = channel_uploads(api_key, c)
        write(rows)
        print(f"channel {c}: {len(rows)} candidates")
        total += len(rows)
    print(f"Done. {total} candidates written (duplicates ignored).")


if __name__ == "__main__":
    main()
