export type NavTab =
  | "needs"
  | "datasets"
  | "warehouse"
  | "local-data"
  | "runs"
  | "custom"
  | "permissions";

export interface DataNeedSpec {
  name: string;
  dataset_ids: string[];
  dataset_options?: Record<string, Record<string, string[]>>;
  start_date: string;
  end_date: string | null;
  update_hour: number;
  lookback_days: number;
  requests_per_minute: number;
  max_requests: number;
}

export interface DataNeedCapability {
  dataset_id: string;
  entry_id: string;
  api_name: string;
  name: string;
  category: string;
  category_name: string;
  doc_url: string;
  date_mode: "snapshot" | "range";
  date_label: string;
  start_date: string;
  available_until: string | null;
  archive_only: boolean;
  options: Record<string, DatasetRuleOptionDef>;
  dependencies: string[];
  scope_note: string;
  update_note: string;
  field_count: number;
  permission: string;
  semantic_note?: string;
  atomic_full_run?: boolean;
}

export interface DataNeedCatalog {
  version: number;
  entries: DataNeedCapability[];
}

export interface DataNeedStep {
  dataset_id: string;
  state: "pending" | "collecting" | "publishing" | "succeeded";
  run_id: string | null;
  target: string;
  fields: string[];
  publish?: boolean;
  result: { snapshot_id?: string; rows?: number; days?: number; last_date?: string | null; changed?: boolean; role?: "planning_dependency" } | null;
}

export interface DataNeedJob {
  id: string;
  need_id: string;
  need_revision: number;
  state: "planning" | "collecting" | "publishing" | "succeeded" | "blocked" | "paused";
  requests_sent: number;
  request_limit: number;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  steps: DataNeedStep[];
}

export interface DataNeed {
  id: string;
  revision: number;
  enabled: boolean;
  spec: DataNeedSpec;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  jobs: DataNeedJob[];
  bindings: Record<string, {
    raw_root: string; schema: Array<{name: string; type: string}>;
    settings_options?: Record<string, string[]>;
  }>;
}

export interface DataNeedSave {
  spec: DataNeedSpec;
  enabled: boolean;
  authorize_network: boolean;
  expected_revision: number;
}

export interface ServerStatus {
  service?: string;
  scope?: string;
  token_configured: boolean;
  token_persisted?: boolean;
  credential_file?: string;
  worker_running: boolean;
  global_requests_per_minute: number;
  collection_threads?: number;
  effective_collection_threads?: number;
  max_collection_threads?: number;
  applies_to?: "next_run" | string;
  default_raw_root: string;
  default_export_root: string;
  database: string;
  catalog_version?: string;
  catalog_verified_at: string;
}

export interface CredentialResult {
  token_configured: boolean;
  token_persisted: boolean;
  persistence: "local_file" | "process_memory_only" | "cleared";
}

export interface WorkerSettings {
  collection_threads: number;
  effective_collection_threads: number;
  max_collection_threads: number;
  applies_to: "next_run" | string;
}

export interface CatalogCategory {
  id: string;
  name: string;
}

export interface CatalogParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface CatalogField {
  name: string;
  type: string;
  default?: boolean;
  description: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  api_name: string;
  category: string;
  category_name: string;
  description?: string;
  permission?: string;
  access?: ApiAccess;
  row_limit: number | null;
  status?: string;
  doc_url?: string;
  params: CatalogParam[];
  fields: CatalogField[];
}

export type PermissionKind = "points" | "independent" | "derived" | "undocumented" | string;
export type AccountAccessState =
  | "points_satisfied"
  | "requires_independent_permission"
  | "undocumented"
  | "insufficient_points"
  | string;

export interface ApiAccess {
  id?: string;
  api_name?: string;
  name?: string;
  doc_url?: string;
  document_sha256?: string;
  account_points: number;
  minimum_points: number | null;
  permission_kind: PermissionKind;
  independent_permission: string | null;
  account_access: AccountAccessState;
  documented_rpm: number | null;
  configured_rpm: number;
  daily_limit: number | null;
  quota_window?: "rolling_24h" | "calendar_day" | string | null;
  quota_scope?: string;
  permission_verified?: boolean;
  rate_source: string;
  sources?: string[];
  evidence?: string[];
  note: string;
}

export interface PermissionEntry extends ApiAccess {
  id: string;
  api_name: string;
  name: string;
  doc_url: string;
  document_sha256: string;
  quota_window: "rolling_24h" | "calendar_day" | string | null;
  quota_scope: string;
  permission_verified: boolean;
  sources: string[];
  evidence: string[];
}

