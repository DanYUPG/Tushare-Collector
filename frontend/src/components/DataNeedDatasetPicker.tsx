import { useState } from "react";
import type { DataNeedCapability, DataNeedSpec } from "../types";

export function DataNeedDatasetPicker({entries, spec, onChange}: {
  entries: DataNeedCapability[]; spec: DataNeedSpec; onChange: (patch: Partial<DataNeedSpec>) => void;
}) {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const groups = [...new Map(entries.map(entry => [entry.category, entry.category_name])).entries()];
  const visible = entries.filter(entry => (!category || entry.category === category)
    && `${entry.name} ${entry.api_name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = entries.filter(entry => spec.dataset_ids.includes(entry.dataset_id));
  const dependencies = new Set<string>();
  const visit = (entry: DataNeedCapability) => entry.dependencies.forEach(id => {
    if (dependencies.has(id)) return;
    dependencies.add(id);
    const dependency = entries.find(item => item.dataset_id === id);
    if (dependency) visit(dependency);
  });
  selected.forEach(visit);

  function select(ids: string[]) {
    onChange({
      dataset_ids: ids,
      dataset_options: Object.fromEntries(Object.entries(spec.dataset_options || {}).filter(([id]) => ids.includes(id))),
      ...(ids.length && entries.filter(entry => ids.includes(entry.dataset_id)).every(entry => entry.date_mode === "snapshot")
        ? {start_date: "1990-12-19", end_date: null} : {}),
    });
  }
  function option(entry: DataNeedCapability, key: string, value: string, checked: boolean) {
    const current = spec.dataset_options?.[entry.dataset_id]?.[key] ?? entry.options[key].default;
    const values = entry.options[key].values.filter(item => item === value ? checked : current.includes(item));
    onChange({dataset_options: {...spec.dataset_options,
      [entry.dataset_id]: {...spec.dataset_options?.[entry.dataset_id], [key]: values},
    }});
  }
  return <section aria-label="需要的数据" className="space-y-3">
    <div className="flex items-center justify-between text-sm">
      <h3 className="font-medium">需要的数据</h3><span className="text-xs text-slate-500">已选 {selected.length} / {entries.length} 个仓库接口</span>
    </div>
    {!selected.length && <p className="text-xs text-slate-500">请至少选择一个需要的数据接口。</p>}
    <div className="grid gap-2 sm:grid-cols-2">
      <select aria-label="需求数据分类" value={category} onChange={event => setCategory(event.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
        <option value="">全部股票分类</option>
        {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select>
      <input aria-label="搜索需求接口" placeholder="名称或 API" value={search} onChange={event => setSearch(event.target.value)}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
    </div>
    <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map(entry => <label key={entry.dataset_id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={spec.dataset_ids.includes(entry.dataset_id)}
            onChange={event => select(event.target.checked ? [...spec.dataset_ids, entry.dataset_id]
              : spec.dataset_ids.filter(id => id !== entry.dataset_id))} />
          <span>{entry.name}<code className="block text-xs text-slate-500">{entry.api_name}</code></span>
        </label>)}
      </div>
      {!visible.length && <p className="text-sm text-slate-500">没有匹配的已支持仓库接口。</p>}
    </div>
    {selected.length > 0 && <details className="rounded-lg border border-slate-200 p-3">
      <summary className="cursor-pointer text-sm">已选接口与分类参数（{selected.length}）</summary>
      <div className="mt-3 space-y-3">{selected.map(entry => <details key={entry.dataset_id} className="rounded border border-slate-200 p-3">
        <summary className="cursor-pointer text-sm">{entry.name} · {entry.date_mode === "snapshot" ? "仅当前快照"
          : entry.archive_only ? "已停更历史" : entry.date_label}{Object.keys(entry.options).length ? " · 可配置分类" : ""}</summary>
        <div className="mt-3 space-y-3 text-xs leading-relaxed text-slate-600">
          <p>{entry.scope_note}</p><p>{entry.update_note}</p>
          {entry.semantic_note && <p>{entry.semantic_note}</p>}
          {entry.date_mode !== "snapshot" && <p>{entry.date_label} · 接口历史起点 {entry.start_date}
            {entry.available_until && <> · 停更边界 {entry.available_until}</>}，实际计划遵循接口规则。</p>}
          {Object.entries(entry.options).map(([key, definition]) => {
            const values = spec.dataset_options?.[entry.dataset_id]?.[key] ?? definition.default;
            return <fieldset key={key} className="space-y-2"><legend className="font-medium text-slate-800">{key}（至少选一项）</legend>
              <div className="flex flex-wrap gap-3">{definition.values.map(value => <label key={value} className="flex items-center gap-2">
                <input type="checkbox" checked={values.includes(value)} onChange={event => option(entry, key, value, event.target.checked)} />{value}
              </label>)}</div>
              {!values.length && <p role="alert" className="text-rose-800">请选择至少一个 {key} 值。</p>}
            </fieldset>;
          })}
          <p>保存全部 {entry.field_count} 个声明字段。{entry.permission}</p>
          <a href={entry.doc_url} target="_blank" rel="noreferrer" className="text-teal-800 underline">接口文档</a>
        </div>
      </details>)}</div>
    </details>}
    {dependencies.size > 0 && <p className="text-xs leading-relaxed text-slate-600">
      自动准备依赖：{[...dependencies].map(id => entries.find(entry => entry.dataset_id === id)?.name || id).join("、")}。
      依赖计入请求预算；仅勾选的数据发布到仓库。代码池依赖须保留全部预置分类。
    </p>}
  </section>;
}
