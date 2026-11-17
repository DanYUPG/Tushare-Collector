import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseObject, parseValues, errorMessage, filteredEntries, cellText,
  canGuide, taskTemplate, assertDraftSafe, collectionScope, datasetPresentation, stockCategoryGroups,
  datasetRuleLabel, advanceActivityCursor, matchesPermissionFilter, formatPermissionRpm,
  formatPermissionThreshold, describeWorkerSettingState, resolveArchiveSourceType,
  archiveSourceLabel, formatRequestCondition, groupNavigationEntriesByDomain,
  EXPORT_LAYOUT_OPTIONS, normalizeExportLayout, summarizeExportResult,
  SUPPORTED_WAREHOUSE_DATASETS, DAILY_WAREHOUSE_DEFAULT_COLUMNS, STOCK_BASIC_KEY_COLUMNS,
  DIVIDEND_POSITION_COLUMNS, normalizeCompactDate, normalizeWarehouseTsCode, parseTsCodeList,
  resolveWarehouseFieldLabel, buildWarehouseExportColumns, resolvePinnedSnapshotId,
  resolveSelectedVariantId, formatWarehouseVariantLabel,
  filterAndGroupWarehouseCatalog, resolveWarehouseProfile, buildWarehouseRowsQuery,
  buildWarehouseExportPayload, normalizeWorkspaceHash, datasetEvidence,
  runOutcome, runRecovery, filterVisibleTableColumns, computeAnchorQuickRange } from "../src/collector/static/helpers.js";

test("workspace URLs preserve safe navigation and filters but reject invalid identifiers and actions", () => {
  const params = new URLSearchParams(normalizeWorkspaceHash("#view=warehouse&dataset=income&entry=33&wh_start=20230101&raw_q=600000.SH"));
  assert.equal(params.get("view"), "warehouse");
  assert.equal(params.get("dataset"), "income");
  assert.equal(params.get("wh_start"), "20230101");
  const invalid = new URLSearchParams(normalizeWorkspaceHash("#view=delete&dataset=../private&run=bad&entry=abc&token=secret&start=true"));
  assert.deepEqual([...invalid], [["view", "needs"]]);
  const needId = "a".repeat(32);
  assert.equal(new URLSearchParams(normalizeWorkspaceHash(`#view=needs&need=${needId}`)).get("need"), needId);
  assert.equal(new URLSearchParams(normalizeWorkspaceHash("#view=needs&need=bad")).has("need"), false);
  assert.equal(new URLSearchParams(normalizeWorkspaceHash("#view=local-data&raw_search=" + "a".repeat(2001))).has("raw_search"), false);
});

test("dataset evidence never treats request dates or execution success as actual freshness or completeness", () => {
  const dataset = { scope: "current", last_run: { scope: "current", state: "succeeded" },
    last_partition: "20261231", covered_partitions: 30, unfinished_partitions: 0 };
  assert.equal(datasetEvidence(dataset).freshness, "数据截至未知");
  assert.equal(datasetEvidence(dataset).quality, "完整性未验证");
  const partial = { state: "ready", storage_layout: "monthly", last_date: "20261113", days: 10, days_with_rows: 5 };
  assert.equal(datasetEvidence(dataset, partial).freshness, "数据截至未知");
  assert.match(datasetEvidence(dataset, { ...partial, days_with_rows: 10 }).freshness, /2026-11-13/);
  assert.match(datasetEvidence(dataset, { ...partial, storage_layout: "request_partitions" }).freshness, /2026-11-13/);
  assert.match(datasetEvidence({ ...dataset, row_limit_partitions: 2 }).quality, /2 个请求触顶/);
  assert.equal(datasetEvidence({ ...dataset, last_run: { scope: "other", state: "succeeded" } }).execution, "上次执行未知");
  assert.equal(datasetPresentation({ covered_partitions: null }).kind, "unknown");
});

test("run recovery distinguishes known configuration, permission, quota and row caps without guessing unknown failures", () => {
  const failed = { state: "failed", error: null, deleted_archives: 0, row_limit_failures: 0 };
  assert.equal(runRecovery({ ...failed, error: "SDK 调用失败：请指定正确的接口名" }).kind, "config");
  assert.equal(runRecovery(failed, [{ state: "failed", error_kind: "permission" }]).retry, false);
  assert.equal(runRecovery(failed, [{ state: "failed", error_kind: "quota" }]).kind, "quota");
  assert.equal(runRecovery({ ...failed, row_limit_failures: 1, dataset_id: "daily" }).kind, "split");
  assert.equal(runRecovery({ ...failed, error: "SDK 网络请求失败：ReadTimeout" }).retry, true);
  assert.equal(runRecovery({ ...failed, error: "SDK 调用失败：每分钟最多访问200次" }).kind, "wait");
  assert.equal(runRecovery({ ...failed, error: "未知业务错误" }).retry, false);
  assert.equal(runOutcome({ state: "succeeded", rows: 0 }), "请求成功 · 无数据");
  assert.equal(runOutcome({ state: "succeeded", rows: 5 }), "请求成功 · 有记录");
});

test("catalog rule labels distinguish live snapshots, stopped history and report periods", () => {
  assert.match(datasetRuleLabel({ kind: "snapshot", rule: { strategy: "realtime" } }), /仅当前快照/);
  assert.match(datasetRuleLabel({ kind: "catalog", rule: { strategy: "trading_day", archive_only: true } }), /已停更/);
  assert.match(datasetRuleLabel({ kind: "snapshot", rule: { strategy: "stock_snapshot" } }), /不回放历史/);
  assert.match(datasetRuleLabel({ kind: "catalog", rule: { strategy: "stock_quarter" } }), /报告期/);
  assert.equal(datasetRuleLabel({ kind: "future" }), "股票目录数据");
});

test("stock hierarchy follows catalog order and groups only the supplied eligible entries", () => {
  const catalog = {
    categories: [{ id: "basic", name: "基础数据" }, { id: "market", name: "行情数据" }, { id: "financial", name: "财务数据" }],
    entries: [
      { id: "daily", category: "market", name: "日线", api_name: "daily" },
      { id: "stock", category: "basic", name: "股票", api_name: "stock_basic" },
      { id: "bar", category: "market", name: "复权", api_name: "pro_bar", status: "sdk_only" },
    ],
  };
  const groups = stockCategoryGroups(catalog);
  assert.deepEqual(groups.map(group => group.name), ["基础数据", "行情数据", "财务数据"]);
  assert.deepEqual(groups.map(group => group.entries.map(entry => entry.id)), [["stock"], ["daily", "bar"], []]);
  const direct = stockCategoryGroups(catalog, catalog.entries.filter(entry => entry.status !== "sdk_only"));
  assert.deepEqual(direct[1].entries.map(entry => entry.id), ["daily"]);
  assert.deepEqual(stockCategoryGroups(catalog, []).map(group => group.entries), [[], [], []]);
});

test("dataset next action uses active and current-scope evidence without claiming completeness", () => {
  const empty = { covered_partitions: 0, unfinished_partitions: 0, scope: "current" };
  assert.deepEqual(datasetPresentation(empty), { status: "未采集", kind: "empty", action: "首次采集" });
  const ready = { ...empty, covered_partitions: 3 };
  assert.equal(datasetPresentation(ready).action, "检查更新");
  assert.equal(datasetPresentation({ ...ready, unfinished_partitions: 1 }).status, "需要处理");
  assert.equal(datasetPresentation({ ...empty, settings_error: "invalid" }).status, "需要处理");
  assert.equal(datasetPresentation({ ...empty, last_run: { scope: "other", state: "failed" } }).status, "未采集");
  assert.equal(datasetPresentation({ ...empty, last_run: { scope: "current", state: "failed" } }).status, "需要处理");
  assert.equal(datasetPresentation({ ...ready, last_run: { scope: "current", state: "failed" } }).action, "检查更新");
  assert.deepEqual(datasetPresentation({ ...ready, unfinished_partitions: 1, active_run: "run" }),
    { status: "采集中", kind: "active", action: "查看进度" });
});

