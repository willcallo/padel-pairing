// Tests for the scheduling engine and Luma import inside index.html.
// Run: node test_engine.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const ctx = vm.createContext({ console, Math, Date });
for (const id of ["engine", "importer", "draw"]) {
  const m = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)</script>`));
  assert.ok(m, `script #${id} not found`);
  vm.runInContext(m[1], ctx);
}
const E = ctx.PadelEngine, I = ctx.PadelImport, D = ctx.PadelDraw;

function roster(n, nPairs, seed = 0, opts = {}) {
  const rng = E.makeRng(seed + 1);
  const players = {};
  const names = Array.from({ length: n }, (_, i) => `Player ${String(i).padStart(2, "0")}`);
  const skills = [1, 2, 2, 3, 3, 3, 4, 4, 5];
  names.forEach((x, i) => {
    const gender = opts.genders ? opts.genders(i) : (rng() < 0.4 ? "F" : "M");
    const pref = opts.prefs ? opts.prefs(i, gender) : "any";
    players[x] = { skill: skills[Math.floor(rng() * skills.length)], partner: null, gender, pref };
  });
  for (let i = 0; i < nPairs; i++) {
    const a = names[2 * i], b = names[2 * i + 1];
    players[a].partner = b; players[b].partner = a;
  }
  return players;
}
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const gamePlayers = g => g.teams.flat().filter(Boolean);

function checkBasic(s) {
  for (const blk of s.blocks) {
    const on = blk.games.flatMap(gamePlayers);
    assert.equal(on.length, new Set(on).size, `double booked at ${blk.time}`);
    assert.ok(!on.some(x => blk.sittingOut.includes(x)), "playing and sitting out");
    for (const n in s.players) if (s.players[n].droppedFrom == null) assert.ok(on.includes(n) || blk.sittingOut.includes(n), `${n} missing at ${blk.time}`);
    for (const g of blk.games) { assert.equal(g.teams.length, 2); g.teams.forEach(t => assert.equal(t.length, 2)); }
  }
}

test("everyone gets an hour, pairs stay together, spread <= 1", () => {
  const cases = [[56, 10], [56, 0], [56, 28], [50, 7], [40, 5], [30, 3], [13, 2], [9, 0], [45, 6]];
  for (const [n, p] of cases) for (let seed = 0; seed < 4; seed++) {
    const players = roster(n, p, seed);
    const s = E.generate(players, { seed });
    checkBasic(s);
    const c = Object.values(E.gamesPlayed(s));
    assert.ok(Math.min(...c) >= 4, `n=${n} p=${p} seed=${seed} min=${Math.min(...c)}`);
    assert.ok(Math.max(...c) - Math.min(...c) <= 1, `spread n=${n}`);
    if (n === 56) assert.deepEqual([...new Set(c)], [4]);
    for (const blk of s.blocks) {
      const team = {};
      blk.games.forEach(g => g.teams.forEach(t => t.forEach(x => { team[x] = t; })));
      for (const x in players) {
        const q = players[x].partner;
        if (q) { assert.equal(x in team, q in team); if (x in team) assert.ok(team[x].includes(q)); }
      }
    }
  }
});

test("skill matching close, singles don't repeat partners", () => {
  for (let seed = 0; seed < 4; seed++) {
    const players = roster(56, 10, seed);
    const s = E.generate(players, { seed });
    const m = E.summary(s);
    assert.ok(m.avgGap < 0.5, `avg gap ${m.avgGap}`);
    assert.ok(m.maxGap <= 1, `max gap ${m.maxGap}`);
    assert.equal(m.repeatPartners, 0);
  }
});

test("capacity error and numbering", () => {
  assert.throws(() => E.generate(roster(57, 5), { seed: 1 }), /Remove 1 player/);
  assert.throws(() => E.generate(roster(3, 0), { seed: 1 }), /at least 4/);
  const s = E.generate(roster(20, 2), { seed: 3 });
  const nums = Object.values(s.numbers).sort((a, b) => a - b);
  assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(s.numbers["Player 00"], 1);
  assert.equal(s.settings.courtsUsed, 5);
  const same = E.generate(roster(40, 4), { seed: 9 }), again = E.generate(roster(40, 4), { seed: 9 });
  assert.deepEqual(same.blocks, again.blocks);
});

test("single-gender requests met when numbers allow", () => {
  // 8 women want women-only, 6 more women happy with anyone, rest men (some men-only too)
  let met = 0, total = 0;
  for (let seed = 0; seed < 5; seed++) {
    const players = roster(52, 6, seed, {
      genders: i => (i >= 12 && i < 26 ? "F" : "M"),
      prefs: (i, g) => ((i >= 12 && i < 20) || (i >= 40 && i < 46) ? "single" : "any"),
    });
    const s = E.generate(players, { seed });
    checkBasic(s);
    assert.ok(Math.min(...Object.values(E.gamesPlayed(s))) >= 4);
    const m = E.summary(s);
    met += m.genderMet; total += m.genderGames;
  }
  assert.ok(met / total >= 0.95, `met ${met}/${total}`);
});

