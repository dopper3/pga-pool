// PGA Championship Fantasy Pool — client-side renderer
//
// Reads data/scores.json (auto-updated by GitHub Actions) and data/entries.json
// (updated when the owner approves an entry issue) and renders the leaderboard.

const PENALTY_WD = 10; // strokes added on top of last to-par for WD/DQ
const PENALTY_NULL = 20; // strokes if the golfer never posted a score
// Each round a cut player didn't play is treated as +8 to par (roughly an
// 80 on a par-72 course, or a 78 on Aronimink's par 70). Cut always means
// 2 missed weekend rounds, so the effective penalty is +16 on top of the
// 36-hole to-par.
const CUT_ROUND_ASSUMED_TO_PAR = 8;
const CUT_MISSED_ROUNDS = 2;
const PICKS_REQUIRED = 6;
const BEST_OF = 4;

// Google Form prefill mapping. PLACEHOLDERS — create a new Google Form for
// the PGA Championship pool, "Get pre-filled link", copy the URL, and replace
// the entry IDs below with the ones from that URL. The picker auto-hides
// itself until the base URL no longer contains "REPLACE_".
const FORM_PREFILL = {
  base: "https://docs.google.com/forms/d/e/1FAIpQLSceym3M3uOnX8MKE48Ak1OZlJ6vqQYkp1uxY20jV_pVGNxGPQ/viewform",
  displayName: "entry.825396781",
  picks: [
    "entry.1008757096",
    "entry.1795423966",
    "entry.883359471",
    "entry.1537260538",
    "entry.712746174",
    "entry.1931449524",
  ],
};

// Submission deadline. Must match SUBMISSION_CUTOFF in scripts/poll_form.py.
// 10:00 AM Eastern on Thursday May 14, 2026 == 14:00 UTC May 14, 2026.
const SUBMISSION_CUTOFF = new Date("2026-05-14T14:00:00Z");

// ---------- Sunday Showdown sidecar ----------
// Three sub-contests on a single secondary form, all scored on R4 only:
//   1. Pick 3:        sum of three R4 to-pars, lowest wins (no drops).
//   2. Champion Call: pick the winner + a winning to-par tiebreak guess.
//   3. Boom Holes:    one golfer's combined strokes-to-par on a fixed set
//                     of "boom" holes (the back-nine drama holes).
const PICK3_REQUIRED = 3;
const BOOM_HOLES = [12, 13, 15, 16, 18];
const SHOWDOWN_PENALTY_WD = 10;

// Real names for the settlement/transfer section. Each team name (display name)
// can be mapped to a real name via dropdowns on the Results tab. The mapping is
// stored in localStorage so it persists across page loads.
const REAL_NAMES = [
  "Dan", "Lucas", "Alx", "Cleo", "Pat", "JayByrd", "Chad",
  "Pat Friend1", "Pat Friend 2",
];

// Shared name map loaded from data/nameMap.json (committed to repo, visible to all).
// localStorage overrides let individual users tweak locally.
let _sharedNameMap = {};
async function loadSharedNameMap() {
  try {
    _sharedNameMap = await loadJson("data/nameMap.json");
  } catch { _sharedNameMap = {}; }
}
function getNameMap() {
  const local = (() => {
    try { return JSON.parse(localStorage.getItem("nameMap") || "{}"); } catch { return {}; }
  })();
  return { ..._sharedNameMap, ...local };
}
function setNameMap(map) {
  localStorage.setItem("nameMap", JSON.stringify(map));
}
function resolvedName(displayName) {
  const map = getNameMap();
  const real = map[(displayName || "").trim()];
  return real || displayName;
}

// Entry fees for the Results tab (settlement math). Change these to update
// the per-contest pot size and per-player settlement calculations.
const FEES = {
  mainPool: 20,
  pick3: 20,
  championCall: 10,
  boomHoles: 10,
};

// Submission deadline for the showdown. Must match SUBMISSION_CUTOFF in
// scripts/poll_showdown.py. 11:00 AM Eastern (EDT) on Sunday May 17, 2026
// == 15:00 UTC May 17, 2026.
const SHOWDOWN_CUTOFF = new Date("2026-05-17T15:00:00Z");

// When the Sunday Showdown tabs become visible. Aligned with the showdown
// poll cron's start window — 6 PM EDT Saturday (after R3 wraps), which is
// 22:00 UTC May 16. Before this moment, both showdown tabs are hidden so
// the main pool entry flow isn't cluttered.
const SHOWDOWN_OPEN = new Date("2026-05-16T22:00:00Z");

function isShowdownWindowOpen() {
  return Date.now() >= SHOWDOWN_OPEN.getTime();
}

// Google Form prefill IDs for the Sunday Showdown form. PLACEHOLDERS — to
// activate the picker, create a Google Form with these short-answer
// questions in this order:
//   Display name, Pick 1, Pick 2, Pick 3, Champion,
//   Winning to-par guess, Boom Holes pick
// Then "Get pre-filled link", fill in any values, copy the URL, and replace
// the entry IDs below with the ones from that URL. The picker auto-hides
// itself until the base URL is changed away from the placeholder.
const SHOWDOWN_FORM_PREFILL = {
  base: "https://docs.google.com/forms/d/e/REPLACE_WITH_PGA_SHOWDOWN_FORM_ID/viewform",
  displayName: "entry.REPLACE_DISPLAY_NAME",
  pick3: [
    "entry.REPLACE_PICK_1",
    "entry.REPLACE_PICK_2",
    "entry.REPLACE_PICK_3",
  ],
  champion: "entry.REPLACE_CHAMPION",
  championGuess: "entry.REPLACE_CHAMPION_GUESS",
  boomHoles: "entry.REPLACE_BOOM_HOLES",
};

function isShowdownConfigured() {
  return !SHOWDOWN_FORM_PREFILL.base.includes("REPLACE_");
}

function isShowdownPastCutoff() {
  return Date.now() >= SHOWDOWN_CUTOFF.getTime();
}

