from __future__ import annotations

import calendar
import itertools
import json
import re
from datetime import date, datetime, timedelta

import pandas as pd

from .client import CollectionFailure
from .models import MAX_SLICES, CollectorError
from .temporal import record_interval


def option(values, default=None):
    return {"values": values, "default": default if default is not None else values}


def rule(strategy, *, cap=100, field="trade_date", param="trade_date", **kwargs):
    return {
        "strategy": strategy,
        "cap": cap,
        "date_field": field,
        "date_param": param,
        "domain": "stock",
        "allow_empty": True,
        "options": {},
        "fixed": {},
        **kwargs,
    }


RULES = {
    "329": rule("trading_day", cap=8000, available_from="2024-05-01"),
    "397": rule("trading_day", cap=1000, available_from="2000-01-01"),
    "423": rule("day", cap=1000, field="pub_date", param="pub_date"),
    "398": rule(
        "trading_day",
        cap=2000,
        available_from="2025-08-12",
        options={"type": option(["HK_SH", "HK_SZ"])},
        note="只采沪深港通北向 A 股名单，不采 SZ_HK / SH_HK 港股名单。",
    ),
    "100": rule(
        "stock_snapshot",
        field=None,
        history_snapshot=True,
        split_pool=None,
        note=(
            "逐股获取接口可提供的全部曾用名历史；旧记录可能缺公告日，不按 ann_date 丢弃历史。"
            "增量重取全部记录。"
        ),
    ),
    "112": rule(
        "snapshot",
        cap=4500,
        field=None,
        options={"exchange": option(["SSE", "SZSE", "BSE"])},
        split_pool="stock_basic",
        note="上市公司当前资料快照，不能重建历史公司资料。",
    ),
    "193": rule("stock_window", field="ann_date"),
    "194": rule("stock_quarter", field="end_date", param="end_date"),
    "375": rule(
        "snapshot",
        cap=1000,
        field=None,
        domain="mapping",
        note="北交所新旧代码当前映射；不把映射生效时间当作可回放的历史快照。",
    ),
    "123": rule("day", cap=2000, field="ipo_date", param="range"),
    "262": rule("trading_day", cap=7000, available_from="2016-01-01"),
    "372": rule("realtime", cap=6000, field=None),
    "370": rule(
        "stock_minute",
        cap=8000,
        field="trade_time",
        available_from="2010-01-01",
        options={"freq": option(["1min", "5min", "15min", "30min", "60min"], ["1min"])},
        note="按股票、开市日、所选分钟频度查询完整日内时段；不假定每股每天有固定根数。",
    ),
    "374": rule(
        "realtime",
        cap=1000,
        field=None,
        options={"freq": option(["1MIN", "5MIN", "15MIN", "30MIN", "60MIN"], ["1MIN"])},
        note="仅返回当前可用的最新已结束分钟线，不提供历史日期回放。",
    ),
    "457": rule(
        "realtime",
        cap=1000,
        field=None,
        options={"freq": option(["1MIN", "5MIN", "15MIN", "30MIN", "60MIN"], ["1MIN"])},
        note="只获取当前交易日可提供的分钟数据；不是历史分钟接口。",
    ),
    "144": rule(
        "trading_day",
        cap=6000,
        note="逐开市日查询周线；非周末交易日允许为空，不猜测尚未完成周的最后交易日。",
    ),
    "145": rule(
        "trading_day",
        cap=4500,
        note="逐开市日查询月线；非月末交易日允许为空，不把当前已知最后一天误认作月末。",
    ),
    "146": rule(
        "derived",
        cap=6000,
        options={
            "adj": option(["hfq", "qfq"], ["hfq"]),
            "freq": option(["D", "W", "M"], ["D"]),
        },
        note=(
            "仅股票 asset=E。后复权可分段；前复权每股整段重算、以本次截止日为共同锚点，"
            "最长 16 年，不拼接不同锚点。"
        ),
    ),
    "336": rule(
        "period",
        cap=6000,
        options={"freq": option(["week", "month"])},
        note="按周五 / 月末日期标签查询，只纳入已结束周期；end_date 是计算截至日，不是请求日期。",
    ),
    "365": rule(
        "period",
        cap=6000,
        options={"freq": option(["week", "month"])},
        refresh_all=True,
        note="按已结束周期标签查询；复权历史可能重述，增量重拉所选历史范围，不只追加最新周期。",
    ),
    "109": rule(
        "derived",
        cap=6000,
        options={
            "adj": option(["none", "hfq", "qfq"], ["none"]),
            "freq": option(["D", "W", "M"], ["D"]),
        },
        note="通用 SDK 仅预置股票 asset=E、日/周/月线；分钟用独立分钟接口。前复权整段重算，最长 16 年。",
    ),
    "183": rule(
        "stock_day",
        cap=5800,
        note="逐股查询沪深北 L/D/P 股票池，避免把接口可能返回的基金等标的作为股票采集。",
    ),
    "214": rule(
        "trading_day",
        cap=5000,
        available_from="2000-01-03",
        options={"suspend_type": option(["S", "R"])},
    ),
    "48": rule("trading_day", options={"market_type": option(["1", "3"])}),
    "255": rule(
        "trading_day",
        cap=7000,
        available_from="2017-01-01",
        note="供应商提示早期历史可能缺失；空请求不能证明早期行情完整。",
    ),
    "45": rule("stock_window", cap=3500, field="ann_date"),
    "46": rule("stock_window", field="ann_date"),
    "80": rule("stock_window", field="ann_date"),
    "81": rule(
        "stock_window",
        field="end_date",
        window_years=1,
        options={"type": option(["P", "D", "I", "S"])},
        note="分别采产品 P、地区 D、行业 I、销售模式 S；日期按报告期。单股单报告日触顶不假造分页。",
    ),
    "162": rule("quarter", cap=6000, field="end_date", param="end_date", split_pool="stock_basic"),
    "451": rule("trading_day", cap=1000),
    "452": rule("trading_day", cap=1000),
    "453": rule("day", cap=1000, field="start_date"),
    "61": rule("stock_window", field="end_date", window_years=1),
    "62": rule("stock_window", field="end_date", window_years=1),
    "110": rule(
        "day",
        cap=1000,
        field="end_date",
        param="end_date",
        note="逐自然日查询统计截止日，包含周末；不硬编码只在周五更新。",
    ),
    "111": rule("day", cap=1000, field="ann_date", param="ann_date"),
    "124": rule(
        "day",
        cap=2000,
        field="ann_date",
        param="ann_date",
        split_pool=None,
        note="接口无股票代码筛选；单公告日触顶后停止，不能用股票池假拆分。",
    ),
    "160": rule("stock_window", cap=6000, field="float_date", window_years=1),
    "161": rule("trading_day", cap=1000),
    "164": rule(
        "day",
        field="date",
        param="range",
        domain="aggregate",
        archive_only=True,
        note="供应商已停更且未公布可靠终止日。首次采集按用户历史范围查询；增量只重查已登记范围，不追新日期。",
    ),
    "165": rule(
        "day",
        field="date",
        param="range",
        domain="aggregate",
        archive_only=True,
        available_from="2008-01-01",
        available_until="2015-05-29",
        note="旧口径账户统计，仅 2008-01 至 2015-05-29 历史；增量是历史补缺和复查，不是实时更新。",
    ),
    "166": rule("stock_window", cap=3000, field="ann_date"),
    "175": rule(
        "day",
        cap=3000,
        field="ann_date",
        param="ann_date",
        options={"trade_type": option(["IN", "DE"]), "holder_type": option(["C", "P", "G"])},
    ),
    "494": rule("day", cap=3000, field="ann_date", param="ann_date", available_from="1991-01-01"),
    "292": rule("day", cap=3000, field="report_date", param="report_date", available_from="2010-01-01"),
    "293": rule("stock_day", cap=6000, available_from="2018-02-01"),
    "294": rule("stock_day", cap=6000, available_from="2018-01-01"),
    "296": rule("trading_day", cap=10000, allow_empty=False, refresh_all=True),
    "328": rule("trading_day", cap=10000, allow_empty=False, refresh_all=True),
    "353": rule("trading_day", cap=10000, available_from="2010-01-01"),
    "354": rule("trading_day", cap=10000, available_from="2010-01-01"),
    "364": rule(
        "time_day",
        cap=10000,
        fixed={"freq": "daily"},
        available_from="2023-01-01",
        note="仅官方列明的 daily 频度；日期按日内起止时间查询，不假定还有 60 分钟频度。",
    ),
    "399": rule(
        "trading_day",
        cap=1000,
        available_from="2025-08-12",
        note="只请求 A 股对应的 AH 比价；保留相关港股比较字段，不另采港股行情。",
    ),
    "275": rule("day", cap=400, field="surv_date"),
    "267": rule("month", cap=1000, field="month", param="month"),
    "58": rule(
        "trading_day",
        cap=4000,
        domain="aggregate",
        options={"exchange_id": option(["SSE", "SZSE", "BSE"])},
        split_pool=None,
    ),
    "59": rule(
        "stock_day",
        cap=6000,
        note="逐股查询 L/D/P 股票池，只采股票融资融券明细，不遍历 ETF。",
    ),
    "326": rule(
        "stock_day",
        cap=6000,
        note="该接口可含 ETF；通过 L/D/P 股票代码约束查询，不采基金标的。",
    ),
    "332": rule("stock_day", cap=5000, archive_only=True),
    "331": rule("trading_day", cap=5000, domain="aggregate", split_pool=None),
    "333": rule("stock_day", cap=5000, archive_only=True),
    "334": rule("stock_day", cap=5000, archive_only=True),
    "348": rule("trading_day", cap=6000, available_from="2019-07-26"),
    "349": rule("trading_day", cap=6000, available_from="2023-09-11"),
    "371": rule("trading_day", cap=5000, domain="board", split_pool="ths_index"),
    "343": rule(
        "trading_day",
        cap=5000,
        domain="board",
        split_pool="ths_index",
        available_from="2024-09-10",
    ),
    "344": rule(
        "trading_day",
        cap=5000,
        domain="board",
        split_pool="dc_index",
        options={"content_type": option(["行业", "概念", "地域"])},
    ),
    "345": rule("trading_day", cap=3000, domain="aggregate", split_pool=None),
    "106": rule("trading_day", cap=10000),
    "107": rule("trading_day", cap=10000),
    "355": rule(
        "trading_day",
        cap=4000,
        available_from="2023-11-01",
        options={
            "limit_type": option(["涨停池", "连扳池", "冲刺涨停", "炸板池", "跌停池"]),
            "market": option(["HS", "GEM", "STAR"]),
        },
    ),
    "298": rule(
        "trading_day",
        cap=2500,
        available_from="2020-01-01",
        options={"limit_type": option(["U", "D", "Z"]), "exchange": option(["SH", "SZ", "BJ"])},
        note="按 U/D/Z 和沪深北分别查询；供应商口径不包含 ST，不宣称覆盖 ST 涨跌停。",
    ),
    "356": rule("trading_day", cap=2000, available_from="2023-11-13"),
    "357": rule("trading_day", cap=2000, domain="board", split_pool=None),
    "259": rule(
        "snapshot",
        cap=5000,
        field=None,
        domain="board",
        fixed={"exchange": "A"},
        allow_empty=False,
        split_pool=None,
        note="一次查询 A 股全部同花顺分类，不循环默认类型，不请求港美分类。",
    ),
    "260": rule("trading_day", cap=3000, domain="board", split_pool="ths_index"),
    "261": rule(
        "stock_snapshot",
        field=None,
        domain="membership",
        code_param="con_code",
        split_pool="ths_index",
        split_param="ts_code",
        note="按股票池及 con_code 逆向查询当前板块关系；接口没有历史日期参数，不能回填历史成员关系。",
    ),
    "362": rule(
        "trading_day",
        cap=5000,
        domain="board",
        split_pool=None,
        options={"idx_type": option(["行业板块", "概念板块", "地域板块"])},
    ),
    "363": rule(
        "board_day",
        cap=5000,
        domain="membership",
        pool="dc_index",
        split_pool=None,
        available_from="2024-12-20",
    ),
    "382": rule(
        "trading_day",
        cap=2000,
        domain="board",
        split_pool="dc_index",
        available_from="2020-01-01",
        options={"idx_type": option(["概念板块", "行业板块", "地域板块"])},
    ),
    "369": rule(
        "trading_day",
        cap=8000,
        available_from="2025-01-16",
        note="股票集合竞价接口；ETF 竞价是独立接口，不在本项目采集。",
    ),
    "311": rule(
        "snapshot",
        cap=1000,
        field=None,
        domain="dictionary",
        split_pool=None,
        allow_empty=False,
        note="游资名称及机构字典的当前快照，不构造历史版本。",
    ),
    "312": rule("trading_day", cap=2000, available_from="2022-08-01"),
    "320": rule(
        "trading_day",
        cap=2000,
        domain="rank",
        options={
            "market": option(["热股", "行业板块", "概念板块"]),
            "is_new": option(["Y", "N"]),
        },
        split_pools={"market": {"热股": "stock_basic", "行业板块": "ths_index", "概念板块": "ths_index"}},
        note="只采 A 股热股及其行业/概念榜；Y/N 分别归档，允许重叠，不采 ETF、港美股、期货榜。",
    ),
    "321": rule(
        "trading_day",
        cap=2000,
        fixed={"market": "A股市场"},
        options={"hot_type": option(["人气榜", "飙升榜"]), "is_new": option(["Y", "N"])},
    ),
    "376": rule(
        "trading_day",
        cap=1000,
        domain="board",
        split_pool=None,
        options={"idx_type": option(["概念板块", "行业板块", "风格板块", "地区板块"])},
    ),
    "377": rule(
        "board_day",
        cap=3000,
        domain="membership",
        pool="tdx_index",
        split_pool=None,
        available_from="2025-03-28",
    ),
    "378": rule("trading_day", cap=3000, domain="board", split_pool="tdx_index"),
    "347": rule(
        "trading_day",
        cap=8000,
        options={"tag": option(["涨停", "炸板", "跌停", "自然涨停", "竞价"])},
    ),
    "351": rule(
        "stock_day",
        cap=3000,
        domain="membership",
        code_param="con_code",
        split_pool=None,
        note="没有预置开盘啦题材代码目录；按股票池及成分股 con_code 逆向遍历关系，不把板块代码当股票代码。",
    ),
}

