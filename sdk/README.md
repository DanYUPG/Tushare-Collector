# Tushare Warehouse SDK

直接读取 Tushare Collector 已发布的本地 Parquet 仓库。无需启动采集服务，无需 Token，不访问网络或 SQLite，不创建缓存，也不修改数据文件。

## 安装

要求 Python 3.11+。依赖只有 PyArrow、pandas 及其依赖，不安装采集器。当前未发布到 PyPI，不能直接使用 `pip install tushare-warehouse-sdk`。

选择以下一种方式，安装到你的策略或研究项目的 Python 环境。

### 从本机源码安装

在本项目根目录执行：

```bash
python -m pip install ./sdk
```

其他目录或项目也可用绝对路径，例如 `python -m pip install "D:\Tushare-Collector\sdk"`。

### 从 GitHub 安装

本机需已安装 Git；只安装 SDK 子项目，不安装采集器：

```bash
python -m pip install "git+https://github.com/DanYUPG/Tushare-Collector.git#subdirectory=sdk"
```

默认安装远程默认分支当前版本。需要复现运行环境时，应在 URL 中用 `@提交号` 固定版本，放在 `#subdirectory=sdk` 前面。

### 使用 wheel 安装包

维护者在项目根目录构建：

```bash
uv build ./sdk --wheel --out-dir ./dist
```

将生成的 `.whl` 发给使用者，对方无需 Git 或采集器源码：

```bash
python -m pip install ./dist/tushare_warehouse_sdk-0.1.0-py3-none-any.whl
```

请将安装路径改为收到文件的实际位置。pip 仍需安装 PyArrow、pandas 等依赖；单个 SDK wheel 不等于完整离线安装包。

## warehouse 目录在哪里

**安装 SDK 不会下载或创建数据仓库。** 它只读取采集器已经发布的数据：

| 采集器启动方式 | SDK 使用的目录 |
|---|---|
| 在源码项目中使用默认控制目录 | `<项目目录>/data/warehouse` |
| 指定 `--data-dir "C:\TushareData"` | `C:\TushareData\warehouse` |
| 指定环境变量 `TC_DATA_DIR` | `<该环境变量指定的目录>/warehouse`，命令行 `--data-dir` 优先 |

不要传 `raw/`、控制目录本身、表目录或 `snapshots/`。仅完成原始采集还不够，需先完成数据需求发布或整理成功归档。