function formatShowdownCutoffLocal() {
  try {
    return SHOWDOWN_CUTOFF.toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (e) {
    return SHOWDOWN_CUTOFF.toString();
  }
}

// Course par per hole. Used as a fallback when no rounds have been played
// yet (so we can still draw the par row in the scorecard modal), and as the
// authoritative par source for Boom Holes scoring before any R4 holes have
// been posted. Aronimink plays as par 70 for the 2026 PGA Championship —
// values below are a placeholder par-70 layout; verify against the official
// scorecard if Boom Holes scoring matters pre-round-4.
const COURSE_PAR = [4, 4, 4, 5, 3, 4, 3, 4, 4, 4, 3, 4, 4, 4, 4, 5, 3, 4];

// ESPN core API exposes per-competitor hole-by-hole linescores. CORS-open.
const SCORECARD_URL = (eventId, athleteId) =>
  `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events/${eventId}/competitions/${eventId}/competitors/${athleteId}/linescores`;

// Stashed when scores.json loads so renderers don't have to thread eventId
// through every call site. Reset on every refresh.
let currentEventId = null;

function isPastCutoff() {
  return Date.now() >= SUBMISSION_CUTOFF.getTime();
}

function formatCutoffLocal() {
  // Render the deadline in the visitor's local time.
  try {
    return SUBMISSION_CUTOFF.toLocaleString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (e) {
    return SUBMISSION_CUTOFF.toString();
  }
}

// ---------- helpers ----------
async function loadJson(path) {
  const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

function fmtToPar(n) {
  if (n == null) return "—";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

// Returns a small round headshot <img> for an ESPN golfer id, or null. The
// URL pattern is ESPN's standard headshot CDN; if a player has no portrait
// uploaded the onerror handler hides the img so it doesn't leave a broken
// icon in the row.
function playerAvatar(id) {
  if (!id) return null;
  const img = document.createElement("img");
  img.className = "player-avatar";
  img.src = `https://a.espncdn.com/i/headshots/golf/players/full/${id}.png`;
  img.alt = "";
  img.loading = "lazy";
  img.onerror = function () {
    this.style.display = "none";
  };
  return img;
}

// Returns a clickable button styled as a player-name link. Wraps an optional
// avatar + the player name. Skips wiring the click if we don't have both an
// athlete id and an event id (e.g. for picks whose golfer isn't in the field).
function playerNameLink(player, opts = {}) {
  const id = player && player.id != null ? String(player.id) : null;
  const name = (player && player.name) || "—";
  const eventId = opts.eventId || currentEventId;

  const wantAvatar = opts.avatar !== false;
  const avatar = wantAvatar && id ? playerAvatar(id) : null;

  if (!id || !eventId) {
    // Not clickable — render as a span so layout matches the link version.
    const span = document.createElement("span");
    span.className = "player-link disabled";
    if (avatar) span.appendChild(avatar);
    span.appendChild(document.createTextNode(name));
    return span;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "player-link";
  if (avatar) btn.appendChild(avatar);
  btn.appendChild(document.createTextNode(name));
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openScorecardModal(player, eventId);
  });
  return btn;
}

// Hits ESPN's per-competitor linescores endpoint and returns the items[]
// array (one entry per round). Throws on non-2xx so the caller can show an
// error state.
async function fetchScorecard(eventId, athleteId) {
  const res = await fetch(SCORECARD_URL(eventId, athleteId), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`scorecard ${res.status}`);
  const data = await res.json();
  return data.items || [];
}

// Pull the par row from the first round that has linescores. If nothing has
// been played yet, fall back to the static course par.
function parsePar(items) {
  for (const round of items || []) {
    const ls = round && round.linescores;
    if (ls && ls.length) {
      const par = new Array(18).fill(null);
      for (const h of ls) {
        const hole = h.period;
        if (hole >= 1 && hole <= 18 && typeof h.par === "number") {
          par[hole - 1] = h.par;
        }
      }
      // Fill any gaps from course defaults so the par row is always complete.
      for (let i = 0; i < 18; i++) {
        if (par[i] == null) par[i] = COURSE_PAR[i];
      }
      return par;
    }
  }
  return COURSE_PAR.slice();
}

// Map ESPN's scoreType.name into a CSS modifier so the cell can be color-coded.
function holeClass(scoreType) {
  const name = (scoreType && scoreType.name) || "";
  if (name === "EAGLE" || name === "DOUBLE_EAGLE") return "hole-eagle";
  if (name === "BIRDIE") return "hole-birdie";
  if (name === "PAR") return "hole-par";
  if (name === "BOGEY") return "hole-bogey";
  if (name === "DOUBLE_BOGEY" || name === "TRIPLE_BOGEY" || name === "OTHER")
    return "hole-double";
  return "";
}

// Render a 2x9 hole grid for one round (par row + strokes row, with In/Out/Tot
// totals). `holes` is keyed by hole number 1..18 from the round's linescores.
function renderRoundGrid(par, holes, round) {
  const wrap = el("div", { class: "scorecard-round" });

  const titleParts = [`Round ${round.period}`];
  if (round.displayValue) titleParts.push(`(${round.displayValue})`);
  wrap.appendChild(el("h3", { class: "scorecard-round-title" }, titleParts.join(" ")));

  const buildHalf = (start) => {
    const table = el("table", { class: "scorecard-grid" });
    const headRow = el("tr", {}, [el("th", {}, "Hole")]);
    for (let i = start; i < start + 9; i++) {
      headRow.appendChild(el("th", {}, String(i + 1)));
    }
    headRow.appendChild(el("th", { class: "scorecard-total" }, start === 0 ? "Out" : "In"));
    table.appendChild(headRow);

    const parRow = el("tr", { class: "scorecard-par-row" }, [el("th", {}, "Par")]);
    let parTotal = 0;
    for (let i = start; i < start + 9; i++) {
      parRow.appendChild(el("td", {}, String(par[i])));
      parTotal += par[i];
    }
    parRow.appendChild(el("td", { class: "scorecard-total" }, String(parTotal)));
    table.appendChild(parRow);

    const scoreRow = el("tr", { class: "scorecard-score-row" }, [el("th", {}, "Score")]);
    let scoreTotal = 0;
    let anyScore = false;
    for (let i = start; i < start + 9; i++) {
      const h = holes[i + 1];
      if (h) {
        anyScore = true;
        scoreTotal += h.value || 0;
        const td = el("td", { class: holeClass(h.scoreType) }, String(h.value));
        scoreRow.appendChild(td);
      } else {
        scoreRow.appendChild(el("td", { class: "hole-empty" }, "—"));
      }
    }
    // Prefer ESPN's outScore/inScore when present (handles in-progress rounds).
    let half = anyScore ? scoreTotal : null;
    if (start === 0 && typeof round.outScore === "number") half = round.outScore;
    if (start === 9 && typeof round.inScore === "number") half = round.inScore;
    scoreRow.appendChild(
      el("td", { class: "scorecard-total" }, half != null ? String(half) : "—"),
    );
    table.appendChild(scoreRow);
    return table;
  };

  wrap.appendChild(buildHalf(0));
  wrap.appendChild(buildHalf(9));

  // Round total line
  if (typeof round.value === "number" && round.value > 0) {
    wrap.appendChild(
      el(
        "p",
        { class: "scorecard-round-total" },
        `Total: ${round.value}${round.displayValue ? " (" + round.displayValue + ")" : ""}`,
      ),
    );
  }

  return wrap;
}

let scorecardKeyHandler = null;
function closeScorecardModal() {
  const existing = document.querySelector(".scorecard-backdrop");
  if (existing) existing.remove();
  if (scorecardKeyHandler) {
    document.removeEventListener("keydown", scorecardKeyHandler);
    scorecardKeyHandler = null;
  }
  document.body.classList.remove("scorecard-open");
}

function openScorecardModal(player, eventId) {
  // Replace any existing modal so a second click swaps content cleanly.
  closeScorecardModal();

  const backdrop = el("div", { class: "scorecard-backdrop" });
  const modal = el("div", { class: "scorecard-modal" });

  // Header
  const header = el("div", { class: "scorecard-header" });
  const avatar = playerAvatar(player.id);
  if (avatar) {
    avatar.classList.add("player-avatar-large");
    header.appendChild(avatar);
  }
  const headerText = el("div", { class: "scorecard-header-text" });
  headerText.appendChild(el("h2", {}, player.name || "Player"));
  const subParts = [];
  if (player.country) subParts.push(player.country);
  if (player.position) subParts.push(player.position);
  if (player.scoreToPar != null) subParts.push(fmtToPar(player.scoreToPar));
  if (subParts.length) {
    headerText.appendChild(el("p", { class: "scorecard-sub" }, subParts.join(" · ")));
  }
  header.appendChild(headerText);

  const closeBtn = el("button", { class: "scorecard-close", "aria-label": "Close" }, "×");
  closeBtn.addEventListener("click", closeScorecardModal);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  // Body — initial loading state
  const body = el("div", { class: "scorecard-body" });
  body.appendChild(el("p", { class: "scorecard-loading" }, "Loading scorecard…"));
  modal.appendChild(body);

  backdrop.appendChild(modal);
  // Backdrop click closes; clicks inside the modal should not.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeScorecardModal();
  });
  document.body.appendChild(backdrop);
  document.body.classList.add("scorecard-open");

  scorecardKeyHandler = (e) => {
    if (e.key === "Escape") closeScorecardModal();
  };
  document.addEventListener("keydown", scorecardKeyHandler);

  // Fetch and render
  fetchScorecard(eventId, player.id)
    .then((items) => {
      body.innerHTML = "";
      if (!items.length) {
        body.appendChild(
          el("p", { class: "scorecard-error" }, "Scorecard not available yet."),
        );
        return;
      }
      const par = parsePar(items);
      // Sort rounds by period to be safe.
      const rounds = items.slice().sort((a, b) => (a.period || 0) - (b.period || 0));
      for (const round of rounds) {
        const holes = {};
        for (const h of round.linescores || []) {
          if (h && h.period) holes[h.period] = h;
        }
        body.appendChild(renderRoundGrid(par, holes, round));
      }
    })
    .catch((err) => {
      console.error("scorecard fetch failed:", err);
      body.innerHTML = "";
      body.appendChild(
        el("p", { class: "scorecard-error" }, "Scorecard not available."),
      );
    });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- scoring ----------
function golferEffectiveScore(player) {
  // Returns { score, label, penalty: bool, status }
  if (!player) {
    return { score: PENALTY_NULL, label: "Not in field", penalty: true };
  }
  const s = player.scoreToPar;
  const status = player.status;

  if (status === "wd" || status === "dq" || status === "dns") {
    const base = s == null ? 0 : s;
    return {
      score: base + PENALTY_WD,
      label: `${fmtToPar(base)} (${status.toUpperCase()})`,
      penalty: true,
    };
  }

  if (status === "cut") {
    // Cut players are scored as if they shot CUT_ROUND_ASSUMED_TO_PAR for
    // each of the two weekend rounds they didn't play. Their team-total
    // score reflects the full 4-round assumed cumulative.
    const base = s == null ? 0 : s;
    const adjusted = base + CUT_MISSED_ROUNDS * CUT_ROUND_ASSUMED_TO_PAR;
    return {
      score: adjusted,
      label: `${fmtToPar(adjusted)} (CUT)`,
      penalty: true,
    };
  }

  if (s == null) {
    return { score: 0, label: "—", penalty: false };
  }
  return { score: s, label: fmtToPar(s), penalty: false };
}

function computeTeam(entry, byId) {
  const picks = entry.picks.map((pk) => {
    const player = byId.get(String(pk.id)) || null;
    const eff = golferEffectiveScore(player);
    return {
      id: pk.id,
      name: (player && player.name) || pk.name,
      position: player ? player.position : "—",
      thru: player ? player.thru : null,
      status: player ? player.status : "missing",
      ...eff,
    };
  });

  const sortedAsc = [...picks].sort((a, b) => a.score - b.score);
  // Mark the best four by object reference (picks and sortedAsc share refs).
  const countedSet = new Set(sortedAsc.slice(0, BEST_OF));
  picks.forEach((p) => (p.counted = countedSet.has(p)));
  const total = sortedAsc.slice(0, BEST_OF).reduce((s, p) => s + p.score, 0);

  return { ...entry, picks, total };
}

// ---------- showdown scoring ----------
// Three sub-contests, all scored against R4 only. Each compute* function
// takes a raw entry from data/showdown.json and returns a scored shape that
// the corresponding renderer knows how to draw.

function scoreShowdownGolferR4(pk, player) {
  // Returns the R4 to-par for one golfer pick, with WD/DQ penalty.
  if (!player) {
    return {
      id: pk.id,
      name: pk.name,
      score: PENALTY_NULL,
      label: "Not in field",
      penalty: true,
      status: "missing",
      thru: null,
    };
  }
  const r4 = (player.rounds || [])[3];
  const status = player.status;
  if (status === "wd" || status === "dq") {
    const base = r4 == null ? 0 : r4;
    return {
      id: pk.id,
      name: player.name,
      score: base + SHOWDOWN_PENALTY_WD,
      label: `${fmtToPar(base)} (${status.toUpperCase()})`,
      penalty: true,
      status,
      thru: player.thru,
    };
  }
  if (r4 == null) {
    return {
      id: pk.id,
      name: player.name,
      score: 0,
      label: "—",
      penalty: false,
      status,
      thru: player.thru,
    };
  }
  return {
    id: pk.id,
    name: player.name,
    score: r4,
    label: fmtToPar(r4),
    penalty: false,
    status,
    thru: player.thru,
  };
}

function computeShowdownPick3(entry, byId) {
  const picks = (entry.pick3 || []).map((pk) => {
    const player = byId.get(String(pk.id)) || null;
    return scoreShowdownGolferR4(pk, player);
  });
  const total = picks.reduce((s, p) => s + p.score, 0);
  // Tiebreak = full R4 of pick #1 (lower is better). Used by the standings
  // render to break ties; surfaced as `tiebreak` for display.
  const firstPickFull = picks[0] ? picks[0].score : 0;
  return { ...entry, scoredPicks: picks, total, tiebreak: firstPickFull };
}

function scoreShowdownBoomHoles(pk, player) {
  // Returns combined strokes-to-par on BOOM_HOLES, plus per-hole detail for
  // the standings table. Holes the golfer hasn't played yet are simply
  // omitted from the running total — partial scores are shown live.
  if (!player) {
    return {
      id: pk.id,
      name: pk.name,
      score: PENALTY_NULL,
      label: "Not in field",
      penalty: true,
      holesPlayed: 0,
      holes: [],
      r4Total: PENALTY_NULL,
    };
  }
  const status = player.status;
  if (status === "wd" || status === "dq") {
    return {
      id: pk.id,
      name: player.name,
      score: SHOWDOWN_PENALTY_WD,
      label: `${status.toUpperCase()} +${SHOWDOWN_PENALTY_WD}`,
      penalty: true,
      holesPlayed: 0,
      holes: [],
      r4Total: SHOWDOWN_PENALTY_WD,
    };
  }
  const r4Holes = player.r4Holes || new Array(18).fill(null);
  let total = 0;
  let played = 0;
  const holes = [];
  for (const holeNum of BOOM_HOLES) {
    const idx = holeNum - 1;
    const strokes = r4Holes[idx];
    const par = COURSE_PAR[idx];
    if (strokes != null) {
      total += strokes - par;
      played += 1;
    }
    holes.push({ hole: holeNum, strokes, par });
  }
  const r4 = (player.rounds || [])[3];
  return {
    id: pk.id,
    name: player.name,
    score: total,
    label: played === 0 ? "—" : fmtToPar(total),
    penalty: false,
    holesPlayed: played,
    holes,
    r4Total: r4 == null ? 0 : r4, // tiebreak: full R4 to-par
    status,
    thru: player.thru,
  };
}

function computeShowdownChampion(entry, players, tournament) {
  // Determine the actual winner. We only crown a winner if the tournament is
  // marked "post" (final). Mid-tournament we still compute predicted-correct
  // and signed diff so the live leaderboard shows current standings.
  const isFinal = tournament && tournament.status === "post";
  let actualWinner = null;
  let actualWinningToPar = null;
  if (players && players.length) {
    const eligible = players
      .filter(
        (p) =>
          p.scoreToPar != null &&
          p.status !== "cut" &&
          p.status !== "wd" &&
          p.status !== "dq",
      )
      .sort((a, b) => a.scoreToPar - b.scoreToPar);
    if (eligible.length) {
      actualWinner = eligible[0];
      actualWinningToPar = eligible[0].scoreToPar;
    }
  }

  const champ = entry.champion || {};
  const correct =
    actualWinner && String(actualWinner.id) === String(champ.id);

  let signedDiff = null;
  let absDiff = null;
  let overshot = false;
  if (actualWinningToPar != null && entry.championGuess != null) {
    // signedDiff = guess - actual (in to-par space).
    // Positive = predicted a worse score than they actually shot
    //           (acceptable / "didn't go over" in PriceIsRight rules).
    // Negative = predicted a better score than they actually shot
    //           ("went over" — disqualified for tiebreak unless nobody is OK).
    signedDiff = entry.championGuess - actualWinningToPar;
    absDiff = Math.abs(signedDiff);
    overshot = signedDiff < 0;
  }

  return {
    displayName: entry.displayName,
    pickName: champ.name || "—",
    pickId: champ.id,
    guess: entry.championGuess,
    actualWinner,
    actualWinningToPar,
    isFinal,
    correct: !!correct,
    signedDiff,
    absDiff,
    overshot,
  };
}

// ---------- renderers ----------
function renderHeader(t) {
  const status = document.getElementById("tournament-status");
  if (!t) {
    status.textContent = "Tournament data unavailable.";
    return;
  }
  const round = t.currentRound ? ` · Round ${t.currentRound}` : "";
  status.textContent = `${t.name} · ${t.statusDescription}${round}`;
  if (t.lastUpdated) {
    const d = new Date(t.lastUpdated);
    document.getElementById("last-updated").textContent =
      `Scores last refreshed ${d.toLocaleString()}`;
  }
}

function renderPreCutoffEntries(root, entries) {
  const card = el("div", { class: "precutoff" });
  card.appendChild(
    el("h2", { class: "precutoff-title" }, "Picks are hidden until the deadline"),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-body" },
      `Teams unlock at ${formatCutoffLocal()}. Until then you'll just see who has entered.`,
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-count" },
      `${entries.length} ${entries.length === 1 ? "entry" : "entries"} submitted so far`,
    ),
  );

  const list = el("ul", { class: "precutoff-list" });
  // Sort alphabetically by display name so the order doesn't leak submission timing.
  const names = entries
    .map((e) => e.displayName || "(no name)")
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    list.appendChild(el("li", {}, name));
  }
  card.appendChild(list);
  root.appendChild(card);
}