export interface PermissionsCatalog {
  version: string;
  verified_at: string;
  account_points: number;
  account_points_source: "user_declared" | string;
  general_doc_url: string;
  overview_doc_url: string;
  sources: Array<{ url: string; sha256: string }>;
  precedence: string;
  entries: PermissionEntry[];
}

export interface Catalog {
  version: string;
  verified_at: string;
  categories: CatalogCategory[];
  entries: CatalogEntry[];
}

export interface DatasetRuleOptionDef {
  values: string[];
  default: string[];
}

export interface DatasetRule {
  domain?: string;
  strategy: string;
  date_param?: string;
  code_param?: string;
  archive_only?: boolean;
  available_until?: string;
  allow_empty?: boolean;
  options?: Record<string, DatasetRuleOptionDef>;
}

export interface DatasetSettings {
  raw_root: string;
  start_date: string;
  lookback_days: number;
  requests_per_minute: number;
  options?: Record<string, string[]>;
}

export interface DatasetLastRun {
  id: string;
  state: string;
  created_at: string;
  error: string | null;
  mode: DatasetMode;
  scope: string;
}

export type DatasetMode = "full" | "incremental" | "retry" | "split";

export interface DatasetItem {
  id: string;
  name: string;
  entry_id: string;
  access?: ApiAccess;
  doc_url?: string;
  permission?: string;
  kind: string;
  start: string;
  scope_note: string;
  incremental_note: string;
  date_field?: string;
  window_years?: number;
  local_limit?: number;
  version: number;
  rule?: DatasetRule;
  settings: DatasetSettings;
  revision: number;
  settings_error?: string;
  scope?: string;
  covered_partitions: number | null;
  unfinished_partitions: number | null;
  row_limit_partitions: number | null;
  first_partition: string | null;
  last_partition: string | null;
  last_run: DatasetLastRun | null;
  active_run: string | null;
  available_through: string;
  coverage: string;
}

export interface DatasetPartition {
  key: string;
  params: Record<string, unknown>;
  reason: "full" | "missing" | "retry" | "refresh" | "split";
}

export interface DatasetPlan {
  id: string;
  dataset_id: string;
  recipe: DatasetItem;
  entry: CatalogEntry;
  mode: DatasetMode;
  settings: DatasetSettings;
  settings_revision: number;
  start_date: string;
  end_date: string;
  scope: string;
  partitions: DatasetPartition[];
  proposed_splits: Record<string, unknown>;
  total_slices: number;
  supplier_requests?: number;
  candidate_partitions: number;
  covered_partitions: number;
  counts: {
    full: number;
    missing: number;
    retry: number;
    refresh: number;
    split: number;
  };
  options?: Record<string, string[]>;
  warnings: string[];
  config: TaskConfigPayload;
  effective_rpm: number;
  estimated_seconds: number;
  fingerprint: string;
  created_at: string;
  expires_at: string;
}

export interface DatasetReview {
  stage: "data" | "dependencies";
  plan: DatasetPlan;
  reason?: string;
  source_dataset_id?: string;
  note?: string;
}

export interface DatasetCoverageItem {
  key: string;
  state: "pending" | "running" | "succeeded" | "failed";
  error_kind: string | null;
  rows: number | null;
  error: string | null;
  run_id: string;
  slice_id: string;
  has_data: boolean;
  last_updated: string;
  successful_run_id: string | null;
  successful_slice_id: string | null;
  successful_rows: number | null;
}

export interface DatasetCoveragePage {
  dataset_id: string;
  raw_root: string;
  settings_revision: number;
  total: number;
  registered_partitions: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  items: DatasetCoverageItem[];
}

export interface DatasetGroup {
  id: string;
  name: string;
  dataset_ids: string[];
  created_at?: string;
}

export interface DatasetBundlePlan {
  id: string;
  dataset_ids: string[];
  mode: "full" | "incremental" | "retry";
  stage: "dependencies" | "data";
  stage_ids: string[];
  end_date: string;
  plans: DatasetPlan[];
  total_slices: number;
  supplier_requests: number;
  estimated_seconds: number;
  warnings: string[];
  expires_at: string;
  completed_dependencies: string[];
  continuation_id: string | null;
}

