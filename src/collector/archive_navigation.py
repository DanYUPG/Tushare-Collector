from .models import ENTRIES, CollectorError

DOMAINS = (
    ("reference", "标的与交易基准", "股票、代码、交易日历与市场标的范围",
     "25 26 397 423 398 100 375 123 262"),
    ("prices", "量价与复权", "各频度行情、每日指标、复权因子与集合竞价",
     "27 372 370 374 457 144 145 146 336 365 28 32 109 255 353 354 369"),
    ("financial", "财报与业绩", "财务报表、指标、业绩预告与披露计划",
     "33 36 44 45 46 79 80 81 162"),
    ("ownership", "股东治理与股本", "公司管理、股东、分红、质押、回购与股本变动",
     "329 112 193 194 103 61 62 110 111 124 160 166 175 494"),
    ("flows", "资金流与北向", "个股、行业与市场资金流，以及沪深股通成交榜",
     "48 170 348 349 371 343 344 345"),
    ("leverage", "两融与转融通", "融资融券标的、交易明细与转融通统计",
     "58 59 326 332 331 333 334"),
    ("boards", "行业板块与成员", "行业与概念分类、成员关系和板块行情",
     "259 260 261 362 363 382 376 377 378 351"),
    ("events", "交易事件与市场情绪", "停复牌、异常交易、涨跌停、龙虎榜、热榜与开户统计",
     "183 214 451 452 453 161 164 165 106 107 355 298 356 357 311 312 320 321 347"),
    ("research", "研究信号与机构观点", "技术信号、筹码、比价、券商观点与机构调研",
     "292 293 294 296 328 364 399 275 267"),
)

BUSINESS_DOMAINS = [
    {"id": key, "name": name, "description": description}
    for key, name, description, _ in DOMAINS
]
ENTRY_DOMAINS = {}
for key, name, _, identifiers in DOMAINS:
    for entry_id in identifiers.split():
        if entry_id in ENTRY_DOMAINS:
            raise ValueError(f"Duplicate business classification: {entry_id}")
        ENTRY_DOMAINS[entry_id] = {"business_domain": key, "business_domain_name": name}
if set(ENTRY_DOMAINS) != set(ENTRIES):
    raise ValueError("Business classification must cover the complete stock catalog")


def domain_entries(domain: str) -> list[str]:
    if domain and domain not in {item["id"] for item in BUSINESS_DOMAINS}:
        raise CollectorError("本地数据业务分类不存在")
    return [
        entry_id for entry_id, item in ENTRY_DOMAINS.items()
        if not domain or item["business_domain"] == domain
    ]