function renderPoolStandings(entries, byId) {
  const root = document.getElementById("pool-standings");
  root.innerHTML = "";

  // Hide the "best 4 of 6 / shaded in green" hint pre-cutoff — it's confusing
  // when there are no picks displayed.
  const hint = document.getElementById("pool-hint");
  if (hint) hint.hidden = !isPastCutoff();

  if (!entries.length) {
    root.appendChild(
      el("div", { class: "empty" }, [
        "No entries yet. Be the first — see the ",
        el("strong", {}, "Rules & how to enter"),
        " tab.",
      ]),
    );
    return;
  }

  // Before the submission deadline, show only the list of submitters — no
  // picks, no scores. Keeps people from copying each other's teams.
  if (!isPastCutoff()) {
    renderPreCutoffEntries(root, entries);
    return;
  }

  const teams = entries.map((e) => computeTeam(e, byId));
  teams.sort((a, b) => a.total - b.total);

  // Assign ranks (handles ties)
  let lastTotal = null;
  let lastRank = 0;
  teams.forEach((t, i) => {
    if (t.total !== lastTotal) {
      lastRank = i + 1;
      lastTotal = t.total;
    }
    t.rank = lastRank;
  });
  const tieCounts = {};
  teams.forEach((t) => (tieCounts[t.rank] = (tieCounts[t.rank] || 0) + 1));

  for (const t of teams) {
    const rankLabel = (tieCounts[t.rank] > 1 ? "T" : "") + t.rank;
    const card = el("div", { class: "pool-entry" });

    card.appendChild(
      el("div", { class: "pool-entry-header" }, [
        el("span", { class: "rank" }, rankLabel),
        el("span", { class: "name" }, t.displayName),
        el("span", { class: "total" }, fmtToPar(t.total)),
      ])
    );

    const table = el("table");
    const thead = el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Golfer"),
        el("th", {}, "Pos"),
        el("th", { class: "num" }, "Thru"),
        el("th", { class: "num" }, "Score"),
      ]),
    ]);
    table.appendChild(thead);

    const tbody = el("tbody");
    // Order picks: counted first (by score), then dropped
    const ordered = [...t.picks].sort((a, b) => {
      if (a.counted !== b.counted) return a.counted ? -1 : 1;
      return a.score - b.score;
    });
    for (const p of ordered) {
      const row = el("tr", { class: p.counted ? "counted" : "dropped" });
      const nameCell = el("td", { class: "name" });
      // Prefer the full player object from byId so the modal header has
      // country / scoreToPar; fall back to the slimmed-down pick.
      const fullPlayer = byId.get(String(p.id)) || p;
      nameCell.appendChild(playerNameLink(fullPlayer));
      if (p.penalty) {
        nameCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
      }
      row.appendChild(nameCell);
      row.appendChild(el("td", {}, p.position || "—"));
      row.appendChild(
        el("td", { class: "num" }, p.thru != null ? String(p.thru) : "—"),
      );
      row.appendChild(el("td", { class: "num" }, p.label));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    root.appendChild(card);
  }
}

function renderLeaderboard(players) {
  const root = document.getElementById("leaderboard");
  root.innerHTML = "";

  if (!players.length) {
    root.appendChild(
      el("div", { class: "empty" }, "Tournament hasn't started yet."),
    );
    return;
  }

  const table = el("table", { class: "lb-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "pos" }, "Pos"),
        el("th", {}, "Player"),
        el("th", { class: "num" }, "Score"),
        el("th", { class: "num" }, "Thru"),
        el("th", {}, "R1"),
        el("th", {}, "R2"),
        el("th", {}, "R3"),
        el("th", {}, "R4"),
      ]),
    ]),
  );

  const tbody = el("tbody");
  for (const p of players) {
    const isCut =
      p.status === "cut" || p.status === "wd" || p.status === "dq";
    const row = el("tr", isCut ? { class: "cut" } : {});
    row.appendChild(el("td", { class: "pos" }, p.position || "—"));
    const lbNameCell = el("td", { class: "player" });
    lbNameCell.appendChild(playerNameLink(p));
    row.appendChild(lbNameCell);
    row.appendChild(el("td", { class: "num" }, fmtToPar(p.scoreToPar)));
    row.appendChild(
      el(
        "td",
        { class: "num" },
        p.thru != null ? String(p.thru) : isCut ? p.status.toUpperCase() : "—",
      ),
    );
    for (let i = 0; i < 4; i++) {
      const r = (p.rounds || [])[i];
      row.appendChild(el("td", { class: "num" }, fmtToPar(r)));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

function renderRejected(rejected) {
  const root = document.getElementById("pending-fixes");
  root.innerHTML = "";
  if (!rejected || !rejected.length) return;

  const header = el("h2", { class: "pending-header" }, [
    "Pending fixes ",
    el("span", { class: "pending-count" }, `(${rejected.length})`),
  ]);
  root.appendChild(header);

  root.appendChild(
    el(
      "p",
      { class: "pending-hint" },
      "These form submissions couldn't be matched against the field. The friend " +
        "should resubmit the form using the same display name (latest submission " +
        "replaces the old one). Owner can also fix names directly in the linked " +
        "Google Sheet.",
    ),
  );

  for (const r of rejected) {
    const card = el("div", { class: "rejected-entry" });
    card.appendChild(
      el("div", { class: "rejected-entry-header" }, [
        el("span", { class: "name" }, r.displayName || "(no name)"),
        r.submittedAt
          ? el(
              "span",
              { class: "ts" },
              new Date(r.submittedAt).toLocaleString(),
            )
          : null,
      ]),
    );

    // Map errors by pickIndex for fast lookup
    const errsByPick = new Map();
    let entryLevelErrors = [];
    for (const e of r.errors || []) {
      if (e.pickIndex && e.pickIndex >= 1 && e.pickIndex <= 6) {
        errsByPick.set(e.pickIndex, e);
      } else {
        entryLevelErrors.push(e);
      }
    }

    const list = el("ol", { class: "rejected-picks" });
    const raw = r.rawPicks || [];
    for (let i = 0; i < 6; i++) {
      const text = raw[i] || "";
      const err = errsByPick.get(i + 1);
      if (err) {
        const li = el("li", { class: "bad" }, [
          el("span", { class: "input" }, text || "(empty)"),
          el("span", { class: "msg" }, err.message),
        ]);
        list.appendChild(li);
      } else {
        list.appendChild(
          el("li", { class: "ok" }, [el("span", { class: "input" }, text)]),
        );
      }
    }
    card.appendChild(list);

    for (const e of entryLevelErrors) {
      card.appendChild(
        el("p", { class: "entry-error" }, e.message),
      );
    }

    root.appendChild(card);
  }
}

// ---------- showdown renderers ----------
// One top-level entry point (`renderShowdown`) that paints the full Sunday
// Showdown tab, then three sub-renderers — one per sub-contest.

function renderShowdown(showdownData, players, byId, tournament) {
  const entries = (showdownData && showdownData.entries) || [];
  const rejected = (showdownData && showdownData.rejected) || [];
  const root = document.getElementById("showdown-content");
  if (!root) return;
  root.innerHTML = "";

  // Always-visible explainer card so the boys remember what game this is.
  root.appendChild(renderShowdownExplainer());

  // Pre-cutoff: just show the entrant list (no picks leaked).
  if (!isShowdownPastCutoff()) {
    root.appendChild(renderShowdownPreCutoff(entries));
    if (rejected.length) {
      root.appendChild(renderShowdownRejected(rejected));
    }
    return;
  }

  if (!entries.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "No showdown entries yet. Picks are due by " +
          formatShowdownCutoffLocal() +
          ".",
      ),
    );
    if (rejected.length) {
      root.appendChild(renderShowdownRejected(rejected));
    }
    return;
  }

  root.appendChild(renderPick3Standings(entries, byId));
  root.appendChild(renderBoomHolesStandings(entries, byId));
  root.appendChild(renderChampionStandings(entries, players, tournament));

  if (rejected.length) {
    root.appendChild(renderShowdownRejected(rejected));
  }
}

function renderShowdownExplainer() {
  const card = el("div", { class: "showdown-explainer" });
  card.appendChild(el("h2", {}, "Sunday Showdown"));
  card.appendChild(
    el(
      "p",
      { class: "hint" },
      "Three secondary contests, all scored on Sunday's final round only. " +
        "One Google Form, one set of picks, three leaderboards.",
    ),
  );
  const ul = el("ul", { class: "showdown-rules" });
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Pick 3: "),
      "sum of three R4 to-pars. No drops. Lowest wins. Tiebreak: full R4 of pick #1. ",
      el("span", { class: "fee-tag" }, "$20 entry"),
    ]),
  );
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Champion Call: "),
      "pick the outright winner + a winning to-par guess. Closest guess that " +
        "wasn't too optimistic wins. ",
      el("span", { class: "fee-tag" }, "$10 entry"),
    ]),
  );
  ul.appendChild(
    el("li", {}, [
      el("strong", {}, "Boom Holes: "),
      "one golfer's combined strokes-to-par on holes " +
        BOOM_HOLES.join(", ") +
        ". Lowest wins. Tiebreak: full R4 to-par. ",
      el("span", { class: "fee-tag" }, "$10 entry"),
    ]),
  );
  card.appendChild(ul);
  return card;
}

function renderShowdownPreCutoff(entries) {
  const card = el("div", { class: "precutoff" });
  card.appendChild(
    el(
      "h2",
      { class: "precutoff-title" },
      "Showdown picks are hidden until the deadline",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-body" },
      `Teams unlock at ${formatShowdownCutoffLocal()}. Until then you'll just ` +
        "see who has entered.",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "precutoff-count" },
      `${entries.length} ${entries.length === 1 ? "entry" : "entries"} submitted so far`,
    ),
  );
  const list = el("ul", { class: "precutoff-list" });
  const names = entries
    .map((e) => e.displayName || "(no name)")
    .sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    list.appendChild(el("li", {}, name));
  }
  card.appendChild(list);
  return card;
}