test("task parameter editors reject malformed and wrong-shaped JSON", () => {
  assert.deepEqual(parseObject('{"ts_code":"600000.SH"}'), { ts_code: "600000.SH" });
  assert.throws(() => parseObject("["), /JSON/);
  assert.throws(() => parseObject("[]"), /对象/);
  assert.throws(() => parseObject("null"), /对象/);
  assert.deepEqual(parseValues('["L","D","P"]'), ["L", "D", "P"]);
  assert.deepEqual(parseValues(""), []);
  assert.throws(() => parseValues("{}"), /数组/);
  assert.throws(() => parseValues('[{"token":"secret"}]'), /只支持/);
});

test("stock catalog search intersects category and API name filters", () => {
  const entries = [
    { name: "股票列表", api_name: "stock_basic", category: "basic" },
    { name: "每日指标", api_name: "daily_basic", category: "market" },
  ];
  assert.deepEqual(filteredEntries(entries, "market", " BASIC "), [entries[1]]);
  assert.deepEqual(filteredEntries(entries, "", "股票"), [entries[0]]);
  assert.deepEqual(filteredEntries(entries, "basic", "daily"), []);
});

test("validation errors display the relevant configuration field without echoing inputs", () => {
  const errors = [{ loc: ["body", "params"], msg: "Invalid value", input: "secret" }];
  assert.equal(errorMessage(errors), "params：Invalid value");
  assert.equal(errorMessage("Raw 目录不可写"), "Raw 目录不可写");
  assert.ok(!errorMessage(errors).includes("secret"));
});

test("preview cells preserve zero, false, exact number strings and null distinctions", () => {
  assert.equal(cellText(0), "0");
  assert.equal(cellText(false), "false");
  assert.equal(cellText(null), "NULL");
  assert.equal(cellText("1152921504606846976"), "1152921504606846976");
  assert.equal(cellText("12345.000000000000000123"), "12345.000000000000000123");
  assert.equal(cellText(["value", null]), '["value",null]');
});

test("guided forms only accept parameters that can be represented without loss", () => {
  const entry = { api_name: "daily", params: [{ name: "trade_date" }, { name: "ts_code" }] };
  assert.ok(canGuide(entry, { trade_date: "20261112", ts_code: "600000.SH" }));
  for (const params of [{ trade_date: "20260230" }, { trade_date: "2026-11-12" },
    { ts_code: null }, { ts_code: "" }, { ts_code: 1 }, { unknown: "value" }]) assert.equal(canGuide(entry, params), false);
});

test("templates distinguish single-day queries from calendar-day slicing", () => {
  assert.deepEqual(taskTemplate("stock_basic", "day", "2026-11-13").params, { list_status: "L" });
  for (const api of ["daily", "daily_basic", "adj_factor"]) {
    assert.deepEqual(taskTemplate(api, "day", "2026-11-13").params, { trade_date: "20261113" });
    const range = taskTemplate(api, "range", "2026-11-13");
    assert.equal(range.mode, "date_range");
    assert.deepEqual(range.params, {});
    assert.equal(range.start_date, "2026-11-13");
  }
  assert.throws(() => taskTemplate("income", "day", "2026-11-13"), /尚无/);
});

test("drafts reject credential fields even during incomplete JSON editing", () => {
  assertDraftSafe('{"ts_code":"600000.SH"');
  for (const text of ['{"token":"secret"', '{"Authorization":"secret"}', "password: secret"]) {
    assert.throws(() => assertDraftSafe(text), /凭证字段/);
  }
});

test("confirmation scope combines dates, base stock and filters with all enumeration values", () => {
  const config = {
    mode: "date_range", date_param: "trade_date", start_date: "2026-11-12", end_date: "2026-11-13",
    params: { ts_code: "600000.SH", enabled: false, count: 0, optional: null },
    split_param: "exchange", split_values: ["SSE", "SZSE", "BSE"],
  };
  const summary = collectionScope(config).join("\n");
  for (const text of ["600000.SH", "2026-11-12", "2026-11-13", "trade_date",
    "SSE", "SZSE", "BSE", "false", "0", "NULL"]) assert.ok(summary.includes(text), text);
  const codes = Array.from({ length: 20000 }, (_, i) => `${String(i).padStart(6, "0")}.SH`);
  const full = collectionScope({ ...config, params: {}, split_param: "ts_code", split_values: codes }).at(-1);
  assert.deepEqual(full.slice(full.indexOf("：") + 1).split("、"), codes);
  const defaults = collectionScope({ mode: "single", params: {} }).join("\n");
  assert.match(defaults, /未限定股票代码/);
  assert.match(defaults, /不代表覆盖所有股票/);
  assert.match(defaults, /未指定日期/);
  for (const [value, expected] of [[false, "false"], [0, "0"], [null, "NULL"], ["", '""（空字符串）']]) {
    assert.equal(collectionScope({ mode: "single", params: { ts_code: value } })[0], `股票范围：${expected}`);
  }
  assert.match(collectionScope({ ...config, split_values: ["", false, 0] }).at(-1), /""（空字符串）、false、0/);
});

test("activity stream cursor advances safely across tail and backlog pages", () => {
  // Initial tail load (cursor = 0) establishes cursor at snapshot latest_seq
  assert.equal(advanceActivityCursor(0, [], 0, 150), 0);
  assert.equal(advanceActivityCursor(0, [{ seq: 10 }, { seq: 12 }], 15, 150), 15);

  // Incremental full page (events.length === limit) stops at last event.seq so backlog is not skipped
  const fullPage = [{ seq: 16 }, { seq: 17 }, { seq: 18 }];
  assert.equal(advanceActivityCursor(15, fullPage, 42, 3), 18);

  // Incremental partial page advances to latest_seq
  assert.equal(advanceActivityCursor(18, [{ seq: 19 }], 42, 3), 42);
  // Monotonic guard if latest_seq is behind current cursor
  assert.equal(advanceActivityCursor(42, [], 40, 200), 42);
});

test("permission formatting and filters distinguish undocumented RPM, independent permission and insufficient points", () => {
  // Never claim official 30 RPM when documented_rpm is null
  const undocumentedRpmEntry = {
    permission_kind: "points",
    minimum_points: 2000,
    account_points: 8000,
    account_access: "points_satisfied",
    documented_rpm: null,
    configured_rpm: 30,
    daily_limit: 100000,
    note: "接口页未公布8000档分钟频次",
  };
  const rpmInfo = formatPermissionRpm(undocumentedRpmEntry);
  assert.equal(rpmInfo.isFallback, true);
  assert.match(rpmInfo.documentedLabel, /未公布/);
  assert.ok(!/官方\s*30/.test(rpmInfo.documentedLabel));
  assert.match(rpmInfo.configuredLabel, /本地保守 30/);
  assert.equal(matchesPermissionFilter(undocumentedRpmEntry, "unknown_rpm"), true);
  assert.equal(matchesPermissionFilter(undocumentedRpmEntry, "daily_limit"), true);
  assert.equal(matchesPermissionFilter(undocumentedRpmEntry, "has_conflict_or_note"), true);

  // Derived pro_bar entry is not misclassified as unknown_rpm fallback
  const derivedEntry = {
    permission_kind: "derived",
    minimum_points: null,
    account_points: 8000,
    account_access: "undocumented",
    documented_rpm: null,
    configured_rpm: 30,
    daily_limit: null,
    note: "SDK派生",
  };
  assert.equal(matchesPermissionFilter(derivedEntry, "unknown_rpm"), false);
  assert.match(formatPermissionRpm(derivedEntry).documentedLabel, /无独立 HTTP 频次/);

  // Independent permission & insufficient points thresholds
  const indep = {
    permission_kind: "independent",
    independent_permission: "股票分钟权限",
    account_access: "requires_independent_permission",
    documented_rpm: 500,
    configured_rpm: 500,
    daily_limit: 300000,
    note: "",
  };
  assert.equal(matchesPermissionFilter(indep, "independent"), true);
  assert.match(formatPermissionThreshold(indep), /股票分钟权限/);

  const insufficient = {
    permission_kind: "points",
    minimum_points: 10000,
    account_access: "insufficient_points",
    documented_rpm: null,
    configured_rpm: 30,
    daily_limit: null,
    note: "",
  };
  assert.equal(matchesPermissionFilter(insufficient, "insufficient_points"), true);
  assert.equal(formatPermissionThreshold(insufficient), "10000 积分起");
});

