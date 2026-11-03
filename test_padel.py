import contextlib
import csv
import io
import random
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

import padel


def make_roster(n, n_pairs, seed=0):
    rng = random.Random(seed)
    names = [f"Player {i:02d}" for i in range(n)]
    players = {x: {"skill": rng.choice([1, 2, 2, 3, 3, 3, 4, 4, 5]), "partner": None} for x in names}
    for i in range(n_pairs):
        a, b = names[2 * i], names[2 * i + 1]
        players[a]["partner"], players[b]["partner"] = b, a
    return players


def all_games(sched):
    for blk in sched["blocks"]:
        for g in blk["games"]:
            yield blk, g


def check_basic(tc, sched):
    players = sched["players"]
    for blk in sched["blocks"]:
        on = [x for g in blk["games"] for t in g["teams"] for x in t if x]
        tc.assertEqual(len(on), len(set(on)), f"double booked at {blk['time']}")
        tc.assertFalse(set(on) & set(blk["sitting_out"]), "playing and sitting out")
        active = {n for n in players
                  if players[n].get("dropped_from") is None}
        tc.assertTrue(active <= set(on) | set(blk["sitting_out"]), "someone missing from a block")


class TestGenerate(unittest.TestCase):
    ROSTERS = [(56, 10), (56, 0), (56, 28), (50, 7), (40, 5), (30, 3), (13, 2), (9, 0), (45, 6)]

    def test_everyone_gets_an_hour_and_rules_hold(self):
        for n, pairs in self.ROSTERS:
            for seed in range(5):
                with self.subTest(n=n, pairs=pairs, seed=seed):
                    players = make_roster(n, pairs, seed)
                    s = padel.generate(players, seed=seed)
                    check_basic(self, s)
                    counts = padel.games_played(s)
                    self.assertGreaterEqual(min(counts.values()), 4)
                    self.assertLessEqual(max(counts.values()) - min(counts.values()), 1)
                    if n == 56:
                        self.assertEqual(set(counts.values()), {4})

                    for blk, g in all_games(s):
                        self.assertEqual(len(g["teams"]), 2)
                        for t in g["teams"]:
                            self.assertEqual(len(t), 2)
                    # fixed pairs: always on the same team, sit out together
                    for blk in s["blocks"]:
                        teams = {x: tuple(t) for g in blk["games"] for t in g["teams"] for x in t}
                        for x, info in players.items():
                            p = info["partner"]
                            if p:
                                self.assertEqual(x in teams, p in teams)
                                if x in teams:
                                    self.assertIn(p, teams[x])

    def test_skill_matching_is_close(self):
        players = make_roster(56, 10, 3)
        s = padel.generate(players, seed=3)
        gaps = []
        for _, g in all_games(s):
            a, b = ([players[x]["skill"] for x in t] for t in g["teams"])
            gaps.append(abs(sum(a) - sum(b)) / 2)
        self.assertLess(sum(gaps) / len(gaps), 0.5)
        self.assertLessEqual(max(gaps), 1.0)

    def test_singles_rotate_partners(self):
        for seed in range(5):
            players = make_roster(56, 10, seed)
            s = padel.generate(players, seed=seed)
            part = defaultdict(int)
            for _, g in all_games(s):
                for t in g["teams"]:
                    if players[t[0]]["partner"] != t[1]:
                        part[tuple(sorted(t))] += 1
            self.assertEqual(sum(1 for v in part.values() if v > 1), 0)

    def test_capacity_error(self):
        with self.assertRaises(padel.PadelError) as cm:
            padel.generate(make_roster(57, 5), seed=1)
        self.assertIn("Remove 1 player", str(cm.exception))
        with self.assertRaises(padel.PadelError):
            padel.generate(make_roster(3, 0), seed=1)

    def test_same_seed_same_schedule(self):
        players = make_roster(40, 5)
        self.assertEqual(padel.generate(players, seed=9)["blocks"],
                         padel.generate(players, seed=9)["blocks"])

    def test_block_times(self):
        t = padel.block_times("14:00", "16:00", 15)
        self.assertEqual(t[0], "14:00")
        self.assertEqual(t[-1], "15:45")
        self.assertEqual(len(t), 8)