function renderPick3Standings(entries, byId) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(el("h2", { class: "showdown-section-title" }, "Pick 3"));
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "Sum of all 3 R4 to-pars. Lowest wins. Tiebreak: full R4 of pick #1.",
    ),
  );

  const teams = entries.map((e) => computeShowdownPick3(e, byId));
  // Sort: total asc, then tiebreak asc, then displayName for stability
  teams.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    if (a.tiebreak !== b.tiebreak) return a.tiebreak - b.tiebreak;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  // Assign ranks (ties share a rank, no skip-ahead)
  let lastTotal = null;
  let lastRank = 0;
  teams.forEach((t, i) => {
    if (t.total !== lastTotal) {
      lastRank = i + 1;
      lastTotal = t.total;
    }
    t.rank = lastRank;
  });
  const tieCounts = {};
  teams.forEach((t) => (tieCounts[t.rank] = (tieCounts[t.rank] || 0) + 1));

  for (const t of teams) {
    const rankLabel = (tieCounts[t.rank] > 1 ? "T" : "") + t.rank;
    const card = el("div", { class: "pool-entry" });
    card.appendChild(
      el("div", { class: "pool-entry-header" }, [
        el("span", { class: "rank" }, rankLabel),
        el("span", { class: "name" }, t.displayName),
        el("span", { class: "total" }, fmtToPar(t.total)),
      ]),
    );

    const table = el("table");
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, "Golfer"),
          el("th", {}, "Pos"),
          el("th", { class: "num" }, "Thru"),
          el("th", { class: "num" }, "R4"),
        ]),
      ]),
    );
    const tbody = el("tbody");
    t.scoredPicks.forEach((p, idx) => {
      const row = el("tr");
      const nameCell = el("td", { class: "name" });
      const fullPlayer = byId.get(String(p.id)) || p;
      nameCell.appendChild(playerNameLink(fullPlayer));
      if (idx === 0) {
        nameCell.appendChild(
          el("span", { class: "badge-tiebreak" }, "TB"),
        );
      }
      if (p.penalty) {
        nameCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
      }
      row.appendChild(nameCell);
      const fp = byId.get(String(p.id));
      row.appendChild(el("td", {}, (fp && fp.position) || "—"));
      row.appendChild(
        el(
          "td",
          { class: "num" },
          p.thru != null ? String(p.thru) : "—",
        ),
      );
      row.appendChild(el("td", { class: "num" }, p.label));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    wrap.appendChild(card);
  }
  return wrap;
}

function renderBoomHolesStandings(entries, byId) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "showdown-section-title" }, "Boom Holes"),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "One golfer, sum of strokes-to-par on holes " +
        BOOM_HOLES.join(", ") +
        ". Lowest wins. Tiebreak: full R4 to-par.",
    ),
  );

  const scored = entries.map((e) => {
    const player = byId.get(String((e.boomHoles || {}).id)) || null;
    return {
      displayName: e.displayName,
      golfer: scoreShowdownBoomHoles(e.boomHoles || {}, player),
    };
  });
  scored.sort((a, b) => {
    if (a.golfer.score !== b.golfer.score)
      return a.golfer.score - b.golfer.score;
    if (a.golfer.r4Total !== b.golfer.r4Total)
      return a.golfer.r4Total - b.golfer.r4Total;
    return (a.displayName || "").localeCompare(b.displayName || "");
  });

  let lastScore = null;
  let lastRank = 0;
  scored.forEach((s, i) => {
    if (s.golfer.score !== lastScore) {
      lastRank = i + 1;
      lastScore = s.golfer.score;
    }
    s.rank = lastRank;
  });
  const tieCounts = {};
  scored.forEach((s) => (tieCounts[s.rank] = (tieCounts[s.rank] || 0) + 1));

  const table = el("table", { class: "boom-table" });
  const headRow = el("tr", {}, [
    el("th", {}, "Rank"),
    el("th", {}, "Player"),
    el("th", {}, "Golfer"),
  ]);
  for (const h of BOOM_HOLES) {
    headRow.appendChild(el("th", { class: "num" }, "H" + h));
  }
  headRow.appendChild(el("th", { class: "num" }, "To Par"));
  headRow.appendChild(el("th", { class: "num" }, "Full R4"));
  table.appendChild(el("thead", {}, headRow));

  const tbody = el("tbody");
  for (const s of scored) {
    const rankLabel = (tieCounts[s.rank] > 1 ? "T" : "") + s.rank;
    const row = el("tr");
    row.appendChild(el("td", { class: "rank" }, rankLabel));
    row.appendChild(el("td", { class: "name" }, s.displayName));
    const golferCell = el("td", { class: "name" });
    const fullPlayer = byId.get(String(s.golfer.id)) || s.golfer;
    golferCell.appendChild(playerNameLink(fullPlayer));
    if (s.golfer.penalty) {
      golferCell.appendChild(el("span", { class: "badge-penalty" }, "PEN"));
    }
    row.appendChild(golferCell);
    for (const h of s.golfer.holes) {
      const td = el("td", { class: "num" });
      if (h.strokes == null) {
        td.textContent = "—";
      } else {
        const diff = h.strokes - h.par;
        td.textContent = String(h.strokes);
        td.classList.add(holeClassFromDiff(diff));
      }
      row.appendChild(td);
    }
    row.appendChild(el("td", { class: "num" }, s.golfer.label));
    row.appendChild(
      el(
        "td",
        { class: "num" },
        s.golfer.r4Total === SHOWDOWN_PENALTY_WD || s.golfer.score === PENALTY_NULL
          ? "—"
          : fmtToPar(s.golfer.r4Total),
      ),
    );
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function holeClassFromDiff(diff) {
  if (diff <= -2) return "hole-eagle";
  if (diff === -1) return "hole-birdie";
  if (diff === 0) return "hole-par";
  if (diff === 1) return "hole-bogey";
  return "hole-double";
}

function renderChampionStandings(entries, players, tournament) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "showdown-section-title" }, "Champion Call"),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "hint" },
      "Pick the outright winner + a winning to-par guess. Among entries that " +
        "picked the actual winner, closest guess that wasn't too optimistic wins.",
    ),
  );

  const scored = entries.map((e) =>
    computeShowdownChampion(e, players, tournament),
  );

  // Surface the actual winner state at the top of the section.
  const first = scored[0];
  if (first && first.actualWinner) {
    wrap.appendChild(
      el(
        "p",
        { class: "champion-actual" },
        first.isFinal
          ? `Winner: ${first.actualWinner.name} at ${fmtToPar(first.actualWinningToPar)}`
          : `Current leader: ${first.actualWinner.name} at ${fmtToPar(first.actualWinningToPar)} (not final yet)`,
      ),
    );
  }

  // Sort: correct picks first, then by (not-overshot, abs diff)
  // Among incorrect picks, sort by abs diff so the live board still ranks them.
  scored.sort((a, b) => {
    if (a.correct !== b.correct) return a.correct ? -1 : 1;
    if (a.absDiff == null && b.absDiff == null) return 0;
    if (a.absDiff == null) return 1;
    if (b.absDiff == null) return -1;
    if (a.overshot !== b.overshot) return a.overshot ? 1 : -1;
    return a.absDiff - b.absDiff;
  });

  const table = el("table", { class: "champion-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Rank"),
        el("th", {}, "Player"),
        el("th", {}, "Their Pick"),
        el("th", { class: "num" }, "Guess"),
        el("th", { class: "num" }, "Diff"),
        el("th", {}, "Status"),
      ]),
    ]),
  );
  const tbody = el("tbody");
  scored.forEach((s, i) => {
    const row = el("tr");
    row.appendChild(el("td", { class: "rank" }, String(i + 1)));
    row.appendChild(el("td", { class: "name" }, s.displayName));
    row.appendChild(el("td", {}, s.pickName));
    row.appendChild(
      el("td", { class: "num" }, s.guess == null ? "—" : fmtToPar(s.guess)),
    );
    row.appendChild(
      el(
        "td",
        { class: "num" },
        s.signedDiff == null
          ? "—"
          : (s.signedDiff > 0 ? "+" : "") + s.signedDiff,
      ),
    );
    let statusText = "—";
    if (s.actualWinner == null) {
      statusText = "pending";
    } else if (!s.correct) {
      statusText = "wrong winner";
    } else if (s.overshot) {
      statusText = "overshot";
    } else {
      statusText = s.signedDiff === 0 ? "exact!" : "in contention";
    }
    row.appendChild(el("td", {}, statusText));
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function renderShowdownRejected(rejected) {
  const wrap = el("div", { class: "showdown-section" });
  wrap.appendChild(
    el("h2", { class: "pending-header" }, [
      "Pending fixes ",
      el("span", { class: "pending-count" }, `(${rejected.length})`),
    ]),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "pending-hint" },
      "These showdown submissions couldn't be matched. Resubmit using the " +
        "same display name (latest submission replaces the old one).",
    ),
  );
  for (const r of rejected) {
    const card = el("div", { class: "rejected-entry" });
    card.appendChild(
      el("div", { class: "rejected-entry-header" }, [
        el("span", { class: "name" }, r.displayName || "(no name)"),
        r.submittedAt
          ? el(
              "span",
              { class: "ts" },
              new Date(r.submittedAt).toLocaleString(),
            )
          : null,
      ]),
    );
    const list = el("ul", { class: "rejected-picks" });
    for (const e of r.errors || []) {
      list.appendChild(
        el("li", { class: "bad" }, [
          el("span", { class: "input" }, `${e.field}: ${e.input || "(empty)"}`),
          el("span", { class: "msg" }, e.message),
        ]),
      );
    }
    card.appendChild(list);
    wrap.appendChild(card);
  }
  return wrap;
}

// ---------- results: fees + payouts + settlement ----------
// Computes each contest's pot, finds winners, rolls them up into a per-player
// balance, and solves the min-transactions settlement problem. Everything is
// done client-side on top of existing scoring functions — there's no separate
// data file for this, it's pure derived state.
//
// Settlement approach: classic greedy (largest creditor ↔ largest debtor
// repeatedly). For N people with nonzero net, this produces at most N-1
// transfers. Not provably optimal for pathological inputs, but optimal for
// the kind of numbers this pool produces.

