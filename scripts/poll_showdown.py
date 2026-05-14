#!/usr/bin/env python3
"""Pull Sunday Showdown entries from a Google Form's published-CSV sheet and
write data/showdown.json.

The Showdown is three sub-contests on a single form:
  - Pick 3:        sum of three R4 to-pars, lowest wins
  - Champion Call: pick the outright winner + a winning to-par tiebreak
  - Boom Holes:    one golfer's combined strokes-to-par on holes 12,13,15,16,18

Stateless: every run rewrites all source="form" entries from scratch based on
what's currently in the sheet. Picks are validated against the CUT-SURVIVOR
field — anyone who's been cut, withdrawn, or DQ'd cannot be chosen.

Usage:
    SHOWDOWN_FORM_CSV_URL=https://docs.google.com/.../pub?output=csv \
        python scripts/poll_showdown.py

Intentionally duplicated parsing helpers from poll_form.py — the two ingest
paths share an output directory but no code, so changes to one can't break
the other.
"""
import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOWDOWN_FILE = ROOT / "data" / "showdown.json"
SCORES_FILE = ROOT / "data" / "scores.json"

PICK3_REQUIRED = 3

# Submission deadline. Submissions with a parsed timestamp at or after this
# moment are dropped. 11:00 AM Eastern (EDT) on Sunday May 17, 2026 ==
# 15:00 UTC May 17, 2026. Must match SHOWDOWN_CUTOFF in assets/app.js.
SUBMISSION_CUTOFF = datetime(2026, 5, 17, 15, 0, 0, tzinfo=timezone.utc)


# ---------- helpers (intentionally duplicated from poll_form.py) ----------

