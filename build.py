#!/usr/bin/env python3
"""Build Lot Tracker HTML: inject static pre-rendered list from SEED into templates."""
from __future__ import annotations
import json, re, html, base64
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SEED_PATH = ROOT / "seed.json"
ICON_PATH = ROOT / "lot-tracker-icon.png"
TEMPLATE = ROOT / "index.template.html"
OUT_INDEX = ROOT / "index.html"
OUT_STANDALONE = ROOT / "lot-tracker-standalone.html"
MANIFEST = ROOT / "manifest.webmanifest"


def esc(s: str) -> str:
    return html.escape(str(s or ""), quote=True)


def sort_key(c: dict):
    return (c.get("make") or "", c.get("model") or "", c.get("stock") or "")


def miles_fmt(m):
    try:
        return f"{int(m):,}"
    except Exception:
        return str(m or "")


def lot_label(lot: str) -> str:
    if lot == "AAA":
        return "AAA"
    return f"Lot {lot}"


def lot_cls(lot: str) -> str:
    if lot == "12":
        return "l12"
    if lot == "1":
        return "l1"
    if lot == "AAA":
        return "laaa"
    return "l9"


WS_COLOR = {
    "Ready for lot": "green",
    "Waiting on parts": "orange",
    "Needs motor or transmission": "red",
    "Ready to come into shop": "yellow",
    "In the shop": "blue",
    "Ready for truck": "green",
}


def card_html(c: dict) -> str:
    has = " has" if c.get("issues") else ""
    lot = c.get("lot") or "9"
    lc = lot_cls(lot)
    ws = c.get("workStatus") or ""
    ws_color = WS_COLOR.get(ws, "")
    ws_border = f" ws-border-{ws_color}" if ws_color else ""
    inop = bool(c.get("inop"))
    inop_cls = " inop" if inop else ""
    color = f" · {esc(c['color'])}" if c.get("color") else ""
    miles = miles_fmt(c.get("miles"))
    purchased = c.get("purchased") or "no purchase date"
    meta2 = f"{miles} mi · purchased {esc(purchased)}" if c.get("miles") else f"purchased {esc(purchased)}"
    issue = f'<div class="issue">{esc(c["issues"])}</div>' if c.get("issues") else ""
    flag = f'<div class="warn">{esc(c["flag"])}</div>' if c.get("flag") else ""
    badge = f'<div class="ws-badge ws-{ws_color}">{esc(ws)}</div>' if ws and ws_color else ""
    inop_badge = '<div class="inop-badge">INOP</div>' if inop else ""
    vin = esc(c.get("vin") or "—")
    sid = esc(c.get("stock") or "")
    return (
        f'<article class="card {lc}{has}{ws_border}{inop_cls}" id="s{sid}">'
        f'<div class="top"><span class="stock">{sid}</span>'
        f'<span class="lot {lc}">{esc(lot_label(lot))}</span></div>'
        f'<div class="meta">{esc(c.get("year"))} {esc(c.get("make"))} {esc(c.get("model"))}{color}</div>'
        f'<div class="meta">{meta2}</div>'
        f'<div class="meta vin">VIN (last 6): {vin}</div>'
        f'{inop_badge}{badge}{issue}{flag}'
        f"</article>"
    )


def section_html(lot: str, cars: list) -> str:
    cars = sorted(cars, key=sort_key)
    cards = "\n".join(card_html(c) for c in cars)
    return (
        f'<section class="lot-section" id="static-lot-{lot}">'
        f'<h2 class="lot-head lot-head-{lot}">{lot_label(lot)} · {len(cars)} cars</h2>'
        f"{cards}</section>"
    )


def section_html_inop(cars: list) -> str:
    cars = sorted(cars, key=sort_key)
    cards = "\n".join(card_html(c) for c in cars)
    return (
        f'<section class="lot-section" id="static-lot-9inop">'
        f'<h2 class="lot-head lot-head-9inop">Lot 9 Inop · {len(cars)} cars</h2>'
        f"{cards}</section>"
    )


