#!/usr/bin/env python3
"""Fetch PGA Championship leaderboard from ESPN and write data/scores.json.

Uses only the Python standard library so it runs on any plain Python install
(including the preinstalled Python on GitHub Actions ubuntu-latest).
"""
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = "https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard"
OUTPUT = Path(__file__).resolve().parent.parent / "data" / "scores.json"

# Per-competitor hole-by-hole linescores (CORS-open). Used to populate the
# r4Holes field on each non-cut player so the Sunday Showdown's Boom Holes
# contest can score against specific holes without each browser hitting
# ESPN N times on every page load.
SCORECARD_URL_TEMPLATE = (
    "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/"
    "{event_id}/competitions/{event_id}/competitors/{athlete_id}/linescores"
)


def fetch():
    req = urllib.request.Request(
        ENDPOINT, headers={"User-Agent": "pga-pool/1.0 (github actions)"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def find_event(data):
    """Pick the PGA Championship from ESPN's response, fall back to the first event."""
    events = data.get("events") or []
    for ev in events:
        name = (ev.get("name") or "")
        if "PGA Championship" in name:
            return ev
    return events[0] if events else None


def normalize_status(ctype):
    """Map ESPN's status type into our small enum."""
    desc = (ctype.get("description") or ctype.get("name") or "").lower()
    state = (ctype.get("state") or "").lower()
    if "cut" in desc:
        return "cut"
    if "withdraw" in desc or desc == "wd":
        return "wd"
    if "disqualif" in desc or desc == "dq":
        return "dq"
    if state == "post":
        return "final"
    if state == "in":
        return "active"
    return "scheduled"


def parse_rounds(linescores):
    """Return a 4-length list of per-round to-par values (int), or None if the
    round hasn't been played / is not yet started. For in-progress rounds this
    is the running to-par so far (e.g. +1 through 4 holes)."""
    rounds = []
    for ls in linescores or []:
        dv = (ls.get("displayValue") or "").strip()
        if not dv or dv == "-":
            rounds.append(None)
        elif dv == "E":
            rounds.append(0)
        else:
            try:
                rounds.append(int(dv))  # handles "+1", "-4", "3"
            except ValueError:
                rounds.append(None)
    while len(rounds) < 4:
        rounds.append(None)
    return rounds[:4]


def parse_event(ev):
    if not ev:
        raise SystemExit("ESPN response contained no events")

    comp = (ev.get("competitions") or [{}])[0]
    tour = ev.get("tournament") or {}
    ev_status = (ev.get("status") or {}).get("type") or {}
    comp_status = (comp.get("status") or {}).get("type") or {}

    players = []
    for c in comp.get("competitors") or []:
        ath = c.get("athlete") or {}
        cstatus = c.get("status") or {}
        ctype = cstatus.get("type") or {}
        position = (cstatus.get("position") or {}).get("displayName") or "-"
        score = c.get("score") or {}
        # ESPN's `score` field reflects the *current round* only. The cumulative
        # tournament to-par lives in the `statistics` array under name=scoreToPar.
        stats_by_name = {
            (s.get("name") or ""): s for s in (c.get("statistics") or [])
        }
        stp = stats_by_name.get("scoreToPar") or {}

        players.append(
            {
                "id": ath.get("id"),
                "name": ath.get("displayName"),
                "shortName": ath.get("shortName"),
                "country": (ath.get("flag") or {}).get("alt"),
                "position": position,
                "scoreToPar": stp.get("value"),
                "scoreDisplay": stp.get("displayValue")
                or score.get("displayValue")
                or "-",
                "thru": cstatus.get("thru"),
                "teeTime": cstatus.get("teeTime"),
                "status": normalize_status(ctype),
                "rounds": parse_rounds(c.get("linescores")),
            }
        )

    # Sort: lowest score first, unscored players last (alphabetical within ties)
    def sort_key(p):
        s = p["scoreToPar"]
        return (1 if s is None else 0, s if s is not None else 0, p["name"] or "")

    players.sort(key=sort_key)

    return {
        "tournament": {
            "id": ev.get("id"),
            "name": ev.get("name"),
            "startDate": ev.get("date"),
            "endDate": ev.get("endDate"),
            "currentRound": (comp.get("status") or {}).get("period") or 0,
            "status": ev_status.get("state") or comp_status.get("state") or "pre",
            "statusDescription": (
                ev_status.get("description")
                or comp_status.get("description")
                or "Scheduled"
            ),
            "cutScore": tour.get("cutScore"),
            "cutCount": tour.get("cutCount"),
            "lastUpdated": datetime.now(timezone.utc).isoformat(),
        },
        "players": players,
    }


def fetch_scorecard(event_id, athlete_id):
    url = SCORECARD_URL_TEMPLATE.format(event_id=event_id, athlete_id=athlete_id)
    req = urllib.request.Request(
        url, headers={"User-Agent": "pga-pool/1.0 (github actions)"}
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def parse_round_holes(scorecard, round_period):
    """Return an 18-length list of strokes per hole for the given round.

    Holes the player hasn't played yet (or that ESPN didn't return) are null.
    Used to feed the Boom Holes sidecar — we always pull round 4."""
    holes = [None] * 18
    for round_item in scorecard.get("items") or []:
        if round_item.get("period") != round_period:
            continue
        for ls in round_item.get("linescores") or []:
            hole = ls.get("period")
            if isinstance(hole, int) and 1 <= hole <= 18:
                val = ls.get("value")
                if isinstance(val, (int, float)):
                    holes[hole - 1] = int(val)
        break
    return holes


def attach_r4_holes(out):
    """Mutate parse_event() output: add r4Holes to every non-cut/non-WD player.

    Skipped before the tournament starts (the linescores endpoint returns
    nothing useful pre-event). Failures per player are non-fatal — we log and
    leave that player's r4Holes as a 18-length null list so the renderer never
    has to handle a missing field."""
    tournament = out["tournament"]
    status = tournament.get("status") or "pre"
    event_id = tournament.get("id")
    if status not in ("in", "post") or not event_id:
        return

    targets = [
        p for p in out["players"]
        if p.get("status") not in ("cut", "wd", "dq", "dns") and p.get("id")
    ]
    print(
        f"Fetching R4 hole data for {len(targets)} active players...",
        file=sys.stderr,
    )

    def worker(p):
        try:
            sc = fetch_scorecard(event_id, p["id"])
            p["r4Holes"] = parse_round_holes(sc, 4)
        except Exception as e:
            print(
                f"  scorecard fetch failed for {p.get('name')!r}: {e}",
                file=sys.stderr,
            )
            p["r4Holes"] = [None] * 18

    # ThreadPoolExecutor keeps the workflow runtime under a few seconds even
    # for the full 50-ish cut survivor field.
    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(worker, targets))


def main():
    print(f"Fetching {ENDPOINT}", file=sys.stderr)
    raw = fetch()
    ev = find_event(raw)
    out = parse_event(ev)
    attach_r4_holes(out)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    t = out["tournament"]
    print(
        f"Wrote {len(out['players'])} players. "
        f"{t['name']} — {t['statusDescription']} (round {t['currentRound']})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