export interface DatasetBundleRecord {
  id: string;
  dataset_ids: string[];
  mode: "full" | "incremental" | "retry";
  stage: "dependencies" | "data";
  stage_ids: string[];
  end_date: string;
  total_slices: number;
  supplier_requests: number;
  batch: BatchItem | null;
  progress: {
    batch_id: string;
    total: number;
    completed: number;
    failed: number;
    pending: number;
    running: number;
  } | null;
  created_at: string;
  next_stage_created: boolean;
}

export interface DatasetReturnDraft {
  id: string;
  mode: DatasetMode;
  settings: DatasetSettings;
  endDate: string;
  dependencyId: string;
  runId?: string;
}

export interface TaskConfigPayload {
  name: string;
  entry_id: string;
  params: Record<string, unknown>;
  fields: string;
  transport: "sdk" | "http";
  raw_root: string;
  requests_per_minute: number;
  max_attempts: number;
  timeout_seconds: number;
  row_limit: number | null;
  allow_empty: boolean;
  mode: "single" | "date_range";
  date_param: string;
  start_date: string | null;
  end_date: string | null;
  split_param: string | null;
  split_values: Array<string | number | boolean>;
}

export interface SavedConfig {
  id: string;
  name: string;
  revision: number;
  config: TaskConfigPayload;
  created_at: string;
  updated_at: string;
}

export interface SavedGroup {
  id: string;
  name: string;
  config_ids: string[];
  created_at?: string;
}

export interface PlanPreview {
  total: number;
  samples: Array<Record<string, unknown>>;
  date_semantics: string;
  coverage: string;
}

export interface RunSummary {
  id: string;
  config_id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  total: number;
  completed: number;
  failed: number;
  pending?: number;
  running?: number;
  rows: number;
  successful_rows?: number;
  row_limit_failures: number;
  deleted_archives: number;
  is_preview: number | boolean;
  dataset_id: string | null;
  dataset_mode: DatasetMode | null;
  batch_id: string | null;
  cancel_requested: number | boolean;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  config: TaskConfigPayload;
  entry?: CatalogEntry;
}

export interface SliceItem {
  id: string;
  run_id: string;
  ordinal: number;
  state: "pending" | "running" | "succeeded" | "failed";
  rows: number | null;
  error: string | null;
  error_kind: string | null;
  raw_path: string | null;
  raw_sha256: string | null;
  meta_path: string | null;
  meta_sha256: string | null;
  archive_deleted?: number | boolean;
  params: Record<string, unknown>;
}

export interface AttemptItem {
  id: string;
  slice_id: string;
  state: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  raw_dir: string | null;
  response_sha256: string | null;
}

export interface RunDetail extends RunSummary {
  entry: CatalogEntry;
  slices?: SliceItem[];
  slices_truncated?: boolean;
  attempts?: AttemptItem[];
  dataset_plan?: {
    recipe: DatasetItem;
    mode: DatasetMode;
    settings: DatasetSettings;
    start_date: string;
    end_date: string;
    counts: Record<string, number>;
    total_slices: number;
    warnings: string[];
  };
}

export interface SlicePage {
  run_id: string;
  total: number;
  run_total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  items: SliceItem[];
}

export interface BatchPlanTask {
  id: string;
  revision: number;
  config: TaskConfigPayload;
  api_name: string;
  total_slices: number;
  samples: Array<Record<string, unknown>>;
  effective_rpm: number;
}

export interface BatchPlan {
  tasks: BatchPlanTask[];
  total_runs: number;
  total_slices: number;
  expected_revisions: Record<string, number>;
  estimated_seconds: number | null;
  estimate_note: string;
}

export interface BatchItem {
  id: string;
  config_ids: string[];
  total_tasks: number;
  total_slices: number;
  created_at: string;
  runs: Array<{
    id: string;
    config_id: string;
    name: string;
    state: string;
    total: number;
    completed: number;
    failed: number;
    rows: number;
    error: string | null;
  }>;
}

export interface PendingDeletion {
  id: string;
  run_id: string;
  slice_id: string;
  state: string;
  created_at: string;
  error: string | null;
}

export type BusinessDomainId =
  | "reference"
  | "prices"
  | "financial"
  | "ownership"
  | "flows"
  | "leverage"
  | "boards"
  | "events"
  | "research"
  | string;

export type ArchiveSourceType = "dataset" | "preview" | "task";

export interface LocalDataDomainSummary {
  id: BusinessDomainId;
  name: string;
  description: string;
  defined_entries: number;
  local_entries: number;
  archives: number;
  successful_archives: number;
  failed_archives: number;
  other_archives: number;
  successful_rows: number;
}