def static_list(seed: list) -> str:
    lot9 = [c for c in seed if c.get("lot") == "9" and not c.get("inop")]
    lot9_inop = [c for c in seed if c.get("lot") == "9" and c.get("inop")]
    lot12 = [c for c in seed if c.get("lot") == "12"]
    lot1 = [c for c in seed if c.get("lot") == "1"]
    lot_aaa = [c for c in seed if c.get("lot") == "AAA"]
    jump_bits = ['<a href="#static-lot-9">Jump to Lot 9</a>']
    if lot9_inop:
        jump_bits.append('<a href="#static-lot-9inop">Jump to Lot 9 Inop</a>')
    jump_bits.append('<a href="#static-lot-12">Jump to Lot 12</a>')
    if lot1:
        jump_bits.append('<a href="#static-lot-1">Jump to Lot 1</a>')
    if lot_aaa:
        jump_bits.append('<a href="#static-lot-AAA">Jump to AAA</a>')
    jumps = (
        '<nav class="jumps" id="static-jumps">'
        + " · ".join(jump_bits)
        + "</nav>"
        '<noscript><p class="noscript-note">Search and editing need this page opened in Safari '
        "(not a Files/Quick Look preview). Meanwhile, use Find on Page for stock numbers.</p></noscript>"
    )
    out = jumps + section_html("9", lot9)
    if lot9_inop:
        out += section_html_inop(lot9_inop)
    out += section_html("12", lot12)
    # Lot 1 & AAA: holding places — omit empty sections (seed starts at zero)
    if lot1:
        out += section_html("1", lot1)
    if lot_aaa:
        out += section_html("AAA", lot_aaa)
    return out


def inject(template: str, static: str, seed_json: str) -> str:
    out = template.replace("<!--STATIC_LIST-->", static)
    out = out.replace("/*SEED_JSON*/null/*END_SEED*/", seed_json)
    return out


def main():
    seed = json.loads(SEED_PATH.read_text())
    n9 = sum(1 for c in seed if c["lot"] == "9")
    n9inop = sum(1 for c in seed if c["lot"] == "9" and c.get("inop"))
    n12 = sum(1 for c in seed if c["lot"] == "12")
    n1 = sum(1 for c in seed if c["lot"] == "1")
    naaa = sum(1 for c in seed if c["lot"] == "AAA")
    print(f"SEED: {len(seed)} cars — Lot 9: {n9} (inop {n9inop}), Lot 12: {n12}, Lot 1: {n1}, AAA: {naaa}")
    static = static_list(seed)
    seed_json = json.dumps(seed, separators=(",", ":"))
    template = TEMPLATE.read_text()
    index = inject(template, static, seed_json)
    OUT_INDEX.write_text(index)

    # Standalone: embed icon as data URI, drop external icon/manifest deps that need hosting
    icon_b64 = base64.b64encode(ICON_PATH.read_bytes()).decode()
    data_uri = f"data:image/png;base64,{icon_b64}"
    standalone = index
    standalone = standalone.replace('href="lot-tracker-icon.png"', f'href="{data_uri}"')
    standalone = standalone.replace('src="lot-tracker-icon.png"', f'src="{data_uri}"')
    # Keep manifest link but also inline a note; for file:// standalone, relative manifest may 404 — leave it
    OUT_STANDALONE.write_text(standalone)

    # Manifest
    MANIFEST.write_text(json.dumps({
        "name": "Lot Tracker",
        "short_name": "Lot Tracker",
        "description": "David's Auto Sales — Lot 9, Lot 12, Lot 1, and AAA inventory",
        "start_url": "./index.html",
        "display": "standalone",
        "background_color": "#12171c",
        "theme_color": "#12171c",
        "icons": [{
            "src": "lot-tracker-icon.png",
            "sizes": "180x180",
            "type": "image/png",
            "purpose": "any maskable"
        }]
    }, indent=2) + "\n")

    print(f"Wrote {OUT_INDEX} ({OUT_INDEX.stat().st_size} bytes)")
    print(f"Wrote {OUT_STANDALONE} ({OUT_STANDALONE.stat().st_size} bytes)")
    print(f"Wrote {MANIFEST}")


if __name__ == "__main__":
    main()
