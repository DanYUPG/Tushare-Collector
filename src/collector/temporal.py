import calendar
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo


def record_interval(value, kind="date"):
    text = str(value)
    if kind == "month":
        if not re.fullmatch(r"\d{6}", text):
            raise ValueError("月份须为 YYYYMM")
        start = datetime.strptime(text, "%Y%m").date()
        return start, start.replace(day=calendar.monthrange(start.year, start.month)[1])
    if kind == "week_interval":
        match = re.fullmatch(r"(\d{8})~(\d{4}|\d{8})", text)
        if not match:
            raise ValueError("统计周期须为 YYYYMMDD~MMDD 或 YYYYMMDD~YYYYMMDD")
        start = datetime.strptime(match[1], "%Y%m%d").date()
        suffix = match[2]
        if len(suffix) == 4:
            year = start.year + (suffix < match[1][4:])
            suffix = f"{year}{suffix}"
        end = datetime.strptime(suffix, "%Y%m%d").date()
        if not 0 <= (end - start).days <= 6:
            raise ValueError("周统计区间须为不超过七个自然日的有效区间")
        return start, end
    if re.fullmatch(r"\d{8}", text):
        point = datetime.strptime(text, "%Y%m%d").date()
    else:
        stamp = datetime.fromisoformat(text)
        if stamp.tzinfo:
            stamp = stamp.astimezone(ZoneInfo("Asia/Shanghai"))
        point = stamp.date()
    if point < date(1990, 12, 19):
        raise ValueError("记录日期早于股票数据起点")
    return point, point
