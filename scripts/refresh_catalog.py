"""Refresh stock-only factual API metadata from official documentation."""

from __future__ import annotations

import argparse
import concurrent.futures
import html
import json
import re
import time
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

CATEGORIES = {
    24: ("basic", "基础数据"),
    15: ("market", "行情数据"),
    16: ("financial", "财务数据"),
    17: ("reference", "参考数据"),
    291: ("special", "特色数据"),
    330: ("margin", "两融及转融通"),
    342: ("moneyflow", "资金流向数据"),
    346: ("limit", "打板专题数据"),
}
BASE = "https://tushare.pro/document/2?doc_id="
DESTINATION = Path(__file__).resolve().parents[1] / "src/collector/catalog.json"


def fetch(doc_id: int) -> str:
    for attempt in range(3):
        try:
            with urllib.request.urlopen(BASE + str(doc_id), timeout=40) as response:
                return response.read().decode()
        except OSError:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("unreachable")


class TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        if tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        if tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def extract(entry: dict) -> dict:
    page = fetch(entry["doc_id"]).split('<div class="content col-md-9 col-sm-8 col-xs-12">', 1)[1]
    plain = html.unescape(re.sub("<[^>]+>", " ", page))
    match = re.search(r"接口\s*[：:]\s*([A-Za-z][A-Za-z_0-9]*)", plain)
    entry["api_name"] = match.group(1) if match else None
    entry["description"] = re.sub(r"\s+", " ", plain).strip()[:1300]
    for marker, key in (("输入参数", "params"), ("输出参数", "fields")):
        entry[key] = []
        heading = re.search(rf"<(?:strong|h[1-6])[^>]*>\s*{marker}\s*</(?:strong|h[1-6])>", page, re.I)
        if heading is None:
            continue
        table = re.search(r"<table.*?</table>", page[heading.end() :], re.S)
        if not table:
            continue
        parser = TableParser()
        parser.feed(table.group())
        for row in parser.rows[1:]:
            if row and re.fullmatch(r"[A-Za-z][A-Za-z_0-9]*", row[0]):
                entry[key].append(
                    {
                        "name": row[0],
                        "type": row[1] if len(row) > 1 else "",
                        "required": key == "params" and len(row) > 2 and row[2] == "Y",
                        "description": row[-1],
                    }
                )
    return entry


def build(entries: list[dict]) -> dict:
    result = []
    bar_params = next(entry["params"] for entry in entries if entry["doc_id"] == 109)
    for entry in entries:
        if entry["category_doc_id"] not in CATEGORIES:
            raise ValueError("Non-stock category rejected")
        slug, name = CATEGORIES[entry["category_doc_id"]]
        introduction = entry["description"].split("输入参数")[0]
        match = re.search(
            r"(?:单次|每次|单个请求|一次请求)[^。；\n]{0,50}?(\d[\d,]*)\s*(?:条|行)",
            introduction,
        )
        status = "http" if entry["api_name"] else "sdk_only"
        if "停" in entry["name"]:
            # 停复牌 is an active event API, not a discontinued interface.
            if re.search(r"[（(]停", entry["name"]):
                status = "discontinued"
        if re.search(r"[（(]旧", entry["name"]):
            status = "legacy"
        input_params = bar_params if entry["doc_id"] == 146 else entry["params"]
        params = [{**param, "description": param["description"][:180]} for param in input_params]
        if entry["api_name"] == "daily_basic":
            # Official documentation allows ts_code OR trade_date.
            for param in params:
                if param["name"] == "ts_code":
                    param["required"] = False
        result.append(
            {
                "id": str(entry["doc_id"]),
                "name": entry["name"],
                "category": slug,
                "category_name": name,
                "api_name": entry["api_name"] or "pro_bar",
                "status": status,
                "doc_url": BASE + str(entry["doc_id"]),
                "row_limit": int(match.group(1).replace(",", "")) if match else None,
                "params": params,
                "fields": [{"name": field["name"], "type": field["type"]} for field in entry["fields"]],
                "permission_note": "单独开通权限"
                if "单独开通" in introduction
                else "按接口积分与账号权限执行",
            }
        )
    if len({entry["id"] for entry in result}) != len(result):
        raise ValueError("Duplicate catalog entry")
    if not all(any(entry["category"] == slug for entry in result) for slug, _ in CATEGORIES.values()):
        raise ValueError("Incomplete stock categories")
    return {
        "version": "stock-catalog-v1",
        "verified_at": datetime.now(timezone.utc).isoformat(),
        "source_url": BASE + "14",
        "categories": [{"id": slug, "name": name} for slug, name in CATEGORIES.values()],
        "entries": result,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, help="Use previously fetched official metadata")
    args = parser.parse_args()
    if args.evidence:
        entries = json.loads(args.evidence.read_text())
    else:
        sidebar = fetch(14).split('<div id="jstree">', 1)[1]
        groups = re.findall(
            r'<li class="  in"><a href="/document/2\?doc_id=(\d+)">([^<]+)</a>'
            r"\s*<ul[^>]*>(.*?)</ul>",
            sidebar,
            re.S,
        )
        entries = []
        for category_id, _, body in groups:
            if int(category_id) not in CATEGORIES:
                continue
            for doc_id, name in re.findall(r'<a href="/document/2\?doc_id=(\d+)">([^<]+)</a>', body):
                entries.append(
                    {
                        "doc_id": int(doc_id),
                        "name": html.unescape(name),
                        "category_doc_id": int(category_id),
                    }
                )
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            entries = list(executor.map(extract, entries))
    catalog = build(entries)
    DESTINATION.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {len(catalog['entries'])} stock entries: {DESTINATION}")


if __name__ == "__main__":
    main()
