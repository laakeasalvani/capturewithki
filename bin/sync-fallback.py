#!/usr/bin/env python3
"""Refresh the wording baked into index.html from what Khiara actually has.

index.html ships with the site's original copy so a visitor still sees a real
page when Firebase is unreachable. That copy went stale — it still said
"Hawai'i" long after she moved to Portland — so the emergency fallback was
showing outdated information.

Run this occasionally, and always before a release:

    ./bin/sync-fallback.py            # show what would change
    ./bin/sync-fallback.py --write    # actually change it

Deliberately NOT automatic. Wiring this to run on every edit would mean a
GitHub token stored in the cloud and an unsupervised process rewriting the one
file that must always keep exactly 114 data-cms-id markers. Losing one silently
costs Khiara the ability to edit part of her own site. The fallback only
matters when Firebase is down, so being a few edits behind is harmless; a
damaged index.html is not.

It refuses to write if the marker count or the contact-form ids change.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

PROJECT = "capturewithki-69dd3"
DOC = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/content/site"
ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

EXPECTED_MARKERS = 131  # 114 + 17 menu labels (9 ids, shared between the top menu and footer)
FORM_IDS = ["n1", "n2", "em", "ph", "dt", "cl", "ms", "send", "sent"]


def counts(html):
    markers = len(re.findall(r"data-cms-id", html))
    ids = sum(1 for i in FORM_IDS if f'id="{i}"' in html)
    return markers, ids


def fetch():
    with urllib.request.urlopen(DOC, timeout=30) as r:
        return json.load(r).get("fields", {})


def main():
    write = "--write" in sys.argv
    html = INDEX.read_text()

    before_markers, before_ids = counts(html)
    if before_markers != EXPECTED_MARKERS or before_ids != len(FORM_IDS):
        print(f"refusing to start: index.html already looks wrong "
              f"({before_markers} markers, {before_ids}/{len(FORM_IDS)} form ids)")
        return 1

    try:
        fields = fetch()
    except Exception as e:
        print(f"could not read her content: {e}")
        return 1

    changed = []
    out = html

    for cms_id, value in fields.items():
        stored = value.get("stringValue")
        if stored is None:
            continue
        stored = stored.strip()
        # She cleared several spots on purpose, and a cleared field is stored as
        # "<br>" or "&nbsp;", not as "". Those are empty to a reader but not to
        # a string check — the first dry run would have baked "<br>" over real
        # wording, which is exactly the hole this fallback exists to prevent.
        # So emptiness is judged on visible text, not on length.
        visible = re.sub(r"<[^>]*>", "", stored)
        visible = re.sub(r"&nbsp;|&#160;|\s", "", visible)
        if not visible:
            continue

        # Only text fields. Attributes and <select> options are edited through
        # prompts and are a different shape.
        pattern = re.compile(
            r'(<(\w+)([^>]*\bdata-cms-id="' + re.escape(cms_id) + r'"[^>]*\bdata-cms-type="text"[^>]*)>)(.*?)(</\2>)',
            re.S)
        m = pattern.search(out)
        if not m:
            continue
        if m.group(4) == stored:
            continue

        changed.append((cms_id, m.group(4)[:48], stored[:48]))
        out = out[:m.start(4)] + stored + out[m.end(4):]

    after_markers, after_ids = counts(out)
    if after_markers != EXPECTED_MARKERS or after_ids != len(FORM_IDS):
        print(f"REFUSING TO WRITE — the edit would damage index.html "
              f"({after_markers} markers, {after_ids}/{len(FORM_IDS)} form ids)")
        return 1

    if not changed:
        print("built-in wording already matches what she has. Nothing to do.")
        return 0

    print(f"{len(changed)} field(s) would change:\n")
    for cms_id, old, new in changed:
        print(f"  {cms_id}\n    was: {old}\n    now: {new}\n")

    if not write:
        print("Nothing written. Re-run with --write to apply.")
        return 0

    INDEX.write_text(out)
    print(f"index.html updated. {after_markers} markers and {after_ids}/{len(FORM_IDS)} "
          f"form ids intact.\nRun ./bin/stamp-version.sh before committing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