export interface LocalDataNavigationEntry {
  entry_id: string;
  api_name: string;
  name: string;
  category: string;
  category_name: string;
  doc_url?: string;
  business_domain: BusinessDomainId;
  business_domain_name: string;
  archives: number;
  successful_archives: number;
  failed_archives: number;
  other_archives: number;
  successful_rows: number;
  last_collected_at: string | null;
  has_data: boolean;
}

export interface LocalDataNavigation {
  classification_version: number;
  summary_basis: "registered_archives" | string;
  hash_verified: boolean;
  coverage_verified: boolean;
  domains: LocalDataDomainSummary[];
  entries: LocalDataNavigationEntry[];
  raw_roots: string[];
  archives: number;
  successful_archives: number;
  failed_archives: number;
  other_archives: number;
  successful_rows: number;
  local_entries: number;
  defined_entries: number;
}

export interface LocalDataCatalogItem {
  entry_id: string;
  name: string;
  api_name: string;
  category: string;
  category_name: string;
  archives: number;
}

export interface LocalDataItem {
  slice_id: string;
  run_id: string;
  ordinal: number;
  state: "succeeded" | "failed" | "pending" | "running";
  rows: number | null;
  error: string | null;
  raw_path: string;
  created_at: string;
  finished_at: string | null;
  task_name: string;
  raw_root: string;
  dataset_id: string | null;
  is_preview: boolean;
  source_type?: ArchiveSourceType;
  business_domain?: BusinessDomainId;
  business_domain_name?: string;
  entry_id: string;
  name: string;
  api_name: string;
  category: string;
  category_name: string;
  params: Record<string, unknown>;
}