test("awkward single-gender count still keeps the hour and reports misses", () => {
  // 5 women-only, no other women: impossible to always fill a women-only court
  const players = roster(40, 0, 2, { genders: i => (i < 5 ? "F" : "M"), prefs: (i) => (i < 5 ? "single" : "any") });
  const s = E.generate(players, { seed: 2 });
  assert.ok(Math.min(...Object.values(E.gamesPlayed(s))) >= 4);
  const m = E.summary(s);
  assert.ok(m.genderMisses.length > 0);
});

test("mixed fixed pair isn't treated as a single-gender request", () => {
  const players = roster(20, 0, 1, { genders: i => (i % 2 ? "F" : "M") });
  players["Player 00"].pref = "single"; players["Player 00"].partner = "Player 01"; players["Player 01"].partner = "Player 00";
  assert.equal(E.wantsSingle(players, "Player 00"), false);
});

test("dropouts: single before start", () => {
  const players = roster(50, 6, 1);
  const s = E.generate(players, { seed: 1 });
  const before = JSON.parse(JSON.stringify(s));
  const victim = "Player 30";
  const due = before.blocks.flatMap(b => b.games.filter(g => gamePlayers(g).includes(victim)));
  const old = E.gamesPlayed(before);
  const ch = E.dropPlayers(s, [victim], null, 1);
  assert.equal(ch.length, due.length);
  checkBasic(s);
  s.blocks.forEach((blk, b) => {
    assert.ok(!blk.sittingOut.includes(victim));
    blk.games.forEach((g, gi) => {
      const og = before.blocks[b].games[gi], ps = gamePlayers(g), ops = gamePlayers(og);
      assert.ok(!ps.includes(victim));
      if (ops.includes(victim)) {
        const nw = ps.find(x => !ops.includes(x));
        assert.ok(before.blocks[b].sittingOut.includes(nw));
        assert.equal(players[nw].partner, null);
      } else same(g, og);
    });
  });
  const now = E.gamesPlayed(s);
  for (const n in players) if (n !== victim) assert.ok(now[n] >= old[n]);
});

test("dropouts: pair member mid-session", () => {
  const players = roster(50, 6, 1);
  const s = E.generate(players, { seed: 1 });
  const before = JSON.parse(JSON.stringify(s));
  const ch = E.dropPlayers(s, ["Player 00"], "15:00", 1);
  checkBasic(s);
  const f = s.blocks.findIndex(b => b.time === "15:00");
  same(s.blocks.slice(0, f), before.blocks.slice(0, f));
  for (let b = f; b < s.blocks.length; b++) {
    const was = before.blocks[b].games.some(g => gamePlayers(g).includes("Player 00"));
    if (was) {
      const g = s.blocks[b].games.find(g => gamePlayers(g).includes("Player 01"));
      const team = g.teams.find(t => t.includes("Player 01"));
      assert.ok(!team.includes("Player 00") && !team.includes(null));
    }
  }
  assert.ok(ch.every(c => c.in));
  assert.match(E.renderText(s), /out from 15:00/);
});

