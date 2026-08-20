# data/ — 运行时数据

本目录存 GEOloop 的**运行时数据**（gitignored，不进代码仓库）。备份 = 打包整个目录。

| 文件 | 内容 |
|---|---|
| `checks.jsonl` | 检测历史（append-only，每次检测一行 JSON） |
| `anchor.json` | 定位锚点（名称/定位/关键词/官网 + 生成的三版简介） |
| `articles.json` | 文章监测库（标题/URL/主题 + 最近一次监测结果） |
| `cites.json` | 域名追踪（域名 + 最近 30 次复测趋势） |
| `entities.json` | 统一实体档案（checks[] 认知时间序列 + citations[] + sceneShares[]） |
| `documentary/` | 开发纪录片素材（关键镜头截图：拒答→答对 / 分数上涨 / 首次被引用，见 ROADMAP P3） |

设计原则：**append-only 不可变**（检测记录只增不改），聚合视图按需派生，保证历史可回溯。时间序列是核心资产——「认知变化」比单次分数值钱。