test("worker thread state distinguishes active effective threads from saved next-run threads", () => {
  const idleSame = describeWorkerSettingState(
    { collection_threads: 4, effective_collection_threads: 4, max_collection_threads: 16 },
    { active_run: null },
  );
  assert.equal(idleSame.configured, 4);
  assert.equal(idleSame.effective, 4);
  assert.equal(idleSame.pendingNextRun, false);

  const activeChanged = describeWorkerSettingState(
    { collection_threads: 8, effective_collection_threads: 2, max_collection_threads: 16 },
    {
      collection_threads: 8,
      effective_collection_threads: 2,
      active_run: { id: "run_1" },
    },
  );
  assert.equal(activeChanged.activeRun, true);
  assert.equal(activeChanged.effective, 2);
  assert.equal(activeChanged.configured, 8);
  assert.equal(activeChanged.pendingNextRun, true);
  assert.match(activeChanged.summary, /实际 2 线程/);
  assert.match(activeChanged.summary, /下次运行生效 8 线程/);
});

test("local data navigation groups business domains in canonical order and formats request conditions and sources", () => {
  // Source priority: explicit source_type, otherwise preview > dataset > task
  assert.equal(resolveArchiveSourceType({ source_type: "preview", dataset_id: "daily" }), "preview");
  assert.equal(resolveArchiveSourceType({ is_preview: true, dataset_id: "daily" }), "preview");
  assert.equal(resolveArchiveSourceType({ is_preview: false, dataset_id: "daily" }), "dataset");
  assert.equal(resolveArchiveSourceType({ is_preview: false, dataset_id: null }), "task");
  assert.equal(archiveSourceLabel("dataset"), "预置数据集");
  assert.equal(archiveSourceLabel("preview"), "即时预览");
  assert.equal(archiveSourceLabel("task"), "自定义任务");

  // Request conditions format labels & choice descriptions honestly without claiming coverage
  assert.match(formatRequestCondition({}), /无显式筛选条件/);
  assert.match(formatRequestCondition({ trade_date: "20261014", list_status: "L" }), /交易日期=20261014/);
  assert.match(formatRequestCondition({ list_status: "L" }), /L \(上市\)/);

  // Domain grouping preserves canonical 9-domain order and separates distinct entry_ids (e.g. two pro_bar entries)
  const grouped = groupNavigationEntriesByDomain({
    domains: [
      { id: "research", name: "研究信号与机构观点", local_entries: 0 },
      { id: "prices", name: "量价与复权", local_entries: 2 },
      { id: "reference", name: "标的与交易基准", local_entries: 1 },
    ],
    entries: [
      { entry_id: "109", api_name: "pro_bar", business_domain: "prices" },
      { entry_id: "146", api_name: "pro_bar", business_domain: "prices" },
      { entry_id: "25", api_name: "stock_basic", business_domain: "reference" },
    ],
  });
  assert.deepEqual(grouped.map(d => d.id), ["reference", "prices", "research"]);
  assert.deepEqual(grouped[1].entries.map(e => e.entry_id), ["109", "146"]);
});

test("export layout helpers default safely to raw and summarize directory, manifest, slices and skipped counts", () => {
  assert.deepEqual(EXPORT_LAYOUT_OPTIONS.map(o => o.id), ["raw", "organized"]);
  assert.equal(normalizeExportLayout(undefined), "raw");
  assert.equal(normalizeExportLayout("invalid"), "raw");
  assert.equal(normalizeExportLayout("raw"), "raw");
  assert.equal(normalizeExportLayout("organized"), "organized");

  const runSummary = summarizeExportResult({
    export_id: "exp_01",
    layout: "organized",
    directory: "/tmp/exports/tushare_exports/export-exp_01",
    manifest_path: "/tmp/exports/tushare_exports/export-exp_01/manifest.json",
    exported_slices: 23,
    skipped_slices: 2,
    destination: "/tmp/exports",
  });
  assert.equal(runSummary.layout, "organized");
  assert.match(runSummary.layoutLabel, /organized/);
  assert.equal(runSummary.directory, "/tmp/exports/tushare_exports/export-exp_01");
  assert.equal(runSummary.manifestPath, "/tmp/exports/tushare_exports/export-exp_01/manifest.json");
  assert.equal(runSummary.exportedSlices, 23);
  assert.equal(runSummary.skippedSlices, 2);

  const sliceSummary = summarizeExportResult({
    export_id: "exp_02",
    directory: "/tmp/exports/tushare_exports/export-exp_02",
    manifest_path: "/tmp/exports/tushare_exports/export-exp_02/manifest.json",
    exported_slices: 1,
    skipped_slices: null,
    destination: "/tmp/exports",
  }, "raw");
  assert.equal(sliceSummary.layout, "raw");
  assert.equal(sliceSummary.exportedSlices, 1);
  assert.equal(sliceSummary.skippedSlices, null);
});

test("daily warehouse helpers normalize compact dates, ts_code lists, column projections and pinned snapshots", () => {
  assert.equal(normalizeCompactDate("2026-04-17"), "20260417");
  assert.equal(normalizeCompactDate(" 20240102 "), "20240102");
  assert.equal(normalizeCompactDate(""), "");
  assert.throws(() => normalizeCompactDate("2026-4-1"), /YYYYMMDD/);
  assert.throws(() => normalizeCompactDate("20261301"), /有效年月日/);

  assert.deepEqual(
    parseTsCodeList("000001.sz, 600519.SH\n000001.SZ  300750.sz"),
    ["000001.SZ", "600519.SH", "300750.SZ"],
  );
  assert.deepEqual(parseTsCodeList("   "), []);
  assert.throws(() => parseTsCodeList("000001.SZ, bad$code"), /格式不正确/);

  // Selecting all available columns sends [] so backend uses full schema default
  assert.deepEqual(
    buildWarehouseExportColumns(DAILY_WAREHOUSE_DEFAULT_COLUMNS, DAILY_WAREHOUSE_DEFAULT_COLUMNS),
    [],
  );

  // Selecting optional subset preserves catalog order and enforces ts_code + trade_date keys
  assert.deepEqual(
    buildWarehouseExportColumns(DAILY_WAREHOUSE_DEFAULT_COLUMNS, ["amount", "close"]),
    ["ts_code", "trade_date", "close", "amount"],
  );

  // Unchecking all optional columns sends explicit ["ts_code", "trade_date"] instead of []
  assert.deepEqual(
    buildWarehouseExportColumns(DAILY_WAREHOUSE_DEFAULT_COLUMNS, []),
    ["ts_code", "trade_date"],
  );

  // Snapshot pinning locks onto first returned 32-hex snapshot_id across pagination until explicit reset
  const snapA = "0123456789abcdef0123456789abcdef";
  const snapB = "fedcba9876543210fedcba9876543210";
  assert.equal(resolvePinnedSnapshotId(null, snapA, false), snapA);
  assert.equal(resolvePinnedSnapshotId(snapA, snapB, false), snapA);
  assert.equal(resolvePinnedSnapshotId(snapA, snapB, true), snapB);
});

