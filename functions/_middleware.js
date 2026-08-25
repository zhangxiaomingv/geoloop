// ⚠️ 本文件由 geoloopos/scripts/gen-observer.mjs 生成 —— 勿手改
// 数据源：geoloopos/data/bots.json（22 个爬虫 · 25 条匹配规则）
// 重新生成：在 ~/geoloopos 下运行 node scripts/gen-observer.mjs 后重新部署本站。
// 职责：识别 AI 爬虫来访并异步上报（双信号架构·输入侧）；人类流量零感知。

const SITE = "geoloopos.com";
const BOTS = [["gptbot","gptbot"],["oai-searchbot","oai-searchbot"],["chatgpt-user","chatgpt-user"],["claudebot","claudebot"],["claude-user","claude-user"],["claude-searchbot","claude-searchbot"],["perplexitybot","perplexitybot"],["perplexity-user","perplexity-user"],["google-extended","google-extended"],["applebot-extended","applebot-extended"],["amazonbot","amazonbot"],["meta-externalagent","meta-externalagent"],["meta-externalagent","meta-externalagent"],["ccbot","ccbot"],["duckassistbot","duckassistbot"],["youbot","youbot"],["cohere-ai","cohere-ai"],["bytespider","bytespider"],["baiduspider","baiduspider"],["petalbot","petalbot"],["yisouspider","yisouspider"],["sogou-spider","sogou web spider"],["sogou-spider","sogou inst spider"],["haosouspider","haosouspider"],["haosouspider","360spider"]];

export async function onRequest({ request, env, next, waitUntil }) {
  try {
    const ua = (request.headers.get("user-agent") || "").toLowerCase();
    if (ua && env && env.OBSERVE_ENDPOINT && env.OBSERVE_TOKEN) {
      let botId = null;
      for (let i = 0; i < BOTS.length; i++) {
        if (ua.indexOf(BOTS[i][1]) !== -1) { botId = BOTS[i][0]; break; }
      }
      if (botId) {
        const u = new URL(request.url);
        const body = JSON.stringify({
          events: [{ site: SITE, bot_id: botId, url: (u.pathname + u.search).slice(0, 512), ts: Date.now() }],
        });
        waitUntil(
          fetch(env.OBSERVE_ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + env.OBSERVE_TOKEN },
            body,
          }).catch(() => {})
        );
      }
    }
  } catch (e) {
    // 观测永不影响主站
  }
  return next();
}
