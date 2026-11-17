# Padel Pairing

A scheduling tool for the University of Bath padel club's Wednesday sessions. It takes the week's sign-ups and builds the whole afternoon: up to 56 players across 7 courts, 15-minute games, everyone guaranteed at least an hour on court, games matched by skill, and partners and opponents rotated so people meet new faces. I'm on the club committee and built it to replace doing the pairings by hand.

**[Try it live](https://willcallo.github.io/padel-pairing/)**: press "Try it with example sign-ups" to load made-up players, then **Make schedule**.

## What it does

- **Imports sign-ups** straight from the Luma event export: names, skill level, gender, court preference, and who they want to play with.
- **Builds the schedule**: one court map per 15-minute block, strongest game on the first court down to the beginner court.
- **Handles the awkward bits**: fixed pairs, friend groups, single-gender court requests, closed courts, people who arrive late or leave early, and specific game requests ("put these two against each other at 14:30").
- **Checks its own work**: after every change a rules check confirms nobody is double-booked, pairs stay together, open courts are full, and everyone gets their hour.
- **Fixes dropouts**: mark someone as gone and only their slots change, filled from the people sitting out.
- **Exports a PDF** for the club group chat. Skills, genders, and emails never appear in it.

## How it works

**Matching sign-ups.** People type partner requests however they like ("AB123, CD456", "Sam and Alex", typos included). Each request is matched against names and uni usernames, with edit-distance matching, so swapped digits and small typos still find the right person. Two people who name each other become a fixed pair. Anyone linked by a chain of requests becomes a friend group that gets to share a court.

**Building each 15-minute block** happens in two steps:

1. **Who plays.** Every player gets a priority score: anyone who has to play now to still reach their hour goes first, then whoever has played least so far, with a nudge to rest people who've played several blocks in a row. It picks the combination of fixed pairs and singles with the highest total priority that exactly fills the open courts.
2. **Who plays whom.** Players start in rough teams sorted by skill, then a local search keeps swapping players between teams, and teams between courts, whenever a swap lowers the total cost. Each game's cost adds up:
   - uneven teams (squared difference in team skill)
   - a wide skill gap between the best and worst player on the court
   - meeting the same opponents again, or singles partnering the same person again
   - breaking someone's single-gender request

   with bonuses for friend groups sharing a court and for game requests. The search runs from more than one random start and keeps the best result.

**The whole session.** If a finished schedule leaves anyone short of their hour or misses a game request, it tries again with a new random seed. A separate validator then checks every rule independently of the code that built the schedule.

## Tech

- A single `index.html`: plain JavaScript, no framework, no build step, and no server. It runs entirely in the browser, and the current week is saved in the browser's local storage.
- PDF export with jsPDF.
- `padel.py` is the original command-line version in Python, kept as a backup.
- Tests: 23 for the app engine (`node --test test_engine.mjs`) and 15 for the Python version (`python -m unittest test_padel`).

## How I built it

I built this with [Claude Code](https://claude.com/claude-code) as a coding assistant, starting with a command-line Python version and then moving to the browser app. I set the rules from running real sessions (what organisers need, what players complain about) and added them one at a time.

---

# Organiser guide

## Using the app (recommended)

Open `index.html`, or the live link above. Nothing to install.

1. **Luma → event → Guests → Download CSV**, then in the app press **Choose Luma CSV** (or paste the CSV). Only approved guests come in; waitlist/declined are skipped.
   The app reads the form questions: name, uni email, skill level (1-5), gender, mixed or single-gender courts, partner (optional).
   - Skill: Beginner = 1, Lower Intermediate = 2, Higher Intermediate = 3, Lower Advanced = 4, Higher Advanced = 5.
   - The "play with" answer can be names, nicknames or uni usernames ("Sam", "Jo Bloggs", `AB123, CD456`); comments like "but mix it up" are ignored. Only people who signed up count.
   - **Named one person:** partners for the whole session. If several people named the same person (or it chains, A picks B who picks C), that person's games are split: they partner each of them about equally and play as a single otherwise.
   - **Named two or more:** no fixed partner (partners mix), and the whole group (them plus who they named, plus those people's fixed partners) plays on one court together in 2 of their blocks. These show in the Game requests panel as "from sign-ups" and can be removed.
2. Check the import messages (e.g. a partner who hasn't signed up, or a single-gender request with very few people to play with) and fix anything in the table.
3. Courts not ours this week? Open **Session settings** and tap them off under "Courts we have" (e.g. 6 and 7). They show as CLOSED on the maps, and the player limit drops to match (5 courts = 40 players for an hour each). **Start a new week** reopens them all.
   **Court order** (same settings panel): arrange the open courts from strongest game to weakest with the arrows. The weakest game always goes on the last court in the list (the beginner court), even on quieter weeks. It carries over to next week. Changing it after making the schedule only changes court numbers, not who plays whom.
   **Times someone can't play**: in the player list tap "Plays all session" under their name and tick the times they can't make (e.g. 14:00 for a late start). A fixed pair sits out together. They show as "not playing at this time" (not "sitting out"), still get their hour from the times they can play, and the bottom bar warns if someone can't reach it.
4. Press **Make schedule**. The **Organiser check** shows a **Rules check** card: nobody double-booked, pairs together, open courts full, no closed court used, nobody missing, everyone gets their hour. It re-runs after every dropout.
   - **Game requests** (Sign-ups tab, before making it): pick two people and Partners / Opponents / Same court, at any time or a set time, e.g. Alex + Sam as partners. If either is in a fixed pair, that pair is split for that one game only (the other half still plays then) and is back together for every other game.
   - **Swaps** (Schedule tab, Courts, **Edit**): pick a time, tap one person then another (on court or sitting out) to swap their places. Nothing else moves. If it would split a fixed pair it asks first: split for this game only, or move their partner too. Swaps go in the changes message and can be undone. Someone can't be swapped out if that would leave them under their hour.
5. Press **Save PDF** and post it in the group chat: one court map per 15-minute block (numbers in yellow vs white, "Next on" under each court), then a "who plays when" list so everyone can find their number.
6. Someone drops out? **Schedule → Someone dropped out**, pick them and the time. Only their slots change, filled from people sitting out (closest skill first, then whoever has played least). Copy the short changes message into the chat and save a fresh PDF.

What it guarantees / tries for:
- Everyone plays at least an hour (max 56 players on 7 courts). Over that it tells you how many to remove.
- Fixed pairs stay together; singles get a new partner each block.
- Games matched by skill; opponents rotate.
- Single-gender requests are met whenever the numbers allow. If they can't be without cutting someone's play time, the organiser check shows exactly who and when.
- Skills, genders, and emails never appear in the PDF. Email is only used to merge duplicate sign-ups.
- Only the current week is remembered (so you can handle dropouts later from your phone). "Start a new week" clears it. Nothing about players carries over between weeks.

## Command-line version (backup)

`padel.py` is the original terminal version. It doesn't know about gender or Luma; the app replaces it.

Makes the 14:00-16:00 schedule (15-minute blocks, 7 courts) for uni rec padel and patches it when people drop out.

- Fixed pairs stay together all session; singles get a new partner (another single) each block
- Games are matched by skill (1-5), strongest game on Court 1 down to weakest on Court 7
- Opponents and singles' partners rotate so people meet new faces
- **Everyone is guaranteed at least an hour of play.** 7 courts x 4 players x 8 blocks = 224 slots, so the max is **56 players** (8 per court). More than that and the script refuses and tells you how many to cut.

Needs Python 3.8+ and nothing else.

### Each week

1. Edit `players.csv` (Excel/Sheets is fine, save as CSV):

   ```
   name,skill,partner
   Alex Smith,4,Jo Brown
   Jo Brown,3,
   Sam Lee,2,
   ```

   - `skill` is 1 (beginner) to 5 (best)
   - `partner` only for people who asked to play together. Listing it on one of the two rows is enough.
   - Someone not coming? Delete their row.

2. Make the schedule:

   ```bash
   python padel.py players.csv
   ```

   This writes `schedule.txt` (paste it into the group chat, times are bold in WhatsApp) and `schedule.json` (keep it, it's needed for dropouts). It also prints an organiser summary to the terminal: play time per person, repeat opponents, skill gaps.

   Don't like it? Run again with a different `--seed 2`. The same seed + same CSV always gives the same schedule.

### Someone drops out after you've posted it

```bash
python padel.py drop schedule.json "Sam Lee"
```

Leaving partway through? Say when their first missed block is:

```bash
python padel.py drop schedule.json "Sam Lee" --from 15:00
```

Several at once: `python padel.py drop schedule.json "Sam Lee" "Jo Brown"`

Nobody else gets moved. In each block the dropout was due to play, their spot goes to someone **sitting out that block**, picked by closest skill first, then who's had the fewest games. Fixed pairs aren't split up to fill a gap. If the dropout was in a fixed pair, their partner keeps all their games and gets a sub as partner.

It prints a short changes message to paste in the chat:

```
*Changes (Sam Lee out from 15:00)*
15:00 C3: Will Black in for Sam Lee
15:30 C3: Holly Lane in for Sam Lee
```

and rewrites `schedule.txt` / `schedule.json`. If nobody is free in a block (small turnout), the game is marked "NEEDS 1 PLAYER".

### Options

| Option | Default | |
|---|---|---|
| `--courts` | 7 | |
| `--start` / `--end` | 14:00 / 16:00 | |
| `--block` | 15 | minutes per block |
| `--min-minutes` | 60 | guaranteed play time per person |
| `--seed` | random | printed in the summary so you can reproduce it |
| `--out` | schedule.txt | the .json is saved next to it |

Tuning knobs are constants at the top of `padel.py`: e.g. `W_OPP` (how hard to avoid repeat opponents) and `DROP_EXTRA_GAME` (raise it if you'd rather dropout slots be shared out more evenly, at the cost of a slightly worse skill match).
