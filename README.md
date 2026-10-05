# Lot Tracker

Lot Tracker for David's Auto Sales — Lot 9, Lot 12, Lot 1, and AAA inventory.
Companion app: **Car Count** (`car-count/`) logs units moved to Lot 1.

Both apps sync edits through a PIN-protected cloud store so Home Screen apps and phones share one source of truth (iPhone gives each Home Screen web app its own localStorage).

## Open on iPhone

1. Open the site in **Safari**
2. Enter your 6-digit Lot code when asked (saved on this phone after unlock)
3. Tap **Share** → **Add to Home Screen** for Lot Tracker and/or Car Count

## Rebuild

Run `python3 build.py` to regenerate `index.html` from `index.template.html` and `seed.json`.

## Cloud restore

Every successful cloud write keeps a backup of the previous document (last ~200 per key) in the private `backups` table. To restore, an admin can copy a `backups` row back into `lot_private.docs` (or bump `version` and set `data`) via the database console — there is no public restore UI.