STRATEGY_NOTES = {
    "trading_day": "按已归档 SSE 市场基准日历的开市日逐日查询，保留多行事件；非个股停牌判断。",
    "day": "按自然日查询，包含周末和节假日，不把无返回的日期视为缺失数据的证明。",
    "stock_window": "按已验证的 L/D/P 股票池及固定日期段查询，保留修订和同股多行。",
    "stock_quarter": "逐股、逐季度末报告期查询，空报告期仅代表本次没有返回。",
    "stock_day": "逐股、逐开市日查询，股票池包含当前可见的上市、退市、暂停上市股票。",
    "stock_minute": "逐股、逐开市日、逐所选频度查询分钟数据。",
    "quarter": "逐季度末报告期查询，不把公告日与报告期混用。",
    "month": "按 YYYYMM 月份查询，包含目标日所在月；不传日频日期参数。",
    "period": "按所选周/月周期标签查询已结束周期，非逐日行情。",
    "time_day": "按开市日的 00:00:00 至 23:59:59 查询。",
    "snapshot": "获取当前快照；不能重建历史时点。",
    "board_snapshot": "从已验证分类归档取得板块代码，逐板块查询当前成员。",
    "stock_snapshot": "逐股查询当前关系快照，不重建历史时点。",
    "board_day": "从已验证历史分类归档取得板块代码，逐板块、逐开市日查询历史成员。",
    "realtime": "逐个当前上市股票获取实时快照；服务及账号必须有相应独立权限。",
    "derived": "使用官方 pro_bar SDK；每个归档单元可能包含行情、复权因子两个子请求。",
}