def slug(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def match_pick(pick_text, field):
    """Match a free-text golfer name against the (cut-survivor-filtered) field.

    Same algorithm as poll_form.match_pick: exact slug → unique substring →
    unique last-name fallback. Accent- and case-insensitive."""
    pick_text = (pick_text or "").strip()
    if not pick_text:
        raise ValueError("empty pick")
    target = slug(pick_text)
    if not target:
        raise ValueError(f"unparseable pick: {pick_text!r}")

    exact = [p for p in field if slug(p.get("name")) == target]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ValueError(f"{pick_text!r} matches multiple players exactly")

    contains = [p for p in field if target in slug(p.get("name"))]
    if len(contains) == 1:
        return contains[0]

    parts = target.split()
    if len(parts) == 1:
        last = [p for p in field if slug(p.get("name")).split()[-1] == parts[0]]
        if len(last) == 1:
            return last[0]

    if not contains:
        raise ValueError(f"no cut-survivor matches {pick_text!r}")
    names = ", ".join(p["name"] for p in contains[:6])
    raise ValueError(f"{pick_text!r} is ambiguous — could be: {names}")


def parse_to_par_guess(s):
    """Parse a winning-to-par guess from form input.

    Accepts '-12', '+1', '12', 'E', '0', or strings with stray whitespace.
    Returns an int (negative = under par). Raises ValueError on garbage."""
    s = (s or "").strip()
    if not s:
        raise ValueError("missing")
    if s.upper() in ("E", "EVEN"):
        return 0
    cleaned = s.replace("+", "").replace(" ", "")
    try:
        return int(cleaned)
    except ValueError:
        raise ValueError(f"unparseable to-par guess: {s!r}")


# ---------- CSV parsing ----------

PICK_HEADER_RE = re.compile(r"^pick\s*0*([1-3])\b", re.IGNORECASE)


def find_column(headers, *candidates):
    norm = {h: slug(h) for h in headers}
    for cand in candidates:
        c = slug(cand)
        for h, n in norm.items():
            if n == c:
                return h
    for cand in candidates:
        c = slug(cand)
        for h, n in norm.items():
            if c in n:
                return h
    return None


def find_pick3_columns(headers):
    """Return a 3-list of headers for Pick 1..3."""
    cols = [None] * 3
    for h in headers:
        m = PICK_HEADER_RE.match(h.strip())
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < 3 and cols[idx] is None:
                cols[idx] = h
    return cols


def parse_form_timestamp(s):
    if not s:
        return None
    s = s.strip()
    formats = [
        "%m/%d/%Y %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%m/%d/%Y %H:%M",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return s


def is_past_cutoff(submitted_at_iso):
    if not submitted_at_iso:
        return False
    try:
        dt = datetime.fromisoformat(submitted_at_iso)
    except (ValueError, TypeError):
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt >= SUBMISSION_CUTOFF


# ---------- IO ----------

def fetch_csv(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "pga-pool-showdown-poller/1.0"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return raw.decode("utf-8-sig")


def load_cut_survivors():
    """Load the field from scores.json, filtered to players who can play R4."""
    if not SCORES_FILE.exists():
        raise SystemExit(
            f"{SCORES_FILE} not found. Run scripts/fetch_scores.py first."
        )
    data = json.loads(SCORES_FILE.read_text(encoding="utf-8"))
    players = data.get("players") or []
    return [
        p for p in players
        if p.get("status") not in ("cut", "wd", "dq", "dns")
    ]


def load_showdown():
    if SHOWDOWN_FILE.exists():
        return json.loads(SHOWDOWN_FILE.read_text(encoding="utf-8"))
    return {"entries": [], "rejected": []}


def save_showdown(data):
    SHOWDOWN_FILE.parent.mkdir(parents=True, exist_ok=True)
    SHOWDOWN_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


# ---------- main ----------

def process_rows(rows, headers, field):
    """Yield (status, payload, log_line) for each row.

    status ∈ {"accepted", "rejected", "skipped", "late"}.
    Errors are collected per row so the friend sees the full picture in
    'Pending fixes' instead of having to resubmit five times to surface five
    different problems."""
    name_col = find_column(headers, "display name", "name")
    pick_cols = find_pick3_columns(headers)
    champ_col = find_column(headers, "champion", "winner", "champion call")
    guess_col = find_column(
        headers,
        "winning to-par guess",
        "winning to par guess",
        "to par guess",
        "to-par guess",
        "tiebreaker",
        "tiebreak",
    )
    boom_col = find_column(
        headers, "boom holes pick", "boom holes", "boom hole pick", "boom hole"
    )
    ts_col = find_column(headers, "timestamp")

    if not name_col:
        raise SystemExit(
            "Showdown CSV is missing a 'Display name' column. Add a "
            "short-answer question titled 'Display name' to the form."
        )
    missing_picks = [i + 1 for i, c in enumerate(pick_cols) if c is None]
    if missing_picks:
        raise SystemExit(
            f"Showdown CSV is missing pick columns: {missing_picks}. "
            "The form needs three short-answer questions named 'Pick 1' "
            "through 'Pick 3'."
        )
    if not champ_col:
        raise SystemExit(
            "Showdown CSV is missing a 'Champion' column. Add a short-answer "
            "question titled 'Champion' to the form."
        )
    if not guess_col:
        raise SystemExit(
            "Showdown CSV is missing a 'Winning to-par guess' column. Add a "
            "short-answer question titled 'Winning to-par guess' to the form."
        )
    if not boom_col:
        raise SystemExit(
            "Showdown CSV is missing a 'Boom Holes pick' column. Add a "
            "short-answer question titled 'Boom Holes pick' to the form."
        )

    for row in rows:
        display_name = (row.get(name_col) or "").strip()
        if not display_name:
            yield "skipped", None, "skipped row with no display name"
            continue

        submitted_at = parse_form_timestamp(row.get(ts_col, "")) or None
        if is_past_cutoff(submitted_at):
            yield (
                "late",
                None,
                f"{display_name!r}: LATE — submitted at {submitted_at} "
                f"(past cutoff {SUBMISSION_CUTOFF.isoformat()})",
            )
            continue

        raw_pick3 = [(row.get(c) or "").strip() for c in pick_cols]
        raw_champ = (row.get(champ_col) or "").strip()
        raw_guess = (row.get(guess_col) or "").strip()
        raw_boom = (row.get(boom_col) or "").strip()

        errors = []
        resolved_pick3 = []
        for i, pt in enumerate(raw_pick3, 1):
            if not pt:
                errors.append(
                    {"field": f"pick{i}", "input": "", "message": "missing"}
                )
                continue
            try:
                p = match_pick(pt, field)
                resolved_pick3.append((i, pt, p))
            except ValueError as e:
                errors.append(
                    {"field": f"pick{i}", "input": pt, "message": str(e)}
                )

        # Pick 3 picks must be unique among themselves
        if len(resolved_pick3) == PICK3_REQUIRED:
            ids = [p["id"] for _, _, p in resolved_pick3]
            if len(set(ids)) != len(ids):
                errors.append(
                    {
                        "field": "pick3",
                        "input": "",
                        "message": "duplicate golfer in Pick 3 picks",
                    }
                )

        resolved_champ = None
        if not raw_champ:
            errors.append(
                {"field": "champion", "input": "", "message": "missing"}
            )
        else:
            try:
                resolved_champ = match_pick(raw_champ, field)
            except ValueError as e:
                errors.append(
                    {"field": "champion", "input": raw_champ, "message": str(e)}
                )

        guess_value = None
        try:
            guess_value = parse_to_par_guess(raw_guess)
        except ValueError as e:
            errors.append(
                {"field": "championGuess", "input": raw_guess, "message": str(e)}
            )

        resolved_boom = None
        if not raw_boom:
            errors.append(
                {"field": "boomHoles", "input": "", "message": "missing"}
            )
        else:
            try:
                resolved_boom = match_pick(raw_boom, field)
            except ValueError as e:
                errors.append(
                    {"field": "boomHoles", "input": raw_boom, "message": str(e)}
                )

        if errors:
            rejection = {
                "displayName": display_name,
                "submittedAt": submitted_at,
                "rawPicks": {
                    "pick1": raw_pick3[0],
                    "pick2": raw_pick3[1],
                    "pick3": raw_pick3[2],
                    "champion": raw_champ,
                    "championGuess": raw_guess,
                    "boomHoles": raw_boom,
                },
                "errors": errors,
            }
            err_summary = "; ".join(
                f"{e['field']}: {e['message']}" for e in errors
            )
            yield "rejected", rejection, f"{display_name!r}: {err_summary}"
            continue

        entry = {
            "source": "form",
            "displayName": display_name,
            "submittedAt": submitted_at,
            "pick3": [
                {"id": p["id"], "name": p["name"]}
                for _, _, p in resolved_pick3
            ],
            "champion": {"id": resolved_champ["id"], "name": resolved_champ["name"]},
            "championGuess": guess_value,
            "boomHoles": {"id": resolved_boom["id"], "name": resolved_boom["name"]},
        }
        yield "accepted", entry, f"{display_name!r}: ok"


def main():
    url = (os.environ.get("SHOWDOWN_FORM_CSV_URL") or "").strip()
    if not url and len(sys.argv) > 1:
        url = sys.argv[1]
    if not url:
        print(
            "SHOWDOWN_FORM_CSV_URL not set — showdown ingestion is not "
            "configured. Skipping. (Set the SHOWDOWN_FORM_CSV_URL repo "
            "variable to enable.)",
            file=sys.stderr,
        )
        return 0

    print(f"Fetching showdown CSV from {url}", file=sys.stderr)
    csv_text = fetch_csv(url)
    reader = csv.DictReader(io.StringIO(csv_text))
    headers = reader.fieldnames or []
    if not headers:
        raise SystemExit(
            "Showdown CSV had no header row — is the form linked to a sheet?"
        )

    rows = list(reader)
    print(f"Read {len(rows)} showdown form rows.", file=sys.stderr)

    field = load_cut_survivors()
    if not field:
        raise SystemExit(
            "No cut-survivors found in scores.json — cannot validate picks. "
            "(Has the cut been applied? Re-run scripts/fetch_scores.py.)"
        )
    print(
        f"Field has {len(field)} cut-survivors eligible for showdown picks.",
        file=sys.stderr,
    )

    results = []
    counts = {"accepted": 0, "rejected": 0, "skipped": 0, "late": 0}
    for status, payload, log in process_rows(rows, headers, field):
        print("  " + log, file=sys.stderr)
        counts[status] += 1
        if status not in ("skipped", "late"):
            results.append((status, payload))

    # Latest submission per displayName wins, regardless of accepted/rejected
    def ts_key(item):
        return (item[1].get("submittedAt") or "")

    results.sort(key=ts_key)
    by_slug = {}
    for item in results:
        by_slug[slug(item[1]["displayName"])] = item

    accepted_entries = [p for s, p in by_slug.values() if s == "accepted"]
    rejected_entries = [p for s, p in by_slug.values() if s == "rejected"]

    save_showdown({"entries": accepted_entries, "rejected": rejected_entries})

    print(
        f"Wrote showdown.json: {len(accepted_entries)} accepted, "
        f"{len(rejected_entries)} rejected.",
        file=sys.stderr,
    )
    print(
        f"Summary: accepted={counts['accepted']} "
        f"rejected={counts['rejected']} skipped={counts['skipped']} "
        f"late={counts['late']} unique-after-dedup={len(by_slug)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
