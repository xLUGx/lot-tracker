# Lot Tracker

Lot Tracker for David's Auto Sales — Lot 9, Lot 12, Lot 1, and AAA inventory.
Companion app: **Car Count** (`car-count/`) logs units moved to Lot 1.

Both apps sync edits through a PIN-protected cloud store so Home Screen apps and phones share one source of truth (iPhone gives each Home Screen web app its own localStorage).

## Open on iPhone

1. Open the site in **Safari**
2. Enter your 6-digit Lot code when asked (saved on this phone after unlock)
3. Tap **Share** → **Add to Home Screen** for Lot Tracker and/or Car Count

## Lot 1 and Car Count

Moving a car to Lot 1 (Move lot or the edit dialog) asks **Count this car in Car Count?** — Yes counts it, No moves it without counting (card shows *Not counted*), Cancel aborts the move. Change your mind later with the card's **Count** button or the editor's *Counts in Car Count* checkbox. Car Count's manual log always counts.

## Rebuild

Run `python3 build.py` to regenerate `index.html` from `index.template.html` and `seed.json`.

Master-list updates: edit `seed.json` and rebuild. `build.py` keeps per-field timestamps in `seed-ts.json` (0 = original baseline; build time when a master value changes). On phones, each field shows whichever is newer: the master value or the user's last edit of that field. To re-assert master values that did not change (e.g. a new Lot 12 list confirms cars are back on 12), run `python3 build.py --stamp 52171,52219` (default fields `lot,status`; override with `--fields`). Commit `seed-ts.json` with the rebuild.

## Cloud restore

Every successful cloud write keeps a backup of the previous document (last ~200 per key) in the private `backups` table. To restore, an admin can copy a `backups` row back into `lot_private.docs` (or bump `version` and set `data`) via the database console — there is no public restore UI.
