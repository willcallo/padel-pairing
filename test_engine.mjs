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
  'g8,Ben Clark,Ben,Clark,b@x,approved,bc@uni,3,Male,Mixed,Rowan',
  'g9,Ben Clark,Ben,Clark,b@x,approved,bc@uni,4,Male,Mixed,Rowan',
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
  assert.equal(by["Ben Clark"].partner, null);       // "Rowan" didn't sign up
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
  assert.match(text, /"Rowan", who didn't match/);
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

// Synthetic copy of the real Luma export's shape (made-up people, no real data).
const REAL_SHAPE = [
  'guest_id,name,first_name,last_name,email,phone_number,created_at,approval_status,checked_in_at,ticket_name,What level are you?,Gender?,What would you like to play?,"Please enter a partners university username if you would like to be paired, E.g AB1234",Are you a driver?,ID',
  'g1,Amy One,Amy,One,ao101@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Female,Mixed,Bt202,Yes,ao101',      // one-sided username
  'g2,Bob Two,Bob,Two,bt202@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Male,Mixed,,No,bt202',
  'g3,Cal Three,Cal,Three,ct303@uni.ac.uk,,t,approved,,Standard,Lower Advanced,Male,Mixed,ZZ999 DF404,Yes,ct303',  // absent + mutual
  'g4,Dan Four,Dan,Four,df404@uni.ac.uk,,t,approved,,Standard,Lower Advanced,Male,Single Gender,ct303,No,df404',
  'g5,Eve Five,Eve,Five,ef505@uni.ac.uk,,t,approved,,Standard,Higher Advanced,Female,Mixed,"FS606, GS707",,ef505', // two pairs
  'g6,Fay Six,Fay,Six,fs606@uni.ac.uk,,t,approved,,Standard,Higher Advanced,Male,Mixed,"EF505, GS707",,fs606',
  'g7,Gus Seven,Gus,Seven,gs707@uni.ac.uk,,t,approved,,Standard,Higher Advanced,Male,Mixed,HE808,No,gs707',
  'g8,Hal Eight,Hal,Eight,he808@uni.ac.uk,,t,approved,,Standard,Higher Advanced,Male,Mixed,Gs707,No,he808',
  'g9,Ivy nine,Ivy,Nine,in909@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Male,Mixed,"jt110 , kl111",No,in909', // trio
  'g10,Jon ten,Jon,Ten,jt110@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Male,Single Gender,KL111 and IN909,,jt110',
  'g11,Kit,,,kl111@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Male,Single Gender,Jt110 or in990,No,kl111', // swapped digits
  'g12,Lou Twelve,Lou,Twelve,lt112@uni.ac.uk,,t,approved,,Standard,Beginner,Male,Mixed,Lt112,No,lt112',            // own username
  'g13,Mo,Mo,,mo113@uni.ac.uk,,t,approved,,Standard,Lower Intermediate,Male,Single Gender,Max Nobody,No,mo113',    // name, absent
  'g14,Nia Fourteen,Nia,Fourteen,nf114@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Female,Mixed,"Oz, Pat sixteen",No,nf114', // names
  'g15,Oz Fifteen,Oz,Fifteen,of115@uni.ac.uk,,t,approved,,Standard,Higher Intermediate,Male,Mixed,,No,of115',
  'g16,Pat Sixteen,Pat,Sixteen,ps116@uni.ac.uk,,t,approved,,Standard,Lower Advanced,Male,Mixed,NF114,No,ps116',
  'g17,Quin Ab,Quin,Ab,qa117@uni.ac.uk,,t,approved,,Standard,Beginner,Female,Single Gender,,No,qa117',
  ',,Rae ,Last,rl118@uni.ac.uk,,,,,,Higher Intermediate,Female,Mixed,nf114,,rl118',                                 // no name/status row
  'g19,Sol Nine,Sol,Nine,sn119@uni.ac.uk,,t,approved,,Standard,Lower Intermediate,Male,Mixed,AB1234,No,sn119',      // example (absent)
].join("\n");

test("real Luma shape: columns, skills, usernames, groups", () => {
  const r = I.importSignups(REAL_SHAPE);
  const by = Object.fromEntries(r.players.map(p => [p.name, p]));
  assert.ok(r.columns.pref >= 0, "court preference column found");
  assert.equal(r.columns.example, "ab1234");
  assert.equal(r.players.length, 19);
  assert.deepEqual(["Higher Intermediate", "Lower Advanced", "Higher Advanced", "Beginner", "Lower Intermediate"].map(I.parseSkill), [3, 4, 5, 1, 2]);
  assert.equal(by["Dan Four"].pref, "single");
  assert.equal(by["Amy One"].pref, "any");
  assert.ok(by["Ivy Nine"] && by["Jon Ten"], "lowercase names tidied");
  assert.ok(by["Rae Last"], "row without name/status built from first + last");
  assert.equal(by["Amy One"].partner, "Bob Two");
  assert.equal(by["Cal Three"].partner, "Dan Four");
  assert.equal(by["Eve Five"].partner, null, "named 2 people -> no fixed partner");
  assert.equal(by["Gus Seven"].partner, "Hal Eight");
  assert.equal(by["Lou Twelve"].partner, null);
  // groups: everyone who named 2+ people, plus named people's fixed partners; 2 games together
  const groups = r.requests.filter(q => q.type === "group");
  const grp = n => groups.find(g => g.members.includes(n));
  same([...grp("Eve Five").members].sort(), ["Eve Five", "Fay Six", "Gus Seven", "Hal Eight"]);
  same([...grp("Kit").members].sort(), ["Ivy Nine", "Jon Ten", "Kit"]);
  same([...grp("Nia Fourteen").members].sort(), ["Nia Fourteen", "Oz Fifteen", "Pat Sixteen"]);
  assert.ok(groups.every(g => g.count === 2 && g.auto));
  ["Ivy Nine", "Jon Ten", "Kit"].forEach(n => assert.equal(by[n].partner, null));
  assert.equal(grp("Amy One"), undefined);
  // Pat and Rae both named only Nia -> Nia is shared, half each
  const shared = r.requests.filter(q => q.type === "partners").map(q => [q.a, q.b].sort().join("+") + "x" + q.count).sort();
  same(shared, ["Nia Fourteen+Pat Sixteenx2", "Nia Fourteen+Rae Lastx2"]);
  assert.equal(by["Nia Fourteen"].partner, null);
  const text = r.notes.map(n => n.text).join("\n");
  assert.match(text, /Cal Three asked for ZZ999, who hasn't signed up\./);
  assert.match(text, /Lou Twelve named themselves/);
  assert.match(text, /"Max Nobody", who didn't match/);
  assert.match(text, /Sol Nine asked for AB1234, who hasn't signed up/);
  assert.match(text, /Quin Ab asked for women-only courts/);
  assert.match(text, /3 groups/);
  assert.match(text, /Nia Fourteen was picked by Pat Sixteen and Rae Last, so Nia Fourteen partners each of them about half the time/);
});

test("group games and shared partners in the engine", () => {
  for (let seed = 0; seed < 4; seed++) {
    const players = roster(40, 2, seed, { genders: () => "M" });   // Player 00+01, 02+03 fixed pairs
    const requests = [
      { type: "group", members: ["Player 10", "Player 11", "Player 12", "Player 13"], count: 2, auto: true },   // 4 singles
      { type: "group", members: ["Player 20", "Player 21", "Player 22"], count: 2, auto: true },                // 3 singles
      { type: "group", members: ["Player 30", "Player 00"], count: 2, auto: true },                             // brings Player 01 along
      { type: "partners", a: "Player 25", b: "Player 26", count: 2, auto: true },                                // shared: 26 with 25 and 27
      { type: "partners", a: "Player 27", b: "Player 26", count: 2, auto: true },
    ];
    const s = E.generate(players, { seed, requests });
    checkBasic(s);
    same(E.validate(s).problems, [], `seed ${seed}`);
    assert.ok(Math.min(...Object.values(E.gamesPlayed(s))) >= 4, "hour kept");
    const st = E.requestStatus(s);
    assert.equal(st.length, 10, "2 copies of each request");
    assert.ok(st.every(x => x.met), JSON.stringify(st.filter(x => !x.met)));
    // group of 4 = one whole game, twice, in different blocks, with different partner splits
    const quad = st.filter(x => x.type === "group" && x.members.length === 4);
    assert.notEqual(quad[0].time, quad[1].time);
    const splits = quad.map(q => {
      const g = s.blocks.find(b => b.time === q.time).games.find(g => g.court === q.court);
      return g.teams.map(t => t.slice().sort().join("+")).sort().join(" v ");
    });
    assert.notEqual(splits[0], splits[1], "partners change between the two group games");
    // the group with a fixed-pair member keeps the pair together on that court
    for (const q of st.filter(x => x.type === "group" && x.members.includes("Player 00"))) {
      const g = s.blocks.find(b => b.time === q.time).games.find(g => g.court === q.court);
      assert.ok(g.teams.some(t => t.includes("Player 00") && t.includes("Player 01")));
    }
    // shared partner: 26 partners 25 twice and 27 twice, in four different blocks
    const sh = st.filter(x => x.type === "partners");
    assert.equal(new Set(sh.map(x => x.time)).size, 4);
    assert.ok(E.summary(s).repeatPartners <= 1, "requested repeats (25+26, 26+27) aren't flagged; other repeats stay rare");
  }
  // a group that can't fit on one court is reported, not built
  const r = I.importSignups(["name,email,Skill,Gender,What would you like to play?,Add names of anyone you want to play with here",
    "A One,a1@u.uk,3,Male,Mixed,\"B Two, C Three, D Four, E Five\"", "B Two,b2@u.uk,3,Male,Mixed,", "C Three,c3@u.uk,3,Male,Mixed,",
    "D Four,d4@u.uk,3,Male,Mixed,", "E Five,e5@u.uk,3,Male,Mixed,"].join("\n"));
  assert.equal(r.requests.length, 0);
  assert.match(r.notes.map(n => n.text).join(" "), /too many for one court/);
});

test("court closures: 6 and 7 closed", () => {
  for (let seed = 0; seed < 4; seed++) {
    const players = roster(40, 6, seed);
    const s = E.generate(players, { closedCourts: [6, 7], seed });
    checkBasic(s);
    assert.equal(s.settings.courtsUsed, 5);
    same(s.settings.openCourts, [1, 2, 3, 4, 5]);
    for (const b of s.blocks) assert.ok(b.games.every(g => g.court <= 5), "no game on 6 or 7");
    same([...new Set(Object.values(E.gamesPlayed(s)))], [4]);   // 40 on 5 courts: exactly an hour each
    assert.equal(E.validate(s).problems.length, 0);
    const m = D.mapModel(s, 0, {});
    assert.equal(m.items.filter(i => i.s === "CLOSED").length, 2);
    assert.equal(m.items.filter(i => i.s === "Next on:").length, 5);
    assert.equal(m.items.filter(i => i.t === "circle").length, 20);
  }
  assert.throws(() => E.generate(roster(41, 0), { closedCourts: [6, 7], seed: 1 }), /Remove 1 player \(max 40\)/);
  // closing a middle court: games skip it, strongest goes on the lowest open court
  const s2 = E.generate(roster(24, 0, 3), { closedCourts: [1, 4], seed: 3 });
  for (const b of s2.blocks) same(b.games.map(g => g.court), [2, 3, 5, 6, 7].slice(0, b.games.length));
  same(E.openCourtList({ openCourts: [7, 2, 2, 9] }), [2, 7]);
  assert.throws(() => E.generate(roster(8, 0), { openCourts: [], seed: 1 }), /All the courts are closed/);
});

test("validate: clean schedules pass, broken ones are caught", () => {
  for (const [n, p] of [[56, 10], [40, 5], [13, 2], [9, 0]]) {
    const s = E.generate(roster(n, p, 2), { seed: 2 });
    same(E.validate(s).problems, [], `n=${n}`);
    E.dropPlayers(s, ["Player 00", "Player 05"], s.blocks[3].time, 1);
    same(E.validate(s).problems, [], `n=${n} after dropouts`);
  }
  const base = E.generate(roster(40, 4, 1), { seed: 1 });
  const broken = fn => { const s = JSON.parse(JSON.stringify(base)); fn(s); return E.validate(s).problems.join(" | "); };
  // double-booked
  assert.match(broken(s => { const b = s.blocks[0]; b.games[1].teams[0][0] = b.games[0].teams[0][0]; }), /is on Court \d and Court \d/);
  // pair split: swap one half of a fixed pair with someone in another game
  assert.match(broken(s => {
    const b = s.blocks.find(b => b.games.some(g => g.teams.flat().includes("Player 00")));
    const g1 = b.games.find(g => g.teams.flat().includes("Player 00")), g2 = b.games.find(g => g !== g1);
    const t = g1.teams.find(t => t.includes("Player 00")); const i = t.indexOf("Player 00");
    [t[i], g2.teams[0][0]] = [g2.teams[0][0], t[i]];
  }), /isn't on the same team as their partner/);
  // missing player
  assert.match(broken(s => { s.blocks[2].sittingOut = s.blocks[2].sittingOut.slice(1); }), /is missing/);
  // game on a closed court
  assert.match(broken(s => { s.settings.openCourts = [1, 2, 3, 4, 5, 6]; }), /Court 7, which is closed/);
  // under an hour: take someone off court in all but one of their games
  assert.match(broken(s => { s.settings.minBlocks = 8; s.settings.minMinutes = 120; }), /only plays \d+ min/);
});

test("game requests: partners split a fixed pair for one game only", () => {
  for (let seed = 0; seed < 5; seed++) {
    const players = roster(40, 6, seed);   // Player 00 + 01 are a fixed pair
    const req = [{ a: "Player 00", b: "Player 30", type: "partners" }];
    const s = E.generate(players, { closedCourts: [6, 7], seed, requests: req });
    const st = E.requestStatus(s)[0];
    assert.ok(st.met, "request met");
    same([...new Set(Object.values(E.gamesPlayed(s)))], [4], "exact capacity: everyone 4 blocks");
    same(E.validate(s).problems, []);
    const blk = s.blocks.find(b => b.time === st.time);
    assert.ok(blk.games.some(g => g.teams.flat().includes("Player 01")), "the other half still plays that block");
    for (const b of s.blocks) {
      if (b.time === st.time) continue;
      for (const g of b.games) for (const t of g.teams) if (t.includes("Player 00")) assert.ok(t.includes("Player 01"), "back together in every other game");
    }
    const noBreaks = JSON.parse(JSON.stringify(s)); noBreaks.pairBreaks = [];
    assert.match(E.validate(noBreaks).problems.join(" "), /isn't on the same team as their partner/);
  }
});

test("game requests: opponents, same court, set time, impossible ones", () => {
  const players = roster(40, 6, 2);
  const s = E.generate(players, { seed: 2, requests: [
    { a: "Player 00", b: "Player 20", type: "opponents", time: "15:15" },
    { a: "Player 21", b: "Player 22", type: "court" },
    { a: "Player 23", b: "Player 24", type: "partners" },
  ] });
  const st = E.requestStatus(s);
  assert.ok(st.every(r => r.met), JSON.stringify(st));
  assert.equal(st[0].time, "15:15");
  same(E.validate(s).problems, []);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ a: "Player 00", b: "Player 01", type: "opponents" }] }), /already a fixed pair/);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ a: "Player 20", b: "Player 21", type: "partners", time: "14:00" }, { a: "Player 20", b: "Player 22", type: "court", time: "14:00" }] }), /two game requests at 14:00/);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ a: "Player 20", b: "Nobody", type: "court" }] }), /isn't playing this week/);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ a: "Player 20", b: "Player 21", type: "court", time: "13:00" }] }), /isn't a block time/);
});

