# Nettzone PGA Championship Pool

A tiny, self-hosted fantasy pool for the PGA Championship. Pick six golfers,
your best four scores each round count, lowest team total wins. Friends submit
entries through a Google Form; scores refresh automatically every ~15 minutes
via GitHub Actions. A **Sunday Showdown** adds three R4-only side contests
(Pick 3, Champion Call, Boom Holes) via a second form.

Everything is static — there is no server. The site lives on GitHub Pages and
the data lives in JSON files committed to the repo.

## What's in here

```
.
├── index.html              # the leaderboard site
├── assets/
│   ├── app.js              # client-side renderer + scoring
│   └── style.css
├── data/
│   ├── scores.json         # auto-updated by the fetch workflow
│   ├── entries.json        # auto-updated by the form-poll workflow
│   └── showdown.json       # auto-updated by the Sunday Showdown poll workflow
├── scripts/
│   ├── fetch_scores.py     # pulls from ESPN, writes data/scores.json
│   ├── poll_form.py        # pulls from the main Google Form sheet, writes entries.json
│   └── poll_showdown.py    # pulls from the showdown Google Form sheet, writes showdown.json
└── .github/workflows/
    ├── update-scores.yml   # cron every ~15 min during PGA Championship week
    ├── poll-form.yml       # cron every ~5 min, polls the main form
    └── poll-showdown.yml   # cron every ~2 min during the Sunday submission window
```

## One-time setup

1. **Create a public repo on GitHub** and push this directory to it.
   ```bash
   git init
   git add .
   git commit -m "Initial pool setup"
   git branch -M main
   git remote add origin https://github.com/<you>/pga-pool.git
   git push -u origin main
   ```

2. **Enable GitHub Pages.** `Settings → Pages → Build and deployment → Source:
   Deploy from a branch → main / (root) → Save`. After a minute the site is
   live at `https://<you>.github.io/pga-pool/`.

3. **Allow Actions to write to the repo.** `Settings → Actions → General →
   Workflow permissions → Read and write permissions → Save`. Without this the
   automated commits will fail.

4. **Kick off the first scores fetch.** `Actions → Update PGA Championship scores → Run
   workflow → main`. This populates `data/scores.json` with the field so picks
   can be validated and the **Field** tab on the site can show the player list.

5. **Create the Google Form** (see next section) and set the `FORM_CSV_URL`
   repo variable.

## The Google Form

Friends submit entries through a Google Form you create. Form responses land
in a linked sheet; the site polls a CSV export of the sheet every five minutes
and merges new submissions into the leaderboard.

### Setup

1. **Create a Google Form.** Add these short-answer questions in this order
   with these exact labels (case-insensitive but otherwise strict):
   - `Display name`
   - `Pick 1`
   - `Pick 2`
   - `Pick 3`
   - `Pick 4`
   - `Pick 5`
   - `Pick 6`

   Mark all of them required. Don't collect emails — none of the parsing
   needs them.

2. **Link a sheet.** In the form, `Responses → Link to Sheets → Create new
   spreadsheet`.

3. **Publish the sheet as CSV.** Open the sheet, then `File → Share → Publish
   to web`. Pick `Entire document` on the left and `Comma-separated values
   (.csv)` on the right. Click `Publish`. Copy the URL — it'll look like
   `https://docs.google.com/spreadsheets/d/e/2PACX-1v.../pub?output=csv`.

   The URL is read-only and unguessable, but it's not auth-protected — anyone
   who has it can read the responses. Fine for a private pool.

4. **Set the repo variable.** `Settings → Secrets and variables → Actions →
   Variables tab → New repository variable`. Name it `FORM_CSV_URL`, paste
   the CSV URL.

5. **Update the entry button on the site.** The "Submit Your Entry" button in
   the header and the link on the Rules tab both point to a Google Form
   `viewform` URL hardcoded in `index.html`. Search for `docs.google.com/forms`
   and replace both occurrences with your form's public URL (the one you get
   from the form's `Send → link icon` dialog, ending in `/viewform`).

6. **Trigger the first poll.** `Actions → Poll Google Form → Run workflow →
   main`. After it runs, any responses already in the sheet are on the board.

After step 6 you're done — the form-poll workflow runs every 5 minutes during
PGA Championship week and picks up new submissions automatically.

### How dedup works

- Each form row produces one entry. The `displayName` field is the dedup key:
  if two rows share the same display name, the **latest submission wins** and
  the older one is dropped.
- A friend can resubmit by filling out the form again with the same display
  name; the new picks replace the old.
- Two friends with the same display name will collide. Tell them to add a
  last initial.