def catalog_recipes(entries, existing):
    covered = {item["entry_id"] for item in existing.values()}
    if covered | set(RULES) != set(entries) or covered & set(RULES):
        raise RuntimeError("股票目录与预置采集规则不一致")
    result = {}
    for entry_id, spec in RULES.items():
        entry = entries[entry_id]
        dataset_id = "pro_bar_adj" if entry_id == "146" else entry["api_name"]
        snapshot = spec["strategy"] in {"snapshot", "board_snapshot", "stock_snapshot", "realtime"}
        note = STRATEGY_NOTES[spec["strategy"]]
        incremental = "补齐失败、缺失分区，并回查最近自然日涉及的日期段；窗口外修订需全量重拉。"
        if snapshot:
            incremental = "重新获取当前快照并独立归档；不是历史增量追加。"
        elif spec.get("archive_only"):
            incremental = "接口已停更；仅补缺、重查已登记历史范围，不生成新的日期。"
        elif spec.get("refresh_all") or spec["strategy"] == "derived":
            incremental = "补缺口；会重述的前复权历史整段重算，保留旧运行，不拼接不同复权锚点。"
        elif spec["strategy"] in {"quarter", "stock_quarter"}:
            incremental = "补齐报告期和失败，并至少重查最近一个已结束报告期及回查窗口内的报告期。"
        elif spec["strategy"] == "month":
            incremental = "补缺口，并重查回查窗口涉及月份及当前月份；月初更新可反映到上月名单。"
        result[dataset_id] = {
            "id": dataset_id,
            "version": 1,
            "entry_id": entry_id,
            "name": entry["name"],
            "kind": "snapshot" if snapshot else "catalog",
            "start": spec.get("available_from", "1990-12-19"),
            "local_limit": spec["cap"],
            "rule": spec,
            "scope_note": f"{note} {spec.get('note', '')}".strip(),
            "incremental_note": incremental,
        }
    return result


