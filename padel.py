#!/usr/bin/env python3
"""Padel Wednesday pairing tool.

Make a schedule:
    python padel.py players.csv [--courts 7] [--start 14:00] [--end 16:00]
                                [--block 15] [--min-minutes 60] [--seed N]
                                [--out schedule.txt]

Patch a schedule when people drop out:
    python padel.py drop schedule.json "Sam Lee" ["Other Name" ...] [--from 14:45]

See README.md for details.
"""

import argparse
import csv
import difflib
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

# Cost weights used when building games. Higher = the script tries harder to avoid it.
W_TEAM = 4.0     # x (difference in average team skill)^2
W_SPREAD = 1.5   # x (best player - worst player in the game)^2
W_OPP = 1.5      # per previous time two players faced each other today
W_PART = 6.0     # per previous time two singles partnered each other today

DROP_EXTRA_GAME = 0.6  # dropout subs: penalty per game a sub has above the least-played candidate

CANDIDATES_PER_BLOCK = 4  # different "who plays" draws tried per block; best kept
RESTARTS = 2               # optimiser restarts per draw
MAX_ATTEMPTS = 20          # whole-schedule retries if the play-time check ever fails


class PadelError(Exception):
    """A problem the organiser needs to fix (bad CSV, too many players...)."""


# --------------------------------------------------------------------------- input

def _clean(s):
    return " ".join((s or "").split())


def _suggest(name, options):
    close = difflib.get_close_matches(name, options, n=1, cutoff=0.6)
    return f" Did you mean '{close[0]}'?" if close else ""


def load_players(path):
    """Read players.csv -> {name: {"skill": int, "partner": name or None}}."""
    try:
        f = open(path, newline="", encoding="utf-8-sig")
    except OSError as e:
        raise PadelError(f"Can't open {path}: {e.strerror}")
    with f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise PadelError(f"{path} is empty")
        cols = {h.strip().lower(): h for h in reader.fieldnames if h}
        for need in ("name", "skill"):
            if need not in cols:
                raise PadelError(f"{path} needs a '{need}' column "
                                 f"(found: {', '.join(reader.fieldnames)})")
        rows = []
        for line, row in enumerate(reader, start=2):
            name = _clean(row.get(cols["name"]))
            if not name:
                continue
            raw = (row.get(cols["skill"]) or "").strip()
            try:
                skill = int(raw)
            except ValueError:
                raise PadelError(f"Line {line}: skill for {name} should be a whole number 1-5, got '{raw}'")
            if not 1 <= skill <= 5:
                raise PadelError(f"Line {line}: skill for {name} should be 1-5, got {skill}")
            partner = _clean(row.get(cols["partner"])) if "partner" in cols else ""
            rows.append((line, name, skill, partner))

    players, by_lower = {}, {}
    for line, name, skill, _ in rows:
        if name.lower() in by_lower:
            raise PadelError(f"Line {line}: {name} is listed twice")
        by_lower[name.lower()] = name
        players[name] = {"skill": skill, "partner": None}

    partner_of = {}
    for line, name, _, partner in rows:
        if not partner:
            continue
        p = by_lower.get(partner.lower())
        if p is None:
            raise PadelError(f"Line {line}: {name}'s partner '{partner}' isn't in the list."
                             + _suggest(partner, list(players)))
        if p == name:
            raise PadelError(f"Line {line}: {name} is listed as their own partner")
        for a, b in ((name, p), (p, name)):
            if partner_of.get(a, b) != b:
                raise PadelError(f"{a} is paired with both {partner_of[a]} and {b}. "
                                 "Fix the partner column so everyone has at most one partner.")
        partner_of[name], partner_of[p] = p, name
    for name, p in partner_of.items():
        players[name]["partner"] = p
    return players


def parse_time(s):
    try:
        h, m = s.strip().split(":")
        h, m = int(h), int(m)
        if not (0 <= h < 24 and 0 <= m < 60):
            raise ValueError
        return h * 60 + m
    except ValueError:
        raise PadelError(f"'{s}' isn't a valid time, use HH:MM like 14:00")