仓库根目录应有 `catalog.json`。已有仓库缺少索引时，先按[已有数据如何接入](#已有数据如何接入)补建，无需重新下载。

### 跨机器或交付给其他项目

先在原机器补齐 SDK 索引，再正常停止采集服务，复制**完整 `warehouse` 目录**并保留内部相对路径。接收方将 `Warehouse(...)` 指向复制后的目录即可，不需要 Token、Raw、SQLite 或原机器路径。

最新快照可能引用旧快照目录中的文件，不能只复制最新快照文件夹。SDK 只读副本可以换位置，但这不代表采集器的控制目录已完成迁移；继续采集仍需原配置及路径。分享数据前请确认供应商授权及使用范围。

## 第一次读取

```python
from tushare_warehouse import Warehouse

# 指定控制目录下的 warehouse，不是 raw，也不是某个 snapshots 目录。
warehouse = Warehouse(r"C:\TushareData\warehouse")
print(warehouse.list_tables())
print(warehouse.describe("daily"))

df = warehouse.read_file(
    "daily",
    cols=["ts_code", "trade_date", "close"],
    filters=[
        ("trade_date", ">", "20200101"),
        ("ts_code", "in", ["000001.SZ", "600000.SH"]),
        ("close", ">", 10),
    ],
)
print(df)
print(df.attrs["snapshot_id"])
```

`filename` 参数实际为逻辑表名，如 `daily`，不是文件路径。`cols=None` 读取所有列；传入列时保留指定顺序，不自动增加主键列。过滤列可以不在返回列中。

默认返回使用 pandas Arrow 类型的 DataFrame，保留可空整数等字段类型。`df.attrs` 带有表名、仓库 ID、快照 ID，以及适用时的变体 ID。传入 `as_arrow=True` 返回 `pyarrow.Table`，相同信息在 schema metadata 中。

未匹配到记录返回带字段类型的空表；表不存在、缺文件、非法列、非法过滤、元数据或数据损坏会明确报错，不返回伪装成功的空表。结果没有分页上限；大表请使用分批读取。默认不承诺全局排序，也不自动去重。

## 过滤规则

第一版所有条件以 **AND** 连接。不支持任意 SQL、OR、表达式、关联或聚合。

| 操作符 | 示例 |
|---|---|
| `==`、`!=`、`>`、`>=`、`<`、`<=` | `("close", ">=", 10)` |
| `in`、`not in` | `("ts_code", "in", ["000001.SZ"])` |
| `is null`、`is not null` | `("close", "is null", None)` |

比较值必须匹配 `describe()` 的字段类型：字符串日期用 `"20200101"`，整数列用整数，时间戳列用无时区 `datetime`。不做隐式日期转换、补零或字符串转数值。空值只用显式空值操作符；普通比较及 `in` / `not in` 不匹配空值。

过滤始终比较**实际存储字段值**。例如月份字段仍为月份、周标签仍为原标签；不是网页查询中“周期区间相交”的业务日期规则。当前股票快照不是历史股票池，SDK 不会用日期推导不存在的历史状态。JSON 编码字段仍返回 JSON 字符串，编码见 `describe()["field_encodings"]`。

## 大数据量分批读取

```python
with warehouse.read_batches(
    "daily",
    cols=["ts_code", "trade_date", "close"],
    filters=[("trade_date", ">=", "20200101")],
    batch_size=65536,
) as batches:
    print(batches.schema.metadata[b"warehouse.snapshot_id"])
    for batch in batches:
        # batch 是 pyarrow.RecordBatch；也可以 batch.to_pandas()。
        process(batch)
```

调用 `read_batches()` 时即固定快照；后续发布新快照不会混入这次读取。每批最多 `batch_size` 行。SDK 按清单逐文件读取，通过 Arrow 下推列选择及过滤，不把整个仓库先加载到内存。

默认 `verify=True`：读取每个选中文件前完整计算 SHA-256，检测损坏，但会增加磁盘读取量。明确接受跳过数据哈希校验时可设 `verify=False`；清单哈希、路径约束和字段类型仍校验。流式读取后续文件若失败会抛错，此前已消费的批次不会自动撤销。

## 固定版本与选择数据来源

```python
info = warehouse.describe("daily")
df = warehouse.read_file("daily", snapshot_id=info["snapshot_id"])

print(warehouse.list_repositories("daily"))
df = warehouse.read_file("daily", repository_id="这里填完整的仓库ID")

# 分钟频度、复权方式等可能对应多个变体，必须选一个，不会自动混表。
info = warehouse.describe("stk_mins")
print(info["variants"])
df = warehouse.read_file("stk_mins", variant_id=info["variants"][0]["id"])
```

新发布仓库的默认来源是该表最后一次成功整理所选择的仓库，由索引明确记录，不按文件修改时间猜测。旧仓库补建索引时若存在多个来源且没有已记录默认值，必须显式传 `repository_id`；也可回到采集器整理目标仓库，记录默认选择。选择历史版本时，必要时同时指定它所属的 `repository_id`。

每次调用单独固定一张表的版本，不提供跨表原子快照。历史快照及其引用文件必须保留；不要扫描并拼接全部历史目录，也不要直接删除旧目录来节省空间。SDK 不会补采缺失数据，仓库存在不等于市场覆盖完整。

## 已有数据如何接入

升级后新整理的仓库会自动写入 SDK 元数据。已有仓库无需重新下载，也无需重写 Parquet：**正常停止原采集服务后**，在采集器项目根目录执行：

```bash
uv run --locked python -m collector.warehouse_metadata --data-dir "原来的控制目录"
```

这里传入的是包含 `collector.sqlite3` 的**控制目录**，不是 `warehouse`。默认目录可使用 `--data-dir ./data`，自定义目录例如 `--data-dir "C:\TushareData"`。

该命令只读 SQLite 中的快照登记和哈希，补建 `warehouse/catalog.json`、快照的 `manifest.sha256` 和当前指针校验字段，不访问供应商，不改配置或快照数据。请使用原目录；跨机器或移动目录造成的绝对路径失效需另行处理。完成后可重新启动采集服务，SDK 可同时只读已发布文件。

## 项目结构

```text
sdk/
├── pyproject.toml
├── README.md
├── src/tushare_warehouse/
│   ├── __init__.py
│   ├── reader.py
│   ├── metadata.py
│   ├── filters.py
│   └── errors.py
└── tests/
    └── test_reader.py
```