test("swapPlayers: plain, sitting out, split pair, move partner, hour guard", () => {
  const players = roster(36, 4, 4);   // 36 on 7 courts -> 28 on, 8 sit out per block
  const fresh = () => E.generate(players, { seed: 4 });
  const s0 = fresh(), t = s0.blocks[2].time, blk = s0.blocks[2];
  const singlesOn = blk.games.flatMap(g => g.teams.flat()).filter(n => !players[n].partner);
  // plain swap between two singles in different games
  let s = fresh();
  const g1 = blk.games.findIndex(g => g.teams.flat().includes(singlesOn[0]));
  const other = singlesOn.find(n => blk.games.findIndex(g => g.teams.flat().includes(n)) !== g1);
  let r = E.swapPlayers(s, t, singlesOn[0], other);
  assert.ok(r.changes.length && !r.needs);
  same(E.validate(s).problems, []);
  // swap someone on court with someone sitting out (single, with games to spare)
  s = fresh();
  const counts = E.gamesPlayed(s);
  const sitter = s.blocks[2].sittingOut.find(n => !players[n].partner);
  const spare = singlesOn.find(n => counts[n] > s.settings.minBlocks);
  if (sitter && spare) {
    r = E.swapPlayers(s, t, spare, sitter);
    assert.match(r.changes[0], /in for/);
    same(E.validate(s).problems, []);
  }
  // split a fixed pair: asks first, then splits for that game only
  s = fresh();
  const pairOn = (s.blocks[2].games.flatMap(g => g.teams).find(tm => players[tm[0]].partner === tm[1]) || []).slice();
  if (pairOn.length) {
    const target = s.blocks[2].games.flatMap(g => g.teams.flat()).find(n => !players[n].partner && !pairOn.includes(n));
    r = E.swapPlayers(s, t, pairOn[0], target);
    assert.equal(r.needs, "pair");
    same(E.validate(s).problems, [], "nothing changed yet");
    r = E.swapPlayers(s, t, pairOn[0], target, { splitPairs: true });
    same(E.validate(s).problems, [], "recorded split passes");
    assert.ok(s.pairBreaks.some(pb => pb.time === t));
    // move partner too
    const s2 = fresh();
    const r2 = E.swapPlayers(s2, t, pairOn[0], target);
    if (r2.canMove) { E.swapPlayers(s2, t, pairOn[0], target, { movePartners: true }); same(E.validate(s2).problems, []); }
  }
  // hour guard: 40 players on 5 courts, everyone exactly 4 -> nobody can be swapped out
  const tight = E.generate(roster(40, 0, 1), { closedCourts: [6, 7], seed: 1 });
  const tb = tight.blocks[0], onc = tb.games[0].teams[0][0], off = tb.sittingOut[0];
  assert.throws(() => E.swapPlayers(tight, tb.time, onc, off), /would only play/);
  assert.throws(() => E.swapPlayers(tight, tb.time, off, tb.sittingOut[1]), /both sitting out/);
});