def block_times(start, end, block):
    s, e = parse_time(start), parse_time(end)
    if block <= 0:
        raise PadelError("Block length must be positive")
    times, t = [], s
    while t + block <= e:
        times.append(f"{t // 60:02d}:{t % 60:02d}")
        t += block
    if not times:
        raise PadelError(f"No {block}-minute blocks fit between {start} and {end}")
    return times


# --------------------------------------------------------------------------- scheduling

def _key(a, b):
    return (a, b) if a < b else (b, a)


class _History:
    def __init__(self, names):
        self.games = {n: 0 for n in names}
        self.streak = {n: 0 for n in names}   # consecutive blocks sat out
        self.opp = defaultdict(int)
        self.part = defaultdict(int)


def _select(units, hist, slots, blocks_left, min_blocks, rng):
    """Choose which pairs/singles play this block, filling exactly `slots` places."""
    max_games = max(hist.games.values())

    def score(name):
        g = hist.games[name]
        need = min_blocks - g
        must = need > 0 and need >= blocks_left
        return (must * 10000 + (max_games - g) * 100
                + (hist.streak[name] >= 2) * 10 + rng.random())

    pairs = sorted(((2 * score(u[0]), u) for u in units if len(u) == 2), reverse=True)
    singles = sorted(((score(u[0]), u) for u in units if len(u) == 1), reverse=True)

    # Prefix sums so we can try every split of pairs vs singles quickly.
    pv, sv = [0.0], [0.0]
    for v, _ in pairs:
        pv.append(pv[-1] + v)
    for v, _ in singles:
        sv.append(sv[-1] + v)
    best_k, best_val = None, None
    for k in range(min(len(pairs), slots // 2) + 1):
        s = slots - 2 * k
        if s > len(singles):
            continue
        val = pv[k] + sv[s]
        if best_val is None or val > best_val:
            best_k, best_val = k, val
    s = slots - 2 * best_k
    return [u for _, u in pairs[:best_k]], [u[0] for _, u in singles[:s]]


def _optimise(fixed_pairs, singles, skill, hist, rng):
    """Turn the chosen players into games. Returns (cost, [(teamA, teamB), ...])."""
    opp, part = hist.opp, hist.part
    best = None
    for _ in range(RESTARTS):
        ss = sorted(singles, key=lambda n: skill[n] + rng.random() * 0.9)
        teams = [list(p) for p in fixed_pairs] + [[ss[i], ss[i + 1]] for i in range(0, len(ss), 2)]
        fixed = [True] * len(fixed_pairs) + [False] * (len(ss) // 2)
        order = sorted(range(len(teams)),
                       key=lambda i: (skill[teams[i][0]] + skill[teams[i][1]]) / 2 + rng.random() * 0.9)
        games = [[order[i], order[i + 1]] for i in range(0, len(order), 2)]
        team_game = {}
        for g, (a, b) in enumerate(games):
            team_game[a] = team_game[b] = g

        def game_cost(g):
            ta, tb = teams[games[g][0]], teams[games[g][1]]
            s = [skill[ta[0]], skill[ta[1]], skill[tb[0]], skill[tb[1]]]
            c = W_TEAM * ((s[0] + s[1] - s[2] - s[3]) / 2) ** 2 + W_SPREAD * (max(s) - min(s)) ** 2
            for x in ta:
                for y in tb:
                    c += W_OPP * opp[_key(x, y)]
            for ti in games[g]:
                if not fixed[ti]:
                    c += W_PART * part[_key(*teams[ti])]
            return c

        gc = [game_cost(g) for g in range(len(games))]
        positions = [(ti, k) for ti in range(len(teams)) if not fixed[ti] for k in (0, 1)]

        improved, passes = True, 0
        while improved and passes < 30:
            improved, passes = False, passes + 1
            # Move 1: swap two singles between different teams.
            for i in range(len(positions)):
                ti, ki = positions[i]
                for j in range(i + 1, len(positions)):
                    tj, kj = positions[j]
                    if ti == tj:
                        continue
                    gi, gj = team_game[ti], team_game[tj]
                    old = gc[gi] + (gc[gj] if gj != gi else 0)
                    teams[ti][ki], teams[tj][kj] = teams[tj][kj], teams[ti][ki]
                    ni = game_cost(gi)
                    nj = game_cost(gj) if gj != gi else 0
                    if ni + nj < old - 1e-9:
                        gc[gi] = ni
                        if gj != gi:
                            gc[gj] = nj
                        improved = True
                    else:
                        teams[ti][ki], teams[tj][kj] = teams[tj][kj], teams[ti][ki]
            # Move 2: swap two teams between different games.
            for ti in range(len(teams)):
                for tj in range(ti + 1, len(teams)):
                    gi, gj = team_game[ti], team_game[tj]
                    if gi == gj:
                        continue
                    pi, pj = games[gi].index(ti), games[gj].index(tj)
                    old = gc[gi] + gc[gj]
                    games[gi][pi], games[gj][pj] = tj, ti
                    ni, nj = game_cost(gi), game_cost(gj)
                    if ni + nj < old - 1e-9:
                        gc[gi], gc[gj] = ni, nj
                        team_game[ti], team_game[tj] = gj, gi
                        improved = True
                    else:
                        games[gi][pi], games[gj][pj] = ti, tj

        total = sum(gc)
        if best is None or total < best[0]:
            result = [(list(teams[a]), list(teams[b]), fixed[a], fixed[b]) for a, b in games]
            best = (total, result)
    return best


def _capacity_check(n_players, courts, n_blocks, min_blocks, min_minutes):
    if n_players < 4:
        raise PadelError(f"Need at least 4 players, got {n_players}")
    used = min(courts, n_players // 4)
    slots = n_blocks * used * 4
    need = n_players * min_blocks
    if need > slots:
        max_players = (n_blocks * courts * 4) // min_blocks
        extra = n_players - max_players
        raise PadelError(
            f"{n_players} players need {need} playing slots for everyone to get "
            f"{min_minutes} minutes, but {courts} courts x {n_blocks} blocks only gives {slots}. "
            f"Remove {extra} player{'s' if extra != 1 else ''} (max {max_players}) or add a court.")
    return used


def _generate_once(players, courts_used, times, min_blocks, rng):
    names = list(players)
    skill = {n: players[n]["skill"] for n in names}
    units, seen = [], set()
    for n in names:
        if n in seen:
            continue
        p = players[n]["partner"]
        units.append((n, p) if p else (n,))
        seen.update(units[-1])

    hist = _History(names)
    blocks = []
    for b, t in enumerate(times):
        best = None
        for _ in range(CANDIDATES_PER_BLOCK):
            pairs, singles = _select(units, hist, courts_used * 4, len(times) - b, min_blocks, rng)
            cost, games = _optimise(pairs, singles, skill, hist, rng)
            if best is None or cost < best[0]:
                best = (cost, games)
        games = sorted(best[1], key=lambda g: -sum(skill[x] for x in g[0] + g[1]))
        playing = set()
        out_games = []
        for court, (ta, tb, fa, fb) in enumerate(games, start=1):
            out_games.append({"court": court, "teams": [ta, tb]})
            for x in ta:
                for y in tb:
                    hist.opp[_key(x, y)] += 1
            for team, is_fixed in ((ta, fa), (tb, fb)):
                if not is_fixed:
                    hist.part[_key(*team)] += 1
            playing.update(ta + tb)
        for n in names:
            if n in playing:
                hist.games[n] += 1
                hist.streak[n] = 0
            else:
                hist.streak[n] += 1
        sitting = sorted((n for n in names if n not in playing), key=str.lower)
        blocks.append({"time": t, "games": out_games, "sitting_out": sitting})
    return blocks, hist


def generate(players, courts=7, start="14:00", end="16:00", block=15, min_minutes=60, seed=None):
    """Build a full session schedule. Returns the schedule dict (JSON-serialisable)."""
    times = block_times(start, end, block)
    min_blocks = math.ceil(min_minutes / block)
    if min_blocks > len(times):
        raise PadelError(f"Can't guarantee {min_minutes} minutes in a {len(times) * block}-minute session")
    used = _capacity_check(len(players), courts, len(times), min_blocks, min_minutes)
    if seed is None:
        seed = random.randrange(1, 1_000_000)
    for attempt in range(MAX_ATTEMPTS):
        blocks, hist = _generate_once(players, used, times, min_blocks, random.Random(seed + attempt))
        if min(hist.games.values()) >= min_blocks:
            break
    else:
        raise PadelError(f"Couldn't find a schedule giving everyone {min_minutes} minutes "
                         f"after {MAX_ATTEMPTS} tries. Try a different --seed.")
    return {
        "settings": {"courts": courts, "courts_used": used, "start": start, "end": end,
                     "block": block, "min_minutes": min_minutes, "min_blocks": min_blocks,
                     "seed": seed + attempt},
        "players": {n: dict(players[n]) for n in players},
        "blocks": blocks,
    }


# --------------------------------------------------------------------------- dropouts

def _times(schedule):
    return [b["time"] for b in schedule["blocks"]]


def _dropped_by(players, times, name, b):
    d = players[name].get("dropped_from")
    return d is not None and times.index(d) <= b


def _game_players(game):
    return [x for t in game["teams"] for x in t if x]


def games_played(schedule):
    counts = {n: 0 for n in schedule["players"]}
    for blk in schedule["blocks"]:
        for g in blk["games"]:
            for x in _game_players(g):
                counts[x] += 1
    return counts


def _meetings(schedule):
    m = defaultdict(int)
    for blk in schedule["blocks"]:
        for g in blk["games"]:
            ps = _game_players(g)
            for i in range(len(ps)):
                for j in range(i + 1, len(ps)):
                    m[_key(ps[i], ps[j])] += 1
    return m


def resolve_name(schedule, name):
    players = schedule["players"]
    lookup = {n.lower(): n for n in players}
    hit = lookup.get(_clean(name).lower())
    if hit is None:
        raise PadelError(f"'{name}' isn't in this schedule." + _suggest(name, list(players)))
    return hit


def drop_players(schedule, names, from_time=None, seed=None):
    """Replace dropouts with people sitting out. Edits schedule in place.

    Returns a list of changes: (time, court, out_name, in_name_or_None).
    """
    players, blocks = schedule["players"], schedule["blocks"]
    times = _times(schedule)
    if from_time is None:
        f = 0
    else:
        ft = f"{parse_time(from_time) // 60:02d}:{parse_time(from_time) % 60:02d}"
        if ft not in times:
            raise PadelError(f"{from_time} isn't a block start. Valid times: {', '.join(times)}")
        f = times.index(ft)

    leaving = []
    for raw in names:
        n = resolve_name(schedule, raw)
        if players[n].get("dropped_from") is not None:
            raise PadelError(f"{n} is already marked as out from {players[n]['dropped_from']}")
        if n not in leaving:
            leaving.append(n)
    for n in leaving:
        players[n]["dropped_from"] = times[f]

    rng = random.Random(seed)
    changes = []
    for b in range(f, len(blocks)):
        blk = blocks[b]
        blk["sitting_out"] = [n for n in blk["sitting_out"] if n not in leaving]
        for g in blk["games"]:
            for team in g["teams"]:
                for i, n in enumerate(team):
                    if n not in leaving:
                        continue
                    others = [x for x in _game_players(g) if x != n]
                    cands = [c for c in blk["sitting_out"]
                             if not _dropped_by(players, times, c, b)
                             and (players[c]["partner"] is None
                                  or _dropped_by(players, times, players[c]["partner"], b))]
                    if not cands:
                        team[i] = None
                        changes.append((blk["time"], g["court"], n, None))
                        continue
                    counts, meet = games_played(schedule), _meetings(schedule)
                    sk = players[n]["skill"]
                    fewest = min(counts[c] for c in cands)
                    # Closest skill matters most, but 2 extra games outweigh 1 skill level,
                    # so one person doesn't end up taking every freed slot.
                    pick = min(cands, key=lambda c: (abs(players[c]["skill"] - sk)
                                                     + DROP_EXTRA_GAME * (counts[c] - fewest),
                                                     sum(meet[_key(c, o)] for o in others),
                                                     rng.random()))
                    team[i] = pick
                    blk["sitting_out"].remove(pick)
                    changes.append((blk["time"], g["court"], n, pick))
    return changes


# --------------------------------------------------------------------------- output

def render_text(schedule):
    """WhatsApp-friendly schedule: by block, then a searchable per-player index."""
    lines = ["*Padel - Wednesday schedule*", ""]
    for blk in schedule["blocks"]:
        lines.append(f"*{blk['time']}*")
        for g in blk["games"]:
            a, b = (" & ".join(x or "NEEDS 1 PLAYER" for x in t) for t in g["teams"])
            lines.append(f"C{g['court']}: {a} vs {b}")
        if blk["sitting_out"]:
            lines.append("Sitting out: " + ", ".join(blk["sitting_out"]))
        lines.append("")

    lines.append("*Who plays when* (search your name)")
    slots = defaultdict(list)
    for blk in schedule["blocks"]:
        for g in blk["games"]:
            for x in _game_players(g):
                slots[x].append(f"{blk['time']} C{g['court']}")
    first = schedule["blocks"][0]["time"]
    for n in sorted(schedule["players"], key=str.lower):
        d = schedule["players"][n].get("dropped_from")
        if d == first:
            continue  # dropped before the start, leave them off
        line = f"{n}: {', '.join(slots[n]) or 'not playing'}"
        if d:
            line += f" (out from {d})"
        lines.append(line)
    return "\n".join(lines) + "\n"


def summary(schedule):
    """Organiser-only stats (printed to the terminal, not for the group chat)."""
    players, times = schedule["players"], _times(schedule)
    s = schedule["settings"]
    active = [n for n in players if players[n].get("dropped_from") is None]
    counts = games_played(schedule)
    n_pairs = sum(1 for n in active if players[n]["partner"]
                  and players[players[n]["partner"]].get("dropped_from") is None) // 2

    opp, part = defaultdict(int), defaultdict(int)
    gaps, spreads, short = [], [], 0
    for b, blk in enumerate(schedule["blocks"]):
        for g in blk["games"]:
            ta, tb = g["teams"]
            if None in ta or None in tb:
                short += 1
                continue
            for x in ta:
                for y in tb:
                    opp[_key(x, y)] += 1
            for t in (ta, tb):
                if players[t[0]]["partner"] != t[1]:
                    part[_key(*t)] += 1
            sk = [players[x]["skill"] for x in ta + tb]
            gaps.append(abs(sk[0] + sk[1] - sk[2] - sk[3]) / 2)
            spreads.append(max(sk) - min(sk))

    played = [counts[n] for n in active]
    mins = s["block"] * min(played) if played else 0
    ok = "OK" if played and min(played) >= s["min_blocks"] else "PROBLEM"
    out = [
        "Organiser summary",
        f"  Players: {len(active)} ({n_pairs} fixed pairs, {len(active) - 2 * n_pairs} singles), "
        f"{s['courts_used']} courts, {len(times)} blocks of {s['block']} min, seed {s['seed']}",
        f"  Blocks played per person: min {min(played)}, max {max(played)} "
        f"(min {mins} min of play: {ok})" if played else "  No active players",
        f"  Pairs of players who faced each other more than once: "
        f"{sum(1 for v in opp.values() if v > 1)}",
        f"  Singles who got the same partner twice: {sum(1 for v in part.values() if v > 1)}",
    ]
    if gaps:
        out.append(f"  Team skill gap: average {sum(gaps) / len(gaps):.2f}, biggest {max(gaps):.1f}")
        out.append(f"  Biggest skill spread inside one game: {max(spreads)}")
    if short:
        out.append(f"  WARNING: {short} game(s) are a player short")
    return "\n".join(out)


def _save(schedule, txt_path):
    txt_path = Path(txt_path)
    json_path = txt_path.with_suffix(".json")
    schedule["settings"]["out"] = str(txt_path)
    txt_path.write_text(render_text(schedule), encoding="utf-8")
    json_path.write_text(json.dumps(schedule, indent=1), encoding="utf-8")
    return txt_path, json_path


# --------------------------------------------------------------------------- CLI

def cmd_generate(argv):
    ap = argparse.ArgumentParser(prog="padel.py", description="Make a padel session schedule.")
    ap.add_argument("players", help="CSV with columns name, skill (1-5), partner (optional)")
    ap.add_argument("--courts", type=int, default=7)
    ap.add_argument("--start", default="14:00")
    ap.add_argument("--end", default="16:00")
    ap.add_argument("--block", type=int, default=15, help="block length in minutes")
    ap.add_argument("--min-minutes", type=int, default=60, help="guaranteed play time per person")
    ap.add_argument("--seed", type=int, help="same seed + same CSV = same schedule")
    ap.add_argument("--out", default="schedule.txt", help="text file to write (a .json is saved next to it)")
    a = ap.parse_args(argv)
    if a.courts < 1:
        raise PadelError("Need at least 1 court")

    players = load_players(a.players)
    sched = generate(players, a.courts, a.start, a.end, a.block, a.min_minutes, a.seed)
    txt, js = _save(sched, a.out)
    print(render_text(sched))
    print(summary(sched))
    print(f"\nSaved {txt} (paste into the group chat) and {js} (keep it for dropouts).")


def cmd_drop(argv):
    ap = argparse.ArgumentParser(prog="padel.py drop",
                                 description="Replace people who dropped out with people sitting out.")
    ap.add_argument("schedule", help="the schedule .json saved when you made the schedule")
    ap.add_argument("names", nargs="+", help="who's dropping out (use quotes around full names)")
    ap.add_argument("--from", dest="from_time", help="first block they miss, e.g. 14:45 (default: all)")
    ap.add_argument("--seed", type=int, help="tie-break seed")
    a = ap.parse_args(argv)

    path = Path(a.schedule)
    try:
        sched = json.loads(path.read_text(encoding="utf-8"))
    except OSError as e:
        raise PadelError(f"Can't open {path}: {e.strerror}")
    except json.JSONDecodeError:
        raise PadelError(f"{path} isn't a schedule file (expected the .json, not the .txt)")

    changes = drop_players(sched, a.names, a.from_time, a.seed)
    txt, js = _save(sched, path.with_suffix(".txt"))  # .txt and .json stay side by side

    who = sorted({c[2] for c in changes} | {resolve_name(sched, n) for n in a.names}, key=str.lower)
    when = f" from {a.from_time}" if a.from_time else ""
    print(f"*Changes ({', '.join(who)} out{when})*")
    if not changes:
        print("Nobody needs moving: they weren't due on court.")
    for t, court, gone, new in changes:
        if new:
            print(f"{t} C{court}: {new} in for {gone}")
        else:
            print(f"{t} C{court}: game is a player short ({gone} out), anyone free please join")
    short = [c for c in changes if c[3] is None]
    if short:
        print(f"\nWARNING: {len(short)} slot(s) had nobody sitting out to fill them.", file=sys.stderr)
    print(f"\n{summary(sched)}")
    print(f"\nUpdated {txt} and {js}.")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv and argv[0] == "drop":
            cmd_drop(argv[1:])
        else:
            cmd_generate(argv)
    except PadelError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