test("dropouts: several at once spread out; nobody free flagged", () => {
  const players = roster(50, 6, 1);
  const s = E.generate(players, { seed: 1 });
  const names = ["Player 20", "Player 21", "Player 22", "Player 23"];
  const ch = E.dropPlayers(s, names, null, 2);
  checkBasic(s);
  assert.ok(new Set(ch.map(c => c.in)).size > 3);
  const small = E.generate(roster(8, 0), { courts: 2, seed: 1 });
  const ch2 = E.dropPlayers(small, ["Player 03"], null, 1);
  assert.ok(ch2.length && ch2.every(c => c.in === null));
  assert.equal(E.summary(small).shortGames, ch2.length);
  assert.throws(() => E.dropPlayers(small, ["Player 03"]), /already marked/);
  assert.throws(() => E.dropPlayers(small, ["Nobody"]), /isn't in this schedule/);
});

test("dropouts keep single-gender courts when possible", () => {
  const players = roster(44, 0, 4, { genders: i => (i < 16 ? "F" : "M"), prefs: i => (i < 8 ? "single" : "any") });
  const s = E.generate(players, { seed: 4 });
  const victim = Object.keys(players).find(n => players[n].gender === "F" && players[n].pref === "single");
  const before = E.summary(s).genderMisses.length;
  E.dropPlayers(s, [victim], null, 3);
  assert.ok(E.summary(s).genderMisses.length <= before + 1);
});

const LUMA = [
  'api_id,name,first_name,last_name,email,approval_status,"What\'s your uni email?","Skill level (1-5)",Gender,"Mixed or single gender courts?","Partner (optional)"',
  'g1,Alex Smith,Alex,Smith,a@x,approved,as1@uni,"4 - Advanced",Male,Happy with mixed,Jo',
  'g2,Jo Brown,Jo,Brown,j@x,approved,jb@uni,3,Female,Single gender courts only,Alex Smith',
  'g3,Sam Lee,Sam,Lee,s@x,approved,sl@uni,2 - Improver,Man,Mixed,Priya Shaw',
  'g4,Priya Shah,Priya,Shah,p@x,approved,ps@uni,5,Woman,Mixed,',
  'g5,"O\'Neill, Kate",Kate,O\'Neill,k@x,approved,ko@uni,Intermediate,female,"Same gender, please",none',
  'g6,Tom Reed,Tom,Reed,t@x,waitlist,tr@uni,3,Male,Mixed,',
  'g7,Ella Patel,Ella,Patel,e@x,declined,ep@uni,3,Female,Mixed,',
  'g8,Ben Clark,Ben,Clark,b@x,approved,bc@uni,3,Male,Mixed,Sammy',
  'g9,Ben Clark,Ben,Clark,b@x,approved,bc@uni,4,Male,Mixed,Sammy',
  'g10,Charlie Carr,Charlie,Carr,c@x,approved,cc@uni,3,Non-binary,Single gender,n/a',
  'g11,Zed,Zed,,z@x,approved,z@uni,banana,Prefer not to say,Mixed,-',
].join("\r\n");

test("Luma import", () => {
  const r = I.importSignups(LUMA);
  const by = Object.fromEntries(r.players.map(p => [p.name, p]));
  assert.equal(r.players.length, 8, r.players.map(p => p.name).join(","));
  assert.ok(!by["Tom Reed"] && !by["Ella Patel"]);
  assert.equal(by["Alex Smith"].partner, "Jo Brown");
  assert.equal(by["Jo Brown"].partner, "Alex Smith");
  assert.equal(by["Sam Lee"].partner, "Priya Shah"); // typo matched, one-sided
  assert.equal(by["Priya Shah"].partner, "Sam Lee");
  assert.equal(by["Ben Clark"].partner, null);       // "Sammy" didn't sign up
  assert.equal(by["Ben Clark"].skill, 4);            // later duplicate wins
  assert.equal(by["Alex Smith"].skill, 4);
  assert.equal(by["Sam Lee"].skill, 2);
  assert.equal(by["O'Neill, Kate"].skill, 3);
  assert.equal(by["O'Neill, Kate"].pref, "single");
  assert.equal(by["O'Neill, Kate"].gender, "F");
  assert.equal(by["Jo Brown"].gender, "F");
  assert.equal(by["Alex Smith"].gender, "M");
  assert.equal(by["Charlie Carr"].gender, "X");
  assert.equal(by["Zed"].skillFlag, true);
  const text = r.notes.map(n => n.text).join("\n");
  assert.match(text, /8 players imported/);
  assert.match(text, /1 waitlist/);
  assert.match(text, /1 declined/);
  assert.match(text, /merged 1 duplicate/);
  assert.match(text, /"Sammy" didn't match/);
  assert.match(text, /Charlie Carr asked for single-gender/);
  assert.match(text, /Jo Brown asked for single-gender courts but is paired with Alex Smith/);
  assert.match(text, /No readable skill level for Zed/);
});

test("import: example CSV, tab-separated paste, players.csv, empty", () => {
  const ex = I.importSignups(I.exampleCsv());
  assert.ok(ex.players.length >= 48 && ex.players.length <= 56, String(ex.players.length));
  const tsv = "Name\tSkill level\tGender\tMixed or single gender courts\tPartner\nA B\t3\tMale\tMixed\t\nC D\t2\tFemale\tMixed\tA B\n";
  const t = I.importSignups(tsv);
  assert.equal(t.players.length, 2);
  assert.equal(t.players[1].partner, "A B");
  const pcsv = readFileSync(new URL("./players.csv", import.meta.url), "utf8");
  const pc = I.importSignups(pcsv);
  assert.equal(pc.players.length, 56);
  assert.equal(I.importSignups("").players.length, 0);
  assert.equal(I.importSignups("foo,bar\n1,2").players.length, 0);
});

test("court map model", () => {
  const s = E.generate(roster(44, 4, 5), { seed: 5 });
  const m = D.mapModel(s, 0, {});
  const texts = m.items.filter(i => i.t === "text").map(i => i.s);
  for (const c of [1, 2, 3, 4, 5, 6, 7]) assert.ok(texts.includes(`COURT ${c}`));
  assert.ok(texts.includes("Next on:"));
  assert.equal(m.items.filter(i => i.t === "circle").length, 28);
  const last = D.mapModel(s, s.blocks.length - 1, {});
  assert.ok(last.items.some(i => i.s === "Last game"));
  const small = E.generate(roster(20, 0, 1), { seed: 1 });
  assert.equal(D.mapModel(small, 0, {}).items.filter(i => i.s === "FREE").length, 2);
  assert.match(D.toSVG(m), /^<svg/);
  assert.equal(D.pdfSafe("Zoë Łukasz 王"), "Zoë Lukasz ?");
});