test("multi-dataset warehouse catalog filters supported tables across grains vs raw_only boundary and preserves Int64 cell strings", () => {
  for (const coreId of [
    "daily",
    "daily_basic",
    "adj_factor",
    "moneyflow",
    "stock_basic",
    "dividend",
  ]) {
    assert.ok(SUPPORTED_WAREHOUSE_DATASETS.includes(coreId));
  }

  const sampleCatalog = [
    {
      dataset_id: "daily",
      entry_id: "27",
      api_name: "daily",
      name: "历史日线",
      business_domain: "prices",
      business_domain_name: "量价与复权",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "date_cross_section",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      fields: [{ name: "ts_code", type: "str" }, { name: "trade_date", type: "str" }, { name: "close", type: "float" }],
    },
    {
      dataset_id: "daily_basic",
      entry_id: "32",
      api_name: "daily_basic",
      name: "每日指标",
      business_domain: "prices",
      business_domain_name: "量价与复权",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "date_cross_section",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      fields: [{ name: "ts_code", type: "str" }, { name: "trade_date", type: "str" }, { name: "pe", type: "float" }, { name: "limit_status", type: "int", arrow_type: "int64" }],
    },
    {
      dataset_id: "adj_factor",
      entry_id: "28",
      api_name: "adj_factor",
      name: "复权因子",
      business_domain: "prices",
      business_domain_name: "量价与复权",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "date_cross_section",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      fields: [{ name: "ts_code", type: "str" }, { name: "trade_date", type: "str" }, { name: "adj_factor", type: "float" }],
    },
    {
      dataset_id: "moneyflow",
      entry_id: "170",
      api_name: "moneyflow",
      name: "个股资金流向",
      business_domain: "flows",
      business_domain_name: "资金流与北向",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "date_cross_section",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      fields: [{ name: "ts_code", type: "str" }, { name: "trade_date", type: "str" }, { name: "net_mf_vol", type: "int", arrow_type: "int64" }],
    },
    {
      dataset_id: "stock_basic",
      entry_id: "25",
      api_name: "stock_basic",
      name: "股票列表",
      business_domain: "reference",
      business_domain_name: "标的与交易基准",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "current_snapshot",
      date_column: null,
      key_columns: ["ts_code"],
      preserves_duplicate_rows: false,
      fields: [{ name: "ts_code", type: "str" }, { name: "name", type: "str" }, { name: "list_date", type: "str" }],
    },
    {
      dataset_id: "dividend",
      entry_id: "103",
      api_name: "dividend",
      name: "分红送股数据",
      business_domain: "financial",
      business_domain_name: "财报与业绩",
      warehouse_supported: true,
      warehouse_status: "supported",
      grain: "announcement_event",
      date_column: "ann_date",
      key_columns: ["ts_code", "ann_date", "end_date", "div_proc"],
      preserves_duplicate_rows: true,
      fields: [
        { name: "ts_code", type: "str" },
        { name: "end_date", type: "str" },
        { name: "ann_date", type: "str" },
        { name: "div_proc", type: "str" },
        { name: "cash_div", type: "float" },
      ],
    },
    {
      dataset_id: "income",
      entry_id: "33",
      api_name: "income",
      name: "利润表",
      business_domain: "financial",
      business_domain_name: "财报与业绩",
      warehouse_supported: false,
      warehouse_status: "raw_only",
      key_columns: [],
      fields: [{ name: "ts_code", type: "str" }, { name: "end_date", type: "str" }],
    },
  ];

  const defaultGrouped = filterAndGroupWarehouseCatalog(sampleCatalog, {
    includeRawOnly: false,
  });
  assert.equal(defaultGrouped.supportedTotal, 6);
  assert.equal(defaultGrouped.definedTotal, 7);
  assert.deepEqual(
    defaultGrouped.visibleEntries.map((e) => e.dataset_id),
    ["daily", "daily_basic", "adj_factor", "moneyflow", "stock_basic", "dividend"],
  );

  const allGrouped = filterAndGroupWarehouseCatalog(sampleCatalog, {
    includeRawOnly: true,
    businessDomain: "financial",
  });
  assert.equal(allGrouped.visibleEntries.length, 2);
  assert.deepEqual(
    allGrouped.visibleEntries.map((e) => `${e.api_name}:${e.warehouse_status}`),
    ["dividend:supported", "income:raw_only"],
  );

  // Dynamic column projection with non-daily schemas
  const moneyflowCols = ["ts_code", "trade_date", "buy_lg_vol", "net_mf_vol", "net_mf_amount"];
  assert.deepEqual(
    buildWarehouseExportColumns(moneyflowCols, ["net_mf_amount"], ["ts_code", "trade_date"]),
    ["ts_code", "trade_date", "net_mf_amount"],
  );
  assert.deepEqual(
    buildWarehouseExportColumns(["ts_code", "trade_date", "adj_factor"], ["ts_code", "trade_date", "adj_factor"], ["ts_code", "trade_date"]),
    [],
  );

  // Unsafe 64-bit integer string from json_cell is rendered verbatim without JS Number rounding
  assert.equal(cellText("9007199254740993"), "9007199254740993");
  assert.equal(cellText(-1284500), "-1284500");
});