- If you delete a row in the linked sheet, it disappears from the leaderboard
  on the next poll.

### When a pick doesn't match a real golfer

The poller validates every pick against the live field. Misspelled or
ambiguous picks don't quietly disappear — they show up on the leaderboard
under a **Pending fixes** section with the bad picks highlighted in red, so
the friend can self-diagnose and resubmit.

The poll workflow also logs every row's verdict in the workflow run. If you
want a more granular view: `Actions → Poll Google Form → most recent run →
poll job`.

## The Sunday Showdown (secondary R4-only contests)

Three sub-contests sit on top of the main pool, all scored on **Sunday's
final round only**. Friends submit a single secondary form on Sunday morning
and their picks are entered in all three contests at once.

| Contest | Picks | Scoring | Tiebreaker |
| --- | --- | --- | --- |
| **Pick 3** | 3 golfers | Sum of all three R4 to-pars (no drops). Lowest wins. | Full R4 of pick #1 |
| **Champion Call** | 1 winner + a guess | Must pick the actual winner. Closest winning to-par guess **that wasn't too optimistic** wins (i.e., can't guess a better score than the winner actually shot). | Smallest absolute diff |
| **Boom Holes** | 1 golfer | Combined strokes-to-par on holes **12, 13, 15, 16, 18** in R4. Lowest wins. | Full R4 to-par |

**Cut survivors only** — the showdown picker filters out anyone who got cut,
WD'd, or DQ'd. The submission deadline is **10:30 AM Eastern on Sunday**
(constants in `assets/app.js` and `scripts/poll_showdown.py` — both must
match if you change one).

### Setting up the showdown form

1. **Create a second Google Form** (separate from the main pool form) with
   these short-answer questions in this exact order:
   - `Display name`
   - `Pick 1`
   - `Pick 2`
   - `Pick 3`
   - `Champion`
   - `Winning to-par guess`
   - `Boom Holes pick`

   Mark all required.

2. **Link a sheet** and **publish it as CSV** (`File → Share → Publish to
   web → Entire document → Comma-separated values`). Copy the URL.

3. **Set the repo variable.** `Settings → Secrets and variables → Actions →
   Variables tab → New repository variable`. Name it `SHOWDOWN_FORM_CSV_URL`
   and paste the published-CSV URL.

4. **Get the prefill entry IDs.** In the form's three-dot menu, choose
   `Get pre-filled link`, fill in any answers, then `Get link`. Copy the
   resulting URL — you'll see segments like `entry.1234567890=foo`. Note
   each `entry.NNNN` ID and which question it belongs to.

5. **Update `SHOWDOWN_FORM_PREFILL` in `assets/app.js`.** Replace the seven
   `REPLACE_*` placeholder values with your form's base URL and entry IDs.
   The picker auto-hides itself until the base URL no longer contains
   `REPLACE_`, so the site will quietly skip the showdown picker until you
   wire it up.

6. **Trigger the first poll.** `Actions → Poll Sunday Showdown form →
   Run workflow → main`. Any test entries already in the sheet show up on
   the Sunday Showdown tab.

The poll workflow's cron is active — it polls every 2 minutes from
Saturday 22:00 UTC through the Sunday cutoff (14:30 UTC).

### How Boom Holes scoring gets its data

`scripts/fetch_scores.py` pulls per-hole R4 strokes for every cut survivor
from ESPN's per-competitor `linescores` endpoint and stores them as an
18-length `r4Holes` array on each player in `data/scores.json`. The renderer
sums the boom-hole strokes-vs-par client-side, so changing the boom hole
set is a one-line edit to `BOOM_HOLES` in `assets/app.js` (no script
changes required).

## Scoring rules

- 6 picks per entry, **best 4 scores each round count** toward the team total.
  Your two worst picks each round are dropped (and they can change round to
  round).
- Cut golfers keep their 36-hole to-par total — that score still counts if
  it's one of your best 4.
- Withdrawals and DQs take their last reported to-par **+ 10 stroke penalty**.
- Lowest team total after Sunday wins.

These constants live at the top of `assets/app.js` if you want to tweak them.

## How the automation works

- **`update-scores.yml`** runs on cron during PGA Championship week (May 14–17 2026)
  every 15 minutes. It runs `scripts/fetch_scores.py`, which hits ESPN's
  public golf leaderboard endpoint and rewrites `data/scores.json`. If
  scores changed it commits and pushes. The script also fetches per-hole
  R4 strokes from ESPN's `linescores` endpoint for Boom Holes scoring
  (stored as `r4Holes` on each player). The site reads `scores.json` on
  every page load (with cache busting) and re-renders.