function normName(s) {
  // Canonical key for matching display names across contests. Case/space
  // insensitive — keep the first-seen original for display.
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// All compute*Results functions return the same shape:
//   { label, entries, fee, pot, payouts, structure, note }
// where `payouts` is an array of { displayName, amount, role } records. Any
// non-entry-fee money flowing to a player goes through this array (prizes,
// refunds, splits) so buildBalances can stay dead simple.

function computeMainPoolResults(entries, byId) {
  const fee = FEES.mainPool;
  if (!entries.length) {
    return {
      label: "Main pool",
      entries: [],
      fee,
      pot: 0,
      payouts: [],
      structure: "Top 3 paid: 1st 70% / 2nd 30% / 3rd refund",
      note: null,
    };
  }
  const teams = entries.map((e) => computeTeam(e, byId));
  teams.sort((a, b) => a.total - b.total);

  // Sparse ranking: tied 1st, tied 1st, 3, 4, … (same as the standings tab).
  let lastTotal = null;
  let lastRank = 0;
  teams.forEach((t, i) => {
    if (t.total !== lastTotal) {
      lastRank = i + 1;
      lastTotal = t.total;
    }
    t.rank = lastRank;
  });

  const N = teams.length;
  const pot = N * fee;
  const rank1 = teams.filter((t) => t.rank === 1);
  const rank2 = teams.filter((t) => t.rank === 2);
  const rank3 = teams.filter((t) => t.rank === 3);

  const payouts = [];

  // Fewer than 3 entries → winner-take-all (split among any tied 1sts).
  if (N < 3) {
    const share = pot / rank1.length;
    for (const t of rank1) {
      payouts.push({
        displayName: t.displayName,
        amount: share,
        role: rank1.length > 1 ? "winner (tie)" : "winner",
      });
    }
    return {
      label: "Main pool",
      entries: teams.map((t) => t.displayName),
      fee,
      pot,
      payouts,
      structure: "Fewer than 3 entries — winner takes all",
      note: null,
    };
  }

  // 3+ entries: 70/30 split of 1st+2nd money, 3rd gets a $fee refund.
  //
  // Tied-3rd edge case: each tied 3rd still gets their own fee back. This
  // effectively removes them from the 1st+2nd pot entirely (they break even),
  // so firstSecondPool shrinks by rank3.length * fee.
  //
  // Tied-1st edge case: sparse ranking puts the next group at rank 3 (not 2),
  // so rank2 is empty. In that case the tied 1sts split the combined 1st+2nd
  // money (= firstSecondPool); no 2nd-place payout happens.
  //
  // Tied-2nd edge case: rank3 ends up empty (pushed off the podium), so no
  // refund happens — the full pot goes to 1st + the tied 2nds.
  const hasRank2 = rank2.length > 0;
  const hasRank3 = rank3.length > 0;
  const refundTotal = hasRank3 ? rank3.length * fee : 0;
  const firstSecondPool = pot - refundTotal;

  let firstShareTotal;
  let secondShareTotal;
  if (hasRank2) {
    firstShareTotal = 0.7 * firstSecondPool;
    secondShareTotal = 0.3 * firstSecondPool;
  } else {
    // Tied 1sts → combined 1st+2nd money goes to the tied group.
    firstShareTotal = firstSecondPool;
    secondShareTotal = 0;
  }

  const firstEach = firstShareTotal / rank1.length;
  const firstRole =
    rank1.length > 1
      ? hasRank2
        ? "1st (tie)"
        : "1st+2nd (tie)"
      : "1st";
  for (const t of rank1) {
    payouts.push({
      displayName: t.displayName,
      amount: firstEach,
      role: firstRole,
    });
  }
  if (hasRank2 && secondShareTotal > 0) {
    const secondEach = secondShareTotal / rank2.length;
    const secondRole = rank2.length > 1 ? "2nd (tie)" : "2nd";
    for (const t of rank2) {
      payouts.push({
        displayName: t.displayName,
        amount: secondEach,
        role: secondRole,
      });
    }
  }
  if (hasRank3) {
    const thirdRole = rank3.length > 1 ? "3rd refund (tie)" : "3rd refund";
    for (const t of rank3) {
      payouts.push({
        displayName: t.displayName,
        amount: fee,
        role: thirdRole,
      });
    }
  }

  return {
    label: "Main pool",
    entries: teams.map((t) => t.displayName),
    fee,
    pot,
    payouts,
    structure: "Top 3 paid: 1st 70% / 2nd 30% / 3rd refund",
    note: null,
  };
}

// Helper for the three showdown contests that are winner-take-all. Takes a
// pre-ranked list of winner display names and builds a payouts array split
// evenly among them.
function buildWinnerTakeAllPayouts(winnerNames, pot) {
  if (!winnerNames.length) return [];
  const share = pot / winnerNames.length;
  const role = winnerNames.length > 1 ? "winner (tie)" : "winner";
  return winnerNames.map((name) => ({
    displayName: name,
    amount: share,
    role,
  }));
}

function computePick3Results(entries, byId) {
  const fee = FEES.pick3;
  if (!entries.length) {
    return {
      label: "Sunday Showdown: Pick 3",
      entries: [],
      fee,
      pot: 0,
      payouts: [],
      structure: "Top 3 paid: 1st 70% / 2nd 30% / 3rd refund",
      note: null,
    };
  }
  const teams = entries.map((e) => computeShowdownPick3(e, byId));
  teams.sort((a, b) => {
    if (a.total !== b.total) return a.total - b.total;
    return a.tiebreak - b.tiebreak;
  });

  // Assign sparse ranks (1, 2, 3 …)
  teams[0].rank = 1;
  for (let i = 1; i < teams.length; i++) {
    const prev = teams[i - 1];
    teams[i].rank =
      teams[i].total === prev.total && teams[i].tiebreak === prev.tiebreak
        ? prev.rank
        : i + 1;
  }

  const N = teams.length;
  const pot = N * fee;
  const rank1 = teams.filter((t) => t.rank === 1);
  const rank2 = teams.filter((t) => t.rank === 2);
  const rank3 = teams.filter((t) => t.rank === 3);
  const payouts = [];

  // Fewer than 3 entries → winner-take-all.
  if (N < 3) {
    const share = pot / rank1.length;
    for (const t of rank1) {
      payouts.push({
        displayName: t.displayName,
        amount: share,
        role: rank1.length > 1 ? "winner (tie)" : "winner",
      });
    }
    return {
      label: "Sunday Showdown: Pick 3",
      entries: teams.map((t) => t.displayName),
      fee,
      pot,
      payouts,
      structure: "Fewer than 3 entries — winner takes all",
      note: null,
    };
  }

  // 3+ entries: 70/30 split of 1st+2nd money, 3rd gets a $fee refund.
  const hasRank2 = rank2.length > 0;
  const hasRank3 = rank3.length > 0;
  const refundTotal = hasRank3 ? rank3.length * fee : 0;
  const firstSecondPool = pot - refundTotal;

  let firstShareTotal;
  let secondShareTotal;
  if (hasRank2) {
    firstShareTotal = 0.7 * firstSecondPool;
    secondShareTotal = 0.3 * firstSecondPool;
  } else {
    firstShareTotal = firstSecondPool;
    secondShareTotal = 0;
  }

  const firstEach = firstShareTotal / rank1.length;
  const firstRole =
    rank1.length > 1
      ? hasRank2
        ? "1st (tie)"
        : "1st+2nd (tie)"
      : "1st";
  for (const t of rank1) {
    payouts.push({ displayName: t.displayName, amount: firstEach, role: firstRole });
  }
  if (hasRank2 && secondShareTotal > 0) {
    const secondEach = secondShareTotal / rank2.length;
    const secondRole = rank2.length > 1 ? "2nd (tie)" : "2nd";
    for (const t of rank2) {
      payouts.push({ displayName: t.displayName, amount: secondEach, role: secondRole });
    }
  }
  if (hasRank3) {
    const thirdRole = rank3.length > 1 ? "3rd refund (tie)" : "3rd refund";
    for (const t of rank3) {
      payouts.push({ displayName: t.displayName, amount: fee, role: thirdRole });
    }
  }

  return {
    label: "Sunday Showdown: Pick 3",
    entries: teams.map((t) => t.displayName),
    fee,
    pot,
    payouts,
    structure: "Top 3 paid: 1st 70% / 2nd 30% / 3rd refund",
    note: null,
  };
}

function computeBoomHolesResults(entries, byId) {
  const fee = FEES.boomHoles;
  if (!entries.length) {
    return {
      label: "Boom Holes",
      entries: [],
      fee,
      pot: 0,
      payouts: [],
      structure: "Winner takes all",
      note: null,
    };
  }
  const scored = entries.map((e) => {
    const player = byId.get(String((e.boomHoles || {}).id)) || null;
    return {
      displayName: e.displayName,
      golfer: scoreShowdownBoomHoles(e.boomHoles || {}, player),
    };
  });
  scored.sort((a, b) => {
    if (a.golfer.score !== b.golfer.score)
      return a.golfer.score - b.golfer.score;
    return a.golfer.r4Total - b.golfer.r4Total;
  });
  const ws = scored[0].golfer.score;
  const wtb = scored[0].golfer.r4Total;
  const winners = scored
    .filter((s) => s.golfer.score === ws && s.golfer.r4Total === wtb)
    .map((s) => s.displayName);
  const pot = entries.length * fee;
  return {
    label: "Boom Holes",
    entries: entries.map((e) => e.displayName),
    fee,
    pot,
    payouts: buildWinnerTakeAllPayouts(winners, pot),
    structure: "Winner takes all",
    note: null,
  };
}

function computeChampionResults(entries, players, tournament) {
  const fee = FEES.championCall;
  if (!entries.length) {
    return {
      label: "Champion Call",
      entries: [],
      fee,
      pot: 0,
      payouts: [],
      structure: "Winner takes all",
      note: null,
    };
  }
  const scored = entries.map((e) =>
    computeShowdownChampion(e, players, tournament),
  );
  // Eligible = picked the correct champion AND didn't overshoot the guess.
  // Among eligible, smallest absDiff wins. No eligible → full refund (each
  // entry gets their own $10 back, zero-net).
  const eligible = scored.filter(
    (s) => s.correct && !s.overshot && s.absDiff != null,
  );
  const pot = entries.length * fee;

  if (!eligible.length) {
    const payouts = entries.map((e) => ({
      displayName: e.displayName,
      amount: fee,
      role: "refund",
    }));
    return {
      label: "Champion Call",
      entries: entries.map((e) => e.displayName),
      fee,
      pot,
      payouts,
      structure: "Winner takes all",
      note: "No one picked the correct winner — pot refunded.",
    };
  }

  eligible.sort((a, b) => a.absDiff - b.absDiff);
  const wd = eligible[0].absDiff;
  const winners = eligible
    .filter((s) => s.absDiff === wd)
    .map((s) => s.displayName);
  return {
    label: "Champion Call",
    entries: entries.map((e) => e.displayName),
    fee,
    pot,
    payouts: buildWinnerTakeAllPayouts(winners, pot),
    structure: "Winner takes all",
    note: null,
  };
}

function buildBalances(contests) {
  // Returns an array of { key, display, net } where net > 0 means the person
  // is owed money (net winner) and net < 0 means they owe money (net loser).
  const people = new Map();
  function touch(displayName) {
    const key = normName(displayName);
    if (!people.has(key)) {
      people.set(key, { key, display: (displayName || "").trim(), net: 0 });
    }
    return people.get(key);
  }
  for (const c of contests) {
    for (const e of c.entries) {
      touch(e).net -= c.fee;
    }
    for (const p of c.payouts) {
      touch(p.displayName).net += p.amount;
    }
  }
  return Array.from(people.values());
}

function settleTransactions(balances) {
  // Classic greedy: match the biggest creditor with the biggest debtor, emit
  // a transaction for min(both), decrement, repeat. Produces ≤ N-1 transfers.
  const EPS = 0.005;
  const creditors = balances
    .filter((b) => b.net > EPS)
    .map((b) => ({ name: b.display, amount: b.net }))
    .sort((a, b) => b.amount - a.amount);
  const debtors = balances
    .filter((b) => b.net < -EPS)
    .map((b) => ({ name: b.display, amount: -b.net }))
    .sort((a, b) => b.amount - a.amount);

  const txns = [];
  let i = 0;
  let j = 0;
  while (i < creditors.length && j < debtors.length) {
    const pay = Math.min(creditors[i].amount, debtors[j].amount);
    txns.push({
      from: debtors[j].name,
      to: creditors[i].name,
      amount: pay,
    });
    creditors[i].amount -= pay;
    debtors[j].amount -= pay;
    if (creditors[i].amount < EPS) i++;
    if (debtors[j].amount < EPS) j++;
  }
  return txns;
}

function fmtMoney(n) {
  const abs = Math.abs(n);
  const cents = abs % 1 !== 0;
  return "$" + abs.toFixed(cents ? 2 : 0);
}

function fmtMoneySigned(n) {
  if (Math.abs(n) < 0.005) return "$0";
  return (n > 0 ? "+" : "−") + fmtMoney(n);
}

function renderResults(entriesData, showdownData, byId, players, tournament) {
  // Stash args so name-map dropdown change handlers can re-render.
  window._lastEntriesData = entriesData;
  window._lastShowdownData = showdownData;
  window._lastById = byId;
  window._lastPlayers = players;
  window._lastTournament = tournament;

  const root = document.getElementById("results");
  root.innerHTML = "";

  const mainEntries = (entriesData && entriesData.entries) || [];
  // Only factor showdown contests in once the submission window has closed —
  // pre-cutoff we're hiding showdown picks on the rest of the site too and
  // we don't want the results page to leak partial in-flight submissions.
  const sdEntries = isShowdownPastCutoff()
    ? (showdownData && showdownData.entries) || []
    : [];

  // Header — explain whether this is live-projected or final.
  const isFinal = tournament && tournament.status === "post";
  const header = el("div", { class: "results-header" });
  header.appendChild(el("h2", {}, "Settle up"));
  header.appendChild(
    el(
      "p",
      { class: "hint" },
      isFinal
        ? "Final results. Everyone owing money to the right should send it to the " +
            "person on the left. Transfers are the minimum set needed to balance " +
            "everything out."
        : "Projected results based on the live leaderboard. These will keep " +
            "updating until the tournament is final.",
    ),
  );
  root.appendChild(header);

  if (!mainEntries.length && !sdEntries.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "No entries yet — nothing to settle.",
      ),
    );
    return;
  }

  // Build per-contest results.
  const contests = [];
  if (mainEntries.length) {
    contests.push(computeMainPoolResults(mainEntries, byId));
  }
  if (sdEntries.length) {
    contests.push(computePick3Results(sdEntries, byId));
    contests.push(computeChampionResults(sdEntries, players, tournament));
    contests.push(computeBoomHolesResults(sdEntries, byId));
  }

  // ----- Prize pots card -----
  const potsCard = el("div", { class: "results-section" });
  potsCard.appendChild(
    el("h3", { class: "results-section-title" }, "Prize pots"),
  );
  for (const c of contests) {
    const card = el("div", { class: "results-contest-card" });
    card.appendChild(
      el("div", { class: "results-contest-header" }, [
        el("span", { class: "results-contest-name" }, c.label),
        el("span", { class: "results-contest-pot" }, fmtMoney(c.pot)),
      ]),
    );
    card.appendChild(
      el(
        "p",
        { class: "results-contest-meta" },
        `${c.entries.length} ${c.entries.length === 1 ? "entry" : "entries"} × ${fmtMoney(c.fee)} · ${c.structure}`,
      ),
    );
    if (c.note) {
      card.appendChild(
        el("p", { class: "results-winners refund" }, c.note),
      );
    }
    if (!c.payouts.length) {
      card.appendChild(
        el("p", { class: "results-winners pending" }, "Payouts TBD"),
      );
    } else {
      const list = el("ul", { class: "results-payouts" });
      for (const p of c.payouts) {
        list.appendChild(
          el("li", {}, [
            el("span", { class: "role" }, p.role),
            el("span", { class: "name" }, p.displayName),
            el("span", { class: "amount" }, fmtMoney(p.amount)),
          ]),
        );
      }
      card.appendChild(list);
    }
    potsCard.appendChild(card);
  }
  root.appendChild(potsCard);

  // ----- Per-player balance (consolidated by real name) -----
  const rawBalances = buildBalances(contests);
  // Merge entries that map to the same real name so one person with multiple
  // teams shows a single row and a single transfer instead of several.
  const mergedMap = new Map();
  for (const b of rawBalances) {
    const rn = resolvedName(b.display);
    if (mergedMap.has(rn)) {
      mergedMap.get(rn).net += b.net;
    } else {
      mergedMap.set(rn, { display: rn, net: b.net });
    }
  }
  const balances = Array.from(mergedMap.values());
  balances.sort((a, b) => b.net - a.net);

  const balanceCard = el("div", { class: "results-section" });
  balanceCard.appendChild(
    el("h3", { class: "results-section-title" }, "Per-player balance"),
  );
  balanceCard.appendChild(
    el(
      "p",
      { class: "hint" },
      "Total winnings minus entry fees for every contest each person played in.",
    ),
  );
  const bt = el("table", { class: "results-table" });
  bt.appendChild(
    el(
      "thead",
      {},
      el("tr", {}, [
        el("th", {}, "Player"),
        el("th", { class: "num" }, "Net"),
      ]),
    ),
  );
  const bbody = el("tbody");
  for (const p of balances) {
    const cls = p.net > 0.005 ? "credit" : p.net < -0.005 ? "debit" : "";
    const row = el("tr", cls ? { class: cls } : {});
    row.appendChild(el("td", { class: "name" }, p.display));
    row.appendChild(el("td", { class: "num" }, fmtMoneySigned(p.net)));
    bbody.appendChild(row);
  }
  bt.appendChild(bbody);
  balanceCard.appendChild(bt);
  root.appendChild(balanceCard);

  // ----- Name mapping UI (collapsible) -----
  const mapCard = el("div", { class: "results-section" });
  const mapDetails = document.createElement("details");
  const mapSummary = document.createElement("summary");
  mapSummary.className = "results-section-title collapsible-title";
  mapSummary.textContent = "Name mapping";
  mapDetails.appendChild(mapSummary);
  const mapInner = document.createDocumentFragment();
  mapInner.appendChild(
    el(
      "p",
      { class: "hint" },
      "Assign real names to team names. Shared mappings load from data/nameMap.json; local overrides saved in your browser.",
    ),
  );
  const allDisplayNames = rawBalances.map((b) => b.display);
  const currentMap = getNameMap();
  const mapTable = el("table", { class: "results-table name-map-table" });
  mapTable.appendChild(
    el("thead", {}, el("tr", {}, [
      el("th", {}, "Team name"),
      el("th", {}, "Real name"),
    ])),
  );
  const mapBody = el("tbody");
  for (const dn of allDisplayNames) {
    const row = el("tr");
    row.appendChild(el("td", { class: "name" }, dn));
    const sel = document.createElement("select");
    sel.className = "name-map-select";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— select —";
    sel.appendChild(blank);
    for (const rn of REAL_NAMES) {
      const opt = document.createElement("option");
      opt.value = rn;
      opt.textContent = rn;
      if (currentMap[dn] === rn) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("change", () => {
      const m = getNameMap();
      if (sel.value) m[dn] = sel.value; else delete m[dn];
      setNameMap(m);
      // Re-render results to apply the new mapping everywhere
      renderResults(
        window._lastEntriesData, window._lastShowdownData,
        window._lastById, window._lastPlayers, window._lastTournament,
      );
    });
    const td = el("td");
    td.appendChild(sel);
    row.appendChild(td);
    mapBody.appendChild(row);
  }
  mapTable.appendChild(mapBody);
  mapInner.appendChild(mapTable);
  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy mapping JSON";
  copyBtn.className = "btn-copy-map";
  copyBtn.addEventListener("click", () => {
    const full = getNameMap();
    navigator.clipboard.writeText(JSON.stringify(full, null, 2)).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy mapping JSON"; }, 2000);
    });
  });
  mapInner.appendChild(copyBtn);
  mapDetails.appendChild(mapInner);
  mapCard.appendChild(mapDetails);
  root.appendChild(mapCard);

  // ----- Settlement transactions -----
  const txns = settleTransactions(balances);
  const settleCard = el("div", { class: "results-section" });
  settleCard.appendChild(
    el("h3", { class: "results-section-title" }, "Transfers"),
  );
  if (!txns.length) {
    settleCard.appendChild(
      el(
        "p",
        { class: "hint" },
        "Everyone's even — no transfers needed.",
      ),
    );
  } else {
    settleCard.appendChild(
      el(
        "p",
        { class: "hint" },
        `${txns.length} transfer${txns.length === 1 ? "" : "s"} will balance the books.`,
      ),
    );
    const list = el("ul", { class: "results-txns" });
    for (const t of txns) {
      list.appendChild(
        el("li", {}, [
          el("span", { class: "from" }, t.from),
          el("span", { class: "arrow" }, " → "),
          el("span", { class: "to" }, t.to),
          el("span", { class: "amount" }, fmtMoney(t.amount)),
        ]),
      );
    }
    settleCard.appendChild(list);
  }
  root.appendChild(settleCard);
}

