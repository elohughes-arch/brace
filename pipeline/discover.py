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

# ---------------------------------------------------------------- the matrix
#
# Difficulty is not one dimension, and the phase ladder is the wrong shape for
# deciding what to go and find. The ladder answers "what order do we teach
# this in" — one number per clip, hardest thing wins. That is right for
# curriculum and useless for coverage, because it cannot tell you that we hold
# four hundred crossers and no teal, or a thousand clear-sky clips and nothing
# in rain. Collapsed to one number, a gap is invisible.
#
# So there are two structures. The ladder (in modal_app._phase_of) orders
# training. This matrix orders collection: several independent axes, each with
# the values that actually occur on a British shooting ground, and a bank of
# searches aimed at each value. Discovery reads what we hold, finds the
# thinnest cells, and spends its quota there — so the dataset fills its own
# holes instead of deepening the pile it already has.
#
# Every query carries POV terms. A ground's promo reel is beautifully shot
# from a tripod and worth nothing to us: the detector watches through a camera
# carried by the shooter, and footage from anywhere else teaches a view it
# will never be given.
#
# The axes are ordered by how much they change what a clay looks like in
# frame. Light and background change the pixels most; discipline changes them
# least but reliably drags the others along with it — nobody films FITASC on a
# clear day at twenty yards.

_POV = '(POV OR "point of view" OR gopro OR shotkam OR "gun camera" OR "barrel cam")'

# axis -> value -> the searches that go looking for it
HUNT: dict[str, dict[str, list[str]]] = {
    # What the light is doing. Britain's default is overcast, and the whole
    # back half of this axis is where the dataset is thinnest by nature: it
    # rains on the days people leave the camera at home.
    "light": {
        "bright":    [f'clay shooting sunny day {_POV}'],
        "overcast":  [f'clay shooting overcast {_POV}',
                      f'"sporting clays" grey day {_POV}'],
        "rain":      [f'clay shooting in the rain {_POV}',
                      f'"clay pigeon shooting" wet weather {_POV}',
                      f'shooting ground rain {_POV} camera'],
        "drizzle":   [f'clay shooting drizzle damp {_POV}'],
        "fog":       [f'clay shooting fog mist {_POV}',
                      f'"clay pigeon" misty morning {_POV}'],
        "low_sun":   [f'clay shooting low sun glare {_POV}',
                      f'clay shooting winter sun {_POV}'],
        "dusk":      [f'clay shooting dusk evening light {_POV}',
                      f'"clay pigeon shooting" late evening {_POV}',
                      f'flighted clays dusk {_POV}'],
        "floodlit":  [f'clay shooting under floodlights night {_POV}'],
    },
    # What the clay is seen against. A clay on sky is a silhouette; a clay on
    # a treeline is a texture problem, and it is where most real sporting
    # targets actually live.
    "background": {
        "sky":       [f'clay shooting against sky {_POV}'],
        "cloud":     [f'clay shooting cloudy background {_POV}'],
        "treeline":  [f'sporting clays woodland treeline {_POV}',
                      f'clay shooting through the trees {_POV}'],
        "hillside":  [f'clay shooting valley hillside {_POV}',
                      f'quarry clay shooting {_POV}'],
        "ground":    [f'rabbit clay ground level {_POV}',
                      f'clay shooting stubble field {_POV}'],
        "water":     [f'clay shooting over water lake {_POV}'],
        "buildings": [f'clay shooting stands buildings {_POV}'],
    },
    # Colour and size. Anything that is not a standard orange is a different
    # detection problem, and the small ones are a different problem again.
    "clay": {
        "orange":    [f'orange clay targets {_POV} shooting'],
        "black":     [f'black clay targets {_POV} shooting'],
        "white":     [f'white clay targets {_POV} shooting'],
        "blaze":     [f'blaze flash clay targets {_POV}'],
        "midi":      [f'midi clay targets {_POV} sporting'],
        "mini":      [f'mini clay targets {_POV} sporting'],
        "battue":    [f'battue clay targets {_POV}'],
        "rabbit":    [f'rabbit clay target {_POV} shooting'],
    },
    # How the clay moves. The model has to survive all of these, and they are
    # not interchangeable: a dropper and a teal are opposite problems.
    "presentation": {
        "driven":    [f'driven clays overhead {_POV} shooting'],
        "crosser":   [f'crossing clay targets {_POV} sporting'],
        "going_away":[f'going away clay targets {_POV}'],
        "incomer":   [f'incoming clay targets {_POV} shooting'],
        "teal":      [f'springing teal clay {_POV} shooting'],
        "dropper":   [f'dropping clay target {_POV} sporting'],
        "looper":    [f'looping clay target {_POV} sporting'],
        "quartering":[f'quartering clay target {_POV}'],
        "pairs":     [f'simultaneous pair clays {_POV}',
                      f'report pair sporting clays {_POV}'],
        "flush":     [f'clay flush multiple targets {_POV}'],
    },
    # Distance and speed. Long birds are the hardest detection problem we
    # have — a few grey pixels — and the least represented, because they are
    # the least satisfying to film.
    "range": {
        "close":     [f'close range clay targets {_POV}'],
        "mid":       [f'sporting clays {_POV} camera'],
        "long":      [f'long range clay targets {_POV} shooting',
                      f'extreme distance clay shooting {_POV}',
                      f'high tower clays {_POV} shooting'],
        "fast":      [f'fast clay targets {_POV} sporting'],
    },
    # British disciplines. Each one drags a whole cluster of conditions along
    # with it, which makes this the cheapest axis to search on: one query for
    # FITASC brings back distance, awkward angles and mixed light together.
    "discipline": {
        "sporting":  [f'english sporting clays {_POV} shooting'],
        "compak":    [f'compak sporting {_POV} shooting'],
        "fitasc":    [f'FITASC sporting {_POV} shooting'],
        "dtl":       [f'"down the line" DTL shooting {_POV}'],
        "abt":       [f'automatic ball trap ABT {_POV} shooting'],
        "olympic":   [f'olympic trap bunker {_POV} shooting'],
        "skeet":     [f'english skeet {_POV} shooting',
                      f'olympic skeet {_POV} shooting'],
        "helice":    [f'helice ZZ shooting {_POV}'],
        "simulated": [f'simulated game day {_POV} gun camera',
                      f'simulated driven grouse {_POV} camera',
                      f'simulated high pheasant {_POV} camera'],
        "school":    [f'clay shooting lesson {_POV} instructor',
                      f'shooting school coaching {_POV} camera'],
    },
}

