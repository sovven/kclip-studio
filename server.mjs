// KCLIP Studio 后端：发现韩国短视频 → AI 推荐 → 排队制作（调用本机 Claude Code 或 Codex + xhs-bilingual-clip skill）
// 运行：node server.mjs   （端口 5291；前端 dev 在 5290，build 后由本服务直接托管 dist/）
import { spawn, execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createTplApi } from "./tpl.mjs";
import { createPackApi } from "./pack.mjs";

const PORT = Number(process.env.PORT) || 5291;
// 只监听本机：这个服务能让 Agent 在电脑上跑命令，不能暴露给局域网。确实要给别的设备用，自己设 HOST=0.0.0.0
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const JOBS = path.join(ROOT, "jobs");
const YTDLP = "D:/Tools/yt-dlp/yt-dlp.exe";
const SKILL = "D:/Agent/Claude/workpalce/work/xhs-bilingual-clip";
const NODE_MODULES = "D:/Agent/Claude/workpalce/work/xhs-bilingual-clip/template/node_modules";
mkdirSync(JOBS, { recursive: true });

// ---------- 栏目 → 搜索词 / 频道 ----------
// 栏目是数据不是代码：默认 6 个内容栏目（按"这条视频是什么内容"分，不按来源分），用户可以在页面上增删，存在 jobs/categories.json。
// 频道由 scripts/scout-channels.mjs 按"最新 12 条 Shorts 播放量中位数"筛出来，过一段时间重跑一次更新。
// ch：官方频道 Shorts 页（最新在前）；q：搜索词；kind:"hot" 的搜索词来自 Melon 实时榜 + theqoo 热帖
const DEFAULT_CATEGORIES = [
  { id: "hot", label: "今日热点", kind: "hot" },
  { id: "variety", label: "综艺名场面", ch: ["https://www.youtube.com/@ddeunddeun/shorts", "https://www.youtube.com/@SBSRunningMan/shorts", "https://www.youtube.com/@JTBCVoyage/shorts", "https://www.youtube.com/@workman/shorts", "https://www.youtube.com/@WassupMan/shorts", "https://www.youtube.com/@mmtg_official/shorts", "https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@mbicnews/shorts"] },
  { id: "idol", label: "爱豆日常", ch: ["https://www.youtube.com/@BLACKPINK/shorts", "https://www.youtube.com/@BABYMONSTER/shorts", "https://www.youtube.com/@NewJeans_official/shorts", "https://www.youtube.com/@StrayKids/shorts", "https://www.youtube.com/@ILLIT_official/shorts", "https://www.youtube.com/@cortis_bighit/shorts", "https://www.youtube.com/@TXT_bighit/shorts", "https://www.youtube.com/@BTS/shorts", "https://www.youtube.com/@RESCENE_official/shorts", "https://www.youtube.com/@aespa/shorts", "https://www.youtube.com/@TWICE/shorts", "https://www.youtube.com/@ATEEZofficial/shorts", "https://www.youtube.com/@IVEstarship/shorts", "https://www.youtube.com/@LESSERAFIM_official/shorts", "https://www.youtube.com/@NCTDREAM/shorts", "https://www.youtube.com/@pledis17/shorts"] },
  { id: "talk", label: "访谈金句", ch: ["https://www.youtube.com/@ddeunddeun/shorts"], q: ["인생 조언 연예인 인터뷰 shorts", "유퀴즈 감동 명언 shorts", "짠한형 shorts", "살롱드립 shorts", "사주 연예인 shorts", "역술가 연예인 사주 풀이 shorts"] },
  { id: "life", label: "生活共鸣", ch: ["https://www.youtube.com/@shortbox/shorts", "https://www.youtube.com/@nerdult/shorts"], q: ["길거리 인터뷰 shorts", "시민 인터뷰 웃긴 shorts", "감동 실화 shorts", "할머니 할아버지 감동 shorts", "가족 웃긴 순간 shorts", "연애 공감 shorts", "직장인 공감 shorts"] },
  { id: "drama", label: "热播韩剧", ch: ["https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@netflixkcontent/shorts", "https://www.youtube.com/@NetflixKorea/shorts", "https://www.youtube.com/@jtbcdrama/shorts"] },
];
const CATS_FILE = path.join(JOBS, "categories.json");
let categories = (() => { try { const c = JSON.parse(readFileSync(CATS_FILE, "utf8")); if (Array.isArray(c) && c.length) return c; } catch {} return structuredClone(DEFAULT_CATEGORIES); })();
const catOf = (id) => categories.find((c) => c.id === id);
const saveCats = () => writeFileSync(CATS_FILE, JSON.stringify(categories, null, 1));
const publicCats = () => categories.map((c) => ({ id: c.id, label: c.label, kind: c.kind, custom: !!c.custom, sources: [...(c.q || []), ...(c.ch || [])] }));
// 每行一个：http 开头的是频道/播放列表链接，其余当搜索词
function addCategory({ label, sources }) {
  const name = String(label || "").trim().slice(0, 12);
  const lines = String(sources || "").split(/\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (!name) throw new Error("给栏目起个名字");
  if (!lines.length) throw new Error("至少填一个关键词或频道链接");
  const ch = lines.filter((x) => /^https?:\/\//.test(x)).map((x) => (/youtube\.com\/@[^/]+\/?$/.test(x) ? x.replace(/\/?$/, "/shorts") : x));
  const q = lines.filter((x) => !/^https?:\/\//.test(x));
  const c = { id: `c${Date.now().toString(36)}`, label: name, custom: true, q, ch };
  categories.push(c);
  saveCats();
  return c;
}
function removeCategory(id) {
  categories = categories.filter((c) => c.id !== id);
  cache.delete(id);
  saveCats();
}

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))),
  );

