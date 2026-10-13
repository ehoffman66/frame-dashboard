# sports.json: the frame's sports feed

The frame's Sports tab re-reads `docs/sports.json` in this repo (served at https://ehoffman66.github.io/frame-dashboard/sports.json) every 15 minutes. If it can't load the file it keeps the copy built into the page.
It's rebuilt by the "Frame sports feed" routine in the Home Dashboard project, twice a day at 8:12 AM and 11:12 PM ET, just after the two routines that refresh Erik's sports boards (Charlotte FC at 7:47 AM and 10:47 PM, Checkers at 7:55 AM). Each run:

1. Saves the current Charlotte FC Stretch Run page (https://claude.ai/artifact/AdwuPQgZTgTEi5NqfX7b1e) and Checkers Stats Board (https://claude.ai/artifact/RQHNuR36ka3DwdL73XeeSz) with the Artifact tool's `read` and `path: "index.html"`.
2. Runs `node scripts/build-sports.js <charlotte-fc.html> <checkers.html> docs/sports.json`, which pulls the data literals out of each page's script (`CLT`, `CLTP`, `FX`, `DEF` and the standings table; `DATA`) and reshapes them.
3. Commits `docs/sports.json` to `main` only if something other than `updated` changed.

If either board changes how it stores its data, `build-sports.js` stops with an error instead of writing a half-empty file, and the frame keeps showing the last good copy.

## Format

```json
{
  "updated": "2026-10-13T19:10:00-04:00",
  "clt": {
    "asof": "MLS standings through Oct 10",
    "rec": "13-8-7", "pts": 46, "place": "5th in the East",
    "last": "Beat Dallas 3-2 from 2-0 down, Oct 10",
    "leaders": "Pep Biel 12 goals, 8 assists · Idan Toklomati 11 goals",
    "form": 0.5, "homeAdv": 1.12, "leagueGoals": 3.21,
    "season": { "gf": 50, "ga": 40, "gp": 28 },
    "post": { "gf": 26, "ga": 17, "gp": 13 },
    "games": [{ "at": "2026-10-14T19:30", "opp": "Columbus", "home": false, "gf": 41, "ga": 46, "gp": 28 }],
    "table": [["Nashville", 63], ["Charlotte", 46]]
  },
  "chk": {
    "asof": "AHL stats through Oct 12",
    "rec": "2-2-0", "pts": 4, "place": "5th in the Atlantic",
    "last": "Won 2-1 in a shootout, Oct 11",
    "leaders": "Nate Smith 3 goals · Jack Devine 2 goals, 1 assist",
    "games": [{ "at": "2026-10-16", "opp": "Hartford", "home": true, "pick": "Checkers win 4-2", "why": "One sentence." }],
    "table": [["Hershey", ".750"], ["Charlotte", ".500"]]
  }
}
```

Rules:
- `at` is Charlotte (Eastern) wall time, with no offset: `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` when the time isn't known.
- `clt.games`: remaining games in order. `gf`, `ga` and `gp` are the opponent's season totals; the frame computes win/draw/loss odds from them with the same model as the Stretch Run page, using `form`, `homeAdv` and `leagueGoals`.
- `clt.table`: Eastern Conference top 5 plus Charlotte if it falls outside it, as `[short name, points]`.
- `chk.games`: next 5 games. `pick` is the board's latest pick written as a sentence ("Checkers win 4-2", "Hartford wins 3-2 in OT"), or `null`.
- `chk.table`: the Atlantic Division in AHL order (points percentage), as `[short name, ".625"]`.
- Charlotte's own row must be named exactly `Charlotte` in both tables; the frame highlights it.
- Keep `last` and `leaders` short; they're one line each on a 10" screen.
