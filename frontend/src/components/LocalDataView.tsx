import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderTree,
  GitBranch,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collectorApi } from "../lib/api";
import { patchLocationState } from "../lib/navigation";
import { useViewLocalHash } from "./viewLocalHash";
import {
  archiveSourceLabel,
  cellText,
  filterVisibleTableColumns,
  formatBytes,
  formatDateTime,
  formatNumber,
  formatParamsCompact,
  formatRequestCondition,
  groupNavigationEntriesByDomain,
  resolveArchiveSourceType,
  stateBadgeClass,
  states,
} from "../lib/helpers";
import { RowDetailDrawer, type RowDetailColumnMeta } from "./RowDetailDrawer";
import type {
  ArchiveDeletionCheck,
  ArchiveSourceType,
  Catalog,
  LocalDataItem,
  LocalDataNavigation,
  LocalDataNavigationEntry,
  LocalDataPage,
  SlicePreview,
} from "../types";

interface LocalDataViewProps {
  catalog: Catalog | null;
  focusTarget: {
    entryId?: string;
    runId?: string;
    sliceId?: string;
    signal: number;
  } | null;
  onRequestExport: (target: {
    runId: string;
    sliceId?: string | null;
    title: string;
  }) => void;
  onOpenRunDetail: (runId: string) => void;
  onArchiveMutated: () => Promise<void>;
}

const SLICE_PAGE_LIMIT = 30;

const FALLBACK_DOMAINS = [
  { id: "reference", name: "标的与交易基准", description: "股票列表、交易日历、曾用名与证券基础对照" },
  { id: "prices", name: "量价与复权", description: "日周月分钟行情、复权因子与每日估值指标" },
  { id: "financial", name: "财报与业绩", description: "三大财务报表、财务指标、业绩预告与快报" },
  { id: "ownership", name: "股东治理与股本", description: "十大股东、股东人数、质押、解禁、回购与分红" },
  { id: "flows", name: "资金流与北向", description: "个股/行业资金流向与沪深港通持股成交" },
  { id: "leverage", name: "两融与转融通", description: "融资融券汇总明细与转融通证券出借" },
  { id: "boards", name: "行业板块与成员", description: "行业概念指数、板块行情与成分股映射" },
  { id: "events", name: "交易事件与市场情绪", description: "龙虎榜、涨跌停、停复牌、大宗交易与游资热榜" },
  { id: "research", name: "研究信号与机构观点", description: "筹码分布、技术信号、机构调研与盈利预测" },
];

function inferFallbackDomain(category: string): { id: string; name: string } {
  switch (category) {
    case "basic":
      return { id: "reference", name: "标的与交易基准" };
    case "market":
      return { id: "prices", name: "量价与复权" };
    case "financial":
      return { id: "financial", name: "财报与业绩" };
    case "reference":
      return { id: "ownership", name: "股东治理与股本" };
    case "moneyflow":
      return { id: "flows", name: "资金流与北向" };
    case "margin":
      return { id: "leverage", name: "两融与转融通" };
    case "board":
      return { id: "boards", name: "行业板块与成员" };
    case "limit":
      return { id: "events", name: "交易事件与市场情绪" };
    case "special":
    default:
      return { id: "research", name: "研究信号与机构观点" };
  }
}

function buildFallbackNavigation(
  catalog: Catalog | null,
  localPage: LocalDataPage,
  includeEmpty: boolean,
  domainFilter: string,
  q: string,
): LocalDataNavigation {
  const localMap = new Map(localPage.catalog.map((c) => [c.entry_id, c]));
  const needle = q.trim().toLowerCase();

  const allEntries: LocalDataNavigationEntry[] = (catalog?.entries ?? []).map(
    (ce) => {
      const loc = localMap.get(ce.id);
      const dom = inferFallbackDomain(ce.category);
      const count = loc?.archives ?? 0;
      return {
        entry_id: ce.id,
        api_name: ce.api_name,
        name: ce.name,
        category: ce.category,
        category_name: ce.category_name,
        doc_url: ce.doc_url,
        business_domain: dom.id,
        business_domain_name: dom.name,
        archives: count,
        successful_archives: count,
        failed_archives: 0,
        other_archives: 0,
        successful_rows: 0,
        last_collected_at: null,
        has_data: count > 0,
      };
    },
  );

  const qMatched = needle
    ? allEntries.filter((e) =>
        `${e.name} ${e.api_name} ${e.category_name} ${e.business_domain_name}`
          .toLowerCase()
          .includes(needle),
      )
    : allEntries;

  const domains = FALLBACK_DOMAINS.map((d) => {
    const inDom = qMatched.filter((e) => e.business_domain === d.id);
    const withData = inDom.filter((e) => e.has_data);
    const archSum = withData.reduce((s, e) => s + e.archives, 0);
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      defined_entries: inDom.length,
      local_entries: withData.length,
      archives: archSum,
      successful_archives: archSum,
      failed_archives: 0,
      other_archives: 0,
      successful_rows: 0,
    };
  });

  const domainFiltered = domainFilter
    ? qMatched.filter((e) => e.business_domain === domainFilter)
    : qMatched;
  const visibleEntries = includeEmpty
    ? domainFiltered
    : domainFiltered.filter((e) => e.has_data);

  return {
    classification_version: 1,
    summary_basis: "registered_archives",
    hash_verified: false,
    coverage_verified: false,
    domains,
    entries: visibleEntries,
    raw_roots: localPage.raw_roots,
    archives: domainFiltered.reduce((s, e) => s + e.archives, 0),
    successful_archives: domainFiltered.reduce(
      (s, e) => s + e.successful_archives,
      0,
    ),
    failed_archives: 0,
    other_archives: 0,
    successful_rows: localPage.successful_rows,
    local_entries: domainFiltered.filter((e) => e.has_data).length,
    defined_entries: domainFiltered.length,
  };
}

function sourceBadgeClass(sourceType: ArchiveSourceType): string {
  if (sourceType === "preview") {
    return "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-600/20";
  }
  if (sourceType === "dataset") {
    return "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-600/20";
  }
  return "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-600/20";
}

const localNavCache = new Map<string, LocalDataNavigation>();
const localSlicePageCache = new Map<string, LocalDataPage>();
const localSlicePreviewCache = new Map<string, SlicePreview>();

function setBoundedCache<T>(map: Map<string, T>, key: string, value: T, max = 24) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function clearLocalDataCaches() {
  localNavCache.clear();
  localSlicePageCache.clear();
  localSlicePreviewCache.clear();
}

