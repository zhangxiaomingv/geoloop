#!/usr/bin/env python3
"""把 ~/zkoner.com/docs/whitepaper.md 转成 geoloopos.com/whitepaper 产品站页面。

用法：python3 scripts/build-whitepaper.py
产出：site/whitepaper.html（bind-mount，容器即时生效；server.ts 需已有 /whitepaper 路由）
"""
import html
import markdown
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path.home() / "zkoner.com/docs/whitepaper.md"
OUT = ROOT / "site/whitepaper.html"

text = SRC.read_text(encoding="utf-8")

# 去掉文档内嵌的 H1（作为页面大标题单独渲染），其余保留
lines = text.split("\n")
h1_idx = next((i for i, l in enumerate(lines) if l.startswith("# ")), -1)
if h1_idx >= 0:
    h1 = lines[h1_idx].lstrip("# ").strip()
    # 移除标题行与紧接的 `> —— 中文...` 副题行
    drop = {h1_idx}
    if h1_idx + 1 < len(lines) and lines[h1_idx + 1].startswith("> ——"):
        drop.add(h1_idx + 1)
    lines = [l for i, l in enumerate(lines) if i not in drop]
    body_src = "\n".join(lines)
else:
    h1 = "GEOloop：AI可见度闭环方法论"
    body_src = text

body = markdown.markdown(
    body_src,
    extensions=["fenced_code", "tables", "sane_lists", "nl2br"],
    output_format="html5",
)

CSS = """
:root{
  --bg:#0a0a0b;--surface:#101013;--surface-2:#16161a;--surface-3:#1d1d24;
  --border:rgba(255,255,255,.08);--border-strong:rgba(255,255,255,.16);
  --text:#f5f5f6;--text-muted:#a1a1aa;--text-faint:#76767f;
  --primary:#4c8dff;--primary-strong:#2563eb;--primary-soft:rgba(76,141,255,.13);
  --radius:16px;--radius-sm:10px;
  --font-sans:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  color:var(--text);font-family:var(--font-sans);font-size:15px;line-height:1.75;
  -webkit-font-smoothing:antialiased;background:var(--bg);
}
.wrap{max-width:860px;margin:0 auto;padding:0 22px 80px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 0 8px}
.logo{display:flex;align-items:center;gap:10px;margin-left:-5px}
.logo-text{display:flex;flex-direction:column;line-height:1.15;font-weight:650;font-size:15px;letter-spacing:-.01em}
.logo-sub{font-size:11px;font-weight:450;color:var(--text-faint)}
.logo-mark{width:40px;height:40px;display:grid;place-items:center}
.logo-mark img{width:100%;height:100%;object-fit:contain;display:block}
.top-nav{display:flex;align-items:center;gap:16px;font-size:13px}
.top-nav a{color:var(--text-muted);text-decoration:none;transition:color .15s}
.top-nav a:hover,.top-nav a.active{color:var(--primary)}
.doc-head{padding:34px 0 26px;border-bottom:1px solid var(--border);margin-bottom:30px}
.doc-title{font-size:30px;line-height:1.3;font-weight:720;letter-spacing:-.02em}
.doc-meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px;color:var(--text-faint);font-size:13px}
.doc-meta b{color:var(--text-muted);font-weight:550}
.doc-meta .author{color:var(--primary)}
#body h2{font-size:21px;font-weight:680;margin:38px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border);letter-spacing:-.01em}
#body h3{font-size:17px;font-weight:640;margin:26px 0 10px}
#body h4{font-size:15px;font-weight:600;margin:20px 0 8px}
#body p{margin:0 0 14px;color:var(--text)}
#body ul,#body ol{margin:0 0 14px;padding-left:24px}
#body li{margin:4px 0}
#body strong{font-weight:640}
#body em{font-style:italic}
#body blockquote{margin:16px 0;padding:12px 18px;border-left:3px solid var(--primary);background:var(--primary-soft);border-radius:0 var(--radius-sm) var(--radius-sm) 0}
#body blockquote p{margin:0;color:var(--text-muted)}
#body code{font-family:var(--font-mono);font-size:.9em;background:var(--surface-2);padding:2px 6px;border-radius:6px;color:#9ecbff}
#body pre{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px 18px;overflow-x:auto;margin:16px 0;line-height:1.6}
#body pre code{background:none;padding:0;font-size:13px;color:var(--text-muted)}
#body table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;display:block;overflow-x:auto}
#body th,#body td{border:1px solid var(--border-strong);padding:9px 12px;text-align:left;white-space:nowrap}
#body th{background:var(--surface-2);font-weight:620}
#body tr:nth-child(2n) td{background:rgba(255,255,255,.02)}
#body hr{border:none;border-top:1px solid var(--border);margin:30px 0}
#body a{color:var(--primary);text-decoration:none}
#body a:hover{text-decoration:underline}
footer{border-top:1px solid var(--border);margin-top:50px;padding:22px 0 0;display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;color:var(--text-faint);font-size:12px}
footer code{font-family:var(--font-mono)}
"""

HTML = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="/logo.png?v=20260823" />
<meta name="color-scheme" content="dark" />
<meta name="description" content="GEOloop：AI可见度闭环方法论——中文 AI 搜索环境下的实体认知、可见度与持续优化。Experiment #001 双源实测数据 + GEO 闭环方法论。" />
<title>{html.escape(h1)} · GEOloopOS 商业白皮书</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="logo">
      <span class="logo-mark" aria-hidden="true"><img src="/logo.png?v=20260823" alt="" /></span>
      <span class="logo-text">GEOloopOS<span class="logo-sub">AI 可见度增长闭环系统</span></span>
    </div>
    <nav class="top-nav">
      <a href="/whitepaper" class="active">白皮书</a>
      <a href="/observe/">来访监测</a>
    </nav>
  </header>

  <section class="doc-head">
    <h1 class="doc-title">{html.escape(h1)}</h1>
    <div class="doc-meta">
      <span>作者：<b class="author">张晓明</b></span>
      <span><b>GEO 与 AI 搜索可见度独立顾问</b></span>
      <span>数据基准：<b>2026 年 8 月 16 日—18 日</b></span>
    </div>
  </section>

  <article id="body">{body}</article>

  <footer>
    <span>GEOloopOS · AI 可见度增长闭环系统</span>
    <span><a href="https://zkoner.com" style="color:var(--text-muted);text-decoration:none;">创始人实验站 zkoner.com</a> · 数据源 <code>DeepSeek</code> / <code>豆包</code> / <code>Ox Alpha</code></span>
  </footer>
</div>
</body>
</html>
"""

OUT.write_text(HTML, encoding="utf-8")
print(f"OK → {OUT}  ({len(HTML)//1024} KB)")
