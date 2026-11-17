"""Build reviewed permission metadata from the official audit evidence."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERAL = "https://tushare.pro/document/1?doc_id=290"
OVERVIEW = "https://tushare.pro/document/1?doc_id=108"

# Explicit resolutions for documents with trials, missing headings, or contradictory summaries.
MINIMUM = {
    "100": None,
    "48": None,
    "146": 2000,
    "109": 120,
    "160": 3000,
    "292": 8000,
    "328": 5000,
    "345": 6000,
    "267": 6000,
}
INDEPENDENT = {
    "329": ("盘前股本", 500),
    "372": ("A股日线RT", 50),
    "370": ("A股历史分钟", 500),
    "374": ("A股分钟RT", 500),
    "457": ("A股分钟RT", 500),
    "353": ("集合竞价成交", 500),
    "354": ("集合竞价成交", 500),
    "369": ("集合竞价成交", 500),
}
NOTES = {
    "100": "接口页未公布积分门槛或频率；不推断为免费或无限制。",
    "48": "接口页及积分最低分值总表均未公布该接口门槛；不推断为免费或无限制。",
    "160": "接口页写120分，最低分值总表写3000分；保守采用3000分并保留冲突。",
    "107": "接口页要求5000积分，最低分值总表写2000分；采用接口页较高门槛。",
    "292": (
        "2000积分仅每天10次试用；8000积分正式权限每天100000次。"
        "总表将盈利预测列为10000分特色权限，保留冲突，以接口页明确8000档为准；该档未公布分钟频率。"
    ),
    "293": "8000积分沿用5000档每天20000次。接口页未给出8000档分钟频率；不套用10000档特色300次。",
    "294": "8000积分沿用5000档每分钟200次、每天20000次。",
    "267": (
        "接口页写6000积分，总表将券商金股列为10000分特色权限；"
        "保留冲突，以接口页门槛为准，8000档分钟频率未公布。"
    ),
    "370": "接口页每天300000次、滚动24小时窗口；历史起点2010年与总表2009年有差异，以接口页为准。",
    "146": "SDK动态复权，无独立HTTP请求额度；每个行情/复权因子子请求分别限流。",
    "109": "股票日/周/月及复权权限取决于实际子接口；分钟须独立授权，本采集器仅允许股票日/周/月。",
}


def build(audit):
    entries = []
    for source in audit["entries"]:
        doc_id = source["id"]
        text = " ".join([source["introduction"], *source["permission_evidence"]])
        points = re.search(r"(\d+)\s*积分(?![：:])|(\d+)\s*分可调取", text)
        minimum = int(points.group(1) or points.group(2)) if points else None
        minimum = MINIMUM.get(doc_id, minimum)
        independent = INDEPENDENT.get(doc_id)
        if minimum is None and doc_id not in {"100", "48"} and not independent:
            raise ValueError(f"Unreviewed permission requirement: {doc_id}")
        if independent:
            minimum = None
            rpm, rate_source = independent[1], "independent_permission_table"
        elif doc_id == "25":
            rpm, rate_source = 50, "interface_document"
        elif doc_id in {"261", "294"}:
            rpm, rate_source = 200, "interface_document"
        elif doc_id in {"296", "328", "355", "298", "356", "357", "347", "27", "332", "331", "333", "334"}:
            rpm, rate_source = 500, "interface_document"
        elif doc_id in {"100", "48", "292", "293", "267", "275", "364", "399"}:
            rpm, rate_source = None, "not_documented_for_8000"
        elif minimum is not None and minimum <= 8000:
            rpm, rate_source = 500, "regular_points_table"
        else:
            rpm, rate_source = None, "insufficient_points"
        daily = {"292": 100000, "293": 20000, "294": 20000, "370": 300000}.get(doc_id)
        excerpts = []
        for paragraph in source["permission_evidence"]:
            for sentence in re.split(r"[。；]", paragraph):
                if re.search(r"积分|权限|每分钟|频次|频率|限量|总量", sentence):
                    # Store only the factual restriction, not full documentation/examples.
                    begin = re.search(r"积分要求|积分：|权限：|限量：|至少需要|不同数据对应", sentence)
                    fragment = sentence[begin.start() :] if begin else sentence
                    if len(fragment) <= 600:
                        excerpts.append(fragment.strip())
        kind = "independent" if independent else ("derived" if doc_id in {"109", "146"} else "points")
        if doc_id in {"100", "48"}:
            kind = "undocumented"
        access = (
            "requires_independent_permission"
            if independent
            else "undocumented"
            if minimum is None
            else "insufficient_points"
            if minimum > 8000
            else "points_satisfied"
        )
        entries.append(
            {
                "id": doc_id,
                "api_name": source["api_name"],
                "name": source["name"],
                "doc_url": source["url"],
                "document_sha256": source["sha256"],
                "minimum_points": minimum,
                "permission_kind": kind,
                "independent_permission": independent[0] if independent else None,
                "account_points": 8000,
                "account_access": access,
                "documented_rpm": rpm,
                "configured_rpm": rpm or 30,
                "rate_source": rate_source,
                "daily_limit": daily,
                "quota_window": "rolling_24h" if doc_id == "370" else ("calendar_day" if daily else None),
                "quota_scope": "this_collector_only",
                "permission_verified": False,
                "sources": [source["url"], GENERAL] + ([OVERVIEW] if doc_id in {"160", "107", "146"} else []),
                "evidence": list(dict.fromkeys(excerpts)),
                "note": NOTES.get(doc_id, ""),
            }
        )
    return {
        "version": "stock-permissions-8000-v1",
        "verified_at": audit["verified_at"],
        "account_points": 8000,
        "account_points_source": "user_declared",
        "general_doc_url": GENERAL,
        "overview_doc_url": OVERVIEW,
        "sources": [{"url": item["url"], "sha256": item["sha256"]} for item in audit["sources"]],
        "precedence": (
            "explicit_interface_restriction_then_regular_points_table; unresolved_8000_rate_uses_30"
        ),
        "entries": entries,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "src/collector/permissions.json")
    args = parser.parse_args()
    result = build(json.loads(args.evidence.read_text(encoding="utf-8")))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved reviewed 8000-point restrictions for {len(result['entries'])} catalog entries")


if __name__ == "__main__":
    main()