export function LocalDataView({
  catalog,
  focusTarget,
  onRequestExport,
  onOpenRunDetail,
  onArchiveMutated,
}: LocalDataViewProps) {
  const { params: localHash, replace: replaceLocalHash } = useViewLocalHash("local-data", "raw_");
  const linkedRun = localHash.get("run") || "";
  const linkedSlice = localHash.get("slice") || "";
  const linkedTarget = /^[\w.:-]{1,200}$/.test(linkedRun) && /^[\w.:-]{1,200}$/.test(linkedSlice)
    ? { runId: linkedRun, sliceId: linkedSlice } : null;
  const linkedSliceRef = useRef(linkedTarget);
  const initialNavSearch = (localHash.get("catalog_search") || "").slice(0, 2000);
  const initialFileSearch = (localHash.get("file_search") || "").slice(0, 2000);
  const initialRowSearch = (localHash.get("search") || "").slice(0, 2000);
  const initialColRaw = localHash.get("column") || "";
  const initialCol = /^[A-Za-z_]\w{0,127}$/.test(initialColRaw) ? initialColRaw : "";

  const [catalogPaneOpen, setCatalogPaneOpen] = useState(!linkedTarget);
  const [filesPaneOpen, setFilesPaneOpen] = useState(true);
  // Navigation tree state (Column 1: Business Domains -> API Entries)
  const [rawRoot, setRawRoot] = useState("");
  const [businessDomain, setBusinessDomain] = useState("");
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [navSearchInput, setNavSearchInput] = useState(initialNavSearch);
  const [appliedNavSearch, setAppliedNavSearch] = useState(initialNavSearch);
  const [collapsedDomains, setCollapsedDomains] = useState<Set<string>>(
    () => new Set(),
  );

  const initialCachedNav = localNavCache.get(`|${initialNavSearch}||false`) ?? null;
  const initialEntryId = useMemo(() => {
    if (focusTarget?.entryId) return focusTarget.entryId;
    if (!initialCachedNav) return "";
    const firstWithData = initialCachedNav.entries.find((e) => e.has_data);
    return firstWithData?.entry_id ?? initialCachedNav.entries[0]?.entry_id ?? "";
  }, []);

  const [navigation, setNavigation] = useState<LocalDataNavigation | null>(
    initialCachedNav,
  );
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  // Selected Entry & Archive File List state (Column 2: Raw Archives of Selected Entry)
  const [selectedEntryId, setSelectedEntryId] = useState<string>(initialEntryId);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<ArchiveSourceType | "">("");
  const [stateFilter, setStateFilter] = useState("");
  const [sliceSearchInput, setSliceSearchInput] = useState(initialFileSearch);
  const [appliedSliceSearch, setAppliedSliceSearch] = useState(initialFileSearch);
  const [listOffset, setListOffset] = useState(0);
  const [expandedLineageIds, setExpandedLineageIds] = useState<Set<string>>(
    () => new Set(),
  );

  const initialCachedPage = initialEntryId
    ? localSlicePageCache.get(`${initialEntryId}|||||${initialFileSearch}|0`) ?? null
    : null;
  const [page, setPage] = useState<LocalDataPage | null>(initialCachedPage);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Selected Slice & Table Preview state (Column 3: Verified Single-File Reader)
  const [selectedSlice, setSelectedSlice] = useState<{
    runId: string;
    sliceId: string;
    title?: string;
    item?: LocalDataItem | null;
  } | null>(() => {
    if (linkedTarget) return linkedTarget;
    if (!initialCachedPage) return null;
    const pick =
      initialCachedPage.items.find((it) => it.state === "succeeded") ??
      initialCachedPage.items[0];
    if (!pick) return null;
    return {
      runId: pick.run_id,
      sliceId: pick.slice_id,
      title: `${pick.name} (${pick.api_name})`,
      item: pick,
    };
  });
  const [showPreviewLineage, setShowPreviewLineage] = useState(false);
  const [displayColumnQuery, setDisplayColumnQuery] = useState("");
  const [inspectedPreviewRowIndex, setInspectedPreviewRowIndex] = useState<
    number | null
  >(null);

  const [preview, setPreview] = useState<SlicePreview | null>(() => {
    const target =
      linkedTarget ??
      (() => {
        const pick =
          initialCachedPage?.items.find((it) => it.state === "succeeded") ??
          initialCachedPage?.items[0];
        return pick ? { runId: pick.run_id, sliceId: pick.slice_id } : null;
      })();
    if (!target) return null;
    return (
      localSlicePreviewCache.get(
        `${target.runId}|${target.sliceId}|0|50|${initialRowSearch}|${initialRowSearch ? initialCol : ""}`,
      ) ?? null
    );
  });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [rowQuery, setRowQuery] = useState(initialRowSearch);
  const [appliedRowQuery, setAppliedRowQuery] = useState(initialRowSearch);
  const [columnFilter, setColumnFilter] = useState(initialCol);
  const [rowOffset, setRowOffset] = useState(0);
  const [rowLimit, setRowLimit] = useState(50);

  // Safe archive deletion check modal
  const [deletionCheck, setDeletionCheck] = useState<ArchiveDeletionCheck | null>(
    null,
  );
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);

  const skipAutoSelectEntryRef = useRef(false);

  const loadNavigation = useCallback(
    async (opts?: {
      rawRoot?: string;
      q?: string;
      businessDomain?: string;
      includeEmpty?: boolean;
      preferEntryId?: string;
    }) => {
      const effRoot = opts?.rawRoot !== undefined ? opts.rawRoot : rawRoot;
      const effQ = opts?.q !== undefined ? opts.q : appliedNavSearch;
      const effDom =
        opts?.businessDomain !== undefined ? opts.businessDomain : businessDomain;
      const effEmpty =
        opts?.includeEmpty !== undefined ? opts.includeEmpty : includeEmpty;

      const navKey = `${effRoot}|${effQ}|${effDom}|${effEmpty}`;
      const cachedNav = localNavCache.get(navKey);
      if (cachedNav) {
        setNavigation(cachedNav);
      }

      setNavLoading(true);
      setNavError(null);
      try {
        let nav: LocalDataNavigation;
        try {
          nav = await collectorApi.getLocalDataNavigation({
            raw_root: effRoot,
            q: effQ,
            business_domain: effDom,
            include_empty: effEmpty,
          });
        } catch {
          // Graceful fallback if backend /api/local-data/navigation is not yet online
          const fallbackPage = await collectorApi.getLocalData({
            raw_root: effRoot,
            limit: 1,
          });
          nav = buildFallbackNavigation(
            catalog,
            fallbackPage,
            effEmpty,
            effDom,
            effQ,
          );
        }
        setBoundedCache(localNavCache, navKey, nav);
        setNavigation(nav);

        const targetEntry = opts?.preferEntryId;
        if (targetEntry !== undefined) {
          setSelectedEntryId(targetEntry);
        } else if (!skipAutoSelectEntryRef.current) {
          setSelectedEntryId((prev) => {
            if (prev && nav.entries.some((e) => e.entry_id === prev)) {
              return prev;
            }
            const firstWithData = nav.entries.find((e) => e.has_data);
            return firstWithData?.entry_id ?? nav.entries[0]?.entry_id ?? "";
          });
        }
      } catch (err) {
        setNavError(
          err instanceof Error ? err.message : "加载业务域与接口目录失败",
        );
      } finally {
        setNavLoading(false);
      }
    },
    [rawRoot, appliedNavSearch, businessDomain, includeEmpty, catalog],
  );

  const selectedNavEntry = useMemo(
    () =>
      navigation?.entries.find((e) => e.entry_id === selectedEntryId) ?? null,
    [navigation, selectedEntryId],
  );

  const catalogFallbackEntry = useMemo(
    () => catalog?.entries.find((e) => e.id === selectedEntryId) ?? null,
    [catalog, selectedEntryId],
  );

  const loadEntrySlices = useCallback(
    async (opts?: {
      entryId?: string;
      offset?: number;
      q?: string;
      autoSelectFirst?: boolean;
    }) => {
      const effEntryId =
        opts?.entryId !== undefined ? opts.entryId : selectedEntryId;
      const effOffset = opts?.offset !== undefined ? opts.offset : listOffset;
      const effQ = opts?.q !== undefined ? opts.q : appliedSliceSearch;

      const sliceCacheKey = `${effEntryId}|${!effEntryId ? businessDomain : ""}|${rawRoot}|${sourceTypeFilter}|${stateFilter}|${effQ}|${effOffset}`;
      const cachedPage = localSlicePageCache.get(sliceCacheKey);
      if (cachedPage) {
        setPage(cachedPage);
      }

      setListLoading(true);
      setListError(null);
      try {
        const data = await collectorApi.getLocalData({
          entry_id: effEntryId || undefined,
          business_domain: !effEntryId && businessDomain ? businessDomain : undefined,
          raw_root: rawRoot || undefined,
          source_type: sourceTypeFilter || undefined,
          state: stateFilter || undefined,
          q: effQ || undefined,
          offset: effOffset,
          limit: SLICE_PAGE_LIMIT,
        });
        setBoundedCache(localSlicePageCache, sliceCacheKey, data);
        setPage(data);

        if (opts?.autoSelectFirst !== false) {
          setSelectedSlice((prev) => {
            if (
              prev &&
              data.items.some(
                (it) => it.run_id === prev.runId && it.slice_id === prev.sliceId,
              )
            ) {
              const updatedItem = data.items.find(
                (it) => it.run_id === prev.runId && it.slice_id === prev.sliceId,
              );
              return { ...prev, item: updatedItem ?? prev.item };
            }
            if (
              prev && (
                (focusTarget?.sliceId && prev.sliceId === focusTarget.sliceId) ||
                (linkedSliceRef.current?.sliceId === prev.sliceId && linkedSliceRef.current.runId === prev.runId)
              )
            ) {
              return prev;
            }
            const firstSucceeded = data.items.find(
              (it) => it.state === "succeeded",
            );
            const pick = firstSucceeded ?? data.items[0];
            if (!pick) return null;
            return {
              runId: pick.run_id,
              sliceId: pick.slice_id,
              title: `${pick.name} (${pick.api_name})`,
              item: pick,
            };
          });
        }
      } catch (err) {
        setListError(
          err instanceof Error ? err.message : "读取原始归档文件列表失败",
        );
      } finally {
        setListLoading(false);
      }
    },
    [
      selectedEntryId,
      businessDomain,
      rawRoot,
      sourceTypeFilter,
      stateFilter,
      appliedSliceSearch,
      listOffset,
      focusTarget?.sliceId,
    ],
  );

  const firstHashSyncRef = useRef(true);
  useEffect(() => {
    if (firstHashSyncRef.current) {
      firstHashSyncRef.current = false;
      if (!linkedTarget) return;
    }
    const search = (localHash.get("search") || "").slice(0, 2000);
    const navSearch = (localHash.get("catalog_search") || "").slice(0, 2000);
    const fileSearch = (localHash.get("file_search") || "").slice(0, 2000);
    linkedSliceRef.current = linkedTarget;
    if (linkedTarget) {
      setSelectedSlice(linkedTarget);
    }
    setRowQuery(search);
    setAppliedRowQuery(search);
    setNavSearchInput(navSearch);
    setAppliedNavSearch(navSearch);
    setSliceSearchInput(fileSearch);
    setAppliedSliceSearch(fileSearch);
    setRowOffset(0);
    setListOffset(0);
    const column = localHash.get("column") || "";
    setColumnFilter(/^[A-Za-z_]\w{0,127}$/.test(column) ? column : "");
  }, [localHash]);

  // Handle external cross-module navigation (from DatasetsView or RunDetail/LiveLogDock)
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.entryId) {
      skipAutoSelectEntryRef.current = false;
      setBusinessDomain("");
      setNavSearchInput(localHash.get("catalog_search") || "");
      setAppliedNavSearch(localHash.get("catalog_search") || "");
      setSelectedEntryId(focusTarget.entryId);
      setListOffset(0);
      setSliceSearchInput(localHash.get("file_search") || "");
      setAppliedSliceSearch(localHash.get("file_search") || "");
      setSelectedSlice(linkedSliceRef.current);
      void loadNavigation({
        businessDomain: "",
        q: localHash.get("catalog_search") || "",
        preferEntryId: focusTarget.entryId,
      });
      return;
    }
    if (focusTarget.runId && focusTarget.sliceId) {
      skipAutoSelectEntryRef.current = true;
      setSelectedSlice({
        runId: focusTarget.runId,
        sliceId: focusTarget.sliceId,
      });
      linkedSliceRef.current = { runId: focusTarget.runId, sliceId: focusTarget.sliceId };
      setRowOffset(0);
      setRowQuery("");
      setAppliedRowQuery("");
      setColumnFilter("");
      void loadNavigation();
    }
  }, [focusTarget?.signal]);

  // Reload navigation when tree-level filters change
  useEffect(() => {
    void loadNavigation();
  }, [rawRoot, businessDomain, includeEmpty, appliedNavSearch, loadNavigation]);

  // Reload archive slice list when selected entry or slice-level filters change
  useEffect(() => {
    if (selectedNavEntry && !selectedNavEntry.has_data) {
      // Selected an empty defined interface: still fetch once if needed for pending deletions, or clear items cleanly
      setPage((prev) =>
        prev
          ? {
              ...prev,
              items: [],
              archives: 0,
              runs: 0,
              successful_rows: 0,
              offset: 0,
              next_offset: null,
            }
          : null,
      );
      if (!skipAutoSelectEntryRef.current) {
        if (!linkedSliceRef.current) setSelectedSlice(null);
      }
      return;
    }
    if (!selectedEntryId && navigation && navigation.entries.length === 0) {
      // Still fetch 1 item on empty state so pending_deletions banner stays accurate
      void loadEntrySlices({ entryId: "", offset: 0, autoSelectFirst: false });
      return;
    }
    if (!selectedEntryId && !skipAutoSelectEntryRef.current) {
      return;
    }
    void loadEntrySlices();
  }, [
    selectedEntryId,
    selectedNavEntry?.has_data,
    rawRoot,
    sourceTypeFilter,
    stateFilter,
    appliedSliceSearch,
    listOffset,
  ]);

  // Load verified single-file table preview when selectedSlice changes
  useEffect(() => {
    if (!selectedSlice) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const effCol = appliedRowQuery ? columnFilter : "";
    const previewKey = `${selectedSlice.runId}|${selectedSlice.sliceId}|${rowOffset}|${rowLimit}|${appliedRowQuery}|${effCol}`;
    const cachedPreview = localSlicePreviewCache.get(previewKey);
    if (cachedPreview) {
      setPreview(cachedPreview);
    }
    let cancelled = false;
    setPreviewLoading(!cachedPreview);
    setPreviewError(null);
    collectorApi
      .previewSlice(selectedSlice.runId, selectedSlice.sliceId, {
        offset: rowOffset,
        limit: rowLimit,
        q: appliedRowQuery,
        column: effCol,
      })
      .then((res) => {
        setBoundedCache(localSlicePreviewCache, previewKey, res);
        if (!cancelled) setPreview(res);
      })
      .catch((err) => {
        if (!cancelled) {
          if (!cachedPreview) setPreview(null);
          setPreviewError(
            err instanceof Error ? err.message : "预览归档文件失败",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedSlice?.runId,
    selectedSlice?.sliceId,
    rowOffset,
    rowLimit,
    appliedRowQuery,
    columnFilter,
  ]);

  const domainGroups = useMemo(
    () => groupNavigationEntriesByDomain(navigation),
    [navigation],
  );

  const visibleDomainGroups = useMemo(() => {
    return domainGroups.filter((dom) => {
      if (businessDomain && dom.id !== businessDomain) return false;
      if (!includeEmpty && dom.entries.length === 0) return false;
      return true;
    });
  }, [domainGroups, businessDomain, includeEmpty]);

  const toggleDomainCollapse = (domId: string) => {
    setCollapsedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domId)) next.delete(domId);
      else next.add(domId);
      return next;
    });
  };

  const toggleCardLineage = (sliceId: string) => {
    setExpandedLineageIds((prev) => {
      const next = new Set(prev);
      if (next.has(sliceId)) next.delete(sliceId);
      else next.add(sliceId);
      return next;
    });
  };

  const handleSelectEntry = (entry: LocalDataNavigationEntry) => {
    linkedSliceRef.current = null;
    patchLocationState({
      entry: entry.entry_id,
      dataset: null,
      run: null,
      slice: null,
      raw_run: null,
      raw_slice: null,
      raw_search: null,
      raw_file_search: null,
      raw_column: null,
    }, "push");
    skipAutoSelectEntryRef.current = false;
    setSelectedEntryId(entry.entry_id);
    setListOffset(0);
    setSliceSearchInput("");
    setAppliedSliceSearch("");
    setSelectedSlice(null);
    setShowPreviewLineage(false);
  };

  const handleSelectItem = (item: LocalDataItem) => {
    linkedSliceRef.current = null;
    replaceLocalHash({ run: item.run_id, slice: item.slice_id, search: null, column: null });
    skipAutoSelectEntryRef.current = false;
    setSelectedSlice({
      runId: item.run_id,
      sliceId: item.slice_id,
      title: `${item.name} (${item.api_name})`,
      item,
    });
    setRowOffset(0);
    setRowQuery("");
    setAppliedRowQuery("");
    setColumnFilter("");
  };

  const handleOpenDeleteCheck = async () => {
    if (!selectedSlice) return;
    setDeletionBusy(true);
    setDeletionError(null);
    try {
      const info = await collectorApi.checkArchiveDeletion(
        selectedSlice.runId,
        selectedSlice.sliceId,
      );
      setDeletionCheck(info);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "检查删除条件失败");
    } finally {
      setDeletionBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletionCheck) return;
    setDeletionBusy(true);
    setDeletionError(null);
    try {
      await collectorApi.deleteArchive(
        deletionCheck.run_id,
        deletionCheck.slice_id,
        deletionCheck.fingerprint,
      );
      clearLocalDataCaches();
      setDeletionCheck(null);
      setSelectedSlice(null);
      setPreview(null);
      await loadNavigation();
      await loadEntrySlices({ offset: 0 });
      await onArchiveMutated();
    } catch (err) {
      setDeletionError(err instanceof Error ? err.message : "删除归档失败");
    } finally {
      setDeletionBusy(false);
    }
  };

  const handleRetryCleanup = async (deletionId: string) => {
    try {
      await collectorApi.retryDeletionCleanup(deletionId);
      clearLocalDataCaches();
      await loadNavigation();
      await loadEntrySlices();
      await onArchiveMutated();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "重试清理失败");
    }
  };

  useEffect(() => {
    setInspectedPreviewRowIndex(null);
  }, [selectedSlice?.runId, selectedSlice?.sliceId, rowOffset, rowLimit]);

  useEffect(() => {
    setDisplayColumnQuery("");
  }, [selectedEntryId]);

  const previewColumnsMeta = useMemo<RowDetailColumnMeta[]>(() => {
    const cols = preview?.columns ?? [];
    const descMap = new Map<string, string>();
    for (const f of catalogFallbackEntry?.fields ?? []) {
      if (f.description) descMap.set(f.name, f.description);
    }
    return cols.map((col, idx) => ({
      name: col.name,
      type: col.type,
      label: descMap.get(col.name),
      isInt64: /int64/i.test(col.type || ""),
      isKey: idx === 0,
    }));
  }, [preview?.columns, catalogFallbackEntry]);

  const visiblePreviewColumns = useMemo(
    () =>
      filterVisibleTableColumns(previewColumnsMeta, displayColumnQuery, {
        keepFirst: true,
      }),
    [previewColumnsMeta, displayColumnQuery],
  );

  const activeHeaderName =
    selectedNavEntry?.name ??
    selectedSlice?.item?.name ??
    catalogFallbackEntry?.name ??
    "原始归档文件";
  const activeHeaderApi =
    selectedNavEntry?.api_name ??
    selectedSlice?.item?.api_name ??
    catalogFallbackEntry?.api_name ??
    "";
  const activeHeaderDomain =
    selectedNavEntry?.business_domain_name ??
    selectedSlice?.item?.business_domain_name ??
    "";
  const activeHeaderDocUrl =
    selectedNavEntry?.doc_url ?? catalogFallbackEntry?.doc_url ?? "";

  return (
    <div className="space-y-3.5">
      {/* Pending Deletion Recovery Banner */}
      {page && page.pending_deletion_count > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 text-xs text-amber-900 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              存在 {page.pending_deletion_count} 项未完成物理文件清理的归档删除记录
            </span>
          </div>
          <div className="space-y-1">
            {page.pending_deletions.slice(0, 5).map((del) => (
              <div
                key={del.id}
                className="flex items-center justify-between rounded bg-white/80 px-2.5 py-1.5"
              >
                <span className="font-mono text-[11px]">
                  切片 {del.slice_id.slice(0, 10)} · 状态 {del.state}
                  {del.error ? ` · ${del.error}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => handleRetryCleanup(del.id)}
                  className="rounded bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                >
                  重试清理文件
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Business Domain Ribbon + Honest Registration Summary */}
      <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
              <FolderTree className="h-4 w-4 text-teal-600" />
              按研究业务域浏览本地原始归档
            </span>
            {navigation && (
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] text-slate-700 font-mono tabular-nums">
                存在本地原始文件：{navigation.local_entries}/{navigation.defined_entries} 个接口 · 登记归档{" "}
                {formatNumber(navigation.archives)} 份（成功{" "}
                {formatNumber(navigation.successful_archives)}
                {navigation.failed_archives > 0
                  ? ` · 失败 ${formatNumber(navigation.failed_archives)}`
                  : ""}
                ）· 累计登记 {formatNumber(navigation.successful_rows)} 行
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(navigation?.raw_roots?.length ?? 0) > 0 && (
              <select
                value={rawRoot}
                onChange={(e) => {
                  setRawRoot(e.target.value);
                  setListOffset(0);
                }}
                aria-label="筛选本地归档根目录"
                className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-700 max-w-64 truncate"
              >
                <option value="">全部保存目录 ({navigation?.raw_roots.length})</option>
                {(navigation?.raw_roots ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}

            <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 cursor-pointer select-none hover:bg-slate-100">
              <input
                type="checkbox"
                checked={includeEmpty}
                onChange={(e) => setIncludeEmpty(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-600"
              />
              显示无本地数据的目录定义
            </label>
          </div>
        </div>

        {/* 9 Business Domain Filter Pills */}
        {navigation && navigation.domains.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setBusinessDomain("");
                setListOffset(0);
              }}
              className={clsx(
                "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                businessDomain === ""
                  ? "bg-navy-900 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200",
              )}
            >
              全部业务域
            </button>
            {navigation.domains.map((dom) => {
              const active = businessDomain === dom.id;
              const dim = !includeEmpty && dom.local_entries === 0;
              return (
                <button
                  key={dom.id}
                  type="button"
                  onClick={() => {
                    setBusinessDomain(active ? "" : dom.id);
                    setListOffset(0);
                  }}
                  title={dom.description}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                    active
                      ? "bg-teal-600 text-white"
                      : dim
                        ? "bg-slate-50 text-slate-400 ring-1 ring-inset ring-slate-200/80 hover:bg-slate-100 hover:text-slate-600"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                  )}
                >
                  <span>{dom.name}</span>
                  <span
                    className={clsx(
                      "rounded px-1 py-0.2 font-mono text-[10px] tabular-nums",
                      active
                        ? "bg-white/20 text-white"
                        : dom.local_entries > 0
                          ? "bg-white text-teal-700"
                          : "bg-slate-200/60 text-slate-400",
                    )}
                  >
                    {includeEmpty
                      ? `${dom.local_entries}/${dom.defined_entries}`
                      : dom.local_entries}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Honest SQLite Registration Notice */}
        <div className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-1.5 text-[11px] text-slate-500 ring-1 ring-inset ring-slate-200/70">
          <Info className="h-3.5 w-3.5 text-slate-400 shrink-0 mt-0.5" />
          <span>
            导航计数基于 SQLite 已登记原始归档统计（未经逐文件磁盘哈希扫描，多次采集可能含重复范围，不代表业务日期连续完整；打开右侧具体文件时将实时核验 SHA256，全程离线零网络请求）。
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          aria-expanded={catalogPaneOpen}
          aria-controls="raw-catalog-pane"
          onClick={() => setCatalogPaneOpen((open) => !open)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
        >
          {catalogPaneOpen ? "收起接口目录" : "展开接口目录"}
        </button>
        <button
          type="button"
          aria-expanded={filesPaneOpen}
          aria-controls="raw-files-pane"
          onClick={() => setFilesPaneOpen((open) => !open)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
        >
          {filesPaneOpen ? "收起文件列表" : "展开文件列表"}
        </button>
        <button
          type="button"
          onClick={() => { setCatalogPaneOpen(false); setFilesPaneOpen(false); }}
          className="rounded-lg border border-teal-200 bg-teal-50 px-3 py-1.5 font-medium text-teal-800 hover:bg-teal-100"
        >
          专注读表
        </button>
        <span className="text-[11px] text-slate-500">文件存在数不代表采集覆盖完整。</span>
      </div>

      {/* 3-Column Master-Detail-Reader Workspace: Domain/Interface Tree -> Raw Archive Cards -> Single-File Verified Table */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Column 1 (3 cols): Business Domain -> API Entry Tree */}
        <div id="raw-catalog-pane" className={clsx("xl:col-span-3 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden flex-col min-w-0", catalogPaneOpen ? "flex" : "hidden")}>
          <div className="border-b border-slate-100 bg-slate-50/70 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800">
                1. 业务域与数据接口
              </span>
              {appliedNavSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setNavSearchInput("");
                    setAppliedNavSearch("");
                    replaceLocalHash({ catalog_search: null });
                  }}
                  className="text-[11px] text-teal-700 hover:underline"
                >
                  清除搜索
                </button>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedNavSearch(navSearchInput.trim());
                replaceLocalHash({ catalog_search: navSearchInput.trim() });
              }}
              className="flex gap-1.5"
            >
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={navSearchInput}
                  onChange={(e) => setNavSearchInput(e.target.value)}
                  placeholder="搜接口名 / api_name / 分类…"
                  className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2 py-1.5 text-xs"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                找表
              </button>
            </form>
          </div>

          {navError && (
            <div className="p-3 text-xs text-rose-600 bg-rose-50">{navError}</div>
          )}

          <div className="max-h-[38rem] overflow-y-auto divide-y divide-slate-100">
            {navLoading && !navigation ? (
              <div className="py-12 text-center text-xs text-slate-400">
                正在加载业务目录…
              </div>
            ) : visibleDomainGroups.length === 0 ? (
              <div className="py-10 px-4 text-center space-y-2">
                <div className="text-xs font-medium text-slate-600">
                  {includeEmpty
                    ? "没有匹配的股票接口定义"
                    : "当前筛选条件下尚无已落盘接口"}
                </div>
                {!includeEmpty && (
                  <button
                    type="button"
                    onClick={() => setIncludeEmpty(true)}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-teal-700 hover:bg-slate-50"
                  >
                    切换查看全部 102 项接口定义
                  </button>
                )}
              </div>
            ) : (
              visibleDomainGroups.map((dom) => {
                const isCollapsed = collapsedDomains.has(dom.id);
                return (
                  <div key={dom.id} className="bg-white">
                    <button
                      type="button"
                      onClick={() => toggleDomainCollapse(dom.id)}
                      className="flex w-full items-center justify-between gap-2 bg-slate-50/90 px-3 py-2 text-left hover:bg-slate-100/80 transition-colors"
                    >
                      <div className="flex min-w-0 items-center gap-1.5">
                        {isCollapsed ? (
                          <ChevronRight className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                        )}
                        <span className="truncate text-xs font-semibold text-slate-800">
                          {dom.name}
                        </span>
                      </div>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500 tabular-nums">
                        {dom.local_entries} 接口有原始文件 · {formatNumber(dom.archives)} 档
                      </span>
                    </button>

                    {!isCollapsed && (
                      <div className="divide-y divide-slate-50">
                        {dom.entries.length === 0 ? (
                          <div className="px-6 py-2.5 text-[11px] text-slate-400">
                            该业务域下暂无匹配的接口
                          </div>
                        ) : (
                          dom.entries.map((entry) => {
                            const active = selectedEntryId === entry.entry_id;
                            return (
                              <button
                                key={entry.entry_id}
                                type="button"
                                onClick={() => handleSelectEntry(entry)}
                                className={clsx(
                                  "w-full px-3.5 py-2.5 text-left transition-colors space-y-1",
                                  active
                                    ? "bg-teal-50/80 border-l-4 border-l-teal-600"
                                    : entry.has_data
                                      ? "hover:bg-slate-50"
                                      : "opacity-65 hover:opacity-100 hover:bg-slate-50",
                                )}
                              >
                                <div className="flex items-center justify-between gap-1.5">
                                  <span className="truncate text-xs font-semibold text-slate-900">
                                    {entry.name}
                                  </span>
                                  {entry.has_data ? (
                                    <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.2 font-mono text-[10px] font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20 tabular-nums">
                                      {formatNumber(entry.successful_archives)} 份
                                    </span>
                                  ) : (
                                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.2 text-[10px] text-slate-400">
                                      无本地归档
                                    </span>
                                  )}
                                </div>

                                <div className="flex items-center justify-between gap-1.5 text-[10px] text-slate-500">
                                  <code className="font-mono text-slate-600 truncate">
                                    {entry.api_name} · #{entry.entry_id}
                                  </code>
                                  {entry.has_data && (
                                    <span className="font-mono tabular-nums text-slate-500 shrink-0">
                                      {formatNumber(entry.successful_rows)} 行
                                      {entry.failed_archives > 0
                                        ? ` · ${entry.failed_archives} 失败`
                                        : ""}
                                    </span>
                                  )}
                                </div>
                                {entry.has_data && entry.last_collected_at && (
                                  <div className="text-[10px] text-slate-400 truncate">
                                    最近文件登记：{formatDateTime(entry.last_collected_at)}
                                  </div>
                                )}
                              </button>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Column 2 (3 cols): Raw Archive Cards for Selected Interface */}
        <div id="raw-files-pane" className={clsx("xl:col-span-3 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden flex-col min-w-0", filesPaneOpen ? "flex" : "hidden")}>
          <div className="border-b border-slate-100 bg-slate-50/70 p-3 space-y-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-slate-900">
                    2. {selectedNavEntry ? selectedNavEntry.name : "原始归档文件"}
                  </span>
                  {selectedNavEntry?.doc_url && (
                    <a
                      href={selectedNavEntry.doc_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-teal-700 shrink-0"
                      title="打开 Tushare 官方接口文档"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {selectedNavEntry && (
                  <div className="mt-0.5 text-[10px] text-slate-500 truncate">
                    {selectedNavEntry.business_domain_name} · 官方分类：{selectedNavEntry.category_name} ·{" "}
                    <code className="font-mono">{selectedNavEntry.api_name}</code>
                  </div>
                )}
              </div>
            </div>

            {(!selectedNavEntry || selectedNavEntry.has_data) && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={sourceTypeFilter}
                    onChange={(e) => {
                      setSourceTypeFilter(e.target.value as ArchiveSourceType | "");
                      setListOffset(0);
                    }}
                    aria-label="按采集来源筛选归档"
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700"
                  >
                    <option value="">全部采集来源</option>
                    <option value="dataset">预置数据集</option>
                    <option value="task">自定义任务</option>
                    <option value="preview">即时预览</option>
                  </select>

                  <select
                    value={stateFilter}
                    onChange={(e) => {
                      setStateFilter(e.target.value);
                      setListOffset(0);
                    }}
                    aria-label="按归档状态筛选"
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-700"
                  >
                    <option value="">全部归档状态</option>
                    <option value="succeeded">归档成功</option>
                    <option value="failed">失败证据</option>
                  </select>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setListOffset(0);
                    setAppliedSliceSearch(sliceSearchInput.trim());
                    replaceLocalHash({ file_search: sliceSearchInput.trim() });
                  }}
                  className="flex gap-1.5"
                >
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="search"
                      value={sliceSearchInput}
                      onChange={(e) => setSliceSearchInput(e.target.value)}
                      placeholder="搜请求条件(日期/代码)或任务名…"
                      className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2 py-1.5 text-xs"
                    />
                  </div>
                  <button
                    type="submit"
                    className="rounded-lg bg-navy-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                  >
                    筛选
                  </button>
                </form>

                {page && (
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      匹配 <strong className="text-slate-800">{formatNumber(page.archives)}</strong> 份归档
                    </span>
                    <span className="font-mono tabular-nums">
                      登记 {formatNumber(page.successful_rows)} 行
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {listError && (
            <div className="p-3 text-xs text-rose-600 bg-rose-50">{listError}</div>
          )}

          {/* Raw Archive File Cards */}
          <div className="divide-y divide-slate-100 max-h-[34rem] overflow-y-auto">
            {selectedNavEntry && !selectedNavEntry.has_data ? (
              <div className="py-12 px-4 text-center space-y-2.5">
                <Database className="mx-auto h-7 w-7 text-slate-300" />
                <div className="text-xs font-semibold text-slate-700">
                  「{selectedNavEntry.name}」本地尚无已登记归档
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  本地阅读器仅离线展示已落盘的原始证据文件，不会自动向供应商发起网络采集。如需获取数据，请在「高级工具」中选择「预置采集」或「自定义 API」创建运行。
                </p>
              </div>
            ) : listLoading ? (
              <div className="py-12 text-center text-xs text-slate-400">
                正在读取接口归档文件列表…
              </div>
            ) : !page || page.items.length === 0 ? (
              <div className="py-12 px-4 text-center text-xs text-slate-400">
                当前筛选条件下尚无匹配的原始归档文件
              </div>
            ) : (
              page.items.map((item) => {
                const active =
                  selectedSlice?.runId === item.run_id &&
                  selectedSlice?.sliceId === item.slice_id;
                const srcType = resolveArchiveSourceType(item);
                const lineageOpen = expandedLineageIds.has(item.slice_id);
                const conditionSummary = formatRequestCondition(item.params);

                return (
                  <div
                    key={item.slice_id}
                    className={clsx(
                      "transition-colors",
                      active
                        ? "bg-teal-50/75 border-l-4 border-l-teal-600"
                        : "hover:bg-slate-50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectItem(item)}
                      className="w-full px-3.5 pt-3 pb-2 text-left space-y-1.5"
                    >
                      {/* Primary: Actual Request Condition */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 font-mono text-xs font-semibold text-slate-900 break-words leading-snug">
                          {conditionSummary}
                        </div>
                        <span
                          className={clsx(
                            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                            stateBadgeClass(item.state),
                          )}
                        >
                          {states[item.state] || item.state}
                        </span>
                      </div>

                      {/* Secondary: Source Type + Interface + Row Count */}
                      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={clsx(
                              "rounded px-1.5 py-0.2 text-[10px] font-medium shrink-0",
                              sourceBadgeClass(srcType),
                            )}
                          >
                            {archiveSourceLabel(srcType)}
                          </span>
                          <code className="text-[10px] font-mono text-slate-500 truncate">
                            {item.api_name}
                          </code>
                        </div>
                        <span className="font-mono text-slate-700 font-medium tabular-nums">
                          {item.rows !== null ? `${formatNumber(item.rows)} 行` : "—"}
                        </span>
                      </div>

                      {/* Tertiary: Collected Timestamp */}
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>
                          采集于 {formatDateTime(item.finished_at || item.created_at)}
                        </span>
                      </div>
                    </button>

                    {/* Collapsible Lineage Toggle (run_id / slice_id / ordinal / task_name) */}
                    <div className="px-3.5 pb-2.5">
                      <button
                        type="button"
                        onClick={() => toggleCardLineage(item.slice_id)}
                        className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-700"
                      >
                        <GitBranch className="h-3 w-3" />
                        <span>{lineageOpen ? "收起采集血缘" : "展开采集血缘"}</span>
                      </button>

                      {lineageOpen && (
                        <div className="mt-1.5 rounded-lg border border-slate-200/80 bg-white/90 p-2 text-[10px] text-slate-600 space-y-1 font-mono">
                          <div className="font-sans text-slate-700 truncate" title={item.task_name}>
                            任务：{item.task_name}
                          </div>
                          <div>
                            运行：{item.run_id.slice(0, 12)}… · 切片序号 #{item.ordinal + 1}
                          </div>
                          <div>切片 ID：{item.slice_id.slice(0, 16)}…</div>
                          <div className="truncate text-slate-400" title={item.raw_path}>
                            路径：{item.raw_path}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Paginated Archive List Footer */}
          {page && (listOffset > 0 || page.next_offset !== null) && (
            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs">
              <button
                type="button"
                disabled={listOffset === 0}
                onClick={() =>
                  setListOffset(Math.max(0, listOffset - SLICE_PAGE_LIMIT))
                }
                className="rounded border border-slate-200 bg-white px-2.5 py-1 disabled:opacity-40"
              >
                上一页
              </button>
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                {listOffset + 1}–
                {Math.min(listOffset + page.items.length, page.archives)} /{" "}
                {formatNumber(page.archives)}
              </span>
              <button
                type="button"
                disabled={page.next_offset === null}
                onClick={() => setListOffset(page.next_offset ?? listOffset)}
                className="rounded border border-slate-200 bg-white px-2.5 py-1 disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </div>

        {/* Column 3 (6 cols): Single-File SHA256-Verified Parquet/JSON Data Reader */}
        <div className={clsx("min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden",
          catalogPaneOpen && filesPaneOpen ? "xl:col-span-6" :
          catalogPaneOpen || filesPaneOpen ? "xl:col-span-9" : "xl:col-span-12")}>
          {!selectedSlice ? (
            <div className="flex h-96 flex-col items-center justify-center p-6 text-center text-slate-400 space-y-2">
              <FileSpreadsheet className="h-9 w-9 text-slate-300" />
              <div className="text-sm font-medium text-slate-600">
                3. 选择一份原始归档文件以离线核验阅读
              </div>
              <p className="max-w-md text-xs text-slate-400 leading-relaxed">
                先从左侧选择研究业务域与接口，再点选中间具体的请求条件归档卡片。每次打开单文件均实时核对元数据与数据文件 SHA256 一致性（不做跨文件去重或改写）。
              </p>
            </div>
          ) : previewLoading && !preview ? (
            <div className="flex h-96 items-center justify-center gap-2 text-xs text-slate-500">
              <RefreshCw className="h-4 w-4 animate-spin text-teal-600" />
              正在实时核对 SHA256 哈希并离线读取原始归档文件…
            </div>
          ) : previewError ? (
            <div className="p-6 space-y-3">
              <div className="rounded-lg bg-rose-50 p-4 text-xs text-rose-700 ring-1 ring-inset ring-rose-600/20">
                {previewError}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onOpenRunDetail(selectedSlice.runId)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  查看所属运行详情
                </button>
                <button
                  type="button"
                  disabled={deletionBusy}
                  onClick={handleOpenDeleteCheck}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  检查并删除此归档文件
                </button>
              </div>
            </div>
          ) : preview ? (
            <div className="flex flex-col">
              {/* Business-First Verified Header */}
              <div className="border-b border-slate-200 bg-slate-50/70 px-4 py-3.5 space-y-2.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">
                        {activeHeaderName}
                      </span>
                      {activeHeaderApi && (
                        <code className="rounded bg-white px-2 py-0.5 text-xs font-mono text-teal-800 ring-1 ring-slate-200">
                          {activeHeaderApi}
                        </code>
                      )}
                      {activeHeaderDomain && (
                        <span className="rounded bg-slate-200/70 px-2 py-0.5 text-[10px] font-medium text-slate-700">
                          {activeHeaderDomain}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        单文件 SHA256 已核验
                      </span>
                      {activeHeaderDocUrl && (
                        <a
                          href={activeHeaderDocUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-0.5 text-[11px] text-teal-700 hover:underline"
                        >
                          官方文档 <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span className="font-mono font-medium text-slate-800">
                        实际请求条件：{formatRequestCondition(preview.params)}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="font-mono tabular-nums">
                        {formatNumber(preview.total_rows)} 行 × {preview.columns.length} 列
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-[11px] text-slate-500">
                        采集于 {formatDateTime(preview.ingested_at || preview.requested_at)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowPreviewLineage((v) => !v)}
                      className={clsx(
                        "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                        showPreviewLineage
                          ? "border-teal-600/30 bg-teal-50 text-teal-800"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      血缘与运维
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onRequestExport({
                          runId: preview.run_id,
                          sliceId: preview.slice_id,
                          title: `导出单文件 (${activeHeaderApi || preview.filename} · 切片 #${preview.slice_number})`,
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      导出此文件
                    </button>
                    <button
                      type="button"
                      disabled={deletionBusy}
                      onClick={handleOpenDeleteCheck}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </button>
                  </div>
                </div>

                {/* Collapsible Underlying Run / Slice Lineage & Whole-Run Export */}
                {showPreviewLineage && (
                  <div className="rounded-lg border border-slate-200 bg-white p-3 text-[11px] text-slate-600 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-mono space-x-2">
                        <span>文件：{preview.filename}</span>
                        <span>·</span>
                        <span>格式：{preview.capture_format || "parquet"}</span>
                        {preview.is_derived && (
                          <>
                            <span>·</span>
                            <span className="text-amber-700">SDK 派生计算结果</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenRunDetail(preview.run_id)}
                          className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          查看所属运行详情
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onRequestExport({
                              runId: preview.run_id,
                              sliceId: null,
                              title: `导出整次运行全部成功归档 (${preview.run_id.slice(0, 8)})`,
                            })
                          }
                          className="inline-flex items-center gap-1 rounded bg-teal-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-teal-700"
                        >
                          <Download className="h-3 w-3" />
                          导出所属运行全部归档
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 font-mono text-[10px] text-slate-500">
                      <div>运行 ID (run_id): {preview.run_id}</div>
                      <div>
                        切片 ID (slice_id): {preview.slice_id} (序号 #{preview.slice_number})
                      </div>
                      {selectedSlice.item?.task_name && (
                        <div className="sm:col-span-2 font-sans text-slate-600">
                          采集任务名称：{selectedSlice.item.task_name}（来源：
                          {archiveSourceLabel(selectedSlice.item)}）
                        </div>
                      )}
                      <div className="sm:col-span-2 text-slate-400">
                        原始参数 JSON：{formatParamsCompact(preview.params)}
                      </div>
                    </div>
                  </div>
                )}

                {/* Single-File Row Search & Column Filter Bar */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setRowOffset(0);
                    setAppliedRowQuery(rowQuery.trim());
                    replaceLocalHash({
                      run: selectedSlice.runId,
                      slice: selectedSlice.sliceId,
                      search: rowQuery.trim(),
                      column: columnFilter,
                    });
                  }}
                  className="flex flex-wrap items-center gap-2 pt-0.5"
                >
                  <select
                    value={columnFilter}
                    onChange={(e) => {
                      setColumnFilter(e.target.value);
                      setRowOffset(0);
                      replaceLocalHash({ column: e.target.value });
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 max-w-44"
                  >
                    <option value="">当前文件全部列</option>
                    {preview.columns.map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name} ({col.type})
                      </option>
                    ))}
                  </select>

                  <div className="relative flex-1 min-w-40">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      type="search"
                      value={rowQuery}
                      onChange={(e) => setRowQuery(e.target.value)}
                      placeholder="在当前原始归档文件内搜索代码、日期或数值…"
                      className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-3 py-1.5 text-xs"
                    />
                  </div>

                  <button
                    type="submit"
                    className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-navy-800"
                  >
                    单文件筛选
                  </button>

                  {appliedRowQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setRowQuery("");
                        setAppliedRowQuery("");
                        setColumnFilter("");
                        setRowOffset(0);
                        replaceLocalHash({ search: null, column: null });
                      }}
                      className="text-xs text-slate-500 hover:text-slate-800"
                    >
                      重置
                    </button>
                  )}

                  <select
                    value={rowLimit}
                    onChange={(e) => {
                      setRowLimit(Number(e.target.value));
                      setRowOffset(0);
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
                  >
                    <option value={50}>50 行/页</option>
                    <option value={100}>100 行/页</option>
                    <option value={200}>200 行/页</option>
                  </select>

                  <div className="ml-auto flex items-center gap-1.5">
                    <div className="relative w-44">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                      <input
                        type="search"
                        value={displayColumnQuery}
                        onChange={(e) => setDisplayColumnQuery(e.target.value)}
                        placeholder={`过滤显示列 (${preview.columns.length})…`}
                        aria-label="过滤原始归档显示列"
                        className="w-full rounded-lg border border-slate-200 bg-white pl-8 pr-2 py-1.5 text-xs"
                      />
                    </div>
                    {visiblePreviewColumns.isFiltered && (
                      <>
                        <span className="rounded bg-teal-50 px-1.5 py-1 font-mono text-[10px] font-medium text-teal-800 ring-1 ring-inset ring-teal-600/20 tabular-nums">
                          {visiblePreviewColumns.visibleCount}/
                          {visiblePreviewColumns.total} 列
                        </span>
                        <button
                          type="button"
                          onClick={() => setDisplayColumnQuery("")}
                          className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100"
                        >
                          全部列
                        </button>
                      </>
                    )}
                  </div>
                </form>
              </div>

              {/* Sticky Header & Sticky Index + First Data Column Table */}
              <div className="overflow-auto max-h-[34rem]">
                <table className="min-w-full border-collapse text-xs">
                  <thead className="sticky top-0 z-20 bg-slate-100 text-slate-700 shadow-sm">
                    <tr>
                      <th className="sticky-col-idx-head bg-slate-100 border-b border-r border-slate-200 px-3 py-2 text-right font-mono text-[11px] text-slate-500">
                        #
                      </th>
                      {visiblePreviewColumns.indices.map((colIdx, visIdx) => {
                        const col = preview.columns[colIdx]!;
                        return (
                          <th
                            key={col.name}
                            className={clsx(
                              "border-b border-slate-200 px-3 py-2 text-left font-mono whitespace-nowrap",
                              visIdx === 0 &&
                                "sticky-col-first-head bg-slate-100 border-r font-semibold text-slate-900",
                            )}
                          >
                            <div>{col.name}</div>
                            <div className="text-[10px] font-normal text-slate-400">
                              {col.type}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono">
                    {preview.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={visiblePreviewColumns.indices.length + 1}
                          className="py-12 text-center font-sans text-slate-400"
                        >
                          此切片包含 0 行数据或无匹配筛选的行
                        </td>
                      </tr>
                    ) : (
                      preview.rows.map((row, rIdx) => (
                        <tr
                          key={rIdx}
                          onClick={() => setInspectedPreviewRowIndex(rIdx)}
                          title="点击查看此行全部字段纵向详情与复制"
                          className="group cursor-pointer hover:bg-teal-50/30"
                        >
                          <td className="sticky-col-idx-cell bg-slate-50 group-hover:bg-teal-50 border-r border-slate-200 px-3 py-1.5 text-right text-[11px] text-slate-400 group-hover:text-teal-700 tabular-nums underline-offset-2 group-hover:underline">
                            {preview.offset + rIdx + 1}
                          </td>
                          {visiblePreviewColumns.indices.map(
                            (colIdx, visIdx) => {
                              const val = row[colIdx];
                              return (
                                <td
                                  key={colIdx}
                                  className={clsx(
                                    "px-3 py-1.5 whitespace-nowrap tabular-nums",
                                    visIdx === 0 &&
                                      "sticky-col-first-cell bg-white group-hover:bg-teal-50 border-r border-slate-200 font-semibold text-slate-900",
                                    val === null
                                      ? "text-slate-300 italic"
                                      : visIdx === 0
                                        ? "font-semibold text-slate-900"
                                        : "text-slate-700",
                                  )}
                                >
                                  {cellText(val)}
                                </td>
                              );
                            },
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination Footer */}
              <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-xs">
                <span className="text-slate-500 font-mono tabular-nums">
                  显示{" "}
                  {preview.matching_rows === 0
                    ? 0
                    : `${preview.offset + 1}–${preview.offset + preview.rows.length}`}{" "}
                  / 匹配 {formatNumber(preview.matching_rows)} 行（总计{" "}
                  {formatNumber(preview.total_rows)} 行）
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={rowOffset === 0 || previewLoading}
                    onClick={() => setRowOffset(Math.max(0, rowOffset - rowLimit))}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1 font-medium disabled:opacity-40"
                  >
                    上一页
                  </button>
                  <button
                    type="button"
                    disabled={preview.next_offset === null || previewLoading}
                    onClick={() => setRowOffset(preview.next_offset ?? rowOffset)}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1 font-medium disabled:opacity-40"
                  >
                    下一页
                  </button>
                </div>
              </div>

              {inspectedPreviewRowIndex !== null &&
                preview.rows[inspectedPreviewRowIndex] && (
                  <RowDetailDrawer
                    open={true}
                    title={`${activeHeaderName}${activeHeaderApi ? ` (${activeHeaderApi})` : ""}`}
                    subtitle={`文件 ${preview.filename} · 切片 #${preview.slice_number}`}
                    rowNumber={preview.offset + inspectedPreviewRowIndex + 1}
                    canPrev={inspectedPreviewRowIndex > 0}
                    canNext={
                      inspectedPreviewRowIndex < preview.rows.length - 1
                    }
                    onPrev={() =>
                      setInspectedPreviewRowIndex((prev) =>
                        prev !== null && prev > 0 ? prev - 1 : prev,
                      )
                    }
                    onNext={() =>
                      setInspectedPreviewRowIndex((prev) =>
                        prev !== null && prev < preview.rows.length - 1
                          ? prev + 1
                          : prev,
                      )
                    }
                    onClose={() => setInspectedPreviewRowIndex(null)}
                    columns={previewColumnsMeta}
                    values={preview.rows[inspectedPreviewRowIndex]!}
                  />
                )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Safe Archive Deletion Verification Modal */}
      {deletionCheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[1px] p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-xl ring-1 ring-slate-200 overflow-hidden">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div className="flex items-center gap-2 text-rose-700">
                <Trash2 className="h-4 w-4" />
                <h3 className="text-sm font-semibold">确认永久删除本地归档切片</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeletionCheck(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-3.5 text-xs">
              <div className="rounded-lg bg-rose-50 p-3 text-rose-800 leading-relaxed ring-1 ring-inset ring-rose-600/20">
                {deletionCheck.note}
              </div>

              <div className="space-y-1.5">
                <div className="font-semibold text-slate-800">
                  目标：{deletionCheck.name} · 切片 #{deletionCheck.slice_number}（共{" "}
                  {formatBytes(deletionCheck.bytes)}）
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 space-y-1.5 font-mono text-[11px]">
                  {deletionCheck.files.map((f) => (
                    <div key={f.path} className="break-all text-slate-700">
                      <div>{f.path}</div>
                      <div className="text-[10px] text-slate-400">
                        SHA256: {f.sha256.slice(0, 16)}… · {formatBytes(f.bytes)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {deletionError && (
                <div className="rounded-lg bg-rose-50 p-2.5 text-rose-700">
                  {deletionError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setDeletionCheck(null)}
                  className="rounded-lg border border-slate-200 px-3.5 py-2 font-medium text-slate-700 hover:bg-slate-50"
                >
                  取消保留
                </button>
                <button
                  type="button"
                  disabled={deletionBusy}
                  onClick={handleConfirmDelete}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {deletionBusy ? "正在核对指纹并删除…" : "确认永久删除归档"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