const ytList = async (src, n) => {
  const url = src.startsWith("http") ? src : src.startsWith("date:") ? `https://www.youtube.com/results?search_query=${encodeURIComponent(src.slice(5))}&sp=CAISAhgB` : `ytsearch${n}:${src}`;
  // 注意不要加 youtube:lang=ko：韩文界面的"조회수 1.7만회"yt-dlp 解析不了，播放量会变成 0
  const out = await run(YTDLP, ["--flat-playlist", "-J", "--playlist-items", `1-${n}`, url]);
  const pl = JSON.parse(out);
  return (pl.entries || []).map((e) => ({
    id: e.id,
    url: e.url?.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    channel: e.channel || e.uploader || pl.channel || pl.uploader || "",
    views: e.view_count || 0,
    duration: e.duration || null,
    // Shorts 用竖版封面：优先取 yt-dlp 给的竖图（高 > 宽），没有就用 oardefault（Shorts 竖版预览）
    thumb: (e.thumbnails || []).filter((t) => t.height > t.width).sort((a, b) => b.height - a.height)[0]?.url || `https://i.ytimg.com/vi/${e.id}/oardefault.jpg`,
    platform: "youtube",
  }));
};

// 不做体育、政治：标题命中这些词就过滤
const BLOCK = /올림픽|금메달|은메달|동메달|선수|경기|축구|야구|농구|배구|골프|펜싱|양궁|KBO|K리그|월드컵|국가대표|대통령|국회|정치|선거|여당|야당|탄핵|정부|장관|의원|北|군사|전쟁/;
const keep = (v) => !BLOCK.test(v.title || "");

// cat → {at, items}。存盘：重启后第一屏不用再等 YouTube；超过 30 分钟先给旧的，后台刷新
const DISC_FILE = path.join(JOBS, "discover-cache.json");
const cache = new Map((() => { try { return Object.entries(JSON.parse(readFileSync(DISC_FILE, "utf8"))).filter(([, v]) => Date.now() - v.at < 3 * 24 * 3600 * 1000); } catch { return []; } })());
const saveCache = () => { try { writeFileSync(DISC_FILE, JSON.stringify(Object.fromEntries(cache))); } catch {} };
const FRESH_MS = 30 * 60 * 1000;
// 视频详情（不下载）：分类、YouTube 识别的原始语言、简介。用来去掉纯舞蹈/纯音乐，只留有台词的。
// 详情缓存存盘，查过的不再查（减少对 YouTube 的请求，避免触发"确认你不是机器人"）
const META_FILE = path.join(JOBS, "meta.json");
const meta = new Map(existsSync(META_FILE) ? Object.entries(JSON.parse(readFileSync(META_FILE, "utf8"))) : []);
const saveMeta = () => writeFileSync(META_FILE, JSON.stringify(Object.fromEntries(meta)));
let ytCooldownUntil = 0;
const DANCE = /챌린지|challenge|dance|댄스|안무|직캠|fancam|M\/V|\bMV\b|teaser|티저|performance|퍼포먼스|OUT NOW|코레오|choreo/i;
const fetchMeta = (v) =>
  meta.has(v.id)
    ? Promise.resolve(meta.get(v.id))
    : Date.now() < ytCooldownUntil
    ? Promise.resolve(null)
    : run(YTDLP, ["-J", "--skip-download", "--no-playlist", v.url], { timeout: 60000 })
        .then((out) => {
          const j = JSON.parse(out);
          const ac = Object.keys(j.automatic_captions || {});
          const orig = (ac.find((k) => k.endsWith("-orig")) || "").replace("-orig", "");
          const m = { categories: j.categories || [], orig, desc: (j.description || "").replace(/\s+/g, " ").slice(0, 160), duration: j.duration ?? v.duration };
          // speech: "ko"=有韩语台词，"none"=没识别到语音，"other"=识别成别的语言（多半是歌）
          m.speech = orig === "ko" ? "ko" : orig ? "other" : "none";
          meta.set(v.id, m);
          return m;
        })
        .catch((e) => {
          if (/not a bot|Sign in to confirm/i.test(e.message)) { ytCooldownUntil = Date.now() + 30 * 60 * 1000; console.warn("YouTube 人机验证，详情查询暂停 30 分钟"); }
          return null;
        });

// 有内容才要：音乐类且没有韩语台词、或被识别成外语（歌声）、或标题明显是舞蹈/MV 的，全部去掉
async function enrich(items, limit = 15) {
  const top = items.slice(0, Math.max(limit, 30));
  const look = top.slice(0, limit);
  for (let i = 0; i < look.length; i += 3) await Promise.all(look.slice(i, i + 3).map(fetchMeta));
  saveMeta();
  return top
    .map((v) => ({ ...v, ...(meta.get(v.id) ? { meta: meta.get(v.id), duration: meta.get(v.id).duration } : {}) }))
    .filter((v) => {
      const m = v.meta;
      if (DANCE.test(v.title)) return false; // 舞蹈、MV、Challenge：不管有没有声音都不要
      if (!m) return true;
      if (m.speech === "other") return false;
      if (m.categories.includes("Music") && m.speech !== "ko") return false;
      return true;
    })
    .sort((a, b) => (b.meta?.speech === "ko") - (a.meta?.speech === "ko") || b.views - a.views);
}