let allFieldPlayers = [];
function renderField(players) {
  allFieldPlayers = players.slice();
  // Alphabetize for the picker view
  allFieldPlayers.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  drawFieldList(allFieldPlayers);
}

function drawFieldList(list) {
  const root = document.getElementById("field-list");
  root.innerHTML = "";
  if (!list.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }
  const table = el("table", { class: "field-table" });
  table.appendChild(
    el("thead", {}, [
      el("tr", {}, [
        el("th", {}, "Player"),
        el("th", {}, "Country"),
      ]),
    ]),
  );
  const tbody = el("tbody");
  for (const p of list) {
    const fieldNameCell = el("td", { class: "player" });
    fieldNameCell.appendChild(playerNameLink(p));
    tbody.appendChild(
      el("tr", {}, [fieldNameCell, el("td", {}, p.country || "")]),
    );
  }
  table.appendChild(tbody);
  root.appendChild(table);
}

// ---------- picker (custom selection page) ----------
// Uses native <input type="checkbox"> elements so the browser handles all
// the click/hover/focus state. We track selection in pickerSelected as an
// ordered list of ids — insertion order becomes Pick 1..Pick 6 in the form.
let pickerSelected = [];
let pickerPlayers = [];
let pickerFiltered = [];

function initPicker(players) {
  try {
    if (isPastCutoff()) {
      renderPickerClosed();
      return;
    }

    pickerPlayers = (players || [])
      .slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    pickerFiltered = pickerPlayers;

    const search = document.getElementById("picker-search");
    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        pickerFiltered = q
          ? pickerPlayers.filter(
              (p) =>
                (p.name || "").toLowerCase().includes(q) ||
                (p.country || "").toLowerCase().includes(q),
            )
          : pickerPlayers;
        drawPickerField();
      });
    }

    const submitBtn = document.getElementById("picker-submit");
    if (submitBtn) {
      submitBtn.addEventListener("click", handlePickerSubmit);
    }

    drawPickerField();
    updatePickerCount();
    renderDeadlineNote();
  } catch (e) {
    console.error("initPicker failed:", e);
    const root = document.getElementById("picker-field");
    if (root) {
      root.innerHTML =
        '<div class="empty">Picker failed to load: ' +
        (e && e.message ? e.message : "unknown error") +
        ". Use the fallback Google Form link below.</div>";
    }
  }
}

function renderPickerClosed() {
  const panel = document.getElementById("tab-pick");
  if (!panel) return;
  // Replace the entire picker UI with a "submissions closed" card so there's
  // no way to confuse the visitor into thinking the form might still accept
  // their entry.
  panel.innerHTML = "";
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el("h2", { class: "picker-closed-title" }, "Submissions are closed"),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      `The deadline was ${formatCutoffLocal()}. New picks won't be counted.`,
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      "Head over to the Pool standings tab to see how everyone is doing.",
    ),
  );
  panel.appendChild(card);
}

function renderDeadlineNote() {
  // Add a small "deadline: ..." note above the green picks bar so visitors
  // know how much time they have left.
  const bar = document.getElementById("picker-count");
  if (!bar) return;
  let note = document.getElementById("picker-deadline-note");
  if (!note) {
    note = el("p", { id: "picker-deadline-note", class: "picker-deadline" });
    const barContainer = bar.closest(".picker-bar");
    if (barContainer && barContainer.parentNode) {
      barContainer.parentNode.insertBefore(note, barContainer);
    }
  }
  note.textContent = `Deadline: ${formatCutoffLocal()}`;
}