export interface LocalDataPage {
  items: LocalDataItem[];
  pending_deletions: PendingDeletion[];
  pending_deletion_count: number;
  catalog: LocalDataCatalogItem[];
  raw_roots: string[];
  archives: number;
  runs: number;
  successful_rows: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

export interface SlicePreview {
  run_id: string;
  slice_id: string;
  source_state: string;
  source_error: string | null;
  is_preview: boolean;
  filename: string;
  columns: Array<{ name: string; type: string }>;
  total_rows: number;
  matching_rows: number;
  query: string;
  column: string;
  offset: number;
  limit: number;
  rows: unknown[][];
  next_offset: number | null;
  capture_format: string | null;
  is_derived: boolean | null;
  hash_verified: boolean;
  slice_number: number;
  params: Record<string, unknown>;
  requested_at: string | null;
  ingested_at: string | null;
}

export interface ArchiveDeletionCheck {
  run_id: string;
  slice_id: string;
  slice_number: number;
  name: string;
  dataset_id: string | null;
  raw_root: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  bytes: number;
  note: string;
  fingerprint: string;
}

export type ExportLayout = "raw" | "organized";

export interface WarehouseCatalogField {
  name: string;
  type: string;
  arrow_type?: string | null;
  description?: string | null;
}

export type WarehouseCodeFilter =
  | "stock"
  | "board"
  | "identifier"
  | "none"
  | string;
export type WarehouseCalendarBasis = "trading_day" | "calendar_day" | null | string;
export type WarehouseStorageLayout =
  | "monthly"
  | "current_snapshot"
  | "request_partitions"
  | string;

export type WarehouseGrain =
  | "date_cross_section"
  | "period_bar"
  | "current_snapshot"
  | "announcement_event"
  | "date_records"
  | "board_records"
  | "aggregate_series"
  | "financial_records"
  | "calendar_records"
  | "partition_records"
  | string;

export interface WarehouseVariant {
  id: string;
  params: Record<string, unknown>;
  partitions: number;
  rows: number;
}

export interface WarehouseCatalogEntry {
  dataset_id: string | null;
  entry_id: string;
  api_name: string;
  name: string;
  category: string;
  category_name: string;
  business_domain: string;
  business_domain_name: string;
  doc_url?: string | null;
  warehouse_supported: boolean;
  warehouse_status: "supported" | "raw_only";
  warehouse_unavailable_reason?: string | null;
  storage_layout?: WarehouseStorageLayout | null;
  supports_variants?: boolean;
  grain: WarehouseGrain | null;
  code_filter?: WarehouseCodeFilter;
  code_column?: string | null;
  calendar_basis?: WarehouseCalendarBasis;
  date_column?: string | null;
  preserves_duplicate_rows?: boolean;
  fields: WarehouseCatalogField[];
  key_columns: string[];
  version_rule: string | null;
  date_semantics?: string;
  atomic_full_run?: boolean;
  semantic_note?: string;
  field_encodings?: Record<string, string>;
}

export interface WarehouseCatalog {
  version: number;
  supported_datasets: string[];
  entries: WarehouseCatalogEntry[];
}

export interface DailyWarehouseMonth {
  month: string;
  label?: string;
  kind?: "request_partition" | string;
  rows: number;
  days: number;
  file: string;
  sha256?: string;
}

export interface DailyWarehouseStatus {
  dataset_id?: string;
  entry_id?: string;
  name?: string;
  storage_layout?: WarehouseStorageLayout | null;
  supports_variants?: boolean;
  date_semantics?: string;
  atomic_full_run?: boolean;
  semantic_note?: string;
  field_encodings?: Record<string, string>;
  capture_window?: {start: string; end: string};
  source_error?: string | null;
  grain?: WarehouseGrain | null;
  code_filter?: WarehouseCodeFilter;
  code_column?: string | null;
  calendar_basis?: WarehouseCalendarBasis;
  date_column?: string | null;
  date_count_kind?: "record_dates_not_coverage" | string | null;
  key_columns?: string[];
  preserves_duplicate_rows?: boolean;
  state: "empty" | "ready";
  repository_root: string;
  source_raw_root: string;
  busy: boolean;
  collection_active: boolean;
  snapshot_id: string | null;
  source_run_id?: string | null;
  created_at: string | null;
  current_manifest_path: string;
  snapshot_manifest_path: string | null;
  columns: string[];
  rows: number;
  days: number;
  days_with_rows?: number;
  partitions?: number;
  first_date: string | null;
  last_date: string | null;
  months: DailyWarehouseMonth[];
  dates: string[];
  variants?: WarehouseVariant[];
  available_source_days: number;
  new_days: number;
  changed_days: number;
  reused_days: number;
  available_source_partitions?: number;
  new_partitions?: number;
  changed_partitions?: number;
  reused_partitions?: number;
  refresh_needed: boolean;
  coverage: "not_proven" | string;
}

export interface DailyWarehouseRefreshResult extends DailyWarehouseStatus {
  changed: boolean;
}

export interface DailyWarehouseRowsPage {
  dataset_id?: string;
  entry_id?: string;
  name?: string;
  snapshot_id: string;
  variant_id?: string | null;
  columns: string[];
  rows: unknown[][];
  total_rows: number;
  matching_rows: number;
  offset: number;
  limit: number;
  next_offset: number | null;
  hash_verified: boolean;
  coverage: "not_proven" | string;
}

export interface DailyWarehouseExportRequest {
  destination: string;
  start_date?: string | null;
  end_date?: string | null;
  columns?: string[];
  ts_codes?: string[];
  snapshot_id?: string | null;
  variant_id?: string | null;
  file_layout?: "partitioned" | "single" | "grouped";
  sort_by?: WarehouseSortKey[];
  split_by?: string | null;
}

export interface WarehouseSortKey {
  column: string;
  direction: "asc" | "desc";
}

export type WarehouseCleanupCheckMode = "fast" | "deep";

export interface StoragePolicySpec {
  retention_days: number;
  update_hour: number;
  check_mode: WarehouseCleanupCheckMode;
}

export interface StoragePolicySave extends StoragePolicySpec {
  enabled: boolean;
  authorize_delete: boolean;
  expected_revision: number;
}

export interface StoragePolicyStatus {
  revision: number;
  enabled: boolean;
  spec: StoragePolicySpec;
  next_attempt_at: string | null;
  last_error: string | null;
  dataset_ids: string[];
  batch_size: number;
  bindings: Record<string, {raw_root: string; warehouse_root: string; schema: Array<{name: string; type: string}>}>;
  jobs: Array<{
    id: string;
    policy_revision: number;
    state: "running" | "succeeded" | "blocked" | "paused";
    created_at: string;
    finished_at: string | null;
    error: string | null;
    steps: Array<{
      dataset_id: string;
      state: "pending" | "prepared" | "succeeded" | "skipped";
      deleted: number;
      files: number;
      bytes: number;
      skipped: number;
      reason: string | null;
      batch: {fingerprint: string; partial_deleted?: number} | null;
    }>;
  }>;
}

export interface WarehouseCleanupPreview {
  check_mode: WarehouseCleanupCheckMode;
  dataset_id: string;
  snapshot_id: string;
  retention_days: number;
  fingerprint: string;
  count: number;
  files: number;
  bytes: number;
  note: string;
  candidates: Array<{run_id: string; slice_id: string; files: Array<{path: string}>}>;
  pending_cleanups?: Array<{fingerprint: string; snapshot_id: string; retention_days: number; check_mode: WarehouseCleanupCheckMode; count: number; remaining: number}>;
  excluded_count?: number;
  excluded?: Array<{reason: string}>;
}

export interface WarehouseCleanupResult {
  state: "deleted" | "cleanup_failed";
  count: number;
  files: number;
  deleted: number;
  failed: number;
  failures: Array<{slice_id: string; error: string}>;
}

export interface GlobalWarehouseCleanupPreview {
  check_mode: WarehouseCleanupCheckMode;
  retention_days: number;
  fingerprint: string;
  count: number;
  files: number;
  bytes: number;
  pending: number;
  datasets: Array<WarehouseCleanupPreview & {name: string}>;
  skipped: Array<{dataset_id: string; name: string; reason: string}>;
}

export interface GlobalWarehouseCleanupResult {
  state: "deleted" | "cleanup_failed";
  deleted: number;
  results: Array<{
    dataset_id: string; name: string; state: "deleted" | "cleanup_failed"; deleted: number;
    error?: string; failures?: Array<{error: string}>;
  }>;
}

export interface DailyWarehouseExportResult {
  file_layout?: "partitioned" | "single" | "grouped";
  sort_by?: WarehouseSortKey[];
  split_by?: string | null;
  dataset_id?: string;
  entry_id?: string;
  name?: string;
  bundle_id: string;
  directory: string;
  manifest_path: string;
  manifest_sha256: string;
  snapshot_id: string;
  variant_id?: string | null;
  columns: string[];
  rows: number;
  days: number;
  files: number;
  start_date: string | null;
  end_date: string | null;
}

export type WarehouseStatus = DailyWarehouseStatus;
export type WarehouseRefreshResult = DailyWarehouseRefreshResult;
export type WarehouseRowsPage = DailyWarehouseRowsPage;
export type WarehouseExportRequest = DailyWarehouseExportRequest;
export type WarehouseExportResult = DailyWarehouseExportResult;

export interface ExportResult {
  export_id: string;
  layout?: ExportLayout;
  directory: string;
  manifest_path: string;
  manifest_sha256?: string;
  exported_slices: number;
  skipped_slices: number | null;
  destination: string;
  slices?: number;
  files?: number;
}

export type ActivityLevel = "info" | "ok" | "warn" | "error";

export interface ActivityCurrentSlice {
  slice_id: string;
  ordinal: number;
  params: Record<string, unknown>;
  attempt: number;
  max_attempts: number;
  started_at: string;
}

export type WorkerSlotPhase = "request" | "pacing" | "retry_wait" | "archiving" | string;

export interface ActivityWorkerSlot {
  worker_id: string;
  run_id: string;
  slice_id: string;
  ordinal: number;
  api_name: string;
  phase: WorkerSlotPhase;
  effective_requests_per_minute: number;
  next_request_in_ms: number;
}

export interface ActivityActiveRun {
  id: string;
  name: string;
  api_name: string;
  dataset_id: string | null;
  state: string;
  cancel_requested: boolean;
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  pending: number;
  rows: number;
  started_at: string | null;
  current_slice: ActivityCurrentSlice | null;
  current_slices?: ActivityCurrentSlice[];
}

export interface ActivityWorker {
  worker_running: boolean;
  token_configured: boolean;
  global_requests_per_minute: number;
  effective_requests_per_minute: number;
  next_request_in_ms: number;
  pacing: boolean;
  queued_runs: number;
  collection_threads?: number;
  effective_collection_threads?: number;
  max_collection_threads?: number;
  applies_to?: "next_run" | string;
  busy_workers?: number;
  workers?: ActivityWorkerSlot[];
  active_runs?: ActivityActiveRun[];
  active_run: ActivityActiveRun | null;
}

export interface ActivityEvent {
  seq: number;
  timestamp: string;
  level: ActivityLevel;
  kind: string;
  run_id: string;
  slice_id: string | null;
  task_name?: string;
  run_name?: string;
  api_name: string;
  dataset_id: string | null;
  ordinal: number | null;
  params: Record<string, unknown>;
  rows: number | null;
  attempt: number | null;
  max_attempts: number | null;
  duration_ms: number | null;
  raw_sha256: string | null;
  error_kind: string | null;
  retry_delay_seconds?: number;
  message: string;
}

export interface ActivitySnapshot {
  worker: ActivityWorker;
  events: ActivityEvent[];
  latest_seq: number;
  supported?: boolean;
}
