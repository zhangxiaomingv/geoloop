# GEOloopOS Identity Engine · 私有化部署手册

给企业客户在**自己的服务器**上部署 GEOloopOS（AI可见度操作系统）。数据保存在客户服务器本地，调用 DeepSeek/豆包 时只发送检测问题，客户自备 API Key。

## 环境要求

| 方式 | 要求 |
|---|---|
| **Docker（推荐）** | Docker 20+ / Docker Compose v2 |
| **Node 直跑** | Node.js 18+，Linux/macOS |

单机即可，无需数据库、无需公网域名（内网也可用）。

## 快速开始（30 秒）

```bash
# 把整个目录拷到目标服务器（可用 scp/宝塔/文件管理器）
cd tools/visibility
bash deploy.sh
```

脚本会自动：① 交互填写 API Key → 生成 `.env` ② 检测 Docker/Node ③ 启动。

启动后访问 `http://服务器IP:8788`。

## 手动部署（Docker）

```bash
cp .env.example .env
vim .env        # 填入 DEEPSEEK_API_KEY、ARK_API_KEY
docker compose up -d --build
docker compose logs -f        # 看日志
```

## 手动部署（Node 直跑）

```bash
cp .env.example .env
vim .env
npm install
nohup npx tsx src/server.ts > geoloopos.log 2>&1 &
# 常驻：建议用 pm2 / systemd 守护，参考下方 systemd 示例
```

## 配置项

`.env`（`docker compose` 会直接读取）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | 必填，DeepSeek（OpenAI 兼容） |
| `ARK_API_KEY` | — | 可选，豆包/火山方舟 |
| `DOUBAO_MODEL` | doubao-seed-2-0-pro-260215 | 可选，豆包模型名 |
| `PORT` | 8788 | 对外端口（Docker 用 `PORT` 映射宿主机） |
| `RATE_PER_MIN` | 8 | 每 IP 每分钟检测次数（防刷） |
| `RATE_PER_DAY` | 80 | 每 IP 每天检测次数 |
| `MAX_CONCURRENT` | 3 | 全局并发检测数 |

## 数据与备份

全部数据在 `data/` 目录（Docker 下为命名卷 `geoloopos-data`）：

- `checks.jsonl` — 检测历史
- `anchor.json` — 定位锚点（客户填写的品牌口径）
- `articles.json` — 文章监测库
- `cites.json` — 域名追踪与趋势

**备份**：直接打包 `data/` 目录即可；恢复时覆盖回原位置。Docker 卷备份：`docker run --rm -v geoloopos-data:/data -v $(pwd):/backup alpine tar czf /backup/data-backup.tar.gz -C /data .`

## 升级

```bash
# 拉新代码后
docker compose up -d --build
```
数据卷不动，历史保留。

## 常见问题

- **端口被占**：改 `.env` 里 `PORT=9000`，重新 `docker compose up -d`。
- **防火墙**：确保 8788（或自定义端口）TCP 已放行。
- **检测很慢/失败**：先 `curl 服务器IP:端口/` 看页面是否正常；再在页面点「检测」看提示。多数是 API Key 失效或账户额度问题。
- **限流太严**：内网私有使用可调大 `RATE_PER_MIN`。
- **想加 Claude 作为检测源**：默认源为 DeepSeek + 豆包。如需接入 Claude，在 `config.ts` 的 `providers` 增加 Anthropic 源并配置客户 Key，或联系我们定制。

## systemd 守护（Node 模式）

`/etc/systemd/system/geoloopos.service`：

```ini
[Unit]
Description=GEOloopOS Identity Engine
After=network.target

[Service]
WorkingDirectory=/opt/geoloopos
ExecStart=/usr/bin/npx tsx src/server.ts
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now geoloopos
```