def effective_options(recipe, settings):
    definitions = recipe.get("rule", {}).get("options", {})
    unknown = set(settings.options) - set(definitions)
    if unknown:
        raise CollectorError(f"本数据集不支持这些采集选项：{', '.join(sorted(unknown))}")
    result = {}
    for name, definition in definitions.items():
        selected = settings.options.get(name, definition["default"])
        if not selected or len(selected) != len(set(selected)) or set(selected) - set(definition["values"]):
            raise CollectorError(f"采集选项 {name} 必须从预置值中选择，且不能为空或重复")
        result[name] = [value for value in definition["values"] if value in selected]
    if recipe.get("rule", {}).get("strategy") == "derived":
        if "qfq" in result["adj"] and result["freq"] != ["D"]:
            raise CollectorError("本采集器前复权规则仅预置日频 D；请分开选择其他频度")
    return result


def date_points(start, end):
    return [start + timedelta(days=index) for index in range((end - start).days + 1)]


def schedule(spec, start, end, variant, trading_days):
    strategy = spec["strategy"]
    if strategy in {"snapshot", "board_snapshot", "stock_snapshot", "realtime"}:
        return [("snapshot", {})]
    if strategy in {"stock_window", "derived"}:
        years = spec.get("window_years", 16)
        if strategy == "derived" and variant.get("adj") == "qfq":
            if (end - start).days > 16 * 366:
                raise CollectorError(
                    "前复权整段查询最长 16 年；更长历史请选择后复权或不复权，不拼接不同前复权锚点"
                )
            return [("qfq", {"start_date": start.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")})]
        first = 1990 + (start.year - 1990) // years * years
        return [
            (
                str(year),
                {
                    "start_date": max(start, date(year, 1, 1)).strftime("%Y%m%d"),
                    "end_date": min(end, date(year + years - 1, 12, 31)).strftime("%Y%m%d"),
                },
            )
            for year in range(first, end.year + 1, years)
        ]
    if strategy == "month":
        return [
            (f"{year}{month:02d}", {spec["date_param"]: f"{year}{month:02d}"})
            for year in range(start.year, end.year + 1)
            for month in range(1, 13)
            if date(year, month, 1) <= end and date(year, month, calendar.monthrange(year, month)[1]) >= start
        ]
    if strategy in {"stock_quarter", "quarter"}:
        points = [
            date(year, month, calendar.monthrange(year, month)[1])
            for year in range(start.year, end.year + 1)
            for month in (3, 6, 9, 12)
            if start <= date(year, month, calendar.monthrange(year, month)[1]) <= end
        ]
    elif strategy == "period":
        points = (
            [point for point in date_points(start, end) if point.weekday() == 4]
            if variant["freq"] == "week"
            else [
                point
                for point in date_points(start, end)
                if point.day == calendar.monthrange(point.year, point.month)[1]
            ]
        )
    elif strategy == "day":
        points = date_points(start, end)
    else:
        points = [datetime.strptime(day, "%Y%m%d").date() for day in trading_days]
    result = []
    for point in points:
        day = point.strftime("%Y%m%d")
        if strategy in {"stock_minute", "time_day"}:
            params = {
                "start_date": f"{point.isoformat()} 00:00:00",
                "end_date": f"{point.isoformat()} 23:59:59",
            }
        elif spec["date_param"] == "range":
            params = {"start_date": day, "end_date": day}
        else:
            params = {spec["date_param"]: day}
        result.append((day, params))
    return result


def candidates_for(recipe, settings, start, end, trading_days, codes, lifetimes=None):
    spec = recipe["rule"]
    options = effective_options(recipe, settings)
    variants = [dict(zip(options, values, strict=True)) for values in itertools.product(*options.values())]
    schedules = [(variant, schedule(spec, start, end, variant, trading_days)) for variant in variants]
    if lifetimes is not None:
        schedules = [
            (
                variant,
                code,
                [
                    (
                        anchor,
                        {
                            "start_date": max(params["start_date"], lifetimes[code][0]).replace("-", ""),
                            "end_date": min(params["end_date"], lifetimes[code][1]).replace("-", ""),
                        },
                    )
                    for anchor, params in points
                    if params["end_date"] >= lifetimes[code][0] and params["start_date"] <= lifetimes[code][1]
                ],
            )
            for variant, points in schedules
            for code in codes
        ]
    else:
        schedules = [(variant, code, points) for variant, points in schedules for code in codes]
    total = sum(len(points) for _, _, points in schedules)
    if total > MAX_SLICES:
        raise CollectorError(
            f"当前股票/板块池、日期及选项需要 {total:,} 个切片，超过单次 {MAX_SLICES:,} 上限；"
            "请缩小日期范围，或选择较少频度/类型后分次采集，各选项范围独立登记。不会静默截断。"
        )
    result = []
    for variant, code, points in schedules:
        fixed = {**spec["fixed"], **variant}
        if spec["strategy"] == "derived":
            fixed["asset"] = "E"
            if fixed.get("adj") == "none":
                del fixed["adj"]
        identity = {**fixed}
        if code is not None:
            identity[spec.get("code_param", "ts_code")] = code
        suffix = json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        for anchor, params in points:
            result.append((f"{anchor}|{suffix}", {**identity, **params}))
    return result


def recent_partition(recipe, params, key, window_start, target):
    spec = recipe["rule"]
    if recipe["kind"] == "snapshot" or spec.get("refresh_all"):
        return True
    if spec["strategy"] == "derived" and params.get("adj") == "qfq":
        return True
    anchor = key.split("|", 1)[0].split("@", 1)[0].split("/", 1)[0]
    if spec["strategy"] == "month":
        return anchor >= window_start.strftime("%Y%m")
    if spec["strategy"] in {"quarter", "stock_quarter"}:
        latest = max(
            (
                date(year, month, calendar.monthrange(year, month)[1])
                for year in (target.year - 1, target.year)
                for month in (3, 6, 9, 12)
                if date(year, month, calendar.monthrange(year, month)[1]) <= target
            ),
        )
        return anchor >= min(window_start, latest).strftime("%Y%m%d")
    return params.get("end_date", anchor).replace("-", "")[:8] >= window_start.strftime("%Y%m%d")


def response_day(value):
    text = str(value)
    try:
        if re.fullmatch(r"\d{8}", text):
            return datetime.strptime(text, "%Y%m%d").date()
        return datetime.fromisoformat(text).date()
    except ValueError:
        raise CollectionFailure(f"返回数据包含无效日期：{text[:40]}") from None


def validate_catalog_response(recipe, frame, params):
    spec = recipe["rule"]
    if frame.empty:
        if not spec["allow_empty"]:
            raise CollectionFailure("分类或字典快照为空，不能登记为可用依赖")
        return
    domain = spec["domain"]
    code_column = spec.get("code_param", "ts_code")
    if domain not in {"aggregate", "dictionary", "mapping"}:
        if code_column not in frame.columns:
            raise CollectionFailure(f"返回数据缺少 {code_column}")
        for value in frame[code_column]:
            if not isinstance(value, str) or not value:
                raise CollectionFailure("返回数据存在无效代码")
            stock = domain == "stock" or domain == "membership" and code_column == "con_code"
            if stock and not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", value):
                raise CollectionFailure("返回数据包含非沪深北股票代码")
            if params.get(code_column) and value != params[code_column]:
                raise CollectionFailure(f"返回的 {code_column} 与请求不一致")
    if domain == "membership":
        if not {"ts_code", "con_code"}.issubset(frame.columns):
            raise CollectionFailure("成分关系缺少板块代码或成分股代码")
        for value in frame["con_code"]:
            if not isinstance(value, str) or not re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", value):
                raise CollectionFailure("成员关系包含非沪深北股票，不能作为股票成员覆盖")
            if params.get("con_code") and value != params["con_code"]:
                raise CollectionFailure("返回的成分股与请求不一致")
        if params.get("ts_code") and any(value != params["ts_code"] for value in frame["ts_code"]):
            raise CollectionFailure("返回的板块代码与请求不一致")
    for name in spec["options"]:
        if name in frame.columns and name in params and name not in {"is_new", "adj"}:
            if any(str(value) != str(params[name]) for value in frame[name]):
                raise CollectionFailure(f"返回数据的 {name} 与查询选项不一致")
    field = spec["date_field"]
    if not field:
        return
    if field not in frame.columns:
        raise CollectionFailure(f"返回数据缺少日期字段 {field}")
    if spec["strategy"] == "month":
        if any(str(value) != params["month"] for value in frame[field]):
            raise CollectionFailure("返回月份与请求不一致")
        return
    if recipe["id"] == "stk_account_old":
        start, end = response_day(params["start_date"]), response_day(params["end_date"])
        for value in frame[field]:
            try:
                first, _ = record_interval(value, "week_interval")
            except ValueError as error:
                raise CollectionFailure(f"旧口径账户统计周期无效：{error}") from None
            if not start <= first <= end:
                raise CollectionFailure("旧口径账户统计周期起点超出请求范围")
        return
    if "start_date" in params and "end_date" in params:
        start, end = response_day(params["start_date"]), response_day(params["end_date"])
    else:
        start = end = response_day(params[spec["date_param"]])
    for value in frame[field]:
        if not start <= response_day(value) <= end:
            raise CollectionFailure(f"返回数据的 {field} 超出请求范围")
        if spec["strategy"] in {"stock_minute", "time_day"}:
            try:
                stamp = pd.Timestamp(value)
                lower, upper = (pd.Timestamp(params[key]) for key in ("start_date", "end_date"))
                if stamp.tzinfo is not None or not lower <= stamp <= upper:
                    raise ValueError("时间戳不在所请求的本地日内时段")
            except ValueError as error:
                raise CollectionFailure(f"返回时间戳无效：{error}") from None
    if spec["strategy"] == "period" and "end_date" in frame.columns:
        if any(response_day(value) > end for value in frame["end_date"]):
            raise CollectionFailure("周期数据的计算截至日超过请求周期")