test("multi-grain warehouse profiles enforce snapshot no-date requests and dividend 4-column event positioning without claiming uniqueness", () => {
  // 1. stock_basic (current_snapshot): no date filter, full plan button, omits start_date/end_date in rows & export, locks ts_code
  const stockProfile = resolveWarehouseProfile(
    {
      dataset_id: "stock_basic",
      grain: "current_snapshot",
      date_column: null,
      key_columns: ["ts_code"],
      preserves_duplicate_rows: false,
    },
    "stock_basic",
  );
  assert.equal(stockProfile.isCurrentSnapshot, true);
  assert.equal(stockProfile.supportsDateFilter, false);
  assert.equal(stockProfile.dateColumn, null);
  assert.deepEqual(stockProfile.keyColumns, STOCK_BASIC_KEY_COLUMNS);
  assert.equal(stockProfile.phase1PrimaryMode, "full");
  assert.equal(stockProfile.phase1PrimaryLabel, "获取当前完整快照");
  assert.equal(stockProfile.showForceRangeButton, false);
  assert.equal(stockProfile.partitionToggleLabel, "当前快照文件与来源切片");

  const stockRowsQuery = buildWarehouseRowsQuery(stockProfile, {
    snapshotId: "11111111111111111111111111111111",
    startDate: "20240101",
    endDate: "20241231",
    tsCode: " 600000.sh ",
    offset: 50,
    limit: 50,
  });
  assert.equal("start_date" in stockRowsQuery, false);
  assert.equal("end_date" in stockRowsQuery, false);
  assert.equal(stockRowsQuery.ts_code, "600000.SH");
  assert.equal(stockRowsQuery.snapshot_id, "11111111111111111111111111111111");

  const stockAllCols = ["ts_code", "symbol", "name", "area", "industry", "list_date"];
  const stockExport = buildWarehouseExportPayload(stockProfile, {
    destination: " /tmp/stock_bundle ",
    startDate: "20240101",
    endDate: "20241231",
    allColumns: stockAllCols,
    selectedColumns: ["name", "list_date"],
    tsCodesText: "600000.sh, 000001.sz",
    snapshotId: "11111111111111111111111111111111",
  });
  assert.equal("start_date" in stockExport, false);
  assert.equal("end_date" in stockExport, false);
  assert.deepEqual(stockExport.columns, ["ts_code", "name", "list_date"]);
  assert.deepEqual(stockExport.ts_codes, ["600000.SH", "000001.SZ"]);

  // 2. dividend (announcement_event): ann_date filter, preserves duplicates, locks 4 positioning fields without calling them unique PKs
  const dividendProfile = resolveWarehouseProfile(
    {
      dataset_id: "dividend",
      grain: "announcement_event",
      date_column: "ann_date",
      key_columns: ["ts_code", "ann_date", "end_date", "div_proc"],
      preserves_duplicate_rows: true,
    },
    "dividend",
  );
  assert.equal(dividendProfile.isAnnouncementEvent, true);
  assert.equal(dividendProfile.supportsDateFilter, true);
  assert.equal(dividendProfile.dateColumn, "ann_date");
  assert.equal(dividendProfile.preservesDuplicateRows, true);
  assert.deepEqual(dividendProfile.keyColumns, DIVIDEND_POSITION_COLUMNS);
  assert.equal(dividendProfile.mandatoryKeysTitle, "必留事件定位字段");
  assert.equal(dividendProfile.resetMandatoryButtonLabel, "仅保留定位字段");
  assert.match(dividendProfile.mandatoryKeysHint, /非唯一主键/);

  const dividendAllCols = ["ts_code", "end_date", "ann_date", "div_proc", "stk_div", "cash_div", "ex_date"];
  const dividendExport = buildWarehouseExportPayload(dividendProfile, {
    destination: "/tmp/dividend_bundle",
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    allColumns: dividendAllCols,
    selectedColumns: ["cash_div"],
    tsCodesText: "",
    snapshotId: "22222222222222222222222222222222",
  });
  assert.equal(dividendExport.start_date, "20240101");
  assert.equal(dividendExport.end_date, "20241231");
  assert.deepEqual(
    dividendExport.columns,
    ["ts_code", "end_date", "ann_date", "div_proc", "cash_div"],
  );
  assert.throws(
    () =>
      buildWarehouseExportPayload(dividendProfile, {
        destination: "/tmp/dividend_bundle",
        startDate: "",
        endDate: "",
        allColumns: dividendAllCols,
        selectedColumns: dividendAllCols,
      }),
    /ann_date/,
  );

  // 3. Warehouse cards keep "共 X 个字段" and do not render Int64 column count badge
  const warehouseSource = fs.readFileSync(
    new URL("../frontend/src/components/DailyWarehouseView.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(!warehouseSource.includes("intFieldCount"), "DailyWarehouseView cards must not compute intFieldCount badge");
  assert.ok(!/含\s*\{[^}]+\}\s*列\s*Int64/.test(warehouseSource), "DailyWarehouseView cards must not render 含X列Int64 badge");
});

test("historical Shanghai T-prefix ts_code is allowed verbatim only on stock_basic and dividend while daily cross-sections enforce strict 6-digit codes", () => {
  const dailyProfile = resolveWarehouseProfile({ dataset_id: "daily", grain: "date_cross_section" }, "daily");
  const stockProfile = resolveWarehouseProfile({ dataset_id: "stock_basic", grain: "current_snapshot" }, "stock_basic");
  const dividendProfile = resolveWarehouseProfile({ dataset_id: "dividend", grain: "announcement_event" }, "dividend");

  assert.equal(dailyProfile.allowsHistoricalTSh, false);
  assert.equal(stockProfile.allowsHistoricalTSh, true);
  assert.equal(dividendProfile.allowsHistoricalTSh, true);

  // Preserves T00018.SH and T600018.SH verbatim without cross-mapping on stock_basic & dividend
  assert.equal(normalizeWarehouseTsCode("t00018.sh", { allowHistoricalTSh: true }), "T00018.SH");
  assert.equal(normalizeWarehouseTsCode("t600018.sh", { allowHistoricalTSh: true }), "T600018.SH");
  assert.deepEqual(
    parseTsCodeList("t00018.sh, T600018.SH, 000001.sz", { allowHistoricalTSh: true }),
    ["T00018.SH", "T600018.SH", "000001.SZ"],
  );

  // Rejects other exchanges, arbitrary letters, or wrong digit counts even on stock_basic / dividend
  assert.throws(() => normalizeWarehouseTsCode("T00018.SZ", { allowHistoricalTSh: true }), /格式不正确/);
  assert.throws(() => normalizeWarehouseTsCode("T600018.BJ", { allowHistoricalTSh: true }), /格式不正确/);
  assert.throws(() => normalizeWarehouseTsCode("A600018.SH", { allowHistoricalTSh: true }), /格式不正确/);
  assert.throws(() => normalizeWarehouseTsCode("T1234.SH", { allowHistoricalTSh: true }), /格式不正确/);
  assert.throws(() => normalizeWarehouseTsCode("T1234567.SH", { allowHistoricalTSh: true }), /格式不正确/);

  // Rejects T-prefix codes on original 4 daily cross-section datasets
  assert.throws(() => parseTsCodeList("T600018.SH"), /格式不正确/);
  assert.throws(() => parseTsCodeList("T00018.SH"), /格式不正确/);
  assert.throws(() => buildWarehouseRowsQuery(dailyProfile, { tsCode: "T600018.SH" }), /格式不正确/);
  assert.throws(
    () =>
      buildWarehouseExportPayload(dailyProfile, {
        destination: "/tmp/daily_out",
        startDate: "20240101",
        endDate: "20240131",
        tsCodesText: "T00018.SH",
        allColumns: DAILY_WAREHOUSE_DEFAULT_COLUMNS,
        selectedColumns: DAILY_WAREHOUSE_DEFAULT_COLUMNS,
      }),
    /格式不正确/,
  );

  // Accepts and preserves T00018.SH & T600018.SH in stock_basic & dividend queries and exports
  assert.equal(buildWarehouseRowsQuery(stockProfile, { tsCode: "t600018.sh" }).ts_code, "T600018.SH");
  assert.equal(buildWarehouseRowsQuery(dividendProfile, { tsCode: "t00018.sh" }).ts_code, "T00018.SH");
  const divPayload = buildWarehouseExportPayload(dividendProfile, {
    destination: "/tmp/div_out",
    startDate: "20010101",
    endDate: "20011231",
    tsCodesText: "t00018.sh, T600018.SH",
    allColumns: ["ts_code", "end_date", "ann_date", "div_proc", "cash_div"],
    selectedColumns: ["cash_div"],
  });
  assert.deepEqual(divPayload.ts_codes, ["T00018.SH", "T600018.SH"]);
});

test("full stock warehouse capabilities retain board, calendar, wide table and Int64 behavior", () => {
  assert.equal(new Set(SUPPORTED_WAREHOUSE_DATASETS).size, 102);
  assert.equal(SUPPORTED_WAREHOUSE_DATASETS.includes("stk_factor"), true);
  assert.equal(SUPPORTED_WAREHOUSE_DATASETS.includes("stk_factor_pro"), true);
  assert.equal(SUPPORTED_WAREHOUSE_DATASETS.includes("income"), true);

  // 1. board_records (ths_daily): accepts board codes (885001.TI, 880001) without forcing .SH/.SZ/.BJ; positioning keys
  const boardProfile = resolveWarehouseProfile(
    {
      dataset_id: "ths_daily",
      grain: "board_records",
      code_filter: "board",
      calendar_basis: "trading_day",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      preserves_duplicate_rows: true,
    },
    "ths_daily",
  );
  assert.equal(boardProfile.codeFilter, "board");
  assert.equal(boardProfile.supportsCodeFilter, true);
  assert.equal(boardProfile.isPositioningOnlyKeys, true);
  assert.equal(boardProfile.mandatoryKeysTitle, "必留定位字段");
  assert.match(boardProfile.mandatoryKeysHint, /非唯一主键/);
  assert.equal(
    normalizeWarehouseTsCode("885001.TI", { codeFilter: "board" }),
    "885001.TI",
  );
  assert.equal(
    normalizeWarehouseTsCode("880001", { codeFilter: "board" }),
    "880001",
  );
  assert.equal(
    normalizeWarehouseTsCode("bk_0475-A", { codeFilter: "board" }),
    "bk_0475-A",
  );
  assert.throws(
    () => normalizeWarehouseTsCode(".885001", { codeFilter: "board" }),
    /板块代码格式不正确/,
  );
  assert.throws(
    () => normalizeWarehouseTsCode("a".repeat(33), { codeFilter: "board" }),
    /板块代码格式不正确/,
  );
  const boardQuery = buildWarehouseRowsQuery(boardProfile, {
    tsCode: " 885001.TI ",
    startDate: "20240101",
    endDate: "20240131",
  });
  assert.equal(boardQuery.ts_code, "885001.TI");
  const boardExport = buildWarehouseExportPayload(boardProfile, {
    destination: "/tmp/ths_out",
    startDate: "20240101",
    endDate: "20240131",
    tsCodesText: "885001.TI, 880001",
    allColumns: ["ts_code", "trade_date", "close", "turnover_rate"],
    selectedColumns: ["close"],
  });
  assert.deepEqual(boardExport.ts_codes, ["885001.TI", "880001"]);
  assert.deepEqual(boardExport.columns, ["ts_code", "trade_date", "close"]);

  // 2. aggregate_series (moneyflow_mkt_dc / slb_len): code_filter=none omits ts_code in rows query and ts_codes in export payload
  const aggProfile = resolveWarehouseProfile(
    {
      dataset_id: "moneyflow_mkt_dc",
      grain: "aggregate_series",
      code_filter: "none",
      calendar_basis: "trading_day",
      date_column: "trade_date",
      key_columns: ["trade_date"],
      preserves_duplicate_rows: true,
    },
    "moneyflow_mkt_dc",
  );
  assert.equal(aggProfile.codeFilter, "none");
  assert.equal(aggProfile.supportsCodeFilter, false);
  const aggQuery = buildWarehouseRowsQuery(aggProfile, {
    tsCode: "600000.SH",
    startDate: "20240101",
    endDate: "20240131",
  });
  assert.equal("ts_code" in aggQuery, false);
  assert.equal(aggQuery.start_date, "20240101");
  const aggExport = buildWarehouseExportPayload(aggProfile, {
    destination: "/tmp/mkt_dc_out",
    startDate: "20240101",
    endDate: "20240131",
    tsCodesText: "",
    allColumns: ["trade_date", "close_sh", "net_amount"],
    selectedColumns: ["net_amount"],
  });
  assert.equal("ts_codes" in aggExport, false);
  assert.deepEqual(aggExport.columns, ["trade_date", "net_amount"]);

  // 3. period_bar (weekly): distinguishes checked open-market request days from returned period-end dates
  const weeklyProfile = resolveWarehouseProfile(
    {
      dataset_id: "weekly",
      grain: "period_bar",
      code_filter: "stock",
      calendar_basis: "trading_day",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
      preserves_duplicate_rows: false,
    },
    "weekly",
  );
  assert.equal(weeklyProfile.isPeriodBar, true);
  assert.equal(weeklyProfile.dayUnitLabel, "已检开市请求日");
  assert.equal(weeklyProfile.daysWithRowsLabel, "有记录周期结束日");
  assert.equal(weeklyProfile.mandatoryKeysTitle, "业务键");

  // 4. pledge_stat (date_cross_section with end_date + calendar_day): never mislabeled as 交易日
  const pledgeStatProfile = resolveWarehouseProfile(
    {
      dataset_id: "pledge_stat",
      grain: "date_cross_section",
      code_filter: "stock",
      calendar_basis: "calendar_day",
      date_column: "end_date",
      key_columns: ["ts_code", "end_date"],
      preserves_duplicate_rows: false,
    },
    "pledge_stat",
  );
  assert.equal(pledgeStatProfile.grainLabel, "统计截止日截面");
  assert.equal(pledgeStatProfile.dayUnitLabel, "已检自然日");
  assert.ok(!pledgeStatProfile.grainLabel.includes("交易日"));
  assert.ok(!pledgeStatProfile.dateAxisLabel.includes("交易日"));
  assert.equal(
    resolveWarehouseFieldLabel("end_date", null, null, "pledge_stat"),
    "截止/报告日期",
  );
  assert.equal(
    resolveWarehouseFieldLabel("end_date", null, { description: "截止日期" }, "pledge_stat"),
    "截止日期",
  );

  // 5. date_records (block_trade & stk_alert): positioning-only keys, preserves duplicates, dynamic start_date
  const blockTradeProfile = resolveWarehouseProfile(
    {
      dataset_id: "block_trade",
      grain: "date_records",
      code_filter: "stock",
      calendar_basis: "trading_day",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date", "buyer", "seller"],
      preserves_duplicate_rows: true,
    },
    "block_trade",
  );
  assert.equal(blockTradeProfile.isPositioningOnlyKeys, true);
  assert.equal(blockTradeProfile.mandatoryKeysTitle, "必留定位字段");
  assert.equal(blockTradeProfile.resetMandatoryButtonLabel, "仅保留定位字段");

  const stkAlertProfile = resolveWarehouseProfile(
    {
      dataset_id: "stk_alert",
      grain: "date_records",
      code_filter: "stock",
      calendar_basis: "calendar_day",
      date_column: "start_date",
      key_columns: ["ts_code", "start_date"],
      preserves_duplicate_rows: true,
    },
    "stk_alert",
  );
  assert.equal(stkAlertProfile.dateColumn, "start_date");
  assert.equal(stkAlertProfile.dayUnitLabel, "已检自然日");

  // 6. >50 columns (stk_seasoned with 69 columns): partial selection of 55 columns is preserved, not truncated at 50 or collapsed to []
  const seasonedCols = [
    "ts_code",
    "ann_date",
    ...Array.from({ length: 67 }, (_, i) => `metric_${i + 1}`),
  ];
  assert.equal(seasonedCols.length, 69);
  const partial55 = seasonedCols.slice(0, 55);
  const built55 = buildWarehouseExportColumns(seasonedCols, partial55, [
    "ts_code",
    "ann_date",
  ]);
  assert.equal(built55.length, 55);
  assert.deepEqual(built55, partial55);
  const builtAll69 = buildWarehouseExportColumns(seasonedCols, seasonedCols, [
    "ts_code",
    "ann_date",
  ]);
  assert.deepEqual(builtAll69, []);

  // 7. Unsafe Int64 exact string preservation & grain filtering
  assert.equal(cellText("9007199254740993"), "9007199254740993");
  assert.equal(cellText("-9007199254740999"), "-9007199254740999");

  const groupedByGrain = filterAndGroupWarehouseCatalog(
    [
      {
        dataset_id: "weekly",
        entry_id: "144",
        api_name: "weekly",
        name: "周线行情",
        business_domain: "prices",
        warehouse_supported: true,
        warehouse_status: "supported",
        grain: "period_bar",
        fields: [],
      },
      {
        dataset_id: "ths_daily",
        entry_id: "260",
        api_name: "ths_daily",
        name: "同花顺板块指数行情",
        business_domain: "boards",
        warehouse_supported: true,
        warehouse_status: "supported",
        grain: "board_records",
        fields: [],
      },
    ],
    { grain: "board_records" },
  );
  assert.equal(groupedByGrain.visibleEntries.length, 1);
  assert.equal(groupedByGrain.visibleEntries[0].dataset_id, "ths_daily");
});

test("request_partitions engines isolate variants, omit variant_id on non-variant tables, and support identifier & con_code filters", () => {
  // 1. Single-variant auto-select (e.g. trade_cal SSE) vs Multi-variant explicit requirement (e.g. fina_mainbz P/D)
  const sseVar = {
    id: "8b1d8eecba8a94e7f577b9a160cb5178a1fe1737826908b83c352561c91cbd88",
    params: { exchange: "SSE" },
    partitions: 37,
    rows: 13162,
  };
  const mainbzVarP = {
    id: "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000",
    params: { type: "P" },
    partitions: 4,
    rows: 72,
  };
  const mainbzVarD = {
    id: "bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111",
    params: { type: "D" },
    partitions: 4,
    rows: 20,
  };

  // Non-variant table always resolves null (never leaks foreign variant_id)
  assert.equal(resolveSelectedVariantId(sseVar.id, [sseVar], false), null);
  // Single variant auto-selects
  assert.equal(resolveSelectedVariantId(null, [sseVar], true), sseVar.id);
  // Foreign variant on single-variant table snaps cleanly to the valid single variant
  assert.equal(resolveSelectedVariantId(mainbzVarP.id, [sseVar], true), sseVar.id);
  // Multi-variant requires explicit choice: null when unselected or when foreign variant passed
  assert.equal(resolveSelectedVariantId(null, [mainbzVarP, mainbzVarD], true), null);
  assert.equal(resolveSelectedVariantId(sseVar.id, [mainbzVarP, mainbzVarD], true), null);
  assert.equal(
    resolveSelectedVariantId(mainbzVarD.id, [mainbzVarP, mainbzVarD], true),
    mainbzVarD.id,
  );
  assert.equal(formatWarehouseVariantLabel(sseVar), "交易所=SSE (上交所)");
  assert.match(formatWarehouseVariantLabel(mainbzVarP), /P/);

  // 2. Non-variant original 38 tables strictly omit variant_id on rows query & export body
  const dailyProfile = resolveWarehouseProfile(
    {
      dataset_id: "daily",
      storage_layout: "monthly",
      supports_variants: false,
      grain: "date_cross_section",
      code_filter: "stock",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date"],
    },
    "daily",
  );
  assert.equal(dailyProfile.supportsVariants, false);
  const dailyRows = buildWarehouseRowsQuery(dailyProfile, {
    snapshotId: "snap_daily",
    variantId: sseVar.id,
    startDate: "20240101",
    endDate: "20240131",
  });
  assert.equal("variant_id" in dailyRows, false);
  const dailyExport = buildWarehouseExportPayload(dailyProfile, {
    destination: "/tmp/daily_out",
    startDate: "20240101",
    endDate: "20240131",
    allColumns: DAILY_WAREHOUSE_DEFAULT_COLUMNS,
    selectedColumns: DAILY_WAREHOUSE_DEFAULT_COLUMNS,
    snapshotId: "snap_daily",
    variantId: sseVar.id,
  });
  assert.equal("variant_id" in dailyExport, false);

  // 3. trade_cal (request_partitions + calendar_records + code_filter=none + supports_variants=true)
  const tradeCalProfile = resolveWarehouseProfile(
    {
      dataset_id: "trade_cal",
      storage_layout: "request_partitions",
      supports_variants: true,
      date_count_kind: "record_dates_not_coverage",
      grain: "calendar_records",
      code_filter: "none",
      calendar_basis: "calendar_day",
      date_column: "cal_date",
      key_columns: ["exchange", "cal_date"],
      preserves_duplicate_rows: true,
    },
    "trade_cal",
  );
  assert.equal(tradeCalProfile.isRequestPartitions, true);
  assert.equal(tradeCalProfile.supportsVariants, true);
  assert.equal(tradeCalProfile.supportsCodeFilter, false);
  assert.equal(tradeCalProfile.partitionToggleLabel, "请求分区文件与仓库路径");
  assert.equal(tradeCalProfile.dateCountKind, "record_dates_not_coverage");
  assert.equal(tradeCalProfile.dayUnitLabel, "记录不同日期");
  assert.equal(tradeCalProfile.daysWithRowsLabel, "记录不同日期");

  const calRows = buildWarehouseRowsQuery(tradeCalProfile, {
    snapshotId: "b7e115f684064ac9844650e911d7ef52",
    variantId: sseVar.id,
    startDate: "20230101",
    endDate: "20230131",
    tsCode: "600000.SH",
  });
  assert.equal(calRows.variant_id, sseVar.id);
  assert.equal(calRows.start_date, "20230101");
  assert.equal(calRows.end_date, "20230131");
  assert.equal("ts_code" in calRows, false);

  // Request-partition export allows empty start/end dates (full selected variant) and omits ts_codes when code_filter=none
  const calExport = buildWarehouseExportPayload(tradeCalProfile, {
    destination: "/tmp/cal_out",
    startDate: "",
    endDate: "",
    allColumns: ["exchange", "cal_date", "is_open", "pretrade_date"],
    selectedColumns: ["is_open"],
    snapshotId: "b7e115f684064ac9844650e911d7ef52",
    variantId: sseVar.id,
    variantCount: 1,
  });
  assert.equal(calExport.variant_id, sseVar.id);
  assert.equal("start_date" in calExport, false);
  assert.equal("end_date" in calExport, false);
  assert.equal("ts_codes" in calExport, false);
  assert.deepEqual(calExport.columns, ["exchange", "cal_date", "is_open"]);

  // 4. Multi-variant fina_mainbz blocks export when no variant selected, succeeds once 1 variant is chosen, and supports 167-col projection
  const mainbzProfile = resolveWarehouseProfile(
    {
      dataset_id: "fina_mainbz",
      storage_layout: "request_partitions",
      supports_variants: true,
      grain: "financial_records",
      code_filter: "stock",
      date_column: "end_date",
      key_columns: ["ts_code", "end_date", "bz_item"],
      preserves_duplicate_rows: true,
    },
    "fina_mainbz",
  );
  assert.throws(
    () =>
      buildWarehouseExportPayload(mainbzProfile, {
        destination: "/tmp/mainbz_out",
        startDate: "20230101",
        endDate: "20231231",
        allColumns: ["ts_code", "end_date", "bz_item", "bz_sales"],
        selectedColumns: ["bz_sales"],
        variantId: null,
        variantCount: 2,
      }),
    /变体/,
  );
  const mainbzExport = buildWarehouseExportPayload(mainbzProfile, {
    destination: "/tmp/mainbz_out",
    startDate: "20230101",
    endDate: "20231231",
    tsCodesText: "600000.sh",
    allColumns: ["ts_code", "end_date", "bz_item", "bz_sales", "bz_profit"],
    selectedColumns: ["bz_sales"],
    variantId: mainbzVarP.id,
    variantCount: 2,
  });
  assert.equal(mainbzExport.variant_id, mainbzVarP.id);
  assert.deepEqual(mainbzExport.ts_codes, ["600000.SH"]);
  assert.deepEqual(mainbzExport.columns, ["ts_code", "end_date", "bz_item", "bz_sales"]);

  const finaIndicatorCols = [
    "ts_code",
    "ann_date",
    "end_date",
    ...Array.from({ length: 164 }, (_, i) => `fin_col_${i + 1}`),
  ];
  assert.equal(finaIndicatorCols.length, 167);
  const finSelected120 = finaIndicatorCols.slice(0, 120);
  const finProjected = buildWarehouseExportColumns(finaIndicatorCols, finSelected120, [
    "ts_code",
    "ann_date",
    "end_date",
  ]);
  assert.equal(finProjected.length, 120);

  // 5. code_filter='identifier' (ths_hot) & code_column='con_code' (dc_member)
  const hotProfile = resolveWarehouseProfile(
    {
      dataset_id: "ths_hot",
      storage_layout: "request_partitions",
      supports_variants: true,
      grain: "partition_records",
      code_filter: "identifier",
      date_column: "trade_date",
      key_columns: ["trade_date", "ts_code"],
      preserves_duplicate_rows: true,
    },
    "ths_hot",
  );
  assert.equal(hotProfile.codeFilter, "identifier");
  assert.equal(hotProfile.codeEntityLabel, "标的代码");
  assert.ok(!hotProfile.codeEntityLabel.includes("纯板块"));
  assert.equal(
    buildWarehouseRowsQuery(hotProfile, { variantId: sseVar.id, tsCode: "885001.TI" }).ts_code,
    "885001.TI",
  );
  assert.equal(
    buildWarehouseRowsQuery(hotProfile, { variantId: sseVar.id, tsCode: "000001.SZ" }).ts_code,
    "000001.SZ",
  );

  const dcMemberProfile = resolveWarehouseProfile(
    {
      dataset_id: "dc_member",
      storage_layout: "request_partitions",
      supports_variants: true,
      grain: "partition_records",
      code_filter: "stock",
      code_column: "con_code",
      date_column: "trade_date",
      key_columns: ["ts_code", "trade_date", "con_code"],
      preserves_duplicate_rows: true,
    },
    "dc_member",
  );
  assert.equal(dcMemberProfile.isConstituentCode, true);
  assert.match(dcMemberProfile.codeEntityLabel, /con_code/);
  assert.equal(
    buildWarehouseRowsQuery(dcMemberProfile, { variantId: sseVar.id, tsCode: "000001.sz" }).ts_code,
    "000001.SZ",
  );
});

test("record warehouse profiles preserve snapshot variants, period axes and atomic collection", () => {
  const current = resolveWarehouseProfile({
    dataset_id: "rt_min_daily", grain: "current_snapshot", storage_layout: "request_partitions",
    date_semantics: "snapshot", atomic_full_run: true, supports_variants: true,
    code_filter: "stock", key_columns: ["ts_code", "time"],
  }, "rt_min_daily");
  assert.equal(current.supportsDateFilter, false);
  assert.equal(current.phase1PrimaryMode, "full");
  const query = buildWarehouseRowsQuery(current, {
    startDate: "20261112", endDate: "20261113", variantId: "minute-round", tsCode: "600000.sh",
  });
  assert.equal(query.variant_id, "minute-round");
  assert.equal(query.ts_code, "600000.SH");
  assert.equal("start_date" in query, false);
  const snapshotExport = buildWarehouseExportPayload(current, {
    destination: "/output", allColumns: ["ts_code", "time", "close", "vol"], selectedColumns: ["close"],
    startDate: "20261112", variantId: "minute-round", variantCount: 2,
  });
  assert.equal("start_date" in snapshotExport, false);
  assert.deepEqual(snapshotExport.columns, ["ts_code", "time", "close"]);
  const dictionary = resolveWarehouseProfile({
    dataset_id: "hm_list", grain: "current_snapshot", storage_layout: "request_partitions",
    date_semantics: "snapshot", atomic_full_run: true, supports_variants: true,
    code_filter: "none", key_columns: ["name"],
  }, "hm_list");
  assert.equal(dictionary.codeFilter, "none");
  assert.equal("ts_code" in buildWarehouseRowsQuery(dictionary, { tsCode: "ignored" }), false);
  assert.match(dictionary.grainBadge, /name/);
  for (const [dataset, semantics, column] of [
    ["broker_recommend", "month", "month"], ["stk_account_old", "week_interval", "date"],
  ]) {
    const period = resolveWarehouseProfile({
      dataset_id: dataset, grain: "temporal_records", date_semantics: semantics,
      date_column: column, storage_layout: "request_partitions", code_filter: "none",
      key_columns: [column],
    }, dataset);
    assert.match(period.dateAxisLabel, /相交/);
    assert.equal(period.dayUnitLabel, "记录周期数");
  }
  const adjusted = resolveWarehouseProfile({
    dataset_id: "pro_bar_adj", grain: "temporal_records", date_column: "trade_date",
    storage_layout: "request_partitions", atomic_full_run: true,
  }, "pro_bar_adj");
  assert.equal(adjusted.phase1PrimaryMode, "full");
  assert.equal(adjusted.showForceRangeButton, false);
  const minute = resolveWarehouseProfile({
    dataset_id: "stk_mins", grain: "temporal_records", date_column: "trade_time",
    date_semantics: "timestamp", storage_layout: "request_partitions",
    key_columns: ["ts_code", "trade_time"],
  }, "stk_mins");
  assert.match(minute.dateAxisLabel, /上海自然日/);
  assert.deepEqual(buildWarehouseExportPayload(minute, {
    destination: "/output", allColumns: ["ts_code", "trade_time", "close", "vol"], selectedColumns: ["close"],
    startDate: "2026-11-12", endDate: "2026-11-13",
  }).columns, ["ts_code", "trade_time", "close"]);
});

test("built static entry and JSX sources obey strict self-only CSP without inline styles", () => {
  const staticHtml = fs.readFileSync(
    new URL("../src/collector/static/index.html", import.meta.url),
    "utf8",
  );
  assert.ok(!/<style[\s>]/i.test(staticHtml), "index.html must not contain inline <style>");
  assert.ok(!/\sstyle=/i.test(staticHtml), "index.html must not contain inline style attributes");
  assert.ok(!/data:image/i.test(staticHtml), "index.html must not contain data: image URIs");

  const srcDir = fileURLToPath(new URL("../frontend/src", import.meta.url));
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const file of walk(srcDir).filter(f => f.endsWith(".tsx") || f.endsWith(".ts"))) {
    const content = fs.readFileSync(file, "utf8");
    assert.ok(!content.includes("style={{"), `${path.basename(file)} must not use inline style={{}} under strict CSP`);
    assert.ok(!content.includes("data:image"), `${path.basename(file)} must not use data:image URIs under strict CSP`);
  }
});

