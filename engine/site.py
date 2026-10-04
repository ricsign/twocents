"""Embed pick.json into site/app.html → docs/index.html (single self-contained page; also fetches /data/pick.json live)."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "site" / "app.html"
OUT = ROOT / "docs" / "index.html"
TOKEN = "/*__PICK_DATA__*/null"


def build(doc: dict, template: Path = TEMPLATE, out: Path = OUT) -> Path:
    html = template.read_text()
    if TOKEN not in html:
        raise ValueError(f"{template} has no {TOKEN} token")
    payload = json.dumps(doc, separators=(",", ":"), allow_nan=False, default=str).replace("</", "<\\/")
    out.write_text(html.replace(TOKEN, payload, 1))
    return out


if __name__ == "__main__":
    build(json.loads((ROOT / "docs" / "data" / "pick.json").read_text()))