function drawPickerField() {
  const root = document.getElementById("picker-field");
  if (!root) return;
  root.innerHTML = "";

  if (!pickerPlayers.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "Field hasn't loaded yet. Try refreshing in a minute.",
      ),
    );
    return;
  }

  if (!pickerFiltered.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }

  const atMax = pickerSelected.length >= PICKS_REQUIRED;

  for (const p of pickerFiltered) {
    const id = String(p.id);
    const isChecked = pickerSelected.includes(id);

    const label = document.createElement("label");
    label.className = "picker-row" + (isChecked ? " checked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "picker-checkbox";
    cb.value = id;
    cb.checked = isChecked;
    cb.disabled = atMax && !isChecked;
    cb.addEventListener("change", function () {
      handleCheckboxChange(id, cb);
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "picker-row-name";
    nameSpan.textContent = p.name || "—";

    label.appendChild(cb);
    const pickerAvatar = playerAvatar(p.id);
    if (pickerAvatar) label.appendChild(pickerAvatar);
    label.appendChild(nameSpan);

    if (p.country) {
      const countrySpan = document.createElement("span");
      countrySpan.className = "picker-row-country";
      countrySpan.textContent = p.country;
      label.appendChild(countrySpan);
    }

    root.appendChild(label);
  }
}

function handleCheckboxChange(id, cb) {
  if (cb.checked) {
    if (pickerSelected.length >= PICKS_REQUIRED) {
      cb.checked = false;
      flashPickerStatus(
        `You've already picked ${PICKS_REQUIRED}. Uncheck one before adding another.`,
        "error",
      );
      return;
    }
    pickerSelected.push(id);
  } else {
    const idx = pickerSelected.indexOf(id);
    if (idx >= 0) pickerSelected.splice(idx, 1);
  }
  updatePickerCount();
  // Redraw so other checkboxes pick up the right disabled state when we
  // cross the cap in either direction.
  drawPickerField();
}

function updatePickerCount() {
  const counter = document.getElementById("picker-count");
  if (counter) {
    counter.textContent = `${pickerSelected.length} / ${PICKS_REQUIRED} picked`;
  }
}

let pickerStatusTimer = null;
function flashPickerStatus(msg, kind) {
  const status = document.getElementById("picker-status");
  if (!status) return;
  status.textContent = msg;
  status.className = "picker-status visible " + (kind || "info");
  if (pickerStatusTimer) clearTimeout(pickerStatusTimer);
  pickerStatusTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 4500);
}

function handlePickerSubmit() {
  if (isPastCutoff()) {
    flashPickerStatus(
      `Submissions closed at ${formatCutoffLocal()}.`,
      "error",
    );
    return;
  }

  const nameEl = document.getElementById("picker-name");
  const name = (nameEl && nameEl.value.trim()) || "";

  if (!name) {
    flashPickerStatus("Enter a display name first.", "error");
    if (nameEl) nameEl.focus();
    return;
  }
  if (pickerSelected.length !== PICKS_REQUIRED) {
    flashPickerStatus(
      `Pick exactly ${PICKS_REQUIRED} golfers — you have ${pickerSelected.length}.`,
      "error",
    );
    return;
  }

  const byId = new Map(pickerPlayers.map((p) => [String(p.id), p]));
  const params = new URLSearchParams();
  params.set("usp", "pp_url");
  params.set(FORM_PREFILL.displayName, name);
  pickerSelected.forEach((id, i) => {
    const p = byId.get(id);
    params.set(FORM_PREFILL.picks[i], (p && p.name) || id);
  });

  const url = `${FORM_PREFILL.base}?${params.toString()}`;
  window.open(url, "_blank", "noopener");
  flashPickerStatus(
    "Form opened in a new tab — click Submit on the form to finalize.",
    "success",
  );
}

// ---------- showdown picker ----------
// Independent state from the main picker so the two pickers don't fight over
// each other's selections. Picker is a one-time DOM build (initShowdownPicker
// is called once in main); the standings/explainer block above it is the
// only thing that re-renders on data refresh.

let showdownPick3Selected = []; // ordered list of golfer ids (max 3)
let showdownChampionId = null;
let showdownBoomHolesId = null;
let showdownPlayers = []; // cut survivors, sorted by leaderboard position
let showdownFiltered = [];
let showdownStatusTimer = null;

function initShowdownPicker(players) {
  const root = document.getElementById("showdown-picker");
  if (!root) return;
  root.innerHTML = "";

  // Show the rules card at top of every state (closed / not-configured /
  // active picker) so anyone landing on this tab can read the rules without
  // having to bounce over to the standings tab. The same explainer is also
  // rendered on the standings tab — duplication is intentional.
  root.appendChild(renderShowdownExplainer());

  if (isShowdownPastCutoff()) {
    root.appendChild(renderShowdownPickerClosed());
    return;
  }
  if (!isShowdownConfigured()) {
    root.appendChild(renderShowdownPickerNotConfigured());
    return;
  }

  // Cut survivors only, sorted by leaderboard position (lowest scoreToPar
  // first). This is intentionally different from the main picker, which
  // alphabetizes — here, the leaders are at the top so they're easy to find.
  showdownPlayers = (players || [])
    .filter(
      (p) =>
        p.status !== "cut" &&
        p.status !== "wd" &&
        p.status !== "dq" &&
        p.status !== "dns",
    )
    .slice()
    .sort((a, b) => {
      const sa = a.scoreToPar == null ? 999 : a.scoreToPar;
      const sb = b.scoreToPar == null ? 999 : b.scoreToPar;
      if (sa !== sb) return sa - sb;
      return (a.name || "").localeCompare(b.name || "");
    });
  showdownFiltered = showdownPlayers;

  if (!showdownPlayers.length) {
    root.appendChild(
      el(
        "div",
        { class: "empty" },
        "No cut-survivors in the field yet. The showdown picker opens after the Friday cut.",
      ),
    );
    return;
  }

  buildShowdownPickerDOM(root);
}

function renderShowdownPickerClosed() {
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el(
      "h2",
      { class: "picker-closed-title" },
      "Showdown submissions are closed",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      `The deadline was ${formatShowdownCutoffLocal()}. New picks won't count.`,
    ),
  );
  return card;
}

function renderShowdownPickerNotConfigured() {
  const card = el("div", { class: "picker-closed" });
  card.appendChild(
    el(
      "h2",
      { class: "picker-closed-title" },
      "Showdown form not yet configured",
    ),
  );
  card.appendChild(
    el(
      "p",
      { class: "picker-closed-body" },
      "The Sunday Showdown picker will appear here once the secondary " +
        "Google Form has been created and SHOWDOWN_FORM_PREFILL is filled " +
        "in inside assets/app.js. See the README for setup steps.",
    ),
  );
  return card;
}

function buildShowdownPickerDOM(root) {
  // Header card
  const header = el("div", { class: "showdown-picker-header" });
  header.appendChild(el("h2", {}, "Make your Sunday Showdown picks"));
  header.appendChild(
    el(
      "p",
      { class: "hint" },
      `Three contests on one form. Deadline: ${formatShowdownCutoffLocal()}.`,
    ),
  );
  root.appendChild(header);

  // Display name
  const nameWrap = el("div", { class: "picker-form" });
  nameWrap.appendChild(
    el(
      "label",
      { class: "picker-label", for: "showdown-name" },
      "Your display name",
    ),
  );
  const nameInput = document.createElement("input");
  nameInput.id = "showdown-name";
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Pat M.";
  nameInput.autocomplete = "off";
  nameInput.maxLength = 40;
  nameWrap.appendChild(nameInput);
  root.appendChild(nameWrap);

  // ===== PICK 3 section =====
  const pick3Section = el("section", { class: "showdown-picker-section" });
  pick3Section.appendChild(
    el("h3", {}, `Pick 3 — choose ${PICK3_REQUIRED} golfers`),
  );
  pick3Section.appendChild(
    el(
      "p",
      { class: "hint" },
      "Sum of all 3 R4 to-pars. No drops. Lowest wins.",
    ),
  );

  const pickerBar = el("div", { class: "picker-bar" });
  const counter = el(
    "span",
    { id: "showdown-pick3-count", class: "picker-count" },
    `0 / ${PICK3_REQUIRED} picked`,
  );
  pickerBar.appendChild(counter);
  pick3Section.appendChild(pickerBar);

  const search = document.createElement("input");
  search.id = "showdown-pick3-search";
  search.type = "search";
  search.placeholder = "Search the field…";
  search.autocomplete = "off";
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    showdownFiltered = q
      ? showdownPlayers.filter(
          (p) =>
            (p.name || "").toLowerCase().includes(q) ||
            (p.country || "").toLowerCase().includes(q),
        )
      : showdownPlayers;
    drawShowdownPick3Field();
  });
  pick3Section.appendChild(search);

  const grid = el("div", {
    id: "showdown-pick3-field",
    class: "picker-field",
  });
  pick3Section.appendChild(grid);
  root.appendChild(pick3Section);

  // ===== CHAMPION CALL section =====
  const champSection = el("section", { class: "showdown-picker-section" });
  champSection.appendChild(el("h3", {}, "Champion Call"));
  champSection.appendChild(
    el(
      "p",
      { class: "hint" },
      "Pick the outright winner + a winning to-par guess.",
    ),
  );

  const champLabel = el(
    "label",
    { class: "picker-label", for: "showdown-champion" },
    "Champion",
  );
  champSection.appendChild(champLabel);
  const champSelect = document.createElement("select");
  champSelect.id = "showdown-champion";
  champSelect.className = "showdown-select";
  populateGolferSelect(champSelect, "(choose a golfer)");
  champSelect.addEventListener("change", () => {
    showdownChampionId = champSelect.value || null;
  });
  champSection.appendChild(champSelect);

  const guessLabel = el(
    "label",
    { class: "picker-label", for: "showdown-guess" },
    "Predicted winning to-par (e.g. -12)",
  );
  champSection.appendChild(guessLabel);
  const guessInput = document.createElement("input");
  guessInput.id = "showdown-guess";
  guessInput.type = "number";
  guessInput.step = "1";
  guessInput.min = "-30";
  guessInput.max = "20";
  guessInput.placeholder = "-10";
  guessInput.className = "showdown-number";
  champSection.appendChild(guessInput);
  root.appendChild(champSection);

  // ===== BOOM HOLES section =====
  const boomSection = el("section", { class: "showdown-picker-section" });
  boomSection.appendChild(el("h3", {}, "Boom Holes"));
  boomSection.appendChild(
    el(
      "p",
      { class: "hint" },
      `One golfer, sum of strokes-to-par on holes ${BOOM_HOLES.join(", ")}. Lowest wins.`,
    ),
  );

  const boomLabel = el(
    "label",
    { class: "picker-label", for: "showdown-boom" },
    "Boom Holes pick",
  );
  boomSection.appendChild(boomLabel);
  const boomSelect = document.createElement("select");
  boomSelect.id = "showdown-boom";
  boomSelect.className = "showdown-select";
  populateGolferSelect(boomSelect, "(choose a golfer)");
  boomSelect.addEventListener("change", () => {
    showdownBoomHolesId = boomSelect.value || null;
  });
  boomSection.appendChild(boomSelect);
  root.appendChild(boomSection);

  // Submit + status
  const submitBar = el("div", { class: "picker-bar" });
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "picker-submit";
  submitBtn.textContent = "Submit showdown picks";
  submitBtn.addEventListener("click", handleShowdownSubmit);
  submitBar.appendChild(submitBtn);
  root.appendChild(submitBar);

  const status = el(
    "p",
    { id: "showdown-status", class: "picker-status" },
    "",
  );
  root.appendChild(status);

  drawShowdownPick3Field();
}