test("warehouse keeps its table independent of on-demand directory, metadata, update, and export drawers", () => {
  const appSrc = fs.readFileSync(
    new URL("../frontend/src/App.tsx", import.meta.url),
    "utf8",
  );
  const warehouseSrc = fs.readFileSync(
    new URL("../frontend/src/components/DailyWarehouseView.tsx", import.meta.url),
    "utf8",
  );
  const localDataSrc = fs.readFileSync(
    new URL("../frontend/src/components/LocalDataView.tsx", import.meta.url),
    "utf8",
  );
  const cssSrc = fs.readFileSync(
    new URL("../frontend/src/index.css", import.meta.url),
    "utf8",
  );

  assert.ok(appSrc.includes("warehouseEvidence={warehouseEvidence}"), "App passes shared warehouseEvidence to views");
  assert.ok(
    warehouseSrc.includes('label={`裁剪导出 ${activeTitle} Bundle`} busy={exportBusy}'),
    "Bundle Exporter uses the shared modal drawer and prevents closing during export",
  );
  const catalogPanelSlice = warehouseSrc.slice(
    warehouseSrc.indexOf("const catalogPanel ="),
    warehouseSrc.indexOf("const rawOnlyPanel ="),
  );
  assert.ok(
    catalogPanelSlice.includes("<WorkspaceDrawer open={catalogOpen}") &&
      !catalogPanelSlice.includes("open={!isWarehouseReady}"),
    "Directory opens on demand, independently of warehouse readiness",
  );
  assert.ok(
    warehouseSrc.includes("aria-expanded={catalogOpen}") &&
      warehouseSrc.slice(warehouseSrc.indexOf("const selectSupportedDataset"), warehouseSrc.indexOf("// Respond to external dataset jump"))
        .includes("setCatalogOpen(false)"),
    "Choosing a dataset returns to the table instead of leaving the directory over it",
  );
  assert.ok(warehouseSrc.includes("sticky-col-first-cell"), "Warehouse table freezes first data column");
  assert.ok(localDataSrc.includes("sticky-col-first-cell"), "Local Raw table freezes first data column");
  assert.ok(localDataSrc.includes("localNavCache"), "Local Raw view caches navigation for instant re-entry");
  assert.ok(cssSrc.includes(".sticky-col-first-cell"), "index.css defines CSP-safe sticky first column rules");
});

