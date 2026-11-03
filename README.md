# Padel Wednesday pairing

Makes the 14:00-16:00 schedule (15-minute blocks, 7 courts) for uni rec padel and patches it when people drop out.

- Fixed pairs stay together all session; singles get a new partner (another single) each block
- Games are matched by skill (1-5), strongest game on Court 1 down to weakest on Court 7
- Opponents and singles' partners rotate so people meet new faces
- **Everyone is guaranteed at least an hour of play.** 7 courts x 4 players x 8 blocks = 224 slots, so the max is **56 players** (8 per court). More than that and the script refuses and tells you how many to cut.

Needs Python 3.8+ and nothing else.

## Each week

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

## Someone drops out after you've posted it

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

## Options

| Option | Default | |
|---|---|---|
| `--courts` | 7 | |
| `--start` / `--end` | 14:00 / 16:00 | |
| `--block` | 15 | minutes per block |
| `--min-minutes` | 60 | guaranteed play time per person |
| `--seed` | random | printed in the summary so you can reproduce it |
| `--out` | schedule.txt | the .json is saved next to it |

Tuning knobs are constants at the top of `padel.py`: e.g. `W_OPP` (how hard to avoid repeat opponents) and `DROP_EXTRA_GAME` (raise it if you'd rather dropout slots be shared out more evenly, at the cost of a slightly worse skill match).

## Tests

```bash
python -m unittest test_padel
```