function populateGolferSelect(select, placeholder) {
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = placeholder;
  select.appendChild(blank);
  for (const p of showdownPlayers) {
    const opt = document.createElement("option");
    opt.value = String(p.id);
    const score = p.scoreToPar != null ? ` (${fmtToPar(p.scoreToPar)})` : "";
    opt.textContent = `${p.name}${score}`;
    select.appendChild(opt);
  }
}

function drawShowdownPick3Field() {
  const root = document.getElementById("showdown-pick3-field");
  if (!root) return;
  root.innerHTML = "";

  if (!showdownFiltered.length) {
    root.appendChild(
      el("div", { class: "empty" }, "No players match that search."),
    );
    return;
  }

  const atMax = showdownPick3Selected.length >= PICK3_REQUIRED;
  for (const p of showdownFiltered) {
    const id = String(p.id);
    const isChecked = showdownPick3Selected.includes(id);
    const label = document.createElement("label");
    label.className = "picker-row" + (isChecked ? " checked" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "picker-checkbox";
    cb.value = id;
    cb.checked = isChecked;
    cb.disabled = atMax && !isChecked;
    cb.addEventListener("change", () => handleShowdownCheckbox(id, cb));

    const nameSpan = document.createElement("span");
    nameSpan.className = "picker-row-name";
    nameSpan.textContent = p.name || "—";

    label.appendChild(cb);
    const av = playerAvatar(p.id);
    if (av) label.appendChild(av);
    label.appendChild(nameSpan);

    if (p.scoreToPar != null) {
      const scoreSpan = document.createElement("span");
      scoreSpan.className = "picker-row-country";
      scoreSpan.textContent = fmtToPar(p.scoreToPar);
      label.appendChild(scoreSpan);
    }
    root.appendChild(label);
  }
}

function handleShowdownCheckbox(id, cb) {
  if (cb.checked) {
    if (showdownPick3Selected.length >= PICK3_REQUIRED) {
      cb.checked = false;
      flashShowdownStatus(
        `You've already picked ${PICK3_REQUIRED}. Uncheck one before adding another.`,
        "error",
      );
      return;
    }
    showdownPick3Selected.push(id);
  } else {
    const idx = showdownPick3Selected.indexOf(id);
    if (idx >= 0) showdownPick3Selected.splice(idx, 1);
  }
  updateShowdownCount();
  drawShowdownPick3Field();
}

function updateShowdownCount() {
  const counter = document.getElementById("showdown-pick3-count");
  if (counter) {
    counter.textContent = `${showdownPick3Selected.length} / ${PICK3_REQUIRED} picked`;
  }
}

function flashShowdownStatus(msg, kind) {
  const status = document.getElementById("showdown-status");
  if (!status) return;
  status.textContent = msg;
  status.className = "picker-status visible " + (kind || "info");
  if (showdownStatusTimer) clearTimeout(showdownStatusTimer);
  showdownStatusTimer = setTimeout(() => {
    status.classList.remove("visible");
  }, 5000);
}

function handleShowdownSubmit() {
  if (isShowdownPastCutoff()) {
    flashShowdownStatus(
      `Submissions closed at ${formatShowdownCutoffLocal()}.`,
      "error",
    );
    return;
  }

  const nameEl = document.getElementById("showdown-name");
  const name = (nameEl && nameEl.value.trim()) || "";
  const guessEl = document.getElementById("showdown-guess");
  const guess = (guessEl && guessEl.value.trim()) || "";

  if (!name) {
    flashShowdownStatus("Enter a display name first.", "error");
    if (nameEl) nameEl.focus();
    return;
  }
  if (showdownPick3Selected.length !== PICK3_REQUIRED) {
    flashShowdownStatus(
      `Pick exactly ${PICK3_REQUIRED} golfers — you have ${showdownPick3Selected.length}.`,
      "error",
    );
    return;
  }
  if (!showdownChampionId) {
    flashShowdownStatus("Pick your Champion Call winner.", "error");
    return;
  }
  if (!guess) {
    flashShowdownStatus(
      "Enter a winning to-par guess for Champion Call.",
      "error",
    );
    if (guessEl) guessEl.focus();
    return;
  }
  if (!showdownBoomHolesId) {
    flashShowdownStatus("Pick your Boom Holes golfer.", "error");
    return;
  }

  const byId = new Map(showdownPlayers.map((p) => [String(p.id), p]));
  const params = new URLSearchParams();
  params.set("usp", "pp_url");
  params.set(SHOWDOWN_FORM_PREFILL.displayName, name);
  showdownPick3Selected.forEach((id, i) => {
    const p = byId.get(id);
    params.set(SHOWDOWN_FORM_PREFILL.pick3[i], (p && p.name) || id);
  });
  const champPlayer = byId.get(showdownChampionId);
  params.set(
    SHOWDOWN_FORM_PREFILL.champion,
    (champPlayer && champPlayer.name) || showdownChampionId,
  );
  params.set(SHOWDOWN_FORM_PREFILL.championGuess, guess);
  const boomPlayer = byId.get(showdownBoomHolesId);
  params.set(
    SHOWDOWN_FORM_PREFILL.boomHoles,
    (boomPlayer && boomPlayer.name) || showdownBoomHolesId,
  );

  const url = `${SHOWDOWN_FORM_PREFILL.base}?${params.toString()}`;
  window.open(url, "_blank", "noopener");
  flashShowdownStatus(
    "Form opened in a new tab — click Submit on the form to finalize.",
    "success",
  );
}

// ---------- tabs + setup ----------
// localStorage key for the active tab. Persisted across page reloads (and
// browser restarts) so the auto-refresh — and any manual refresh — keeps
// the user on whichever tab they were last looking at instead of dumping
// them back on Pool standings every 30 seconds.
const ACTIVE_TAB_STORAGE_KEY = "pga-pool:active-tab";

function saveActiveTab(tabId) {
  try {
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabId);
  } catch (e) {
    // localStorage may be unavailable (private browsing, disabled, etc.).
    // Ignore — falling back to the HTML default tab is fine.
  }
}

function loadActiveTab() {
  try {
    return localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

function wireTabs() {
  // Time-gated tab visibility:
  //   - "Make picks" hides once past the main pool submission cutoff.
  //   - The two showdown tabs ("Sunday Showdown" standings + "Make Showdown
  //     picks") stay hidden until SHOWDOWN_OPEN (Sat 22:00 UTC, after R3
  //     wraps), so the main-pool entry flow isn't cluttered earlier in the
  //     week.
  //   - "Make Showdown picks" hides again once the showdown cutoff passes.
  const pickTab = document.querySelector('.tab[data-tab="pick"]');
  if (pickTab) pickTab.hidden = isPastCutoff();

  const showdownTab = document.querySelector('.tab[data-tab="showdown"]');
  if (showdownTab) showdownTab.hidden = !isShowdownWindowOpen();

  const showdownPickTab = document.querySelector(
    '.tab[data-tab="showdown-pick"]',
  );
  if (showdownPickTab) {
    showdownPickTab.hidden = !isShowdownWindowOpen() || isShowdownPastCutoff();
  }

  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");
  tabs.forEach((tab) =>
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
      saveActiveTab(tab.dataset.tab);
    }),
  );
  document.querySelectorAll("[data-jump]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = a.getAttribute("data-jump");
      document.querySelector(`.tab[data-tab="${target}"]`).click();
    }),
  );

  // Restore the saved tab from localStorage if there is one. Skip if the
  // saved tab no longer exists (e.g. removed in a code update) or has been
  // hidden — falling back to the HTML default in either case.
  const saved = loadActiveTab();
  if (saved) {
    const savedTab = document.querySelector(`.tab[data-tab="${saved}"]`);
    if (savedTab && !savedTab.hidden) {
      savedTab.click();
    }
  }
}

// Auto-refresh: full page reload every 30s, but ONLY on tabs where there's
// no in-flight picker state to lose. Picker tabs (Make picks, Sunday
// Showdown) hold unsaved selections in JS globals — reloading mid-pick
// would nuke them and frustrate the boys.
//
// Picker tabs become safe to refresh once their submission cutoff passes
// (the picker UI gets replaced with a "submissions closed" card and the
// only thing on the tab is read-only data).
//
// Implemented as setInterval rather than meta http-equiv so the active-tab
// check happens at fire time, not schedule time. Worst case: user switches
// to a safe tab right before a tick, sees a refresh shortly after — fine.
function isTabSafeToRefresh(tabId) {
  // Never refresh while a scorecard modal is open — the user is reading it.
  if (document.body.classList.contains("scorecard-open")) return false;

  // Read-only tabs (no picker state) are always safe. The "showdown" tab
  // is in this list because the picker was split into its own tab below;
  // the showdown tab itself only contains standings + entrant list now.
  if (
    tabId === "pool" ||
    tabId === "showdown" ||
    tabId === "leaderboard" ||
    tabId === "field" ||
    tabId === "rules" ||
    tabId === "results"
  ) {
    return true;
  }
  // Picker tabs are only safe once their cutoff has passed (at which point
  // the picker UI is replaced by a "submissions closed" card).
  if (tabId === "pick") return isPastCutoff();
  if (tabId === "showdown-pick") return isShowdownPastCutoff();
  return false;
}

function startAutoRefresh() {
  setInterval(() => {
    const activeTab = document.querySelector(".tab.active");
    if (activeTab && isTabSafeToRefresh(activeTab.dataset.tab)) {
      location.reload();
    }
  }, 30000);
}

function wireRepoLinks() {
  // Detect repo from the current GitHub Pages URL so the footer link works
  // wherever this site is deployed.
  const host = location.hostname;
  const path = location.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const repo = path[0] || `${owner}.github.io`;
    document.getElementById("repo-link").href =
      `https://github.com/${owner}/${repo}`;
  } else {
    document.getElementById("repo-link").href = "https://github.com";
  }
}

function wireFieldSearch() {
  const input = document.getElementById("field-search");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) return drawFieldList(allFieldPlayers);
    drawFieldList(
      allFieldPlayers.filter(
        (p) =>
          (p.name || "").toLowerCase().includes(q) ||
          (p.country || "").toLowerCase().includes(q),
      ),
    );
  });
}

async function main() {
  wireTabs();
  wireRepoLinks();
  wireFieldSearch();
  startAutoRefresh();

  let scores, entriesData, showdownData;
  try {
    [scores, entriesData, showdownData] = await Promise.all([
      loadJson("data/scores.json"),
      loadJson("data/entries.json").catch(() => ({ entries: [] })),
      loadJson("data/showdown.json").catch(() => ({ entries: [], rejected: [] })),
      loadSharedNameMap(),
    ]);
  } catch (e) {
    const err = document.getElementById("error");
    err.textContent =
      e.message + " — the workflow may not have run yet. Try again shortly.";
    err.hidden = false;
    return;
  }

  const players = scores.players || [];
  const byId = new Map(players.map((p) => [String(p.id), p]));
  currentEventId = (scores.tournament && scores.tournament.id) || currentEventId;

  renderHeader(scores.tournament);
  renderPoolStandings(entriesData.entries || [], byId);
  renderRejected(entriesData.rejected || []);
  renderLeaderboard(players);
  renderField(players);
  initPicker(players);
  renderShowdown(showdownData, players, byId, scores.tournament);
  initShowdownPicker(players);
  renderResults(entriesData, showdownData, byId, players, scores.tournament);
}

main();