test("wide-table column filter, anchor quick date ranges, command palette, and visibility polling behave accurately", () => {
  const finaColumns = [
    { name: "ts_code", label: "TS股票代码", type: "str" },
    { name: "ann_date", label: "公告日期", type: "str" },
    { name: "end_date", label: "报告期", type: "str" },
    { name: "eps", label: "基本每股收益", type: "float" },
    { name: "roe", label: "净资产收益率", type: "float" },
    { name: "grossprofit_margin", label: "销售毛利率", type: "float" },
    { name: "debt_to_assets", label: "资产负债率", type: "float" },
  ];

  // Empty query returns all columns unfiltered
  const allCols = filterVisibleTableColumns(finaColumns, "", {
    pinnedNames: ["ts_code", "ann_date", "end_date"],
  });
  assert.equal(allCols.isFiltered, false);
  assert.equal(allCols.visibleCount, 7);

  // Chinese label search keeps pinned positioning keys + matched column
  const byLabel = filterVisibleTableColumns(finaColumns, "毛利率", {
    pinnedNames: ["ts_code", "ann_date", "end_date"],
  });
  assert.equal(byLabel.isFiltered, true);
  assert.deepEqual(
    byLabel.indices.map((i) => finaColumns[i].name),
    ["ts_code", "ann_date", "end_date", "grossprofit_margin"],
  );

  // English name search keeps first column when no pinnedNames passed
  const rawPreviewCols = filterVisibleTableColumns(finaColumns, "roe");
  assert.deepEqual(
    rawPreviewCols.indices.map((i) => finaColumns[i].name),
    ["ts_code", "roe"],
  );

  // Anchor quick date range calculations & first_date clamping
  assert.deepEqual(computeAnchorQuickRange("20261113", "all"), {
    startDate: "",
    endDate: "",
  });
  assert.deepEqual(computeAnchorQuickRange("20261113", "latest"), {
    startDate: "20261113",
    endDate: "20261113",
  });
  assert.deepEqual(computeAnchorQuickRange("20261113", "1m"), {
    startDate: "20261014",
    endDate: "20261113",
  });
  assert.deepEqual(computeAnchorQuickRange("20261113", "1y"), {
    startDate: "20251113",
    endDate: "20261113",
  });
  assert.deepEqual(computeAnchorQuickRange("20261113", "ytd"), {
    startDate: "20260101",
    endDate: "20261113",
  });
  // Clamps startDate to firstDate when dataset begins after computed start
  assert.deepEqual(computeAnchorQuickRange("20260210", "1y", "20251201"), {
    startDate: "20251201",
    endDate: "20260210",
  });

  // Verify App.tsx wires CommandPaletteModal, React.lazy, and visibilitychange throttle
  const appSrc = fs.readFileSync(
    new URL("../frontend/src/App.tsx", import.meta.url),
    "utf8",
  );
  const warehouseSrc = fs.readFileSync(
    new URL("../frontend/src/components/DailyWarehouseView.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(appSrc.includes("CommandPaletteModal"), "App mounts CommandPaletteModal");
  assert.ok(appSrc.includes("visibilitychange"), "App throttles background polling via visibilitychange");
  assert.ok(appSrc.includes("Suspense"), "App wraps lazy-loaded views in Suspense");
  assert.ok(warehouseSrc.includes("RowDetailDrawer"), "Warehouse reader opens RowDetailDrawer");
  assert.ok(warehouseSrc.includes("handleRunBatchRefresh"), "Warehouse supports sequential batch refresh");
});



