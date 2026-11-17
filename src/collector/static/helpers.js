export const states = {
  queued: "排队中", running: "执行中", succeeded: "请求成功", failed: "失败",
  cancelled: "已取消", interrupted: "已中断", pending: "待执行",
  http: "HTTP", sdk_only: "仅 SDK", discontinued: "已停更", legacy: "旧版",
  partial: "部分成功",
};

export function datasetPresentation(dataset) {
  if (dataset.active_run) return { status: "采集中", kind: "active", action: "查看进度" };
  const currentRun = dataset.last_run?.scope === dataset.scope ? dataset.last_run : null;
  if (dataset.settings_error || dataset.unfinished_partitions > 0
    || (dataset.covered_partitions === 0 && currentRun && ["failed", "cancelled", "interrupted"].includes(currentRun.state))) {
    return { status: "需要处理", kind: "attention", action: "处理未完成" };
  }
  if (dataset.covered_partitions > 0) return { status: "已有采集归档", kind: "ready", action: "检查更新" };
  if (dataset.covered_partitions == null) return { status: "归档状态未知", kind: "unknown", action: "检查配置" };
  return { status: "未采集", kind: "empty", action: "首次采集" };
}

export function normalizeWorkspaceHash(hash) {
  const source = new URLSearchParams(String(hash).replace(/^#/, "").slice(0, 16000));
  const result = new URLSearchParams();
  const views = new Set(["needs", "datasets", "warehouse", "local-data", "runs", "custom", "permissions"]);
  result.set("view", views.has(source.get("view")) ? source.get("view") : "needs");
  for (const [key, value] of source) {
    if (!value || key === "view") continue;
    if (key === "dataset" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
      || key === "entry" && /^\d{1,6}$/.test(value)
      || ["run", "slice", "need"].includes(key) && /^[a-f0-9]{32}$/.test(value)
      || ["category", "q"].includes(key) && value.length <= 200
      || /^(ds|wh|raw|run|perm|custom)_[a-z_]{1,32}$/.test(key) && value.length <= 2000) {
      result.set(key, value);
    }
  }
  return result.toString();
}

export function datasetEvidence(dataset, warehouse) {
  const currentRun = dataset.last_run?.scope === dataset.scope ? dataset.last_run : null;
  const execution = dataset.active_run ? "采集中"
    : currentRun ? `上次${states[currentRun.state] || "结果未知"}` : "上次执行未知";
  let freshness = "数据截至未知";
  if (warehouse?.state === "ready") {
    if (warehouse.grain === "current_snapshot") freshness = "当前快照（非历史时点）";
    else if (warehouse.last_date && (warehouse.storage_layout === "request_partitions"
      || warehouse.days > 0 && warehouse.days === warehouse.days_with_rows)) {
      const date = warehouse.last_date;
      if (validCompactDate(date)) freshness = `记录截至 ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
    }
  }
  const quality = dataset.row_limit_partitions > 0 ? `${dataset.row_limit_partitions} 个请求触顶 · 完整性未验证`
    : dataset.unfinished_partitions > 0 ? `${dataset.unfinished_partitions} 个请求未完成 · 完整性未验证`
    : "完整性未验证";
  return { execution, freshness, quality, timeliness: "更新是否到期未知（尚无发布时效证据）" };
}

export function runOutcome(run) {
  return run.state === "succeeded"
    ? (run.successful_rows ?? run.rows) === 0 ? "请求成功 · 无数据" : "请求成功 · 有记录"
    : states[run.state] || run.state;
}

export function runRecovery(run, slices = []) {
  if (!["failed", "cancelled", "interrupted"].includes(run.state)) return null;
  const kinds = new Set(slices.filter(item => item.state === "failed").map(item => item.error_kind));
  if (run.deleted_archives > 0) return { kind: "inspect", label: "核查已删除归档", retry: false };
  if (run.row_limit_failures > 0 || kinds.has("row_limit"))
    return { kind: "split", label: run.dataset_id ? "检查拆分方案" : "修改切片配置", retry: false };
  if (kinds.has("permission")) return { kind: "permission", label: "查看授权要求", retry: false };
  if (kinds.has("quota")) return { kind: "quota", label: "查看额度与限流", retry: false };
  if ((run.error || "").includes("请指定正确的接口名"))
    return { kind: "config", label: "修改接口配置", retry: false };
  const message = run.error || "";
  if (/^SDK 调用失败：/.test(message) && /没有.{0,30}权限|权限不足|无权访问/.test(message))
    return { kind: "permission", label: "查看授权要求", retry: false };
  if (/^SDK 调用失败：/.test(message) && /每分钟|频次|频率|稍后|服务繁忙/.test(message))
    return { kind: "wait", label: "等待后核查限流", retry: false };
  if (/^(SDK )?网络请求失败：/.test(message))
    return { kind: "network", label: "重试未完成部分", retry: true };
  if (["cancelled", "interrupted"].includes(run.state))
    return { kind: "resume", label: "继续未完成部分", retry: true };
  return { kind: "inspect", label: "查看原因与恢复", retry: false };
}

export function datasetRuleLabel(dataset) {
  const rule = dataset.rule;
  if (rule?.archive_only) return "已停更 · 仅历史归档";
  if (rule?.strategy === "realtime") return "实时接口 · 仅当前快照";
  if (rule?.history_snapshot) return "全历史记录快照 · 整表刷新";
  if (["board_snapshot", "stock_snapshot"].includes(rule?.strategy)) return "当前板块成员 · 不回放历史";
  if (rule?.strategy === "derived") return "SDK 行情 · 明确复权锚点";
  if (dataset.kind === "snapshot") return "当前快照 · 不重建历史";
  if (rule) return ({
    stock_minute: "逐股分钟历史", stock_quarter: "逐股报告期",
    quarter: "报告期数据", month: "按月数据", period: "已结束周 / 月周期",
    board_day: "逐板块历史成员", stock_window: "逐股日期段",
    stock_day: "逐股交易日", day: "自然日 / 公告事件",
    time_day: "日内日期范围", trading_day: "按开市日查询",
  })[rule.strategy] || "股票目录数据";
  return ({ calendar: "沪深交易日历", financial: "逐股财务报告 / 指标",
    event: "自然日公告", daily: "按交易日查询全市场" })[dataset.kind] || "股票目录数据";
}

export function cellText(value) {
  if (value === null) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function parameterValue(value) { return value === "" ? '""（空字符串）' : cellText(value); }

export function parameterText(params) {
  return Object.entries(params).map(([name, value]) =>
    `${parameterLabels[name] || name} (${name})：${parameterValue(value)}`).join("；");
}

export function collectionScope(config) {
  const stock = config.split_param === "ts_code"
    ? `按股票代码枚举 ${config.split_values.length} 个值（具体值见下方）`
    : Object.hasOwn(config.params, "ts_code") ? parameterValue(config.params.ts_code)
      : "未限定股票代码；由接口按以下条件返回，不代表覆盖所有股票";
  const dates = config.mode === "date_range"
    ? `${config.start_date} → ${config.end_date}（自然日；日期参数 ${config.date_param}）`
    : parameterText(Object.fromEntries(Object.entries(config.params).filter(([name]) =>
      name.endsWith("date") || name === "period"))) || "未指定日期，按接口语义查询";
  return [
    `股票范围：${stock}`,
    `日期范围：${dates}`,
    `基础筛选条件：${parameterText(config.params) || "无显式基础参数，使用接口默认条件"}`,
    config.split_param
      ? `枚举参数 ${config.split_param} · ${config.split_values.length} 个值：${config.split_values.map(parameterValue).join("、")}`
      : "无额外枚举切片",
  ];
}

export const commonAPIs = new Set(["stock_basic", "daily", "daily_basic", "adj_factor"]);
export const parameterLabels = {
  ts_code: "股票代码", name: "股票名称", trade_date: "交易日期", start_date: "开始日期",
  end_date: "结束日期", list_status: "上市状态", exchange: "交易所", market: "市场类别", is_hs: "沪深港通标的",
};
export const parameterChoices = {
  list_status: [["L", "上市"], ["D", "退市"], ["P", "暂停上市"], ["G", "未交易"], ["UN", "未上市"]],
  exchange: [["SSE", "上交所"], ["SZSE", "深交所"], ["BSE", "北交所"]],
  market: ["主板", "创业板", "科创板", "CDR", "北交所"].map(value => [value, value]),
  is_hs: [["N", "否"], ["H", "沪股通"], ["S", "深股通"]],
};

function validCompactDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const formatted = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`;
  const date = new Date(`${formatted}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === formatted;
}

export function canGuide(entry, params) {
  if (!commonAPIs.has(entry.api_name)) return false;
  return Object.entries(params).every(([name, value]) =>
    entry.params.some(param => param.name === name) && typeof value === "string" && value !== ""
    && (!name.endsWith("date") || value === "" || validCompactDate(value))
    && (!parameterChoices[name] || value === "" || parameterChoices[name].some(([key]) => key === value)));
}

export function taskTemplate(apiName, kind, today) {
  if (!commonAPIs.has(apiName)) throw new Error("此接口尚无常用模板");
  if (apiName === "stock_basic") {
    return { params: { list_status: "L" }, mode: "single", start_date: "", end_date: "", label: "上市股票清单" };
  }
  if (kind !== "day" && kind !== "range") throw new Error("未知任务模板");
  return {
    params: kind === "day" ? { trade_date: today.replaceAll("-", "") } : {},
    mode: kind === "day" ? "single" : "date_range",
    start_date: kind === "range" ? today : "", end_date: kind === "range" ? today : "",
    label: kind === "day" ? "单日全市场" : "逐日日期范围",
  };
}

export function assertDraftSafe(paramsText) {
  if (/["']?(?:token|password|secret|authorization)["']?\s*:/i.test(paramsText)) {
    throw new Error("参数含凭证字段，草稿未保存；请移除凭证，Token 只填写在凭证窗口");
  }
}

export function parseObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("基础请求参数不是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("基础请求参数必须是 JSON 对象");
  }
  return value;
}

export function parseValues(text) {
  if (!text.trim()) return [];
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("枚举值不是有效 JSON"); }
  if (!Array.isArray(value)) throw new Error("枚举值必须是 JSON 数组");
  if (value.some(item => item === null || typeof item === "object")) {
    throw new Error("枚举值只支持字符串、数值或布尔值");
  }
  return value;
}

export function errorMessage(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(item => `${item.loc?.slice(1).join(".") || "配置"}：${item.msg}`).join("；");
  return "请求失败，请查看服务状态";
}

export function filteredEntries(entries, category, search) {
  const query = search.trim().toLowerCase();
  return entries.filter(entry => (!category || entry.category === category)
    && `${entry.name} ${entry.api_name}`.toLowerCase().includes(query));
}

export function stockCategoryGroups(catalog, entries = catalog.entries) {
  return catalog.categories.map(category => ({
    ...category, entries: filteredEntries(entries, category.id, ""),
  }));
}

export const PERMISSION_FILTER_KEYS = new Set([
  "all",
  "points_satisfied",
  "independent",
  "insufficient_points",
  "unknown_rpm",
  "daily_limit",
  "has_conflict_or_note",
  "undocumented",
]);

export function matchesPermissionFilter(entry, filterKey) {
  if (!filterKey || filterKey === "all") return true;
  if (filterKey === "points_satisfied") return entry.account_access === "points_satisfied";
  if (filterKey === "independent") {
    return entry.permission_kind === "independent" || entry.account_access === "requires_independent_permission";
  }
  if (filterKey === "insufficient_points") return entry.account_access === "insufficient_points";
  if (filterKey === "unknown_rpm") {
    return entry.documented_rpm === null && entry.permission_kind !== "derived";
  }
  if (filterKey === "daily_limit") return entry.daily_limit !== null && entry.daily_limit !== undefined;
  if (filterKey === "has_conflict_or_note") return Boolean(entry.note && entry.note.trim());
  if (filterKey === "undocumented") {
    return entry.permission_kind === "undocumented" || entry.account_access === "undocumented";
  }
  return true;
}

export function formatPermissionRpm(entry) {
  if (!entry) return { documentedLabel: "未公布", configuredLabel: "—", isFallback: false };
  if (entry.permission_kind === "derived") {
    return {
      documentedLabel: "无独立 HTTP 频次（按子请求分别限流）",
      configuredLabel: `本地基准 ${entry.configured_rpm} 次/分`,
      isFallback: false,
    };
  }
  if (entry.documented_rpm === null || entry.documented_rpm === undefined) {
    return {
      documentedLabel: "官方未公布 8000 档频次",
      configuredLabel: `本地保守 ${entry.configured_rpm} 次/分`,
      isFallback: true,
    };
  }
  return {
    documentedLabel: `官方 ${entry.documented_rpm} 次/分`,
    configuredLabel: `本地配置 ${entry.configured_rpm} 次/分`,
    isFallback: false,
  };
}

export function formatPermissionThreshold(entry) {
  if (!entry) return "未知";
  if (entry.permission_kind === "independent") {
    return entry.independent_permission
      ? `独立授权：${entry.independent_permission}`
      : "需单独开通独立权限";
  }
  if (entry.permission_kind === "derived") {
    return "SDK 派生（取决于底层行情/因子子接口）";
  }
  if (entry.permission_kind === "undocumented" || entry.minimum_points === null || entry.minimum_points === undefined) {
    return "文档未公布积分门槛";
  }
  return `${entry.minimum_points} 积分起`;
}

export function describeWorkerSettingState(settings, worker) {
  const configured = Number(worker?.collection_threads ?? settings?.collection_threads ?? 1) || 1;
  const effective = Number(worker?.effective_collection_threads ?? settings?.effective_collection_threads ?? configured) || 1;
  const max = Number(settings?.max_collection_threads ?? 16) || 16;
  const activeRun = Boolean(worker?.active_run);
  const pendingNextRun = configured !== effective;
  return {
    configured,
    effective,
    max,
    activeRun,
    pendingNextRun,
    summary: pendingNextRun
      ? `当前运行实际 ${effective} 线程 · 下次运行生效 ${configured} 线程`
      : activeRun
        ? `当前运行实际 ${effective} 线程`
        : `已配置 ${configured} 线程（下次运行生效）`,
  };
}

export function advanceActivityCursor(currentCursor, events, latestSeq, limit) {
  if (currentCursor <= 0) {
    return Math.max(0, Number(latestSeq) || 0);
  }
  if (Array.isArray(events) && events.length >= limit && events.length > 0) {
    const lastSeq = Number(events[events.length - 1]?.seq) || currentCursor;
    return Math.max(currentCursor, lastSeq);
  }
  return Math.max(currentCursor, Number(latestSeq) || 0);
}

export const BUSINESS_DOMAIN_ORDER = [
  "reference",
  "prices",
  "financial",
  "ownership",
  "flows",
  "leverage",
  "boards",
  "events",
  "research",
];

export function resolveArchiveSourceType(item) {
  if (!item) return "task";
  if (item.source_type === "preview" || item.source_type === "dataset" || item.source_type === "task") {
    return item.source_type;
  }
  if (item.is_preview) return "preview";
  if (item.dataset_id) return "dataset";
  return "task";
}

export function archiveSourceLabel(itemOrSourceType) {
  const kind =
    typeof itemOrSourceType === "string"
      ? itemOrSourceType
      : resolveArchiveSourceType(itemOrSourceType);
  if (kind === "preview") return "即时预览";
  if (kind === "dataset") return "预置数据集";
  return "自定义任务";
}

export function formatRequestCondition(params) {
  if (!params || typeof params !== "object") return "无显式筛选条件（接口默认请求）";
  const entries = Object.entries(params);
  if (entries.length === 0) return "无显式筛选条件（接口默认请求）";
  return entries
    .map(([key, value]) => {
      const label = parameterLabels[key] || key;
      const choiceList = parameterChoices[key];
      let valText = cellText(value);
      if (typeof value === "string" && Array.isArray(choiceList)) {
        const matched = choiceList.find(([code]) => code === value);
        if (matched) valText = `${value} (${matched[1]})`;
      } else if (value === "") {
        valText = '""（空字符串）';
      }
      return `${label}=${valText}`;
    })
    .join(" · ");
}

export function groupNavigationEntriesByDomain(navigation) {
  if (!navigation) return [];
  const domains = Array.isArray(navigation.domains) ? navigation.domains : [];
  const entries = Array.isArray(navigation.entries) ? navigation.entries : [];
  const byDomain = new Map();
  for (const entry of entries) {
    const domId = entry.business_domain || "other";
    if (!byDomain.has(domId)) byDomain.set(domId, []);
    byDomain.get(domId).push(entry);
  }
  const orderedDomains = [...domains].sort((a, b) => {
    const ia = BUSINESS_DOMAIN_ORDER.indexOf(a.id);
    const ib = BUSINESS_DOMAIN_ORDER.indexOf(b.id);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return orderedDomains.map((dom) => ({
    ...dom,
    entries: byDomain.get(dom.id) || [],
  }));
}

export const EXPORT_LAYOUT_OPTIONS = [
  {
    id: "raw",
    title: "原始归档布局 (raw · 默认)",
    shortLabel: "原始归档 (raw)",
    subtitle: "保持原采集序号切片子目录，数据文件与 meta.json 同目录原样留档",
  },
  {
    id: "organized",
    title: "后处理友好整理 (organized)",
    shortLabel: "后处理友好 (organized)",
    subtitle: "按接口入口 / 请求变体 / 字段结构隔离，组内 data/ 与 metadata/ 分离",
  },
];

export function normalizeExportLayout(layout) {
  return layout === "organized" ? "organized" : "raw";
}

export function summarizeExportResult(result, fallbackLayout = "raw") {
  const layout = normalizeExportLayout(result?.layout ?? fallbackLayout);
  const exportedSlices =
    typeof result?.exported_slices === "number"
      ? result.exported_slices
      : typeof result?.slices === "number"
        ? result.slices
        : 0;
  const skippedSlices =
    typeof result?.skipped_slices === "number" ? result.skipped_slices : null;
  return {
    exportId: result?.export_id || "",
    layout,
    layoutLabel:
      layout === "organized" ? "后处理友好 (organized)" : "原始归档 (raw)",
    directory: result?.directory || result?.destination || "",
    destinationRoot: result?.destination || "",
    manifestPath: result?.manifest_path || "",
    exportedSlices,
    skippedSlices,
  };
}

export const DAILY_WAREHOUSE_KEY_COLUMNS = ["ts_code", "trade_date"];
export const STOCK_BASIC_KEY_COLUMNS = ["ts_code"];
export const DIVIDEND_POSITION_COLUMNS = [
  "ts_code",
  "ann_date",
  "end_date",
  "div_proc",
];

export const SUPPORTED_WAREHOUSE_DATASETS = [
  "stk_premarket",
  "stock_st",
  "st",
  "stock_basic",
  "bak_basic",
  "daily",
  "weekly",
  "monthly",
  "adj_factor",
  "daily_basic",
  "bak_daily",
  "stk_shock",
  "stk_high_shock",
  "stk_alert",
  "dividend",
  "pledge_stat",
  "pledge_detail",
  "repurchase",
  "block_trade",
  "stk_seasoned",
  "stk_auction_o",
  "stk_auction_c",
  "stk_ah_comparison",
  "slb_len",
  "moneyflow",
  "moneyflow_ths",
  "moneyflow_dc",
  "moneyflow_cnt_ths",
  "moneyflow_ind_ths",
  "moneyflow_mkt_dc",
  "top_list",
  "top_inst",
  "limit_step",
  "limit_cpt_list",
  "ths_daily",
  "stk_auction",
  "hm_detail",
  "tdx_daily",
  "trade_cal", "income", "balancesheet", "cashflow", "fina_indicator",
  "stock_hsgt", "stk_managers", "stk_rewards", "new_share", "stk_limit", "suspend_d", "hsgt_top10",
  "forecast", "express", "fina_audit", "fina_mainbz", "disclosure_date", "top10_holders",
  "top10_floatholders", "share_float", "stk_account", "stk_holdernumber", "stk_holdertrade",
  "cyq_perf", "cyq_chips", "margin", "margin_detail", "margin_secs", "slb_sec", "slb_sec_detail",
  "slb_len_mm", "moneyflow_ind_dc", "limit_list_ths", "limit_list_d", "dc_index", "dc_member",
  "dc_daily", "ths_hot", "dc_hot", "tdx_index", "tdx_member", "kpl_list", "kpl_concept_cons",
  "namechange", "stock_company", "bse_mapping", "rt_k", "stk_mins", "rt_min", "rt_min_daily",
  "pro_bar_adj", "stk_weekly_monthly", "stk_week_month_adj", "pro_bar", "stk_account_old",
  "report_rc", "stk_factor", "stk_factor_pro", "stk_nineturn", "stk_surv", "broker_recommend",
  "ths_index", "ths_member", "hm_list",
];

export const DAILY_WAREHOUSE_DEFAULT_COLUMNS = [
  "ts_code",
  "trade_date",
  "open",
  "high",
  "low",
  "close",
  "pre_close",
  "change",
  "pct_chg",
  "vol",
  "amount",
  "ah_vol",
  "ah_amount",
];

export const WAREHOUSE_FIELD_LABELS = {
  // Common mandatory keys
  ts_code: "股票代码",
  trade_date: "交易日期",
  // daily (27)
  open: "开盘价",
  high: "最高价",
  low: "最低价",
  close: "收盘价",
  pre_close: "昨收价",
  change: "涨跌额",
  pct_chg: "涨跌幅(%)",
  vol: "成交量(手)",
  amount: "成交额(千元)",
  ah_vol: "盘后成交量",
  ah_amount: "盘后成交额",
  // adj_factor (28)
  adj_factor: "复权因子",
  // daily_basic (32)
  turnover_rate: "换手率(%)",
  turnover_rate_f: "自由流通换手率(%)",
  volume_ratio: "量比",
  pe: "市盈率(总市值/净利)",
  pe_ttm: "市盈率(TTM)",
  pb: "市净率",
  ps: "市销率",
  ps_ttm: "市销率(TTM)",
  dv_ratio: "股息率(%)",
  dv_ttm: "股息率(TTM)(%)",
  total_share: "总股本(万股)",
  float_share: "流通股本(万股)",
  free_share: "自由流通股本(万股)",
  total_mv: "总市值(万元)",
  circ_mv: "流通市值(万元)",
  limit_status: "涨跌停状态",
  // moneyflow (170)
  buy_sm_vol: "小单买入量(手)",
  buy_sm_amount: "小单买入金额(万元)",
  sell_sm_vol: "小单卖出量(手)",
  sell_sm_amount: "小单卖出金额(万元)",
  buy_md_vol: "中单买入量(手)",
  buy_md_amount: "中单买入金额(万元)",
  sell_md_vol: "中单卖出量(手)",
  sell_md_amount: "中单卖出金额(万元)",
  buy_lg_vol: "大单买入量(手)",
  buy_lg_amount: "大单买入金额(万元)",
  sell_lg_vol: "大单卖出量(手)",
  sell_lg_amount: "大单卖出金额(万元)",
  buy_elg_vol: "特大单买入量(手)",
  buy_elg_amount: "特大单买入金额(万元)",
  sell_elg_vol: "特大单卖出量(手)",
  sell_elg_amount: "特大单卖出金额(万元)",
  net_mf_vol: "净流入量(手)",
  net_mf_amount: "净流入额(万元)",
  // stock_basic (25)
  symbol: "股票代码(6位)",
  name: "股票名称",
  area: "地域",
  industry: "所属行业",
  fullname: "股票全称",
  enname: "英文全称",
  cnspell: "拼音缩写",
  market: "市场类型",
  exchange: "交易所代码",
  curr_type: "交易货币",
  list_status: "上市状态",
  list_date: "上市日期",
  delist_date: "退市日期",
  is_hs: "沪深港通标的",
  act_name: "实控人名称",
  act_ent_type: "实控人企业性质",
  // dividend (103)
  end_date: "分红年度/报告期",
  ann_date: "预案/实施公告日",
  div_proc: "实施进度",
  stk_div: "每股送转",
  stk_bo_rate: "每股送股比例",
  stk_co_rate: "每股转增比例",
  cash_div: "每股分红(税后)",
  cash_div_tax: "每股分红(税前)",
  record_date: "股权登记日",
  ex_date: "除权除息日",
  pay_date: "派息日",
  div_listdate: "红股上市日",
  imp_ann_date: "实施公告日",
  base_date: "基准日",
  base_share: "基准股本(万)",
};

export const DAILY_FIELD_LABELS = WAREHOUSE_FIELD_LABELS;

export const WAREHOUSE_COLUMN_PRESETS = {
  daily: [
    {
      id: "ohlcv",
      label: "常用量价 (不含盘后)",
      columns: [
        "ts_code",
        "trade_date",
        "open",
        "high",
        "low",
        "close",
        "pre_close",
        "change",
        "pct_chg",
        "vol",
        "amount",
      ],
    },
  ],
  daily_basic: [
    {
      id: "valuation_turnover",
      label: "估值与市值核心",
      columns: [
        "ts_code",
        "trade_date",
        "close",
        "turnover_rate",
        "turnover_rate_f",
        "pe",
        "pe_ttm",
        "pb",
        "ps_ttm",
        "dv_ttm",
        "total_mv",
        "circ_mv",
      ],
    },
  ],
  moneyflow: [
    {
      id: "main_net_flow",
      label: "主力大单与净流入",
      columns: [
        "ts_code",
        "trade_date",
        "buy_lg_vol",
        "buy_lg_amount",
        "sell_lg_vol",
        "sell_lg_amount",
        "buy_elg_vol",
        "buy_elg_amount",
        "sell_elg_vol",
        "sell_elg_amount",
        "net_mf_vol",
        "net_mf_amount",
      ],
    },
  ],
  stock_basic: [
    {
      id: "security_identity",
      label: "证券基础身份",
      columns: [
        "ts_code",
        "symbol",
        "name",
        "area",
        "industry",
        "market",
        "exchange",
        "list_status",
        "list_date",
        "delist_date",
        "is_hs",
      ],
    },
  ],
  dividend: [
    {
      id: "dividend_core",
      label: "分红送转与除权核心",
      columns: [
        "ts_code",
        "ann_date",
        "end_date",
        "div_proc",
        "stk_div",
        "stk_bo_rate",
        "stk_co_rate",
        "cash_div",
        "cash_div_tax",
        "record_date",
        "ex_date",
        "pay_date",
      ],
    },
  ],
};

export function normalizeCompactDate(input, label = "日期") {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const compact = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw.replace(/-/g, "") : raw;
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`${label}格式需为 YYYYMMDD 或 YYYY-MM-DD`);
  }
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${label}超出有效年月日范围：${raw}`);
  }
  return compact;
}

const STANDARD_TS_CODE_RE = /^\d{6}\.(SH|SZ|BJ)$/;
const HISTORICAL_SH_TS_CODE_RE = /^T\d{5,6}\.SH$/;
const BOARD_TS_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export function normalizeWarehouseTsCode(input, options = {}) {
  const raw = String(input ?? "").trim();
  const codeFilter = options?.codeFilter || "stock";
  if (codeFilter === "none") {
    if (!raw) return "";
    throw new Error("当前数据集无证券/板块代码列，不支持代码筛选");
  }
  if (!raw) return "";
  if (codeFilter === "board" || codeFilter === "identifier") {
    if (BOARD_TS_CODE_RE.test(raw)) {
      return raw;
    }
    throw new Error(
      codeFilter === "identifier"
        ? `标的代码格式不正确：${raw}（需为 1–32 位字母数字及 ._-）`
        : `板块代码格式不正确：${raw}（需为 1–32 位字母数字及 ._-，如 885001.TI 或 880001）`,
    );
  }
  const code = raw.toUpperCase();
  const allowHistoricalTSh = Boolean(
    options?.allowHistoricalTSh ||
      options?.datasetId === "stock_basic" ||
      options?.datasetId === "dividend",
  );
  if (
    STANDARD_TS_CODE_RE.test(code) ||
    (allowHistoricalTSh && HISTORICAL_SH_TS_CODE_RE.test(code))
  ) {
    return code;
  }
  const codeEntity =
    options?.codeColumn === "con_code" ? "成分股代码 (con_code)" : "股票代码";
  throw new Error(
    allowHistoricalTSh
      ? `${codeEntity}格式不正确：${code}（需为 6 位数字 .SH/.SZ/.BJ，或上交所历史 Txxxxx.SH / Txxxxxx.SH）`
      : `${codeEntity}格式不正确：${code}（需为 6 位数字 .SH/.SZ/.BJ，如 000001.SZ）`,
  );
}

export function parseTsCodeList(input, options = {}) {
  if (options?.codeFilter === "none") {
    const raw = String(input ?? "").trim();
    if (!raw) return [];
    throw new Error("当前数据集无证券/板块代码列，不支持代码列表筛选");
  }
  const raw = String(input ?? "").trim();
  if (!raw) return [];
  const tokens = raw
    .split(/[\s,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    const normalized = normalizeWarehouseTsCode(token, options);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function resolveWarehouseFieldLabel(
  columnName,
  warehouseField = null,
  catalogField = null,
  datasetId = "",
) {
  const col = String(columnName ?? "").trim();
  if (!col) return "";
  const wfDesc = String(warehouseField?.description ?? "").trim();
  if (wfDesc) return wfDesc;
  const cfDesc = String(catalogField?.description ?? "").trim();
  if (cfDesc) return cfDesc;
  if (col === "end_date" && datasetId && datasetId !== "dividend") {
    return "截止/报告日期";
  }
  return WAREHOUSE_FIELD_LABELS[col] || "";
}

export function buildWarehouseExportColumns(
  allColumns,
  selectedColumns,
  keyColumns = DAILY_WAREHOUSE_KEY_COLUMNS,
) {
  const mandatoryKeys =
    Array.isArray(keyColumns) && keyColumns.length > 0
      ? keyColumns
      : DAILY_WAREHOUSE_KEY_COLUMNS;
  const canonical =
    Array.isArray(allColumns) && allColumns.length > 0
      ? allColumns
      : mandatoryKeys;
  const selectedSet = new Set(
    Array.isArray(selectedColumns)
      ? selectedColumns
      : selectedColumns instanceof Set
        ? [...selectedColumns]
        : [],
  );
  for (const key of mandatoryKeys) {
    selectedSet.add(key);
  }
  const ordered = [];
  for (const col of canonical) {
    if (selectedSet.has(col)) ordered.push(col);
  }
  for (const key of [...mandatoryKeys].reverse()) {
    if (!ordered.includes(key)) ordered.unshift(key);
  }
  if (
    canonical.length > 0 &&
    ordered.length === canonical.length &&
    canonical.every((c) => selectedSet.has(c))
  ) {
    return [];
  }
  return ordered;
}

export function resolvePinnedSnapshotId(
  currentPinned,
  latestSnapshotId,
  forceReset = false,
) {
  if (forceReset) {
    return latestSnapshotId || null;
  }
  return currentPinned || latestSnapshotId || null;
}

export function resolveSelectedVariantId(
  currentSelectedId,
  variants,
  supportsVariants = false,
) {
  if (!supportsVariants) return null;
  const list = Array.isArray(variants) ? variants : [];
  if (list.length === 0) return null;
  if (
    currentSelectedId &&
    list.some((v) => v && String(v.id) === String(currentSelectedId))
  ) {
    return String(currentSelectedId);
  }
  if (list.length === 1) {
    return list[0]?.id ? String(list[0].id) : null;
  }
  return null;
}

export function formatWarehouseVariantLabel(variant) {
  if (!variant || typeof variant !== "object") return "默认请求变体";
  const params = variant.params;
  if (!params || typeof params !== "object" || Object.keys(params).length === 0) {
    return "默认请求选项（无附加选项参数）";
  }
  return formatRequestCondition(params);
}

function describeDateAxis(dateColumn, grain, calendarBasis) {
  if (!dateColumn || grain === "current_snapshot") {
    return {
      shortLabel: "",
      axisLabel: "",
      startLabel: "",
      endLabel: "",
    };
  }
  if (grain === "period_bar") {
    return {
      shortLabel: "周期结束交易日",
      axisLabel: `周期结束交易日 (${dateColumn})`,
      startLabel: `起始周期结束日 ${dateColumn}`,
      endLabel: `结束周期结束日 ${dateColumn}`,
    };
  }
  if (dateColumn === "ann_date") {
    return {
      shortLabel: "公告日",
      axisLabel: `公告日期 (${dateColumn})`,
      startLabel: `起始公告日 ${dateColumn}`,
      endLabel: `结束公告日 ${dateColumn}`,
    };
  }
  if (dateColumn === "end_date") {
    return {
      shortLabel: grain === "financial_records" ? "报告期截止日" : "统计截止日",
      axisLabel: `统计/报告截止日 (${dateColumn})`,
      startLabel: `起始截止日 ${dateColumn}`,
      endLabel: `结束截止日 ${dateColumn}`,
    };
  }
  if (dateColumn === "cal_date") {
    return {
      shortLabel: "日历日",
      axisLabel: `日历日期 (${dateColumn})`,
      startLabel: `起始日历日 ${dateColumn}`,
      endLabel: `结束日历日 ${dateColumn}`,
    };
  }
  if (dateColumn === "float_date") {
    return {
      shortLabel: "解禁日",
      axisLabel: `解禁日期 (${dateColumn})`,
      startLabel: `起始解禁日 ${dateColumn}`,
      endLabel: `结束解禁日 ${dateColumn}`,
    };
  }
  if (dateColumn === "ipo_date") {
    return {
      shortLabel: "发行日",
      axisLabel: `上网发行日 (${dateColumn})`,
      startLabel: `起始发行日 ${dateColumn}`,
      endLabel: `结束发行日 ${dateColumn}`,
    };
  }
  if (dateColumn === "start_date") {
    return {
      shortLabel: "业务起始日",
      axisLabel: `业务起始日期 (${dateColumn})`,
      startLabel: `区间起日 (${dateColumn})`,
      endLabel: `区间止日 (${dateColumn})`,
    };
  }
  if (dateColumn === "pub_date") {
    return {
      shortLabel: "发布日",
      axisLabel: `发布日期 (${dateColumn})`,
      startLabel: `起始发布日 ${dateColumn}`,
      endLabel: `结束发布日 ${dateColumn}`,
    };
  }
  if (dateColumn === "trade_date" && calendarBasis !== "calendar_day") {
    return {
      shortLabel: "交易日",
      axisLabel: `交易日期 (${dateColumn})`,
      startLabel: `起始交易日 ${dateColumn}`,
      endLabel: `结束交易日 ${dateColumn}`,
    };
  }
  return {
    shortLabel: calendarBasis === "calendar_day" ? "自然日" : "记录日期",
    axisLabel: `业务日期 (${dateColumn})`,
    startLabel: `起始日期 ${dateColumn}`,
    endLabel: `结束日期 ${dateColumn}`,
  };
}

export function resolveWarehouseProfile(meta = {}, datasetIdFallback = "") {
  const datasetId = String(meta?.dataset_id || datasetIdFallback || "").trim();
  const grain =
    meta?.grain ||
    (datasetId === "stock_basic"
      ? "current_snapshot"
      : datasetId === "dividend"
        ? "announcement_event"
        : "date_cross_section");

  const isCurrentSnapshot = grain === "current_snapshot";
  const isPeriodBar = grain === "period_bar";
  const isAnnouncementEvent = grain === "announcement_event";
  const isDateRecords = grain === "date_records";
  const isBoardRecords = grain === "board_records";
  const isAggregateSeries = grain === "aggregate_series";
  const isFinancialRecords = grain === "financial_records";
  const isCalendarRecords = grain === "calendar_records";
  const isPartitionRecords = grain === "partition_records";
  const isDateCrossSection = grain === "date_cross_section";

  const storageLayout =
    meta?.storage_layout ||
    (isCurrentSnapshot
      ? "current_snapshot"
      : isFinancialRecords || isCalendarRecords || isPartitionRecords
        ? "request_partitions"
        : "monthly");
  const isRequestPartitions = storageLayout === "request_partitions";
  const supportsVariants = Boolean(meta?.supports_variants);
  const dateCountKind = meta?.date_count_kind || null;
  const dateSemantics = meta?.date_semantics || "date";
  const atomicFullRun = Boolean(meta?.atomic_full_run);

  const codeFilter =
    meta?.code_filter === "stock" ||
    meta?.code_filter === "board" ||
    meta?.code_filter === "identifier" ||
    meta?.code_filter === "none"
      ? meta.code_filter
      : isAggregateSeries || isCalendarRecords
        ? "none"
        : isBoardRecords
          ? "board"
          : "stock";
  const supportsCodeFilter = codeFilter !== "none";
  const codeColumn = meta?.code_column || "ts_code";
  const isConstituentCode = supportsCodeFilter && codeColumn === "con_code";

  const calendarBasis =
    meta?.calendar_basis === "trading_day" ||
    meta?.calendar_basis === "calendar_day" ||
    meta?.calendar_basis === null
      ? meta.calendar_basis
      : isCurrentSnapshot || isRequestPartitions
        ? null
        : isAnnouncementEvent
          ? "calendar_day"
          : "trading_day";

  const dateColumn =
    meta?.date_column !== undefined
      ? meta.date_column
      : isCurrentSnapshot
        ? null
        : isAnnouncementEvent
          ? "ann_date"
          : isCalendarRecords
            ? "cal_date"
            : "trade_date";

  const supportsDateFilter = Boolean(dateColumn) && !isCurrentSnapshot;

  const preservesDuplicateRows =
    typeof meta?.preserves_duplicate_rows === "boolean"
      ? meta.preserves_duplicate_rows
      : isAnnouncementEvent ||
        isDateRecords ||
        isBoardRecords ||
        isAggregateSeries ||
        isRequestPartitions;

  const keyColumns =
    Array.isArray(meta?.key_columns) && meta.key_columns.length > 0
      ? [...meta.key_columns]
      : isCurrentSnapshot
        ? [...STOCK_BASIC_KEY_COLUMNS]
        : isAnnouncementEvent
          ? [...DIVIDEND_POSITION_COLUMNS]
          : codeFilter === "none" && dateColumn
            ? [dateColumn]
            : [codeColumn || "ts_code", dateColumn || "trade_date"];

  const allowsHistoricalTSh =
    codeFilter === "stock" &&
    (datasetId === "stock_basic" || datasetId === "dividend");

  const isPositioningOnlyKeys =
    isAnnouncementEvent ||
    isDateRecords ||
    isBoardRecords ||
    isRequestPartitions ||
    preservesDuplicateRows;

  const dateAxis = dateSemantics === "week_interval" || dateSemantics === "month"
    ? {shortLabel: "周期区间", axisLabel: `周期区间相交 (${dateColumn})`,
       startLabel: "相交范围起日", endLabel: "相交范围止日"}
    : dateSemantics === "timestamp"
      ? {shortLabel: "记录自然日", axisLabel: `上海自然日 (${dateColumn})`,
         startLabel: "起始自然日", endLabel: "结束自然日"}
      : dateSemantics === "period_label"
        ? {shortLabel: "周期标签", axisLabel: `周／月标签 (${dateColumn})`,
           startLabel: "起始周期标签日", endLabel: "结束周期标签日"}
        : describeDateAxis(dateColumn, grain, calendarBasis);

  let grainLabel = "交易日截面";
  if (isCurrentSnapshot) {
    grainLabel = "当前完整快照";
  } else if (dateSemantics === "timestamp") {
    grainLabel = "日内时间记录";
  } else if (["month", "week_interval", "period_label"].includes(dateSemantics)) {
    grainLabel = "周期标签记录";
  } else if (atomicFullRun) {
    grainLabel = "整段重述历史";
  } else if (isPeriodBar) {
    grainLabel = "周期 K 线";
  } else if (isAnnouncementEvent) {
    grainLabel = "公告事件明细";
  } else if (isFinancialRecords) {
    grainLabel = "财报/治理分区";
  } else if (isCalendarRecords) {
    grainLabel = "交易日历分区";
  } else if (isPartitionRecords) {
    grainLabel = "请求分区明细";
  } else if (isDateRecords) {
    grainLabel = "日期明细记录";
  } else if (isBoardRecords) {
    grainLabel = "板块行情明细";
  } else if (isAggregateSeries) {
    grainLabel = "市场汇总序列";
  } else if (
    calendarBasis === "calendar_day" ||
    (dateColumn && dateColumn !== "trade_date")
  ) {
    grainLabel = dateColumn === "end_date" ? "统计截止日截面" : "日期截面";
  }

  const grainBadge = isCurrentSnapshot
    ? `当前快照 · ${keyColumns.join(" + ")}`
    : isRequestPartitions
      ? `${grainLabel} · ${dateColumn || "partition"}`
      : `${grainLabel} · ${dateColumn || "trade_date"}`;

  let dayUnitLabel = "已检交易日";
  if (isCurrentSnapshot) {
    dayUnitLabel = "来源切片";
  } else if (dateCountKind === "period_labels_not_coverage" ||
    ["month", "week_interval", "period_label"].includes(dateSemantics)) {
    dayUnitLabel = "记录周期数";
  } else if (isRequestPartitions || dateCountKind === "record_dates_not_coverage") {
    dayUnitLabel = "记录不同日期";
  } else if (isPeriodBar) {
    dayUnitLabel = "已检开市请求日";
  } else if (calendarBasis === "calendar_day") {
    dayUnitLabel = "已检自然日";
  } else if (isDateRecords || isBoardRecords || isAggregateSeries) {
    dayUnitLabel = "已检开市日";
  }

  const daysWithRowsLabel = dayUnitLabel === "记录周期数" ? "有记录周期数" : isPeriodBar
    ? "有记录周期结束日"
    : isRequestPartitions
      ? "记录不同日期"
      : "有返回记录日期";

  const mandatoryKeysTitle = isAnnouncementEvent
    ? "必留事件定位字段"
    : isPositioningOnlyKeys
      ? "必留定位字段"
      : isAggregateSeries
        ? "日期业务键"
        : "业务键";

  const mandatoryKeysHint = isPositioningOnlyKeys
    ? preservesDuplicateRows
      ? "始终锁定保留 · 原样保留多条/重复记录，非唯一主键"
      : "始终锁定保留 · 仅作记录定位字段，非唯一主键"
    : "始终保留";

  const resetMandatoryButtonLabel = isPositioningOnlyKeys
    ? "仅保留定位字段"
    : "仅保留业务键";

  const partitionToggleLabel = isCurrentSnapshot
    ? "当前快照文件与来源切片"
    : isRequestPartitions
      ? "请求分区文件与仓库路径"
      : isAnnouncementEvent
        ? "公告月分区与仓库路径"
        : "月分区与仓库路径";

  const codeEntityLabel =
    codeFilter === "none"
      ? ""
      : codeFilter === "identifier"
        ? "标的代码"
        : codeFilter === "board"
          ? "板块代码"
          : isConstituentCode
            ? "成分股代码 (con_code)"
            : "股票代码";

  const tsCodePlaceholder =
    codeFilter === "none"
      ? ""
      : codeFilter === "identifier"
        ? "标的代码（混合榜单标的，如 000001.SZ / 885001.TI，留空全部标的）"
        : codeFilter === "board"
          ? "板块代码（如 885001.TI 或 880001，留空全部板块）"
          : isConstituentCode
            ? "成分股代码 con_code（如 000001.SZ，留空全部成分股）"
            : allowsHistoricalTSh
              ? "单股代码（如 000001.SZ 或历史 T600018.SH / T00018.SH）"
              : "单股代码（如 000001.SZ，留空全市场）";

  const exportCodeLabel =
    codeFilter === "none"
      ? ""
      : codeFilter === "identifier"
        ? "指定标的代码列表（可选，留空默认导出全部标的）"
        : codeFilter === "board"
          ? "指定板块代码列表（可选，留空默认导出全部板块）"
          : isConstituentCode
            ? "指定成分股代码列表 con_code（可选，留空默认导出全部成分股）"
            : "指定股票代码列表（可选，留空默认导出全市场）";

  const exportTsCodesPlaceholder =
    codeFilter === "none"
      ? ""
      : codeFilter === "identifier"
        ? "留空导出全部标的；多个标的代码用逗号或空格分隔"
        : codeFilter === "board"
          ? "留空导出全部板块；多个板块代码用逗号或空格分隔，如 885001.TI, 880001"
          : isConstituentCode
            ? "留空导出全部成分股；多只成分股代码（按 con_code 过滤）用逗号或空格分隔，如 000001.SZ, 600519.SH"
            : allowsHistoricalTSh
              ? "留空导出全部；多只用逗号或空格分隔，支持上交所历史 T 前缀如 000001.SZ, T600018.SH, T00018.SH"
              : "留空导出全市场；多只股票用逗号或空格分隔，如 000001.SZ, 600519.SH";

  return {
    datasetId,
    storageLayout,
    isRequestPartitions,
    supportsVariants,
    dateCountKind,
    dateSemantics,
    atomicFullRun,
    semanticNote: String(meta?.semantic_note || ""),
    grain,
    codeFilter,
    codeColumn,
    isConstituentCode,
    supportsCodeFilter,
    calendarBasis,
    isCurrentSnapshot,
    isPeriodBar,
    isAnnouncementEvent,
    isDateRecords,
    isBoardRecords,
    isAggregateSeries,
    isFinancialRecords,
    isCalendarRecords,
    isPartitionRecords,
    isDateCrossSection,
    isPositioningOnlyKeys,
    allowsHistoricalTSh,
    dateColumn,
    supportsDateFilter,
    preservesDuplicateRows,
    keyColumns,
    grainLabel,
    grainBadge,
    dateShortLabel: dateAxis.shortLabel,
    dateAxisLabel: dateAxis.axisLabel,
    startDateFieldLabel: dateAxis.startLabel,
    endDateFieldLabel: dateAxis.endLabel,
    dayUnitLabel,
    daysWithRowsLabel,
    mandatoryKeysTitle,
    mandatoryKeysHint,
    resetMandatoryButtonLabel,
    partitionToggleLabel,
    codeEntityLabel,
    tsCodePlaceholder,
    exportCodeLabel,
    exportTsCodesPlaceholder,
    phase1PrimaryMode: isCurrentSnapshot || atomicFullRun ? "full" : "incremental",
    phase1PrimaryLabel: isCurrentSnapshot ? "获取当前完整快照" : atomicFullRun ? "整段重新采集" : "检查 / 补采",
    showForceRangeButton: !isCurrentSnapshot && !atomicFullRun,
  };
}

export function buildWarehouseRowsQuery(profile, params = {}) {
  const query = {
    offset: Math.max(0, Number(params.offset ?? 0) || 0),
    limit: Math.min(200, Math.max(1, Number(params.limit ?? 50) || 50)),
  };
  if (params.snapshotId) {
    query.snapshot_id = String(params.snapshotId);
  }
  if (profile?.supportsVariants && params.variantId) {
    query.variant_id = String(params.variantId);
  }
  const codeFilter = profile?.codeFilter || "stock";
  if (codeFilter !== "none") {
    const tsCode = normalizeWarehouseTsCode(params.tsCode ?? "", {
      codeFilter,
      codeColumn: profile?.codeColumn,
      allowHistoricalTSh: Boolean(profile?.allowsHistoricalTSh),
      datasetId: profile?.datasetId,
    });
    if (tsCode) {
      query.ts_code = tsCode;
    }
  }
  if (profile?.supportsDateFilter) {
    const start = String(params.startDate ?? "").trim();
    const end = String(params.endDate ?? "").trim();
    if (start) query.start_date = start;
    if (end) query.end_date = end;
  }
  return query;
}

export function buildWarehouseExportPayload(profile, params = {}) {
  const destination = String(params.destination ?? "").trim();
  if (!destination) {
    throw new Error("请填写目标导出根目录（绝对路径）");
  }
  if (profile?.supportsVariants) {
    const variantId = String(params.variantId ?? "").trim();
    if (!variantId && Number(params.variantCount ?? 0) > 1) {
      throw new Error("当前表包含多个请求选项变体，请先选择 1 个变体后再导出");
    }
  }
  const codeFilter = profile?.codeFilter || "stock";
  const columns = buildWarehouseExportColumns(
    params.allColumns ?? [],
    params.selectedColumns ?? [],
    profile?.keyColumns ?? DAILY_WAREHOUSE_KEY_COLUMNS,
  );
  const payload = {
    destination,
    columns,
  };
  if (profile?.supportsVariants && params.variantId) {
    payload.variant_id = String(params.variantId).trim();
  }
  if (codeFilter !== "none") {
    const tsCodeOpts = {
      codeFilter,
      codeColumn: profile?.codeColumn,
      allowHistoricalTSh: Boolean(profile?.allowsHistoricalTSh),
      datasetId: profile?.datasetId,
    };
    payload.ts_codes = Array.isArray(params.tsCodes)
      ? parseTsCodeList(params.tsCodes.join(","), tsCodeOpts)
      : parseTsCodeList(params.tsCodesText ?? "", tsCodeOpts);
  }
  if (params.snapshotId) {
    payload.snapshot_id = String(params.snapshotId);
  }
  if (profile?.supportsDateFilter) {
    const colLabel = profile.dateColumn || "trade_date";
    const startLabel = profile.startDateFieldLabel || `导出起始日期 (${colLabel})`;
    const endLabel = profile.endDateFieldLabel || `导出结束日期 (${colLabel})`;
    const normStart = normalizeCompactDate(params.startDate ?? "", startLabel);
    const normEnd = normalizeCompactDate(params.endDate ?? "", endLabel);
    if (!profile.isRequestPartitions && (!normStart || !normEnd)) {
      throw new Error(`请填写导出的起止日期 ${colLabel}（YYYYMMDD）`);
    }
    if (normStart && normEnd && normStart > normEnd) {
      throw new Error("导出起始日期不能晚于结束日期");
    }
    if (normStart) payload.start_date = normStart;
    if (normEnd) payload.end_date = normEnd;
  }
  return payload;
}

export const BUSINESS_DOMAIN_NAMES = {
  reference: "标的与交易基准",
  prices: "量价与复权",
  financial: "财报与业绩",
  ownership: "股东治理与股本",
  flows: "资金流与北向",
  leverage: "两融与转融通",
  boards: "行业板块与成员",
  events: "交易事件与市场情绪",
  research: "研究信号与机构观点",
};

export function filterAndGroupWarehouseCatalog(
  entries,
  options = {},
) {
  const list = Array.isArray(entries) ? entries : [];
  const includeRawOnly = Boolean(options.includeRawOnly);
  const domainFilter = String(options.businessDomain ?? "").trim();
  const grainFilter = String(options.grain ?? "").trim();
  const q = String(options.search ?? "").trim().toLowerCase();

  // Search-filtered entries (before domain/grain/includeRawOnly filter) for accurate domain pill badges
  const searchMatched = list.filter((entry) => {
    if (!q) return true;
    const hay = `${entry.name || ""} ${entry.api_name || ""} ${entry.dataset_id || ""} ${entry.entry_id || ""} ${entry.grain || ""} ${entry.date_column || ""} ${entry.category_name || ""} ${entry.business_domain_name || ""}`.toLowerCase();
    return hay.includes(q);
  });

  const domainMap = new Map();
  for (const domId of BUSINESS_DOMAIN_ORDER) {
    domainMap.set(domId, {
      id: domId,
      name: BUSINESS_DOMAIN_NAMES[domId] || domId,
      supportedCount: 0,
      totalCount: 0,
      entries: [],
    });
  }

  for (const entry of searchMatched) {
    const domId = entry.business_domain || "other";
    if (!domainMap.has(domId)) {
      domainMap.set(domId, {
        id: domId,
        name: entry.business_domain_name || BUSINESS_DOMAIN_NAMES[domId] || domId,
        supportedCount: 0,
        totalCount: 0,
        entries: [],
      });
    }
    const bucket = domainMap.get(domId);
    bucket.totalCount += 1;
    if (entry.warehouse_supported || entry.warehouse_status === "supported") {
      bucket.supportedCount += 1;
    }
  }

  const visibleEntries = searchMatched.filter((entry) => {
    const isSupported =
      Boolean(entry.warehouse_supported) ||
      entry.warehouse_status === "supported";
    if (!includeRawOnly && !isSupported) return false;
    if (domainFilter && entry.business_domain !== domainFilter) return false;
    if (grainFilter && entry.grain !== grainFilter) return false;
    return true;
  });

  for (const entry of visibleEntries) {
    const domId = entry.business_domain || "other";
    domainMap.get(domId)?.entries.push(entry);
  }

  const domains = [...domainMap.values()].filter((d) => d.totalCount > 0);
  return {
    domains,
    visibleEntries,
    supportedTotal: searchMatched.filter(
      (e) => e.warehouse_supported || e.warehouse_status === "supported",
    ).length,
    definedTotal: searchMatched.length,
  };
}

export function filterVisibleTableColumns(columns, query = "", options = {}) {
  const list = Array.isArray(columns) ? columns : [];
  const total = list.length;
  const q = String(query ?? "").trim().toLowerCase();
  if (!q || total === 0) {
    return {
      indices: list.map((_, idx) => idx),
      total,
      visibleCount: total,
      isFiltered: false,
    };
  }
  const pinnedSet = new Set(
    Array.isArray(options.pinnedNames) ? options.pinnedNames.map(String) : [],
  );
  const keepFirst = options.keepFirst !== false;
  const indices = [];
  for (let idx = 0; idx < total; idx += 1) {
    const item = list[idx];
    const name = typeof item === "string" ? item : String(item?.name ?? "");
    const label = typeof item === "object" && item ? String(item.label ?? "") : "";
    const dtype = typeof item === "object" && item ? String(item.type ?? "") : "";
    const isPinned = (keepFirst && idx === 0) || pinnedSet.has(name);
    const matched =
      name.toLowerCase().includes(q) ||
      label.toLowerCase().includes(q) ||
      dtype.toLowerCase().includes(q);
    if (isPinned || matched) {
      indices.push(idx);
    }
  }
  return {
    indices,
    total,
    visibleCount: indices.length,
    isFiltered: true,
  };
}

function formatUtcCompactDate(dateObj) {
  const y = String(dateObj.getUTCFullYear()).padStart(4, "0");
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export function computeAnchorQuickRange(anchorDate, kind, firstDate = "") {
  if (kind === "all") {
    return { startDate: "", endDate: "" };
  }
  const cleanAnchor = /^\d{8}$/.test(String(anchorDate ?? "").trim())
    ? String(anchorDate).trim()
    : "";
  if (!cleanAnchor) {
    return { startDate: "", endDate: "" };
  }
  if (kind === "latest") {
    return { startDate: cleanAnchor, endDate: cleanAnchor };
  }
  const year = Number(cleanAnchor.slice(0, 4));
  const month = Number(cleanAnchor.slice(4, 6)) - 1;
  const day = Number(cleanAnchor.slice(6, 8));
  let start = cleanAnchor;

  if (kind === "ytd") {
    start = `${String(year).padStart(4, "0")}0101`;
  } else {
    const base = new Date(Date.UTC(year, month, day));
    if (kind === "1m") {
      base.setUTCDate(base.getUTCDate() - 30);
    } else if (kind === "3m") {
      base.setUTCDate(base.getUTCDate() - 90);
    } else if (kind === "1y") {
      base.setUTCFullYear(base.getUTCFullYear() - 1);
    }
    start = formatUtcCompactDate(base);
  }

  const cleanFirst = /^\d{8}$/.test(String(firstDate ?? "").trim())
    ? String(firstDate).trim()
    : "";
  if (cleanFirst && cleanFirst <= cleanAnchor && start < cleanFirst) {
    start = cleanFirst;
  }
  return { startDate: start, endDate: cleanAnchor };
}