- **`poll-form.yml`** runs every 5 minutes during the main entry window
  (currently disabled — cron commented out since the main pool deadline
  has passed). It runs `scripts/poll_form.py`, which fetches the
  published-CSV form responses, validates picks against the current field,
  dedups by display name, and rewrites `data/entries.json`. The poller is
  **stateless** — every run rebuilds the form portion of the file from the
  current sheet contents, so deleting a row in the sheet eventually removes
  it from the leaderboard.

- **`poll-showdown.yml`** runs every 2 minutes from Saturday 22:00 UTC
  through Sunday 14:30 UTC (the showdown submission window). It runs
  `scripts/poll_showdown.py`, which fetches the showdown Google Form CSV,
  validates picks against cut survivors, dedups by display name, and writes
  `data/showdown.json`. Entries that fail validation appear in a "Pending
  fixes" section on the site with detailed error messages.

GitHub Actions cron is best-effort and may be delayed several minutes when
GitHub is busy — fine for golf, not fine for stock trading.

## If something breaks mid-tournament

- **Manual score refresh:** `Actions → Update PGA Championship scores → Run workflow`.
- **Manual form poll:** `Actions → Poll Google Form → Run workflow`.
- **Manual showdown poll:** `Actions → Poll Sunday Showdown form → Run workflow`.
- **ESPN endpoint changes:** edit `scripts/fetch_scores.py`. The shape it
  expects is documented in the parsing functions. Worst case, write the
  fields you care about into `data/scores.json` by hand and commit — the
  site only cares about the file's shape, not where it came from.
- **A friend can't get their entry to validate:** check the **Pending fixes**
  section on the site, or open the latest poll workflow run. Names are
  matched against the **Field** tab — case-insensitive, accent-insensitive,
  unique substrings and unique last names work, but typos don't fuzzy-match.
  The same applies to showdown picks, which match against cut survivors only.

## Tweakable constants

| Where | What |
| --- | --- |
| `assets/app.js` top | `PENALTY_WD`, `PENALTY_NULL`, `BEST_OF`, `PICKS_REQUIRED`, `SUBMISSION_CUTOFF` |
| `assets/app.js` top | `PICK3_REQUIRED`, `BOOM_HOLES`, `SHOWDOWN_PENALTY_WD`, `FEES`, `SHOWDOWN_CUTOFF` |
| `scripts/poll_form.py` top | `SUBMISSION_CUTOFF` (must match `app.js`) |
| `scripts/poll_showdown.py` top | `SUBMISSION_CUTOFF` (must match `SHOWDOWN_CUTOFF` in `app.js`) |
| `.github/workflows/update-scores.yml` | Cron schedule for score fetch |
| `.github/workflows/poll-form.yml` | Cron schedule for form poll (currently disabled) |
| `.github/workflows/poll-showdown.yml` | Cron schedule for showdown poll |
| `scripts/fetch_scores.py` | ESPN endpoint, status mapping, R4 hole-by-hole fetch |

> **Submission deadlines:** cutoffs are enforced in two places each — the
> picker UI hides itself after the deadline, and the poller drops any form
> rows with a `submittedAt` timestamp at or after the cutoff. Both constants
> must match if you change one.
>
> - **Main pool:** `2026-05-14T14:00:00Z` (10 AM EDT, Thursday May 14)
> - **Sunday Showdown:** `2026-05-17T14:30:00Z` (10:30 AM EDT, Sunday May 17)

## Auto-refresh

The site auto-refreshes every 30 seconds on read-only tabs (Pool, Showdown,
Leaderboard, Field, Rules, Results). Refresh is suppressed when:

- The user is on a picker tab (Make picks / Make Showdown picks) before its
  cutoff, to avoid losing in-progress selections.
- A player scorecard modal is open.

## Results & settlement

The Results tab computes payouts across all four contests (main pool + three
showdown), calculates each player's net balance (entry fees paid minus prizes
won), and shows the minimum set of transfers needed to settle up.

| Contest | Entry fee | Payout |
| --- | --- | --- |
| Main Pool | $20 | 70/30 split (1st/2nd), 3rd gets entry fee back |
| Pick 3 | $20 | 70/30 split (1st/2nd), 3rd gets entry fee back |
| Champion Call | $10 | Winner-take-all (full refund if no eligible winner) |
| Boom Holes | $10 | Winner-take-all |

## Local preview

```bash
cd C:\git\PGA_Champ
python -m http.server 8000
```

Then open <http://localhost:8000>. The site fetches `data/scores.json` and
`data/entries.json` over HTTP, so opening `index.html` directly via `file://`
won't work — you need a local server.