const strength = (s, g) => g.teams.flat().reduce((a, x) => a + s.players[x].skill, 0);

test("can't-play times: respected, pairs sit out together, guarantee kept", () => {
  for (let seed = 0; seed < 5; seed++) {
    const players = roster(40, 6, seed);            // Player 00 + 01 fixed pair
    players["Player 00"].unavailable = ["14:00"];   // late start: partner 01 waits too
    players["Player 30"].unavailable = ["14:00", "14:15", "15:30", "15:45"];   // arrives late AND leaves early
    players["Player 31"].unavailable = ["14:00", "14:15", "14:30", "14:45", "15:00"];   // only 3 free blocks
    const s = E.generate(players, { closedCourts: [6, 7], seed });
    same(E.validate(s).problems, [], `seed ${seed}`);
    const at = (t, n) => s.blocks.find(b => b.time === t).games.some(g => g.teams.flat().includes(n));
    for (const n of ["Player 00", "Player 01", "Player 30", "Player 31"]) assert.ok(!at("14:00", n), `${n} not on at 14:00`);
    assert.ok(s.blocks[0].away.includes("Player 01") && !s.blocks[0].sittingOut.includes("Player 00"), "away, not 'sitting out'");
    for (const t of ["15:30", "15:45"]) assert.ok(!at(t, "Player 30"));
    const c = E.gamesPlayed(s);
    assert.ok(c["Player 00"] >= 4 && c["Player 30"] >= 4, "late starter still gets the hour");
    assert.equal(c["Player 31"], 3, "only 3 free blocks -> plays all 3");
    // a person put on court when they can't play is caught
    const bad = JSON.parse(JSON.stringify(s));
    const g = bad.blocks[0].games[0]; const swapped = g.teams[0][0]; g.teams[0][0] = "Player 31";
    bad.blocks[0].away = bad.blocks[0].away.filter(n => n !== "Player 31"); bad.blocks[0].sittingOut.push(swapped);
    assert.match(E.validate(bad).problems.join(" "), /Player 31 is on Court \d but can't play then/);
  }
  const plan = E.planCapacity(Object.assign(roster(40, 0), { }), { start: "14:00", end: "16:00", block: 15, minMinutes: 60, closedCourts: [6, 7] });
  assert.equal(plan.need, 160); assert.equal(plan.slots, 160);
});

test("can't-play: thin block uses fewer courts; requests, swaps and capacity respect it", () => {
  const players = roster(30, 0, 3);
  Object.keys(players).slice(0, 14).forEach(n => { players[n].unavailable = ["14:00"]; });   // only 16 free at 14:00
  const s = E.generate(players, { seed: 3 });
  assert.equal(s.blocks[0].games.length, 4, "4 courts at 14:00");
  same(E.validate(s).problems, []);
  assert.throws(() => E.swapPlayers(s, "14:00", "Player 00", s.blocks[0].games[0].teams[0][0]), /can't play at 14:00/);
  assert.throws(() => E.generate(players, { seed: 3, requests: [{ a: "Player 00", b: "Player 20", type: "court", time: "14:00" }] }), /can't play at 14:00/);
  const r = E.generate(players, { seed: 3, requests: [{ a: "Player 00", b: "Player 20", type: "partners" }] });
  assert.notEqual(E.requestStatus(r)[0].time, "14:00");
  assert.ok(E.requestStatus(r)[0].met);
  // too few places once times are ticked
  const tight = roster(40, 0, 1);
  Object.keys(tight).slice(0, 30).forEach(n => { tight[n].unavailable = ["14:00", "14:15", "14:30", "14:45"]; });
  assert.throws(() => E.generate(tight, { seed: 1, closedCourts: [6, 7] }), /only \d+ playing places but \d+ are needed/);
});

test("court order: strongest to weakest in the chosen order, beginner court fixed", () => {
  for (let seed = 0; seed < 4; seed++) {
    const s = E.generate(roster(56, 8, seed), { seed, courtOrder: [3, 2, 1, 6, 7, 4, 5] });
    same(E.validate(s).problems, []);
    for (const b of s.blocks) {
      const byC = Object.fromEntries(b.games.map(g => [g.court, strength(s, g)]));
      const ord = [3, 2, 1, 6, 7, 4, 5].map(c => byC[c]);
      for (let i = 1; i < ord.length; i++) assert.ok(ord[i - 1] >= ord[i], `order ${b.time}`);
    }
  }
  // closed courts skipped, weakest game still on the last court in the order
  const s2 = E.generate(roster(40, 4, 2), { seed: 2, closedCourts: [6, 7], courtOrder: [3, 2, 1, 6, 7, 4, 5] });
  same(s2.settings.courtOrder, [3, 2, 1, 4, 5]);
  for (const b of s2.blocks) {
    const weakest = b.games.reduce((m, g) => (strength(s2, g) < strength(s2, m) ? g : m));
    assert.equal(strength(s2, b.games.find(g => g.court === 5)), strength(s2, weakest));
  }
  // fewer games than courts: beginner court still used, spare court comes out of the middle
  const s3 = E.generate(roster(20, 0, 1), { seed: 1, courtOrder: [3, 2, 1, 6, 7, 4, 5] });
  for (const b of s3.blocks) same(b.games.map(g => g.court).sort(), [1, 2, 3, 5, 6].sort());
  // re-ordering an existing schedule only changes court numbers
  const before = JSON.parse(JSON.stringify(s2));
  E.reorderCourts(s2, [5, 4, 3, 2, 1]);
  same(E.validate(s2).problems, []);
  s2.blocks.forEach((b, i) => {
    const key = g => g.teams.map(t => t.slice().sort().join("+")).sort().join(" v ");
    same(b.games.map(key).sort(), before.blocks[i].games.map(key).sort(), "same games");
    const weakest = b.games.reduce((m, g) => (strength(s2, g) < strength(s2, m) ? g : m));
    assert.equal(weakest.court, 1, "beginners now on Court 1");
  });
});

test("match requests: pair vs pair", () => {
  const sameSet = (t, u) => t.length === u.length && u.every(x => t.includes(x));
  const findMatch = (s, st) => s.blocks.find(b => b.time === st.time).games.find(g => g.court === st.court);
  for (let seed = 0; seed < 4; seed++) {
    const players = roster(40, 6, seed);   // fixed pairs: 00+01, 02+03, 04+05 ...
    // fixed pair vs two singles, twice
    const m1 = { type: "match", teams: [["Player 00", "Player 01"], ["Player 20", "Player 21"]], count: 2 };
    // splits Player 02 from fixed partner 03 for that game only, at a set time
    const m2 = { type: "match", teams: [["Player 02", "Player 22"], ["Player 23", "Player 24"]], time: "15:00" };
    const s = E.generate(players, { seed, closedCourts: [6, 7], requests: [m1, m2] });
    same(E.validate(s).problems, [], `seed ${seed}`);
    same([...new Set(Object.values(E.gamesPlayed(s)))], [4], "everyone's hour kept at exact capacity");
    const st = E.requestStatus(s);
    assert.equal(st.length, 3);
    assert.ok(st.every(x => x.met), JSON.stringify(st));
    const ones = st.filter(x => x.teams[0][0] === "Player 00");
    assert.notEqual(ones[0].time, ones[1].time, "twice, in different blocks");
    for (const x of st) {
      const g = findMatch(s, x);
      assert.ok((sameSet(g.teams[0], x.teams[0]) && sameSet(g.teams[1], x.teams[1])) || (sameSet(g.teams[0], x.teams[1]) && sameSet(g.teams[1], x.teams[0])), "exact sides");
    }
    const t2 = st.find(x => x.teams[0][0] === "Player 02");
    assert.equal(t2.time, "15:00");
    assert.ok(s.blocks.find(b => b.time === "15:00").games.some(g => g.teams.flat().includes("Player 03")), "split-off partner still plays then");
    for (const b of s.blocks) if (b.time !== "15:00") for (const g of b.games) for (const t of g.teams) if (t.includes("Player 02")) assert.ok(t.includes("Player 03"));
    assert.ok(!(s.pairBreaks || []).some(pb => pb.pair.includes("Player 00")), "teammates who are a fixed pair aren't 'split'");
  }
  const players = roster(40, 6, 1);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ type: "match", teams: [["Player 20", "Player 21"], ["Player 20", "Player 22"]] }] }), /twice/);
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ type: "match", teams: [["Player 00", "Player 20"], ["Player 01", "Player 21"]] }] }), /opposite sides/);
  players["Player 20"].unavailable = ["14:00"];
  assert.throws(() => E.generate(players, { seed: 1, requests: [{ type: "match", teams: [["Player 20", "Player 21"], ["Player 22", "Player 23"]], time: "14:00" }] }), /can't play at 14:00/);
  assert.throws(() => E.generate(players, { seed: 1, requests: [
    { type: "match", teams: [["Player 21", "Player 22"], ["Player 23", "Player 24"]], time: "14:30" },
    { type: "court", a: "Player 21", b: "Player 30", time: "14:30" }] }), /two game requests at 14:30/);
});