// ---------- 韩国真实热度：Melon 实时音源榜 ----------
// 前 50 首按名次加权（第 1 名 50 分），统计艺人热度。比"从自己挑的频道里数标签"可靠得多。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
let melonCache = { at: 0, artists: [] };
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
async function melonHot() {
  if (Date.now() - melonCache.at < 60 * 60 * 1000 && melonCache.artists.length) return melonCache.artists;
  const html = await (await fetch("https://www.melon.com/chart/index.htm", { headers: { "user-agent": UA } })).text();
  const rows = html.split(/<tr class="lst(?:50|100)"/).slice(1, 51);
  const score = new Map();
  rows.forEach((r, i) => {
    const song = decode((r.match(/rank01">[\s\S]*?<a[^>]*>([^<]+)<\/a>/) || [])[1] || "");
    const artists = [...new Set([...(((r.match(/rank02">([\s\S]*?)<\/div>/) || [])[1]) || "").matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => decode(m[1])))];
    for (const a of artists) {
      const cur = score.get(a) || { name: a, score: 0, songs: [], best: 99 };
      cur.score += 50 - i;
      cur.best = Math.min(cur.best, i + 1);
      if (cur.songs.length < 2) cur.songs.push(song);
      score.set(a, cur);
    }
  });
  // 搜索用名：有韩文括号就用韩文（"RESCENE (리센느)" → 리센느），否则原名
  const artists = [...score.values()]
    .sort((a, b) => b.score - a.score)
    .map((a) => ({ ...a, query: (a.name.match(/\(([^)]*[\uAC00-\uD7A3][^)]*)\)/) || [])[1] || a.name.replace(/\s*\(.*\)/, "") }));
  melonCache = { at: Date.now(), artists };
  return artists;
}

// ---------- 韩网热议：theqoo HOT（韩国最大的女粉社区热帖）----------
// 帖子标题 → 便宜的 Haiku 挑出适合小红书韩语视频的话题 + 韩文搜索词；缓存 1 小时
let buzzCache = { at: 0, titles: [], topics: [] };
const unesc = (s) => s.replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
async function buzz() {
  if (Date.now() - buzzCache.at < 60 * 60 * 1000 && buzzCache.topics.length) return buzzCache;
  const html = await (await fetch("https://theqoo.net/hot", { headers: { "user-agent": UA } })).text();
  const titles = [...new Set([...html.matchAll(/href="\/hot\/\d+"[^>]*>([^<]{4,120})/g)].map((m) => unesc(m[1])))].filter((t) => !BLOCK.test(t)).slice(0, 50);
  const prompt = `下面是韩国女粉社区 theqoo 的 HOT 热帖标题（实时）。挑出 10 个"韩国人正在热议、放到小红书（中国 18-30 岁女生，韩语学习/韩娱/追星/综艺）也会有人看"的话题，并给每个话题一个能在 YouTube 搜到相关短视频的韩文搜索词。
优先：爱豆/艺人的有趣瞬间、综艺梗、流行语和梗、生活共鸣（职场、恋爱、家人、MBTI）、韩国文化/方言/习惯。排除：政治、社会负面新闻、八卦丑闻、体育。
全部用简体中文。只输出 JSON 数组，字符串里不要用英文双引号：[{"zh":"中文话题(≤12字)","ko":"韩文搜索词(2-4个词)","why":"一句话为什么小红书会喜欢"}]
标题：\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
  const o = JSON.parse(await agent(prompt, { model: "haiku" }));
  if (o.is_error) throw new Error(o.result || "Agent 调用失败");
  const t = o.result || "";
  const topics = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
  buzzCache = { at: Date.now(), titles, topics };
  return buzzCache;
}

const inflight = new Map();
function refreshCat(cat) {
  if (inflight.has(cat)) return inflight.get(cat);
  const p = buildCat(cat).finally(() => inflight.delete(cat));
  inflight.set(cat, p);
  return p;
}
async function discover(cat, { fresh = false } = {}) {
  if (!catOf(cat)) throw new Error("没有这个栏目");
  const hit = cache.get(cat);
  if (hit && !fresh) {
    if (Date.now() - hit.at > FRESH_MS) refreshCat(cat).catch(() => {});
    return hit.items;
  }
  return refreshCat(cat);
}
async function buildCat(cat) {
  const c = catOf(cat);
  let sources;
  if (c.kind === "hot") {
    const [artists, topics] = await Promise.all([melonHot().then((a) => a.slice(0, 8)).catch(() => []), (health.loggedIn === false ? Promise.resolve([]) : buzz().then((b) => b.topics).catch(() => []))]); // AI 没连上就只用音源榜，不干等
    sources = [
      // 艺人：标题或频道里必须出现艺人名，防止搜到无关视频
      ...artists.map((a) => ({ src: `date:${a.query}`, topic: a.name.replace(/\s*\(.*\)/, ""), must: [a.query, a.name.replace(/\s*\(.*\)/, "")] })),
      ...topics.map((t) => ({ src: `date:${t.ko}`, topic: t.zh })),
    ];
  } else sources = [...(c.q || []), ...(c.ch || [])].map((src) => ({ src }));
  const lists = await Promise.allSettled(sources.map(async (s) =>
    (await ytList(s.src, 12))
      .filter((v) => !s.must || s.must.some((n) => n && (v.title + " " + v.channel).toLowerCase().includes(n.toLowerCase())))
      .map((v) => (s.topic ? { ...v, topic: s.topic } : v))));
  const seen = new Set();
  const items = lists
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((v) => v.id && !seen.has(v.id) && seen.add(v.id))
    .filter((v) => v.duration == null || (v.duration >= 10 && v.duration <= 120))
    .filter(keep)
    .map((v) => ({ ...v, category: cat }))
    .sort((a, b) => b.views - a.views);
  const rich = (await enrich(items, 15)).slice(0, 36);
  if (rich.length) { cache.set(cat, { at: Date.now(), items: rich }); saveCache(); } // 空结果不缓存，下次重新抓
  else if (cache.has(cat)) return cache.get(cat).items;
  return rich;
}

// 贴链接直接做：不经过发现页，任何 yt-dlp 认识的链接都行
async function resolveLink(url) {
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("这不像一个视频链接");
  let j;
  try { j = JSON.parse(await run(YTDLP, ["-J", "--skip-download", "--no-playlist", url], { timeout: 60000 })); }
  catch (e) { throw new Error(/Unsupported URL/i.test(e.message) ? "这个网站的链接还不支持" : `读不到这个视频：${String(e.message).split("\n").find((l) => /ERROR/.test(l)) || "检查一下链接"}`.slice(0, 200)); }
  const yt = /youtube/i.test(j.extractor_key || "");
  return {
    id: j.id, url: j.webpage_url || url, title: j.title || "", channel: j.channel || j.uploader || "", views: j.view_count || 0, duration: j.duration ?? null,
    thumb: j.thumbnail || "", platform: yt ? "youtube" : String(j.extractor_key || "web").toLowerCase(), category: "link", vertical: (j.height || 0) > (j.width || 0),
  };
}

async function search(q) {
  const key = "q:" + q;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.items;
  const items = (await ytList(q.includes("shorts") ? q : q + " #shorts", 30))
    .filter((v) => v.duration == null || (v.duration >= 10 && v.duration <= 120))
    .filter(keep)
    .map((v) => ({ ...v, category: "search" }));
  const rich = await enrich(items, 12);
  cache.set(key, { at: Date.now(), items: rich });
  return rich;
}

// Agent 登录状态（制作和 AI 推荐都靠它）；自定义 API 不检查连通性，有 Key 就算已配置
let health = { loggedIn: null, at: 0 };
async function getHealth(force) {
  if (force) health.at = 0;
  const custom = currentApi();
  if (Date.now() - health.at > 60000) try {
    if (custom) health = { loggedIn: true, at: Date.now() };
    else if (auth.engine === "codex") {
      await run("codex", ["login", "status"], { shell: true, timeout: 30000, env: BASE_ENV });
      health = { loggedIn: true, at: Date.now() };
    } else {
      const out = await run("claude", ["auth", "status"], { shell: true, timeout: 30000, env: claudeEnv() });
      health = { loggedIn: !!JSON.parse(out).loggedIn, at: Date.now() };
    }
  } catch {
    health = { loggedIn: false, at: Date.now() };
  }
  const loginCmd = auth.engine === "codex" ? "codex login" : auth.routes.claude === "official" ? `$env:CLAUDE_CONFIG_DIR="${OFFICIAL_DIR}"; claude.cmd /login` : "claude.cmd /login";
  const routes = Object.fromEntries(Object.entries(BUILTIN_ROUTES).map(([e, list]) => [e, [...list, ...auth.apis.filter((a) => a.engine === e).map((a) => ({ id: a.id, label: a.name, custom: true }))]]));
  return { ...health, engine: auth.engine, route: auth.routes[auth.engine], routes, loginCmd };
}

// 本周热门爱豆/话题：已抓取候选里的 #标签，按播放量加权（去掉 #shorts 这类通用标签）
const GENERIC = /^#(shorts?|kpop|k-pop|광고|ad|fyp|viral|youtube|dance|challenge|챌린지)$/i;
function trending(limit = 20) {
  const heat = new Map();
  for (const [k, { items }] of cache) {
    if (k.startsWith("q:")) continue;
    for (const v of items) for (const t of new Set((v.title || "").match(/#[^\s#]+/g) || [])) if (!GENERIC.test(t)) heat.set(t, (heat.get(t) || 0) + v.views);
  }
  // 同一个人中英韩多种写法只留播放量最高的那个写法（按热度值去重）
  const seen = new Set();
  return [...heat].sort((a, b) => b[1] - a[1]).filter(([, v]) => !seen.has(v) && seen.add(v)).slice(0, limit).map(([tag, views]) => ({ tag, views }));
}

// ---------- Agent 无头调用（Claude Code / Codex）----------
// 去掉从宿主 Claude 会话继承来的鉴权/会话变量，让子进程用 CLI 自己的登录
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_AGENT_|CLAUDE_CONFIG_DIR$)/.test(k)));
// 线路：relay = ~/.claude/settings.json 里配的中转站；official = 独立配置目录里登录的官方账号（不动 ~/.claude）；
// default = ~/.codex/config.toml 的默认配置；其余是用户添加的 API（Key 只存在 jobs/auth.json，不返回给前端）
const OFFICIAL_DIR = "D:/Tools/claude-official";
const CLAUDE_API_DIR = "D:/Tools/claude-api"; // 空配置目录，避免 ~/.claude/settings.json 的中转站变量盖掉自定义 API
const AUTH_FILE = path.join(JOBS, "auth.json");
const BUILTIN_ROUTES = {
  claude: [{ id: "relay", label: "中转站" }, { id: "official", label: "官方账号" }],
  codex: [{ id: "default", label: "ChatGPT 账号" }],
};
const auth = (() => {
  let a = {};
  try { a = JSON.parse(readFileSync(AUTH_FILE, "utf8")); } catch {}
  return {
    engine: a.engine === "codex" ? "codex" : "claude",
    routes: { claude: a.routes?.claude || (a.mode === "official" ? "official" : "relay"), codex: a.routes?.codex || "default" },
    apis: Array.isArray(a.apis) ? a.apis : [],
  };
})();
const saveAuth = () => {
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
  health.at = 0; // 换线路后重新检查登录
};
const currentApi = () => auth.apis.find((a) => a.engine === auth.engine && a.id === auth.routes[auth.engine]);
const claudeEnv = () => {
  const custom = currentApi();
  if (auth.engine === "claude" && custom) return { ...BASE_ENV, CLAUDE_CONFIG_DIR: CLAUDE_API_DIR, ANTHROPIC_BASE_URL: custom.baseUrl, ANTHROPIC_AUTH_TOKEN: custom.apiKey };
  return auth.routes.claude === "official" ? { ...BASE_ENV, CLAUDE_CONFIG_DIR: OFFICIAL_DIR } : BASE_ENV;
};
function setRoute({ engine, route }) {
  if (engine) auth.engine = engine === "codex" ? "codex" : "claude";
  if (route) {
    const known = BUILTIN_ROUTES[auth.engine].some((r) => r.id === route) || auth.apis.some((a) => a.engine === auth.engine && a.id === route);
    if (!known) throw new Error("没有这条线路");
    auth.routes[auth.engine] = route;
  }
  mkdirSync(OFFICIAL_DIR, { recursive: true });
  saveAuth();
}
// base_url 和模型名会进命令行（shell: true），只放行安全字符；Key 走环境变量
function addApi({ engine, name, baseUrl, apiKey, model }) {
  const e = engine === "codex" ? "codex" : "claude";
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.\-:/_]+$/.test(url)) throw new Error("API 地址格式不对，要以 http:// 或 https:// 开头");
  if (!String(apiKey || "").trim()) throw new Error("请填写 API Key");
  const m = String(model || "").trim();
  if (m && !/^[\w.:\-/]+$/.test(m)) throw new Error("模型名只能包含字母、数字和 . : - / _");
  const id = `api-${Date.now()}`;
  auth.apis.push({ id, engine: e, name: String(name || "").trim().slice(0, 24) || new URL(url).hostname, baseUrl: url, apiKey: String(apiKey).trim(), model: m });
  auth.engine = e;
  auth.routes[e] = id;
  mkdirSync(CLAUDE_API_DIR, { recursive: true });
  saveAuth();
}
function removeApi(id) {
  auth.apis = auth.apis.filter((a) => a.id !== id);
  for (const e of Object.keys(auth.routes)) if (auth.routes[e] === id) auth.routes[e] = BUILTIN_ROUTES[e][0].id;
  saveAuth();
}
const runClaude = (prompt, { cwd = ROOT, onLine, model, web, effort, onSpawn } = {}) =>
  new Promise((res, rej) => {
    const args = ["-p", "--output-format", onLine || web ? "stream-json" : "json"];
    const pinned = currentApi()?.model;
    if (pinned || model) args.push("--model", pinned || model);
    if (effort) args.push("--effort", effort);
    if (onLine || web) args.push("--verbose"); // stream-json 必须带 verbose；json 模式带了会变成消息数组
    if (web) args.push("--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch", "WebFetch");
    else if (!onLine) args.push("--tools", '""'); // 选题、出词这类纯文字任务不给工具，否则它会去翻项目文件，又慢又答非所问
    if (onLine) args.push("--allowedTools", "Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "--add-dir", SKILL, NODE_MODULES);
    const p = spawn("claude", args, { cwd, shell: true, windowsHide: true, env: claudeEnv() });
    onSpawn?.(p);
    p.stdin.end(prompt); // 提示词走 stdin，避免 Windows 命令行转义问题
    let buf = "", all = "";
    p.stdout.on("data", (d) => {
      all += d;
      if (!onLine) return;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on("data", (d) => onLine?.(JSON.stringify({ type: "stderr", text: String(d) })));
    p.on("close", (code) => {
      if (code !== 0) return rej(new Error(`claude exit ${code}: ${all.slice(-500)}`));
      if (!web) return res(all);
      let final = {};
      for (const line of all.split("\n")) { try { const ev = JSON.parse(line); if (ev.type === "result") final = ev; } catch {} }
      res(JSON.stringify({ result: final.result || "", is_error: !!final.is_error, raw: all }));
    });
  });
// 返回值和 claude -p --output-format json 同形（result 字段是最后一条回复），调用方不用区分引擎
const runCodex = (prompt, { cwd = ROOT, onLine, web, onSpawn } = {}) =>
  new Promise((res, rej) => {
    const custom = currentApi();
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (custom) args.push("-c", "model_provider=kclip", "-c", "model_providers.kclip.name=kclip", "-c", `model_providers.kclip.base_url=${custom.baseUrl}`, "-c", "model_providers.kclip.env_key=KCLIP_API_KEY", "-c", "model_providers.kclip.wire_api=responses");
    if (custom?.model) args.push("-m", custom.model);
    if (onLine) args.push("-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "--add-dir", SKILL, "--add-dir", NODE_MODULES);
    else args.push("-s", "read-only", "--ephemeral", "-c", "model_reasoning_effort=low");
    if (web) args.push("-c", "web_search=live");
    args.push("-"); // 提示词走 stdin
    const p = spawn("codex", args, { cwd, shell: true, windowsHide: true, env: custom ? { ...BASE_ENV, KCLIP_API_KEY: custom.apiKey } : BASE_ENV });
    onSpawn?.(p);
    p.stdin.end(prompt);
    let buf = "", text = "", failure = "", errOut = "", raw = "";
    const onEvent = (line) => {
      raw += line + "\n";
      onLine?.(line);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text;
        if (ev.type === "turn.failed") failure = ev.error?.message || "Codex 调用失败";
        if (ev.type === "error") failure = ev.message || "Codex 调用失败";
      } catch {}
    };
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onEvent(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on("data", (d) => { errOut += d; onLine?.(JSON.stringify({ type: "stderr", text: String(d) })); });
    p.on("close", (code) => (code === 0 && !failure ? res(JSON.stringify({ result: text, is_error: false, ...(web ? { raw } : {}) })) : rej(new Error(`codex exit ${code}: ${(failure || errOut).slice(-500)}`))));
  });
const agent = (prompt, opts) => (auth.engine === "codex" ? runCodex(prompt, opts) : runClaude(prompt, opts));

async function recommend(cats) {
  const pool = (await Promise.all(cats.map((c) => discover(c).catch(() => [])))).flat();
  const list = pool.slice(0, 80).map((v) => ({ id: v.id, title: v.title, channel: v.channel, views: v.views, duration: v.duration, category: catOf(v.category)?.label, speech: v.meta?.speech, desc: v.meta?.desc }));
  const prompt = `你是小红书"韩语学习 + 韩娱"账号的选题编辑。目标观众是小红书上的：韩语学习者、韩国文化爱好者、K-pop 追星族、韩综爱好者（大多是 18–30 岁中国女生）。
下面是从 YouTube 抓到的、本月播放量高的韩国短视频候选（JSON）。挑出 8 条**放到小红书也会有很多人点赞收藏**的。

好选题的标准（按重要性）：
1. 中国观众**不需要韩国背景知识**也能看懂笑点或共鸣点（太"韩国人才懂"的梗、本土时事、冷门艺人要排除）
2. 小红书上已验证好卖的类型：名人访谈里的人生感悟（如 Rain 聊 JYP）、韩国命理/占卜大师锐评明星、街头采访、家人/老人/惊喜等温暖瞬间、生活共鸣（MBTI、职场、恋爱）、综艺爆笑名场面；或在中国知名度高的爱豆/演员/综艺（如 BTS、SEVENTEEN、Stray Kids、aespa、IVE、NewJeans、BLACKPINK、Running Man、地球娱乐室 等），或者情绪很强（爆笑、心动、感动、共鸣）
3. 和中国有关的内容（爱豆说中文、韩国人吃中国菜、谈中国）在小红书特别吃香
4. 有一两句好学、好用的韩语口语
5. 60 秒以内最好；播放量高说明最近火
硬性排除：纯舞蹈/纯音乐/MV/舞台直拍（没有台词就没法做字幕；speech 字段="ko" 表示有韩语台词，优先选）、体育（比赛、运动员、奥运等）、政治/时政、负面社会新闻、灾难事故、低俗擦边。

只输出 JSON 数组，不要其他文字；字符串里不要用英文双引号，引用请用「」。每项：{"id":原id,"zh_title":"中文小标题(≤14字，小红书风格)","summary":"一句话讲视频内容","why":"小红书用户为什么会喜欢（点出人群和情绪）","tags":["2-3个标签"],"cover_style":"band|poster|card|reels 之一","score":1-10}
`+`韩网正在热议（theqoo HOT）：${(await buzz().catch(() => ({ topics: [] }))).topics.map((t) => t.zh).join("、")}
韩国音源榜最火的艺人（Melon，仅供参考，不要只选音乐内容）：${(await melonHot().catch(() => [])).slice(0, 15).map((a) => a.name).join("、")}
候选：${JSON.stringify(list)}`;
  const ask = async (p) => {
    const o = JSON.parse(await agent(p));
    if (o.is_error) throw new Error(o.result?.includes("login") ? "Claude CLI 未登录：在终端运行 claude 然后输入 /login" : o.result || "Agent 调用失败");
    const t = o.result || "";
    return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
  };
  let arr;
  try { arr = await ask(prompt); }
  catch (e) { if (/未登录|Claude 调用失败/.test(e.message)) throw e; arr = await ask(prompt + `

（上次输出不是合法 JSON：${e.message}。这次务必输出合法 JSON。）`); }
  const byId = Object.fromEntries(pool.map((v) => [v.id, v]));
  const picks = arr.filter((r) => byId[r.id]).map((r) => ({ ...byId[r.id], ai: r }));
  writeFileSync(path.join(JOBS, "picks.json"), JSON.stringify({ at: Date.now(), cats, picks }));
  return picks;
}

// ---------- 制作队列 ----------
const jobs = []; // {id, url, title, coverStyle, status, steps, last, dir, outputs, error}
let busy = false;
let current = null; // { id, proc } 正在跑的那条，取消时连子进程树一起结束
const killTree = (proc) => {
  if (!proc?.pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { proc.kill("SIGTERM"); } catch {}
};
function cancelJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (j.status === "queued") jobs.splice(jobs.indexOf(j), 1);
  else if (j.status === "running") { j.cancelled = true; if (current?.id === id) killTree(current.proc); }
  saveJobs();
}
// 删除不是真删：文件夹挪到 jobs/_trash，后悔了还能找回来
function deleteJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status === "running" || j.status === "queued") throw new Error("先取消再删除");
  const dir = path.resolve(j.dir || "");
  if (dir.startsWith(path.resolve(JOBS) + path.sep) && existsSync(dir)) {
    const trash = path.join(JOBS, "_trash");
    mkdirSync(trash, { recursive: true });
    try { renameSync(dir, path.join(trash, `${path.basename(dir)}-${Date.now()}`)); } catch (e) { throw new Error(`文件夹正在被占用，关掉播放器再试：${e.code || e.message}`); }
  }
  jobs.splice(jobs.indexOf(j), 1);
  saveJobs();
}

function jobPrompt(j) {
  return `用 xhs-bilingual-clip skill（在 ${SKILL}，先读 SKILL.md）把这个视频做成小红书双语字幕视频：${j.url}
- 当前目录就是项目目录：把 ${SKILL}/template 的内容复制到这里，node_modules 用 junction 指向 ${NODE_MODULES}（PowerShell New-Item -ItemType Junction），字体从 C:\\Windows\\Fonts 复制 NotoSansSC-VF.ttf / NotoSansKR-VF.ttf 到 public/fonts。
- 视频标题参考：${j.title}${j.note ? `；用户备注：${j.note}` : ""}
- 封面样式：${j.coverStyle}（config.ts 的 COVER_STYLE：band 黑底大标题 / poster 大字报 / card 韩中对照卡 / reels Reels 款）；配色 PALETTE = "${/^[a-z]+$/.test(j.accent || "") ? j.accent : "yellow"}"（config.ts，字幕/标题/单词卡/封面都跟着变）。版式要守小红书安全区：顶部 150px、底部 y>1480、右侧 140px 不放字；一句字幕最多 2 行原文 + 1 行中文，超了就拆。封面底图挑人物清楚、没有烧录大字幕的一帧。
- 全自动，不要提问；听不清的句子删掉并记录。python 不可用，用 node。
- 最后必须产出：out/成片.mp4、out/封面_3比4.png、out/小红书文案.txt、out/剪映素材/（npm run pack），以及 out/summary.json：{"title":"中文标题","summary":"内容一句话","uncertain":["删掉或不确定的句子"],"cues":字幕条数}`;
}

async function pump() {
  if (busy) return;
  const j = jobs.find((x) => x.status === "queued");
  if (!j) return;
  busy = true;
  j.status = "running";
  j.startedAt = Date.now();
  mkdirSync(j.dir, { recursive: true });
  const log = path.join(j.dir, "log.jsonl");
  try {
    const track = (cmd, label) => {
      j.steps++;
      j.last = label;
      const st = [[/yt-dlp/, 0], [/whisper/, 1], [/cues.ts|config.ts/, 2], [/remotion render/, 3], [/Cover|封面/, 4], [/文案|summary.json/, 5]].find(([re]) => re.test(cmd));
      if (st && st[1] > (j.stage ?? -1)) j.stage = st[1];
    };
    await agent(jobPrompt(j), {
      cwd: j.dir,
      onSpawn: (proc) => { current = { id: j.id, proc }; },
      onLine: (line) => {
        appendFileSync(log, line + "\n");
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant") {
            for (const c of ev.message?.content || []) {
              if (c.type === "tool_use") track(JSON.stringify(c.input || {}), c.input?.description || c.name);
              if (c.type === "text" && c.text.trim()) j.last = c.text.trim().slice(0, 120);
            }
          }
          // Codex 的事件格式
          if (ev.type === "item.started" && ev.item?.type === "command_execution") track(ev.item.command || "", String(ev.item.command || "").slice(0, 120));
          if (ev.type === "item.completed" && ev.item?.type === "file_change") track(JSON.stringify(ev.item.changes || []), "修改文件");
          if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text?.trim()) j.last = ev.item.text.trim().slice(0, 120);
        } catch {}
      },
    });
    j.status = existsSync(path.join(j.dir, "out", "成片.mp4")) ? "done" : "failed";
    if (j.status === "failed") j.error = "没有生成 out/成片.mp4，看 log.jsonl";
  } catch (e) {
    j.status = "failed";
    j.error = String(e.message).slice(0, 300);
  }
  if (j.cancelled) { j.status = "failed"; j.error = "已取消"; delete j.cancelled; }
  current = null;
  j.finishedAt = Date.now();
  saveJobs();
  busy = false;
  pump();
}

const JOBS_FILE = path.join(JOBS, "jobs.json");
const saveJobs = () => writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
if (existsSync(JOBS_FILE)) for (const j of JSON.parse(readFileSync(JOBS_FILE, "utf8"))) jobs.push(j.status === "running" ? { ...j, status: "failed", error: "服务重启中断" } : j);

const outputsOf = (j) => {
  const out = path.join(j.dir, "out");
  if (!existsSync(out)) return {};
  const rel = (f) => `/files/${path.basename(j.dir)}/out/${f}`;
  const has = (f) => existsSync(path.join(out, f));
  let summary = null, caption = null;
  try { summary = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8")); } catch {}
  try { caption = readFileSync(path.join(out, "小红书文案.txt"), "utf8"); } catch {}
  return {
    video: has("成片.mp4") ? rel("成片.mp4") : null,
    cover: has("封面.jpg") ? rel("封面.jpg") : has("封面_3比4.png") ? rel("封面_3比4.png") : null, // 模板视频是 9:16 的封面.jpg
    caption,
    summary,
    folder: out,
  };
};

// ---------- 封面校验 ----------
// YouTube 的竖版封面经常不存在，不存在时返回 404 和一张灰色占位图，图片标签照样显示。
// 所以发给前端前逐级确认哪张真实存在；一张都没有的视频不展示。
const THUMBS_FILE = path.join(JOBS, "thumbs.json");
const thumbMemo = (() => { try { return JSON.parse(readFileSync(THUMBS_FILE, "utf8")); } catch { return {}; } })();
const THUMB_SIZES = ["oar2", "hq720", "sddefault", "hqdefault", "mqdefault"];
async function thumbExists(url) {
  const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
  return r.status === 200;
}
async function resolveThumb(v) {
  if (v.id in thumbMemo) return thumbMemo[v.id];
  const given = v.thumb && !/\/(oardefault|oar2|hq720|sddefault|hqdefault|mqdefault)\.jpg/.test(v.thumb) ? [v.thumb] : [];
  let networkError = false;
  for (const url of [...given, ...THUMB_SIZES.map((n) => `https://i.ytimg.com/vi/${v.id}/${n}.jpg`)]) {
    try { if (await thumbExists(url)) return (thumbMemo[v.id] = url); }
    catch { networkError = true; }
  }
  if (networkError) return undefined; // 网络问题，不下结论，这次先不展示，下次再查
  return (thumbMemo[v.id] = null);
}
async function withRealThumbs(items) {
  const list = (items || []).filter((v) => v?.id);
  const queue = [...list];
  const out = new Map();
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let v = queue.shift(); v; v = queue.shift()) out.set(v.id, await resolveThumb(v));
  }));
  writeFileSync(THUMBS_FILE, JSON.stringify(thumbMemo));
  return list.filter((v) => out.get(v.id)).map((v) => ({ ...v, thumb: out.get(v.id) }));
}

// ---------- HTTP ----------
const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

const serveFile = (res, file, req) => {
  if (!existsSync(file) || statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
  const size = statSync(file).size;
  const type = MIME[path.extname(file)] || "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "cache-control": "no-cache", "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "cache-control": "no-cache", "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  createReadStream(file).pipe(res);
};

const tplApi = createTplApi({ JOBS, agent, jobs, saveJobs, send, body, serveFile });
const packApi = createPackApi({ jobs, outputsOf, send, body });

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      // 改数据的请求只接受工作台自己的页面：别的网站不能借浏览器指挥本机的 Agent
      if (req.method !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: "来源不对" });
      if (await tplApi(req, res, u)) return;
      if (await packApi(req, res, u)) return;
      if (u.pathname === "/api/categories" && req.method === "GET") return send(res, 200, publicCats());
      if (u.pathname === "/api/categories" && req.method === "POST") { const c = addCategory(await body(req)); return send(res, 200, { id: c.id, categories: publicCats() }); }
      if (u.pathname === "/api/categories/delete" && req.method === "POST") { removeCategory((await body(req)).id); return send(res, 200, { categories: publicCats() }); }
      if (u.pathname === "/api/categories/reset" && req.method === "POST") { categories = structuredClone(DEFAULT_CATEGORIES); saveCats(); return send(res, 200, { categories: publicCats() }); }
      if (u.pathname === "/api/resolve") return send(res, 200, await resolveLink(u.searchParams.get("url") || ""));
      if (u.pathname === "/api/jobs/cancel" && req.method === "POST") { cancelJob((await body(req)).id); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/jobs/delete" && req.method === "POST") { deleteJob((await body(req)).id); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/open" && req.method === "POST") {
        const { id } = await body(req);
        const j = jobs.find((x) => x.id === id);
        const out = j && path.join(j.dir, "out");
        if (!out || !existsSync(out)) throw new Error("找不到这条作品的文件夹");
        const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [out.replace(/\//g, "\\")]] : process.platform === "darwin" ? ["open", [out]] : ["xdg-open", [out]];
        execFile(cmd, args, () => {}); // explorer 正常打开也会返回非 0，不看结果
        return send(res, 200, { ok: true, folder: out });
      }
      if (u.pathname === "/api/health") return send(res, 200, await getHealth(u.searchParams.has("fresh")));
      if (u.pathname === "/api/auth-mode" && req.method === "POST") { setRoute(await body(req)); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/apis" && req.method === "POST") { addApi(await body(req)); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/apis/delete" && req.method === "POST") { removeApi((await body(req)).id); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/search") return send(res, 200, await withRealThumbs(await search(u.searchParams.get("q") || "")));
      if (u.pathname === "/api/picks") { try { const saved = JSON.parse(readFileSync(path.join(JOBS, "picks.json"), "utf8")); return send(res, 200, { ...saved, picks: await withRealThumbs(saved.picks) }); } catch { return send(res, 200, { picks: [] }); } }
      if (u.pathname === "/api/retry" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j && j.status === "failed") { Object.assign(j, { status: "queued", error: undefined, steps: 0, stage: -1, last: "排队中" }); saveJobs(); pump(); } return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/checked" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j) { j.checked = true; saveJobs(); } return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/buzz") return send(res, 200, (await buzz()).topics);
      if (u.pathname === "/api/trending") return send(res, 200, (await melonHot()).slice(0, 16).map((a) => ({ tag: a.name, query: a.query, views: a.score, best: a.best, songs: a.songs })));
      if (u.pathname === "/api/discover") return send(res, 200, await withRealThumbs(await discover(u.searchParams.get("cat"), { fresh: u.searchParams.has("fresh") })));
      if (u.pathname === "/api/recommend") return send(res, 200, await withRealThumbs(await recommend((u.searchParams.get("cats") || "").split(",").filter(catOf).length ? u.searchParams.get("cats").split(",").filter(catOf) : categories.map((c) => c.id))));
      if (u.pathname === "/api/jobs" && req.method === "GET") return send(res, 200, jobs.map((j) => ({ ...j, outputs: outputsOf(j) })));
      if (u.pathname === "/api/jobs" && req.method === "POST") {
        const items = (await body(req)).items || [];
        for (const it of items) {
          const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${String(it.id).replace(/[^\w-]/g, "").slice(0, 40)}`;
          // 同一条视频正在排队或制作时不重复加；做完的可以再做一版（again）
          if (jobs.some((j) => j.vid === it.id && (j.status === "queued" || j.status === "running" || (j.status === "done" && !it.again)))) continue;
          jobs.push({ id, vid: it.id, url: it.url, title: it.title, note: it.note || "", coverStyle: it.coverStyle || "band", accent: it.accent || "", status: "queued", steps: 0, stage: -1, last: "排队中", createdAt: Date.now(), dir: path.join(JOBS, id) });
        }
        saveJobs();
        pump();
        return send(res, 200, { ok: true });
      }
      if (u.pathname.startsWith("/files/")) {
        const file = path.resolve(JOBS, decodeURIComponent(u.pathname.slice(7)));
        // 只提供 jobs 里的素材，不能跳出目录，也不能读存 Key 的 auth.json
        if (!file.startsWith(path.resolve(JOBS) + path.sep) || file === path.resolve(AUTH_FILE)) return send(res, 404, { error: "not found" });
        return serveFile(res, file, req);
      }
      // 前端（build 后）
      const dist = path.join(ROOT, "dist");
      const f = path.join(dist, u.pathname === "/" ? "index.html" : u.pathname);
      return serveFile(res, existsSync(f) ? f : path.join(dist, "index.html"), req);
    } catch (e) {
      send(res, 500, { error: String(e.message).slice(0, 500) });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`KCLIP Studio API → http://localhost:${PORT}`);
    pump(); // 上次服务器关闭时还在排队的任务，接着做
  });
