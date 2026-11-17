"""Fetch official stock API permission evidence without sending account credentials."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKERS = re.compile(r"积分|权限|频次|频率|每分钟|每.*?次|限量|上限|限频|限制|限额")


def fetch(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=40) as response:
                page = response.read().decode("utf-8")
            break
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    content = page.split('<div class="content col-md-9 col-sm-8 col-xs-12">', 1)
    if len(content) != 2:
        raise ValueError(f"Official document content missing: {url}")
    body = content[1].split('<div id="jstree">', 1)[0]
    body = re.sub(r"<(?:script|style)\b[^>]*>.*?</(?:script|style)>", "", body, flags=re.S)
    text = html.unescape(re.sub("<[^>]+>", " ", body))
    text = re.sub(r"\s+", " ", text).strip()
    intro = re.split(r"输入参数|接口参数|输出参数|参数说明", text, maxsplit=1)[0]
    paragraphs = []
    for block in re.findall(r"<(?:p|tr)\b[^>]*>(.*?)</(?:p|tr)>", body, re.S):
        plain = re.sub(r"\s+", " ", html.unescape(re.sub("<[^>]+>", " ", block))).strip()
        if MARKERS.search(plain) and len(plain) < 1800:
            paragraphs.append(plain)
    return {
        "url": url,
        "sha256": hashlib.sha256(page.encode()).hexdigest(),
        "introduction": intro[:2500],
        "permission_evidence": list(dict.fromkeys(paragraphs)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    catalog = json.loads((ROOT / "src/collector/catalog.json").read_text(encoding="utf-8"))

    def audit(entry):
        return {
            "id": entry["id"],
            "api_name": entry["api_name"],
            "name": entry["name"],
            **fetch(entry["doc_url"]),
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        entries = list(executor.map(audit, catalog["entries"]))
    result = {
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "sources": [fetch(f"https://tushare.pro/document/1?doc_id={doc}") for doc in (290, 108)],
        "entries": entries,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Fetched {len(entries)} official stock documents and two permission tables")


if __name__ == "__main__":
    main()