class TestDrop(unittest.TestCase):
    def setUp(self):
        self.players = make_roster(50, 6, 1)
        self.sched = padel.generate(self.players, seed=1)

    def _snapshot(self):
        import copy
        return copy.deepcopy(self.sched)

    def test_single_drops_before_start(self):
        before = self._snapshot()
        victim = "Player 30"  # a single
        due = [(b, g["court"]) for b, blk in enumerate(before["blocks"]) for g in blk["games"]
               if victim in padel._game_players(g)]
        old_counts = padel.games_played(before)
        changes = padel.drop_players(self.sched, [victim], seed=1)
        self.assertEqual(len(changes), len(due))
        check_basic(self, self.sched)
        for b, blk in enumerate(self.sched["blocks"]):
            self.assertNotIn(victim, blk["sitting_out"])
            for g, og in zip(blk["games"], before["blocks"][b]["games"]):
                ps, ops = padel._game_players(g), padel._game_players(og)
                self.assertNotIn(victim, ps)
                if victim in ops:
                    new = (set(ps) - set(ops)).pop()
                    self.assertIn(new, before["blocks"][b]["sitting_out"])
                    self.assertIsNone(self.players[new]["partner"])
                else:
                    self.assertEqual(g, og)
        new_counts = padel.games_played(self.sched)
        for n in self.players:
            if n != victim:
                self.assertGreaterEqual(new_counts[n], old_counts[n])

    def test_pair_member_drops_mid_session(self):
        before = self._snapshot()
        victim, partner = "Player 00", "Player 01"
        changes = padel.drop_players(self.sched, [victim], from_time="15:00", seed=1)
        check_basic(self, self.sched)
        f = padel._times(self.sched).index("15:00")
        self.assertEqual(self.sched["blocks"][:f], before["blocks"][:f])
        for b in range(f, len(self.sched["blocks"])):
            was = [g for g in before["blocks"][b]["games"] if victim in padel._game_players(g)]
            now = [g for g in self.sched["blocks"][b]["games"] if partner in padel._game_players(g)]
            if was:
                self.assertEqual(len(now), 1)
                team = [t for t in now[0]["teams"] if partner in t][0]
                self.assertNotIn(victim, team)
                self.assertNotIn(None, team)
        self.assertTrue(all(c[3] for c in changes))
        self.assertIn("(out from 15:00)", padel.render_text(self.sched))

    def test_several_dropouts_spread_out(self):
        names = ["Player 20", "Player 21", "Player 22", "Player 23"]
        changes = padel.drop_players(self.sched, names, seed=2)
        check_basic(self, self.sched)
        fills = defaultdict(int)
        for c in changes:
            fills[c[3]] += 1
        self.assertGreater(len(fills), 3)
        counts = padel.games_played(self.sched)
        active = [counts[n] for n in self.players if n not in names]
        self.assertLessEqual(max(active) - min(active), 3)  # skill match beats perfect fairness

    def test_nobody_free_flags_game(self):
        players = make_roster(8, 0)
        s = padel.generate(players, courts=2, seed=1)
        changes = padel.drop_players(s, ["Player 03"])
        self.assertTrue(changes)
        self.assertTrue(all(c[3] is None for c in changes))
        self.assertIn("NEEDS 1 PLAYER", padel.render_text(s))
        self.assertIn("player short", padel.summary(s))

    def test_bad_names_and_times(self):
        with self.assertRaises(padel.PadelError) as cm:
            padel.drop_players(self.sched, ["Player 7"])
        self.assertIn("Did you mean", str(cm.exception))
        with self.assertRaises(padel.PadelError):
            padel.drop_players(self.sched, ["Player 07"], from_time="14:10")


class TestCsv(unittest.TestCase):
    def _csv(self, rows):
        d = tempfile.mkdtemp()
        p = Path(d) / "p.csv"
        with open(p, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Name", "Skill", "Partner"])
            w.writerows(rows)
        return p

    def test_one_sided_partner_ok(self):
        p = padel.load_players(self._csv([["A", 3, "b"], ["B", 2, ""], ["C", 1, ""]]))
        self.assertEqual(p["A"]["partner"], "B")
        self.assertEqual(p["B"]["partner"], "A")
        self.assertIsNone(p["C"]["partner"])

    def test_conflict_and_unknown(self):
        with self.assertRaises(padel.PadelError):
            padel.load_players(self._csv([["A", 3, "B"], ["B", 2, "C"], ["C", 1, ""]]))
        with self.assertRaises(padel.PadelError):
            padel.load_players(self._csv([["A", 3, "Zed"]]))
        with self.assertRaises(padel.PadelError):
            padel.load_players(self._csv([["A", 7, ""]]))
        with self.assertRaises(padel.PadelError):
            padel.load_players(self._csv([["A", 3, ""], ["a", 2, ""]]))

    def test_example_csv_loads(self):
        p = padel.load_players(Path(__file__).with_name("players.csv"))
        self.assertEqual(len(p), 56)


class TestCli(unittest.TestCase):
    def test_generate_then_drop(self):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self._run()

    def _run(self):
        d = Path(tempfile.mkdtemp())
        csvp = Path(__file__).with_name("players.csv")
        self.assertEqual(padel.main([str(csvp), "--seed", "1", "--out", str(d / "s.txt")]), 0)
        self.assertTrue((d / "s.json").exists())
        self.assertEqual(padel.main(["drop", str(d / "s.json"), "Sam Lee", "--from", "14:45"]), 0)
        self.assertIn("Sam Lee: ", (d / "s.txt").read_text())
        self.assertEqual(padel.main(["drop", str(d / "s.json"), "Sam Lee"]), 1)  # already out


if __name__ == "__main__":
    unittest.main()
