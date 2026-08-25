-- geoloop-observe · 爬虫来访事件表（切片②）
-- 应用: npx wrangler d1 execute geoloop-observe --remote --file=scripts/d1-schema.sql

CREATE TABLE IF NOT EXISTS crawl_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  site   TEXT    NOT NULL,           -- 站点域名，如 zkoner.com
  bot_id TEXT    NOT NULL,           -- data/bots.json 里的爬虫 id
  url    TEXT    NOT NULL DEFAULT '/', -- 页面级路径（含 query），≤512 字符
  ts     INTEGER NOT NULL            -- 边缘采集时刻，Unix 毫秒
);

CREATE INDEX IF NOT EXISTS idx_events_site_ts ON crawl_events (site, ts);
CREATE INDEX IF NOT EXISTS idx_events_bot     ON crawl_events (bot_id);