# Flattened, for a plain run with nothing to aim at.
DEFAULT_QUERIES = [q for axis in HUNT.values() for qs in axis.values() for q in qs]

# What to chase first when everything is equally empty, hardest and rarest
# leading. Two things put a cell high on this list: the clay is hard to see
# (a long bird, a black clay on a treeline, anything at dusk), or the footage
# is scarce because it is unpleasant to film — nobody takes a camera out in
# the rain for fun, which is precisely why a wet-weather detector has to be
# built on purpose rather than waited for.
#
# Everything absent from this list sorts after everything in it. Standard
# orange clays on a clear day against open sky need no help arriving.
WANTED = (
    # light nobody films in
    "rain", "fog", "dusk", "low_sun", "drizzle",
    # the birds that are a handful of grey pixels
    "long", "fast",
    # anything that is not a silhouette on sky
    "treeline", "hillside", "ground", "water",
    # clays that do not look like a clay is supposed to look
    "black", "battue", "mini", "midi", "white",
    # presentations that break a tracker rather than a shooter
    "teal", "dropper", "quartering", "looper", "flush",
    # disciplines that drag distance and awkward light along with them
    "fitasc", "helice", "olympic", "abt",
)


def hunt_queries(coverage: dict[str, dict[str, int]] | None = None,
                 per_axis: int = 3, floor: int = 25) -> list[tuple[str, str, str]]:
    """The searches worth running next, thinnest cell first.

    `coverage` is {axis: {value: how many clips we hold}}. Values missing from
    it count as zero, which is the point — a cell nobody has ever filled is
    the one most worth filling.

    Returns (axis, value, query) so what comes back can be attributed to the
    hole it was dug for, rather than vanishing into an undifferentiated pile.

    `floor` is where a cell stops being a gap. Above it the axis has enough to
    teach from and the quota is better spent elsewhere; there is no gain in
    hunting a value we already hold four hundred of.
    """
    coverage = coverage or {}
    out: list[tuple[str, str, str]] = []
    for axis, values in HUNT.items():
        have = coverage.get(axis, {})
        # Thinnest first — but on a cold start every cell reads zero and the
        # tie has to be broken by something. Alphabet would spend the opening
        # quota on bright days and drizzle; WANTED spends it on the footage
        # that is hard to detect and rarely filmed, which is the footage that
        # will still be missing a month from now if nobody goes after it
        # deliberately. Name breaks the remaining ties so a run repeats.
        ranked = sorted(values, key=lambda v: (
            have.get(v, 0),
            WANTED.index(v) if v in WANTED else len(WANTED),
            v))
        for value in ranked[:per_axis]:
            if have.get(value, 0) >= floor:
                continue          # this cell is fed; spend the quota elsewhere
            for q in values[value]:
                out.append((axis, value, q))
    return out


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
