// KCLIP Studio 后端：发现韩国短视频 → AI 推荐 → 排队制作（调用本机 Claude Code 或 Codex + xhs-bilingual-clip skill）
// 运行：node server.mjs   （端口 5291；前端 dev 在 5290，build 后由本服务直接托管 dist/）
import { spawn, execFile } from "node:child_process";
import { createReadStream, readdirSync, rmSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import http from "node:http";
import { pipeline } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createTplApi } from "./tpl.mjs";
import { createPackApi } from "./pack.mjs";
import { createConfig, toolLines } from "./config.mjs";

const PORT = Number(process.env.PORT) || 5291;
// 只监听本机：这个服务能让 Agent 在电脑上跑命令，不能暴露给局域网。确实要给别的设备用，自己设 HOST=0.0.0.0
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const JOBS = path.join(ROOT, "jobs");
mkdirSync(JOBS, { recursive: true });
// 工具路径都从 config 取（自动检测 + 页面「环境」里可改），不写死哪台电脑的位置
const cfg = createConfig({ ROOT, JOBS });
const needYtdlp = () => { if (!cfg.ytdlp) throw new Error("没找到 yt-dlp：点左下角「环境」按提示安装"); return cfg.ytdlp; };

// ---------- 栏目 → 搜索词 / 频道 ----------
// 栏目是数据不是代码：默认 6 个内容栏目（按"这条视频是什么内容"分，不按来源分），用户可以在页面上增删，存在 jobs/categories.json。
// 频道由 scripts/scout-channels.mjs 按"最新 12 条 Shorts 播放量中位数"筛出来，过一段时间重跑一次更新。
// ch：官方频道 Shorts 页（最新在前）；q：搜索词；kind:"hot" 的搜索词来自 Melon 实时榜 + theqoo 热帖
const DEFAULT_CATEGORIES = [
  { id: "hot", label: "今日热点", kind: "hot" },
  { id: "issue", label: "韩网话题", q: ["연예인 썰 shorts", "연예계 이슈 shorts", "연예인 레전드 썰 shorts", "연예인 미담 shorts", "방송 레전드 발언 shorts", "예능 비하인드 썰 shorts"] },
  { id: "variety", label: "综艺名场面", ch: ["https://www.youtube.com/@ddeunddeun/shorts", "https://www.youtube.com/@SBSRunningMan/shorts", "https://www.youtube.com/@JTBCVoyage/shorts", "https://www.youtube.com/@workman/shorts", "https://www.youtube.com/@WassupMan/shorts", "https://www.youtube.com/@mmtg_official/shorts", "https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@mbicnews/shorts"], q: ["예능 레전드 shorts", "예능 웃긴 장면 shorts", "유재석 웃긴 shorts", "런닝맨 레전드 shorts"] },
  // 不放爱豆官方频道：官方 Shorts 几乎全是舞蹈和挑战，没有台词做不了字幕
  { id: "idol", label: "爱豆有梗", q: ["아이돌 예능 웃긴 shorts", "아이돌 인터뷰 웃긴 shorts", "아이돌 자컨 레전드 shorts", "아이돌 라디오 썰 shorts", "아이돌 팬사인회 웃긴 shorts", "아이돌 말실수 shorts"] },
  { id: "talk", label: "访谈金句", ch: ["https://www.youtube.com/@ddeunddeun/shorts"], q: ["인생 조언 연예인 인터뷰 shorts", "유퀴즈 감동 명언 shorts", "짠한형 shorts", "살롱드립 shorts", "사주 연예인 shorts", "역술가 연예인 사주 풀이 shorts"] },
  { id: "life", label: "生活共鸣", ch: ["https://www.youtube.com/@shortbox/shorts", "https://www.youtube.com/@nerdult/shorts"], q: ["길거리 인터뷰 shorts", "시민 인터뷰 웃긴 shorts", "감동 실화 shorts", "할머니 할아버지 감동 shorts", "가족 웃긴 순간 shorts", "연애 공감 shorts", "직장인 공감 shorts"] },
  { id: "drama", label: "热播韩剧", ch: ["https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@netflixkcontent/shorts", "https://www.youtube.com/@NetflixKorea/shorts", "https://www.youtube.com/@jtbcdrama/shorts"], q: ["드라마 명장면 shorts", "드라마 명대사 shorts"] },
];
const CATS_VERSION = 2; // 默认栏目改了就加一：没动过栏目的人自动换成新的默认
const CATS_FILE = path.join(JOBS, "categories.json");
let categories = (() => { try { const c = JSON.parse(readFileSync(CATS_FILE, "utf8")); if (c.v === CATS_VERSION && Array.isArray(c.list) && c.list.length) return c.list; if (Array.isArray(c.list)) return [...structuredClone(DEFAULT_CATEGORIES), ...c.list.filter((x) => x.custom)]; } catch {} return structuredClone(DEFAULT_CATEGORIES); })();
const catOf = (id) => categories.find((c) => c.id === id);
const saveCats = () => writeFileSync(CATS_FILE, JSON.stringify({ v: CATS_VERSION, list: categories }, null, 1));
const publicCats = () => categories.map((c) => ({ id: c.id, label: c.label, kind: c.kind, custom: !!c.custom, sources: [...(c.q || []), ...(c.ch || [])], found: (scouted[c.id]?.channels || []).map((x) => x.name), scouting: scouting.has(c.id) || queued.has(c.id) }));
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
  delete scouted[id];
  saveCats();
}

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))),
  );

const ytList = async (src, n) => {
  const url = src.startsWith("http") ? src : src.startsWith("date:") ? `https://www.youtube.com/results?search_query=${encodeURIComponent(src.slice(5))}&sp=CAISBBABGAE%3D` : `ytsearch${n}:${src}`;
  // 注意不要加 youtube:lang=ko：韩文界面的"조회수 1.7만회"yt-dlp 解析不了，播放量会变成 0
  const out = await run(needYtdlp(), ["--flat-playlist", "-J", "--playlist-items", `1-${n}`, url]);
  const pl = JSON.parse(out);
  return (pl.entries || []).map((e) => ({
    id: e.id,
    url: e.url?.startsWith("http") ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    title: e.title,
    channel: e.channel || e.uploader || pl.channel || pl.uploader || "",
    handle: e.uploader_id || pl.uploader_id || "",
    views: e.view_count || 0,
    duration: e.duration || null,
    // Shorts 用竖版封面：优先取 yt-dlp 给的竖图（高 > 宽），没有就用 oardefault（Shorts 竖版预览）
    thumb: (e.thumbnails || []).filter((t) => t.height > t.width).sort((a, b) => b.height - a.height)[0]?.url || `https://i.ytimg.com/vi/${e.id}/oardefault.jpg`,
    platform: "youtube",
  }));
};

// 不做体育、政治：标题命中这些词就过滤
const BLOCK = /올림픽|금메달|은메달|동메달|선수|경기|축구|야구|농구|배구|골프|펜싱|양궁|KBO|K리그|월드컵|국가대표|대통령|국회|정치|선거|여당|야당|탄핵|정부|장관|의원|北|군사|전쟁|대선|토론|이재명|이준석|윤석열|국민의힘|민주당|검찰|재판|구속|성추행|성폭행|살인|사망|사고|뉴스|속보/;
// 新闻台的短视频基本是时政和社会新闻，整个频道不要
const NEWS = /뉴스|news|YTN|연합|MBN|채널A|TV조선|KNN|시사/i;
const keep = (v) => !BLOCK.test(v.title || "") && !NEWS.test(v.channel || "");

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
const DANCE = /챌린지|challenge|dance|댄스|안무|직캠|fancam|M\/V|\bMV\b|teaser|티저|trailer|performance|퍼포먼스|OUT NOW|코레오|choreo|#fyp|#추천|cover|커버|무대|stage|엠카|인기가요|음악중심|뮤직뱅크|음방|live clip|라이브 클립|응원법|컨셉|concept|highlight medley|발매|컴백|comeback|릴스|reels|ASMR|vlog|브이로그/i;
// 标题去掉 #标签 和表情后几乎不剩字的，多半是舞蹈、自拍这类"看脸不看话"的视频
const titleOk = (t = "") => !DANCE.test(t) && t.replace(/#[^\s#]+/g, "").replace(/[^\p{L}\p{N}]/gu, "").length >= 4;
const fetchMeta = (v) =>
  meta.has(v.id)
    ? Promise.resolve(meta.get(v.id))
    : Date.now() < ytCooldownUntil
    ? Promise.resolve(null)
    : run(needYtdlp(), ["-J", "--skip-download", "--no-playlist", v.url], { timeout: 60000 })
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

// 有台词才要：舞蹈、MV、挑战、只有标签的标题一律不要；查过详情的必须识别出韩语台词；没查到详情的排在后面
async function enrich(items, limit = 24) {
  const top = items.filter((v) => titleOk(v.title)).slice(0, Math.max(limit, 40));
  const look = top.slice(0, limit);
  for (let i = 0; i < look.length; i += 3) await Promise.all(look.slice(i, i + 3).map(fetchMeta));
  saveMeta();
  return top
    .map((v) => ({ ...v, ...(meta.get(v.id) ? { meta: meta.get(v.id), duration: meta.get(v.id).duration } : {}) }))
    .filter((v) => !v.meta || v.meta.speech === "ko")
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

// ---------- 频道侦察：自己去找"专门做有台词短视频"的频道（剪辑号、营销号、综艺切片） ----------
// 做法：拿栏目的搜索词去搜短视频 → 统计结果里反复出现的频道 → 看每个频道最新 12 条 Shorts：
// 播放量中位数够高、标题不是舞蹈类、抽查两条确实有韩语台词，才收进来。结果存 jobs/channels.json，7 天重找一次。
const SCOUT_FILE = path.join(JOBS, "channels.json");
const scouted = (() => { try { return JSON.parse(readFileSync(SCOUT_FILE, "utf8")); } catch { return {}; } })();
const scouting = new Set();
const SCOUT_MS = 7 * 24 * 3600 * 1000;
const shortUrl = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgQQARgB`; // sp = 类型:视频 + 4 分钟以内。不带「类型:视频」时结果页大半是 Shorts 货架，yt-dlp 只能读到一两条
const shortSearch = (q, n) => ytList(shortUrl(q), n);
async function scoutCat(cat) {
  const c = catOf(cat);
  const seeds = c?.q || [];
  if (!c || c.kind === "hot" || !seeds.length || scouting.has(cat) || Date.now() < ytCooldownUntil || !cfg.ytdlp) return;
  scouting.add(cat);
  try {
    const known = new Set((c.ch || []).map((u) => (u.match(/@[^/]+/) || [""])[0].toLowerCase()));
    const tally = new Map();
    for (const q of seeds.slice(0, 6)) {
      for (const v of await shortSearch(q, 25).catch(() => [])) {
        if (!v.handle?.startsWith("@") || known.has(v.handle.toLowerCase()) || (v.duration && v.duration > 120) || !titleOk(v.title) || !keep(v)) continue;
        const t = tally.get(v.handle) || { handle: v.handle, name: v.channel, hits: 0 };
        t.hits++;
        tally.set(v.handle, t);
      }
    }
    // 只在一个搜索结果里出现一次的多半是碰巧，至少出现两次才算「专门做这类内容」；不够 4 个时再放宽
    const all = [...tally.values()].sort((a, b) => b.hits - a.hits);
    const twice = all.filter((x) => x.hits >= 2);
    const cands = (twice.length >= 4 ? twice : all).slice(0, 14);
    if (!cands.length) return; // 搜索没拿到东西（断网、被拦）：不记结果，下次再找
    const out = [];
    for (let i = 0; i < cands.length; i += 3) await Promise.all(cands.slice(i, i + 3).map(async (ch) => {
      const url = `https://www.youtube.com/${ch.handle}/shorts`;
      const vids = await ytList(url, 12).catch(() => []);
      if (vids.length < 6) return; // 不怎么发 Shorts
      const views = vids.map((v) => v.views).sort((a, b) => a - b);
      const median = views[views.length >> 1];
      const good = vids.filter((v) => titleOk(v.title) && keep(v));
      if (median < 20000 || good.length / vids.length < 0.75) return;
      const metas = (await Promise.all(good.sort((a, b) => b.views - a.views).slice(0, 2).map(fetchMeta))).filter(Boolean);
      if (metas.length && !metas.some((m) => m.speech === "ko")) return; // 抽查没有韩语台词
      out.push({ url, name: ch.name || ch.handle, handle: ch.handle, median, hits: ch.hits, verified: metas.some((m) => m.speech === "ko") });
    }));
    saveMeta();
    out.sort((a, b) => b.verified - a.verified || b.hits * Math.log10(b.median + 10) - a.hits * Math.log10(a.median + 10));
    scouted[cat] = { at: Date.now(), channels: out.slice(0, 8) };
    writeFileSync(SCOUT_FILE, JSON.stringify(scouted, null, 1));
    console.log(`频道侦察「${c.label}」：候选 ${cands.length} 个，收下 ${scouted[cat].channels.map((x) => x.name).join("、") || "0 个"}`);
    if (scouted[cat].channels.length) await refreshCat(cat).catch(() => {});
  } finally {
    scouting.delete(cat);
  }
}

// 一次只找一个栏目，免得同时发太多请求被 YouTube 拦
let scoutChain = Promise.resolve();
const queued = new Set();
function queueScout(cat) {
  if (queued.has(cat)) return;
  queued.add(cat);
  scoutChain = scoutChain.then(() => scoutCat(cat)).catch((e) => console.warn("频道侦察失败", e.message)).finally(() => queued.delete(cat));
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
  needYtdlp();
  if (!scouted[cat] || Date.now() - scouted[cat].at > SCOUT_MS) queueScout(cat);
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
      ...artists.map((a) => ({ src: `date:${a.query} 예능`, topic: a.name.replace(/\s*\(.*\)/, ""), must: [a.query, a.name.replace(/\s*\(.*\)/, "")] })),
      ...topics.map((t) => ({ src: `date:${t.ko}`, topic: t.zh })),
    ];
  } else sources = [...(c.q || []).map(shortUrl), ...(c.ch || []), ...(scouted[cat]?.channels || []).map((x) => x.url)].map((src) => ({ src, n: src.includes("search_query=") ? 20 : 12 }));
  const lists = await Promise.allSettled(sources.map(async (s) =>
    (await ytList(s.src, s.n || 12))
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
  const rich = (await enrich(items, 24)).slice(0, 40);
  if (rich.length) { cache.set(cat, { at: Date.now(), items: rich }); saveCache(); } // 空结果不缓存，下次重新抓
  else if (cache.has(cat)) return cache.get(cat).items;
  return rich;
}

// 贴链接直接做：不经过发现页，任何 yt-dlp 认识的链接都行
async function resolveLink(url) {
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("这不像一个视频链接");
  let j;
  try { j = JSON.parse(await run(needYtdlp(), ["-J", "--skip-download", "--no-playlist", url], { timeout: 60000 })); }
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
// 检查某条内置线路有没有登录（不动当前设置）
async function routeLoggedIn(engine, route) {
  try {
    if (engine === "codex") { await run("codex", ["login", "status"], { shell: true, timeout: 30000, env: BASE_ENV }); return true; }
    const env = route === "official" ? { ...BASE_ENV, CLAUDE_CONFIG_DIR: OFFICIAL_DIR } : BASE_ENV;
    return !!JSON.parse(await run("claude", ["auth", "status"], { shell: true, timeout: 30000, env })).loggedIn;
  } catch (e) {
    try { return !!JSON.parse(String(e.message).slice(String(e.message).indexOf("{"))).loggedIn; } catch { return false; }
  }
}
async function getHealth(force) {
  if (force) health.at = 0;
  const custom = currentApi();
  if (Date.now() - health.at > 60000) {
    let switched = null;
    let ok = custom ? true : await routeLoggedIn(auth.engine, auth.routes[auth.engine]);
    // 当前线路没登录、也不在登录中：自动找一条已经登录的线路换过去
    if (!ok && !loginProc && !userPicked) {
      const order = [["claude", "official"], ["claude", "relay"], ["codex", "default"]].filter(([e, r]) => !(e === auth.engine && r === auth.routes[e]));
      for (const [e, r] of order) {
        if (await routeLoggedIn(e, r)) {
          auth.engine = e; auth.routes[e] = r;
          writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
          switched = `${e === "codex" ? "Codex" : "Claude Code"} · ${BUILTIN_ROUTES[e].find((x) => x.id === r).label}`;
          ok = true;
          break;
        }
      }
    }
    health = { loggedIn: ok, at: Date.now(), switched };
  }
  const loginCmd = auth.engine === "codex" ? "codex login" : auth.routes.claude === "official" ? `$env:CLAUDE_CONFIG_DIR="${OFFICIAL_DIR}"; claude.cmd /login` : "claude.cmd /login";
  const routes = Object.fromEntries(Object.entries(BUILTIN_ROUTES).map(([e, list]) => [e, [...list, ...auth.apis.filter((a) => a.engine === e).map((a) => ({ id: a.id, label: a.name, custom: true }))]]));
  const out = { ...health, engine: auth.engine, route: auth.routes[auth.engine], routes, loginCmd, loggingIn: !!loginProc, canLogin: !custom };
  health.switched = null; // 自动切换只提示一次
  return out;
}

// 一键登录：服务端自己跑登录命令，CLI 会打开浏览器授权页，用户点「授权」即可，不用开终端
let loginProc = null;
let userPicked = false; // 用户这次手动选过线路，就别再自动换走
function startLogin() {
  if (currentApi()) throw new Error("自定义 API 不需要登录，填好 Key 就能用");
  if (loginProc) return;
  const codex = auth.engine === "codex";
  if (!codex) mkdirSync(OFFICIAL_DIR, { recursive: true });
  const p = codex
    ? spawn("codex", ["login"], { shell: true, windowsHide: true, env: BASE_ENV })
    : spawn("claude", ["auth", "login", "--claudeai"], { shell: true, windowsHide: true, env: claudeEnv() });
  loginProc = p;
  let log = "";
  const keep = (d) => { log = (log + d).slice(-4000); };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  const done = () => { if (loginProc === p) loginProc = null; health.at = 0; };
  p.on("exit", (code) => { if (code) console.log("[login] exit", code, log.slice(-500)); done(); });
  p.on("error", done);
  setTimeout(() => { if (loginProc === p) { p.kill(); done(); } }, 5 * 60000); // 5 分钟没授权就放弃
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
const OFFICIAL_DIR = cfg.claudeOfficialDir;
const CLAUDE_API_DIR = cfg.claudeApiDir; // 空配置目录，避免 ~/.claude/settings.json 的中转站变量盖掉自定义 API
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
// 临时文件一律放 D 盘（作品文件夹 work/tmp，或 jobs/_tmp），不往 C 盘系统 Temp 写；作品做完就删
const withTmp = (env, dir) => { const t = path.join(dir, "work", "tmp"); mkdirSync(t, { recursive: true }); return { ...env, TEMP: t, TMP: t, TMPDIR: t }; };
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
  userPicked = true;
  mkdirSync(OFFICIAL_DIR, { recursive: true });
  saveAuth();
}
// base_url 和模型名会进命令行（shell: true），只放行安全字符；Key 走环境变量
async function addApi({ engine, name, baseUrl, apiKey, model }) {
  const e = engine === "codex" ? "codex" : "claude";
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9.\-:/_]+$/.test(url)) throw new Error("API 地址格式不对，要以 http:// 或 https:// 开头");
  if (!String(apiKey || "").trim()) throw new Error("请填写 API Key");
  const m = String(model || "").trim();
  if (m && !/^[\w.:\-/]+$/.test(m)) throw new Error("模型名只能包含字母、数字和 . : - / _");
  // 先连一下地址：连不上当场告诉用户，不保存一条用不了的线路（任何 HTTP 回应都算连得上，401/404 也行）
  try { await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) }); }
  catch { throw new Error("这个 API 地址连不上：检查地址有没有填错、网络是否正常"); }
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
    if (onLine) args.push("--allowedTools", "Bash", "PowerShell", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "--add-dir", cfg.skill, cfg.skillModules);
    const p = spawn("claude", args, { cwd, shell: true, windowsHide: true, env: withTmp(claudeEnv(), onLine ? cwd : path.join(JOBS, "_tmp")) });
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
const runCodex = (prompt, { cwd = ROOT, onLine, web, effort, onSpawn } = {}) =>
  new Promise((res, rej) => {
    const custom = currentApi();
    const args = ["exec", "--json", "--skip-git-repo-check"];
    if (onLine && effort) args.push("-c", `model_reasoning_effort=${effort === "low" ? "low" : "medium"}`);
    if (custom) args.push("-c", "model_provider=kclip", "-c", "model_providers.kclip.name=kclip", "-c", `model_providers.kclip.base_url=${custom.baseUrl}`, "-c", "model_providers.kclip.env_key=KCLIP_API_KEY", "-c", "model_providers.kclip.wire_api=responses");
    if (custom?.model) args.push("-m", custom.model);
    // 始终套沙箱：做视频只能写作品自己的文件夹（cwd），纯文字任务只读。
    // Windows 上不指定沙箱实现时 workspace-write 会退化成只读（写文件报 blocked by policy），unelevated 才可写。
    // 沙箱里 node 起不了子进程，渲染等固定命令由服务代跑（见 HELPERS）；联网只为访问本机工作台和查资料
    if (process.platform === "win32") args.push("-c", "windows.sandbox=unelevated");
    if (onLine) args.push("-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true");
    else args.push("-s", "read-only", "-c", "model_reasoning_effort=low");
    args.push("--ephemeral"); // 不在 C:\Users\…\.codex\sessions 留对话记录
    if (web) args.push("-c", "web_search=live");
    args.push("-"); // 提示词走 stdin
    const p = spawn("codex", args, { cwd, shell: true, windowsHide: true, env: withTmp(custom ? { ...BASE_ENV, KCLIP_API_KEY: custom.apiKey } : BASE_ENV, onLine ? cwd : path.join(JOBS, "_tmp")) });
    onSpawn?.(p);
    p.stdin.end(prompt);
    let buf = "", text = "", failure = "", lastError = "", completed = false, errOut = "", raw = "";
    const onEvent = (line) => {
      raw += line + "\n";
      onLine?.(line);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text;
        // 网络抖动时 Codex 会发 error 事件「Reconnecting... n/5」然后自己重连，不算失败；只有整轮失败才算
        if (ev.type === "turn.failed") failure = ev.error?.message || "Codex 调用失败";
        if (ev.type === "error" && !/Reconnecting/i.test(ev.message || "")) lastError = ev.message || "Codex 调用失败";
        if (ev.type === "turn.completed") completed = true;
      } catch {}
    };
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onEvent(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    p.stderr.on("data", (d) => { errOut += d; onLine?.(JSON.stringify({ type: "stderr", text: String(d) })); });
    p.on("close", (code) => {
      if (!completed && !failure) failure = lastError;
      if (code === 0 && !failure) res(JSON.stringify({ result: text, is_error: false, ...(web ? { raw } : {}) }));
      else rej(new Error(`codex exit ${code}: ${(failure || errOut).slice(-500)}`));
    });
  });
// 出错时给人话：线路名 + 原因 + 下一步，不把 CLI 的原始日志甩给用户
const routeName = () => {
  const custom = currentApi();
  if (custom) return `「${custom.label || custom.name || "自定义 API"}」`;
  return auth.engine === "codex" ? "Codex" : auth.routes.claude === "relay" ? "Claude 中转站" : "Claude 官方账号";
};
function friendlyError(raw) {
  const s = String(raw || "");
  const r = routeName();
  if (/insufficient.{0,10}balance|余额不足|billing_error|\b402\b|credit balance/i.test(s)) return `${r}余额不足：充值后再试，或在左下角换一条线路`;
  if (/\b401\b|invalid.{0,12}(api.?key|token|x-api-key)|authentication_error|Failed to authenticate|not logged in|Please run \/login|未登录/i.test(s)) return `${r}登录失效或 Key 不对：点顶部「一键登录」，或在左下角「…」里改 Key`;
  if (/\b429\b|rate.?limit|usage.?limit|quota|limit reached|额度/i.test(s)) return `${r}额度用完或请求太频繁：稍后再试，或换一条线路`;
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|fetch failed|stream disconnected|network error|unable to connect/i.test(s)) return `连不上${r}的服务器：检查网络，或 API 地址是否填对`;
  if (/overloaded|\b529\b|\b50[0-4]\b|server error/i.test(s)) return `${r}服务器繁忙：稍后再试`;
  if (/not recognized|ENOENT|command not found|不是内部或外部命令/i.test(s)) return `没找到${auth.engine === "codex" ? "Codex" : "Claude Code"} 命令行：点左下角「环境」按提示安装`;
  const m = s.match(/"result":"((?:[^"\\]|\\.)*)"/);
  return (m ? m[1].replace(/\\n/g, " ") : s.replace(/^(claude|codex) exit -?\d+:\s*/, "")).slice(0, 160) || "AI 调用失败";
}
const agent = async (prompt, opts = {}) => {
  // 文字类任务（选题、检查、对话）最多等 2 分钟（联网查资料 4 分钟）：CLI 连不上时会自己反复重试好几分钟，不能让用户干等
  let proc = null, timedOut = false, timer = null;
  const o2 = { ...opts, onSpawn: (p) => { proc = p; opts.onSpawn?.(p); } };
  if (!opts.onLine) timer = setTimeout(() => { timedOut = true; killTree(proc); }, opts.web ? 240000 : 120000);
  let out;
  try { out = await (auth.engine === "codex" ? runCodex(prompt, o2) : runClaude(prompt, o2)); }
  catch (e) { throw new Error(timedOut ? `${routeName()}太久没回应：可能是网络或这条线路的问题，稍后再试或换一条线路` : friendlyError(e.message)); }
  finally { clearTimeout(timer); }
  if (!opts?.onLine) {
    let o = null;
    try { o = JSON.parse(out); } catch {}
    if (o?.is_error) throw new Error(friendlyError(o.result));
  }
  return out;
};
// 要 JSON 的文字任务：解析失败就让 AI 重写一次（字符串里带引号等格式问题，任何线路都可能遇到）
async function askJSON(prompt, opts = {}, open = "{") {
  const close = open === "{" ? "}" : "]";
  const once = async (p) => {
    const t = JSON.parse(await agent(p, opts)).result || "";
    return JSON.parse(t.slice(t.indexOf(open), t.lastIndexOf(close) + 1));
  };
  try { return await once(prompt); }
  catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return once(`${prompt}\n\n（上次输出不是合法 JSON：${e.message}。这次只输出合法 JSON；字符串里不要用英文双引号，引用一律用「」。）`);
  }
}

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
const captionEdits = {}; // 作品 id → 等待学习的手改文案
let current = null; // { id, proc } 正在跑的那条，取消时连子进程树一起结束

// Codex 在沙箱里只能改作品自己的文件夹，而且沙箱里 node 起不了子进程（ffmpeg、Remotion 的浏览器都 EPERM）。
// 这几条固定命令由服务在作品文件夹里代跑：AI 只能按名字请求白名单里的命令，不能自己拼任意命令
const HELPERS = {
  crop: { stage: 2, run: () => ["node", ["scripts/detect-crop.mjs", "original.mp4"]], for: "node scripts/detect-crop.mjs original.mp4" },
  ocr: { stage: 2, run: () => ["node", ["scripts/burned-subs.mjs", "public/clip.mp4", "audio16k.json", "data/burned.json"]], for: "node scripts/burned-subs.mjs public/clip.mp4 audio16k.json data/burned.json" },
  frame: { stage: 3, run: (q) => ["npx", ["remotion", "still", "src/index.ts", "Kim", "work/f.png", `--frame=${Math.max(0, parseInt(q.get("frame"), 10) || 0)}`, "--log=error"]], for: "npx remotion still src/index.ts Kim work/f.png --frame=N（N 填帧号）", arg: "&frame=N" },
  render: { stage: 3, run: () => ["npx", ["remotion", "render", "src/index.ts", "Kim", "out/成片.mp4", "--codec=h264", "--crf=16", "--audio-codec=aac", "--audio-bitrate=256k", "--log=error"]], for: "npx remotion render src/index.ts Kim out/成片.mp4 …（整片渲染）" },
  cover: { stage: 4, run: () => ["npx", ["remotion", "still", "src/index.ts", "Cover", "out/封面_3比4.png", "--log=error"]], for: "npx remotion still src/index.ts Cover out/封面_3比4.png" },
  srt: { stage: 5, run: () => ["npm", ["run", "srt"]], for: "npm run srt" },
  pack: { stage: 5, run: () => ["npm", ["run", "pack"]], for: "npm run pack" },
};
const helperProcs = new Map(); // 作品 id → 正在代跑的进程，取消时一起结束
const helperBase = (j) => `http://127.0.0.1:${PORT}/api/helper?id=${encodeURIComponent(j.id)}&token=${j.helperToken}&cmd=`;
const helperNote = (j) => `
- 你在沙箱里运行：只能改当前目录里的文件，不要试图改别的地方。ffmpeg、ffprobe、whisper-cli 直接在命令行跑没问题；但 node 脚本不能启动其他程序（会报 EPERM），所以下面这些命令不要自己跑，改用 curl 请工作台代跑（会等它跑完，返回退出码和输出）：
${Object.entries(HELPERS).map(([k, h]) => `  ${h.for} → curl.exe -s "${helperBase(j)}${k}${h.arg || ""}"`).join("\n")}
  不在这个清单里、又需要 node 启动其他程序的事，改成直接用 ffmpeg 命令行做。`;
function runHelper(j, name, q) {
  const h = HELPERS[name];
  if (!h) throw new Error(`没有这个命令：${name}`);
  const [cmd, args] = h.run(q);
  j.last = `工作台代跑：${h.for}`;
  if (h.stage > (j.stage ?? -1)) j.stage = h.stage;
  j.steps++;
  return new Promise((res) => {
    const p = spawn(cmd, args.map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)), { cwd: j.dir, shell: true, windowsHide: true, env: withTmp(BASE_ENV, j.dir) });
    helperProcs.set(j.id, p);
    let out = "";
    const add = (d) => { out = (out + d).slice(-6000); };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    const timer = setTimeout(() => killTree(p), 30 * 60 * 1000);
    p.on("close", (code) => { clearTimeout(timer); helperProcs.delete(j.id); res(`exit=${code}\n${out.trim().slice(-3500)}`); });
    p.on("error", (e) => { clearTimeout(timer); res(`exit=-1\n${e.message}`); });
  });
}
const killTree = (proc) => {
  if (!proc?.pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { proc.kill("SIGTERM"); } catch {}
};
function cancelJob(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (j.status === "queued") jobs.splice(jobs.indexOf(j), 1);
  else if (j.status === "running") { j.cancelled = true; if (current?.id === id) killTree(current.proc); killTree(helperProcs.get(id)); }
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

// ---------- 经验本：从用户每次纠正里学，自己判断值不值得记 ----------
// 两条线路共用；每次做视频、改视频、对话、检查文案都带上。只记"做事的规则"，不改代码
const LESSONS_FILE = path.join(JOBS, "lessons.json");
const LESSON_MAX = 30;
let lessons = { rules: [], log: [] }; // rules: {id, rule, why, hits, pinned, from[], at}；log: 最近的判断（记/合并/跳过 + 理由）
try { lessons = { rules: [], log: [], ...JSON.parse(readFileSync(LESSONS_FILE, "utf8")) }; } catch {}
const saveLessons = () => writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
const rankedRules = () => [...lessons.rules].sort((a, b) => (b.pinned - a.pinned) || (b.hits - a.hits) || (b.at - a.at));
const lessonsNote = () => {
  const r = rankedRules();
  return r.length ? `\n- 用户以前纠正过、要长期遵守的规则（经验本）：\n${r.map((x) => `  · ${x.rule}`).join("\n")}` : "";
};
let learning = Promise.resolve();
// 每条反馈都排队判断一次（串行，避免两次同时改经验本）；失败只记日志，不影响制作
function learnFrom(ev) {
  learning = learning.then(() => judgeLesson(ev)).catch((e) => { lessons.log.unshift({ at: Date.now(), action: "error", why: String(e.message).slice(0, 120), src: ev.src }); lessons.log = lessons.log.slice(0, 40); saveLessons(); });
}
async function judgeLesson({ kind, text, before, after, job }) {
  const list = lessons.rules.map((r) => `${r.id}: ${r.rule}（被提到 ${r.hits} 次）`).join("\n") || "（还没有）";
  const what = kind === "caption-edit"
    ? `用户亲手改了小红书文案。\n改前：\n${String(before).slice(0, 1500)}\n改后：\n${String(after).slice(0, 1500)}`
    : `用户对成片提的修改意见${kind === "chat" ? "（对话里确认的方案，括号里是用户原话）" : ""}：\n「${String(text).slice(0, 1500)}」`;
  const arr = await askJSON(`你在维护一个"韩语学习小红书短视频工作台"的经验本：把用户的纠正提炼成以后做视频要长期遵守的规则。现在判断这次反馈值不值得记。
${what}

判断标准：
- 记（add）：以后别的视频也会遇到的问题或用户的稳定偏好（版式、措辞风格、出处写法、字幕翻译习惯、选什么做单词卡、封面要求等）。
- 合并（merge）：和已有某条意思相同或相近 → 给出那条的 id，并写一条合并后更准确的规则。和已有某条矛盾（比如以前说写出处、现在说不写）→ 也用 merge 覆盖那条，以这次为准，不要两条并存。
- 跳过（skip）：只针对这条视频具体内容的一次性修改（比如某句听错了、某个词翻错了），没有普遍性；或者太含糊、说不出可执行的规则。但如果它暴露的是一类反复会犯的错（比如"韩文和中文对不上"），就提炼成通用规则记下。
规则要具体可执行，一句话，中文，≤40 字，不要写这条视频的具体内容。

已有规则：
${list}

一条反馈里常常有好几点，逐点判断，每点一个对象（最多 3 个）。
只输出 JSON 数组：[{"action":"add|merge|skip","id":"merge 时填已有规则 id","rule":"规则（skip 时留空）","why":"一句话说明为什么记/合并/跳过"}]`, { model: "sonnet", effort: "low" }, "[");
  for (const r of (Array.isArray(arr) ? arr : [arr]).slice(0, 3)) applyLesson(r, { job, kind, text: text || after });
  saveLessons();
}
function applyLesson(r, { job, kind, text }) {
  const src = { job: job?.id, title: job?.title, kind, text: String(text || "").slice(0, 120) };
  const rule = String(r.rule || "").trim().slice(0, 80);
  const old = r.action === "merge" && lessons.rules.find((x) => x.id === r.id);
  if (old && rule) { old.rule = rule; old.hits++; old.at = Date.now(); if (job && !old.from.includes(job.id)) old.from.push(job.id); }
  else if ((r.action === "add" || r.action === "merge") && rule) {
    lessons.rules.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, rule, why: String(r.why || ""), hits: 1, pinned: false, from: job ? [job.id] : [], at: Date.now() });
    // 超过上限：去掉最不常用、没置顶的那条
    while (lessons.rules.length > LESSON_MAX) { const drop = rankedRules().filter((x) => !x.pinned).at(-1); if (!drop) break; lessons.rules.splice(lessons.rules.indexOf(drop), 1); }
  }
  lessons.log.unshift({ at: Date.now(), action: old ? "merge" : rule && r.action !== "skip" ? "add" : "skip", rule: r.action === "skip" ? "" : rule, why: String(r.why || "").slice(0, 160), src });
  lessons.log = lessons.log.slice(0, 40);
  saveLessons();
}

// 交付前自检：用户不想替 AI 发现排版问题。出片和改画面/封面时都要亲眼看图，看到难看就自己改，不问
const SELF_CHECK = `
- 交付前自检（必须做，不要问用户）：把封面 out/封面_3比4.png 和成片里有标题、字幕、单词卡的几帧（npx remotion still … --frame=N 出到 work/）都用看图工具亲眼看一遍。标准是"排版好看"，像小红书上做得好的博主那样：
  · 断行要在意思完整的地方断，不能有一两个字或一个标点单独掉到下一行，两行长短要协调；标点本身没问题，放得好看就保留；
  · 字号、粗细、颜色层次清楚，关键词高亮要高亮完整的词，留白均衡，整体居中对齐，不拥挤不空洞；
  · 字有没有超出小红书安全区（顶部 150px、底部 y>1480、右侧 140px）、有没有被裁切、互相压住、压住人脸；
  · 封面和字幕的韩文、中文是否对得上，有没有乱码或错字。
  看到任何难看或出错的地方直接改，改完重新出图再看一遍，直到没问题；这一步只看你自己改出来的东西，用户之后不应该再指出这类问题。`;

function jobPrompt(j) {
  const SKILL = cfg.skill, NODE_MODULES = cfg.skillModules;
  const link = process.platform === "win32" ? "用 junction 指向（PowerShell New-Item -ItemType Junction）" : "用符号链接指向（ln -s）";
  return `用 xhs-bilingual-clip skill（在 ${SKILL}，先读 SKILL.md）把这个视频做成小红书双语字幕视频：${j.url}
- 这台电脑的工具位置（SKILL.md 里写的路径只是示例，以这里为准，不要去找别的位置，也不要自己下载安装）：
  ${toolLines(cfg)}
- 当前目录就是项目目录：把 ${SKILL}/template 的内容复制到这里（不要复制 node_modules），node_modules ${link} ${NODE_MODULES}，字体从上面的字体文件夹复制 NotoSansSC-VF.ttf / NotoSansKR-VF.ttf 到 public/fonts。
- 视频标题参考：${j.title}${j.note ? `；用户备注：${j.note}` : ""}
- 封面样式：${j.coverStyle}（config.ts 的 COVER_STYLE：band 黑底大标题 / poster 大字报 / card 韩中对照卡 / reels Reels 款）；配色 PALETTE = "${/^[a-z]+$/.test(j.accent || "") ? j.accent : "yellow"}"（config.ts，字幕/标题/单词卡/封面都跟着变）。版式要守小红书安全区：顶部 150px、底部 y>1480、右侧 140px 不放字；一句字幕最多 2 行原文 + 1 行中文，超了就拆。封面底图挑人物清楚、没有烧录大字幕的一帧。
- 全自动，不要提问；听不清的句子删掉并记录。写脚本一律用 node，不要用 python。
${SELF_CHECK}${lessonsNote()}
- 最后必须产出：out/成片.mp4、out/封面_3比4.png、out/小红书文案.txt、out/剪映素材/（npm run pack），以及 out/summary.json：{"title":"中文标题","summary":"内容一句话","uncertain":["删掉或不确定的句子"],"cues":字幕条数}`;
}

// 成片出来后按意见局部返工：先按关键词判断改哪一块（不调 AI），只给 AI 那几个文件和那一条命令
const REVISE_SCOPES = {
  caption: { re: /文案|小红书标题|话题|标签|hashtag|#|简介|正文/i, files: "out/小红书文案.txt（必要时 out/summary.json 的 title）", run: "" },
  cover: { re: /封面|首图|缩略图/, files: "src/Cover.tsx、src/config.ts 里 COVER_ 开头的常量", run: "npx remotion still src/index.ts Cover out/封面_3比4.png --log=error" },
  subs: { re: /字幕|翻译|错字|意思|台词|这句|听错|听写|对不上|不同步|太快|太慢|漏了|这一句|那句|第\s*\d+\s*句/, files: "src/cues.ts（只改需要改的那几条）", run: "video" },
  style: { re: /颜色|配色|字体|字号|大小|位置|太大|太小|单词卡|标题|排版|粗|细|边距|安全区|黑底/, files: "src/config.ts（TITLE、PALETTE、SUB_MODE 等）；只有常量改不到时才动 src/Video.tsx / src/TitleLines.tsx", run: "video" },
  cut: { re: /剪掉|删掉|开头|结尾|片段|时长|太长|太短|多余|截到|从.*秒/, files: "src/config.ts 的时间常量（TOTAL 等）和 src/cues.ts 的时间", run: "video" },
};
const reviseScopes = (text) => Object.keys(REVISE_SCOPES).filter((k) => REVISE_SCOPES[k].re.test(text));

function revisePrompt(j) {
  const { text, scopes } = j.revision;
  const list = scopes.length ? scopes : [];
  const files = list.map((k) => `- ${REVISE_SCOPES[k].files}`).join("\n");
  const video = list.some((k) => REVISE_SCOPES[k].run === "video");
  const cmds = [];
  if (video) cmds.push("npx remotion render src/index.ts Kim out/成片.mp4 --codec=h264 --crf=16 --audio-codec=aac --audio-bitrate=256k --log=error", "npm run pack");
  if (video || list.includes("cover")) cmds.push(REVISE_SCOPES.cover.run);
  return `这是一个已经做好的小红书双语字幕视频工程（当前目录）。用户看了成片，${j.revision.big ? "和你在对话里确认了下面的修改方案" : "提出修改意见"}：
「${text}」

只做局部修改，省 token：
- 不要读 SKILL.md，不要重新下载视频、不要重新转写/听写、不要重建工程或复制模板，已有的素材和文件全部沿用。
- ${list.length ? `先看这些文件（这是按意见初步判断的范围）：\n${files}\n- 以意见文字为准：如果意见明显要改的是清单外的东西，就改那里，并照下面规则决定要不要重渲染。` : "先判断意见对应哪个文件，只读那个文件里相关的部分，改完即止。"}
- 用 Grep 定位要改的地方，不要整个读大文件；不要动和这条意见无关的内容。
- ${cmds.length ? `改完按顺序只跑这些命令：\n${cmds.map((c) => `  ${c}`).join("\n")}` : list.length ? "不需要重新渲染视频，改完文件就结束。" : "如果改了 src/ 下影响画面的文件，跑 npx remotion render src/index.ts Kim out/成片.mp4 --codec=h264 --crf=16 --audio-codec=aac --audio-bitrate=256k --log=error；改了封面就跑 " + REVISE_SCOPES.cover.run + "；只改文案就不渲染。"}
- 渲染成片如果报 EPERM / 文件被占用（用户可能正开着播放），不要反复重试，改为渲染到 out/成片_new.mp4 就结束，工作台会在文件释放后替换。
- 全自动，不要提问；写脚本用 node，不要用 python。${list.some((k) => k !== "caption") || !list.length ? SELF_CHECK : ""}${lessonsNote()}
- 改了封面就必须重新生成 out/封面_3比4.png，改了画面就必须重新渲染 out/成片.mp4；说"已重新生成"之前先确认文件时间确实是刚才的。
- 最后一句话用中文说明你改了什么（一句即可）；如果有没做成的部分，必须明确说出来。`;
}

function snapshotOutputs(j) {
  const out = path.join(j.dir, "out");
  const n = (j.revisions?.length || 0) + 1;
  const dest = path.join(j.dir, "revisions", String(n));
  mkdirSync(dest, { recursive: true });
  for (const f of ["成片.mp4", "封面_3比4.png", "小红书文案.txt", "summary.json"]) if (existsSync(path.join(out, f))) copyFileSync(path.join(out, f), path.join(dest, f));
  return dest;
}

// 改哪块以意见文字为准，勾选只作参考（用户常点错）：先关键词，认不出再问小模型，都不行才用勾选
const SCOPE_KEYS = Object.keys(REVISE_SCOPES);
async function resolveScopes(text, picked = []) {
  const kw = reviseScopes(text);
  // 关键词和勾选一致（或没勾）就直接用，不花钱；对不上、或关键词认不出时才问小模型
  const same = kw.length && (!picked.length || (kw.length === picked.length && kw.every((k) => picked.includes(k))));
  if (same) return { scopes: kw, by: "keyword" };
  try {
    const o = JSON.parse(await agent(`把这条短视频修改意见归类，判断要改哪几块。可选：caption=小红书文案/标题/话题，cover=封面，subs=字幕内容或翻译或时间，style=画面上字的颜色字体大小位置，cut=剪辑时长片段。
用户界面上勾了：${picked.join(",") || "无"}；关键词粗判是：${kw.join(",") || "无"}。两者都可能错，只作参考，以意见文字的真实意思为准（比如「结尾补一句关注我」多半是文案，「这句翻译错了」是字幕）。
注意「标题」：单说「标题」「上面的标题」「视频里的标题」指视频画面顶部的大标题 → style；「文案里的标题」「小红书标题」才是 caption；两种都提到就两个都选。意见里提到的每一处都要覆盖到，宁可多选一项，不要漏。
意见：「${text}」
只输出 JSON 数组，比如 ["subs"]；看不出来就输出 []。`, { model: "sonnet", effort: "low" }));
    const t = o.result || "";
    const arr = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1)).filter((k) => SCOPE_KEYS.includes(k));
    if (arr.length) return { scopes: arr, by: "ai" };
  } catch {}
  return kw.length ? { scopes: kw, by: "keyword" } : { scopes: picked.filter((k) => SCOPE_KEYS.includes(k)), by: "picked" };
}

async function reviseJob({ id, text, scopes, big }) {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status !== "done") throw new Error("只有做好的成片才能修改");
  if (j.id.startsWith("tpl-")) throw new Error("模板作品请在模板编辑器里改");
  const t = String(text || "").trim().slice(0, big ? 4000 : 1000);
  if (!t) throw new Error("写一下要改什么");
  const picked = (Array.isArray(scopes) ? scopes : []).filter((k) => REVISE_SCOPES[k]);
  const { scopes: valid, by } = big ? { scopes: picked, by: "chat" } : await resolveScopes(t, picked);
  if (j.status !== "done") throw new Error("这条已经在改了");
  const backup = snapshotOutputs(j);
  j.revision = { text: t, scopes: valid, by, big: !!big, backup, at: Date.now(), cfg0: readSafe(path.join(j.dir, "src", "config.ts"), 200000) };
  Object.assign(j, { status: "queued", steps: 0, stage: -1, last: "排队修改中", error: undefined });
  saveJobs();
  pump();
}

// 大改用对话：AI 只读不动文件，先说它的理解和打算；用户点「同意」后才把方案交给 reviseJob 去改
const readSafe = (f, n) => { try { return readFileSync(f, "utf8").slice(0, n); } catch { return ""; } };
async function chatJob({ id, text }) {
  const j = jobs.find((x) => x.id === id);
  if (!j || j.status !== "done") throw new Error("只有做好的成片才能对话修改");
  const t = String(text || "").trim().slice(0, 2000);
  if (!t) throw new Error("说一下想怎么改");
  const chat = (j.chat ||= []);
  chat.push({ role: "user", text: t, at: Date.now() });
  const out = path.join(j.dir, "out");
  const srt = readSafe(path.join(out, "双语字幕.srt"), 5000);
  const conf = readSafe(path.join(j.dir, "src", "config.ts"), 2500);
  const history = chat.slice(-12).map((m) => `${m.role === "user" ? "用户" : "你"}：${m.text}`).join("\n");
  const prompt = `你是小红书双语字幕短视频的剪辑负责人，正在和用户商量怎么修改一条已经做好的成片。现在只讨论，不动任何文件。
工程里可改的部分：caption=out/小红书文案.txt；cover=封面(src/Cover.tsx、COVER_ 常量)；subs=字幕(src/cues.ts，每条有时间、韩文、中文)；style=画面上字的颜色字体大小位置(src/config.ts)；cut=剪辑时长片段(config.ts 时间常量、cues.ts 时间)。改字幕/样式/剪辑要重渲染视频（几分钟），只改文案或封面很快。

作品标题：${j.title || ""}
双语字幕（节选）：
${srt || "（没有）"}
src/config.ts（节选）：
${conf || "（没有）"}
小红书文案（节选）：
${readSafe(path.join(out, "小红书文案.txt"), 1200) || "（没有）"}

用户长期要求（经验本）：${lessonsNote() || "（还没有）"}

对话记录：
${history}

请用中文回复用户，口语、简短：
1. 先一两句复述你理解的需求；
2. 再分条说打算怎么改（改哪块、具体改成什么、要不要重渲染）；
3. 需求不清楚就只问一个最关键的问题，先不给方案。
最后单独一行输出（用户看不到这一行）：
PLAN_JSON {"ready":true或false,"plan":"交给执行者的完整修改方案，写清每处改成什么","scopes":["caption","cover","subs","style","cut" 里需要的几个]}`;
  // 思考中的标记给页面看：关掉弹窗也不中断，回复照样写进对话，右侧停靠的对话框会显示出来
  j.chatBusy = true;
  let o;
  try { o = JSON.parse(await agent(prompt, { model: "sonnet", effort: "low" })); }
  catch (e) { chat.pop(); j.chatBusy = false; throw e; }
  j.chatBusy = false;
  if (o.is_error) { chat.pop(); throw new Error(o.result || "AI 调用失败"); }
  const raw = o.result || "";
  const at = raw.lastIndexOf("PLAN_JSON");
  let plan = null;
  if (at >= 0) try { const s = raw.slice(at); plan = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch {}
  const reply = (at >= 0 ? raw.slice(0, at) : raw).trim();
  chat.push({ role: "ai", text: reply, at: Date.now(), ...(plan?.ready && plan.plan ? { plan: String(plan.plan), scopes: (plan.scopes || []).filter((k) => SCOPE_KEYS.includes(k)) } : {}) });
  saveJobs();
  return chat;
}
async function approveChat({ id }) {
  const j = jobs.find((x) => x.id === id);
  const m = [...(j?.chat || [])].reverse().find((x) => x.role === "ai");
  if (!m?.plan) throw new Error("AI 还没给出可以执行的方案");
  const asked = j.chat.filter((x) => x.role === "user").map((x) => x.text).join("；");
  await reviseJob({ id, text: `${m.plan}\n（用户在对话里的原话：${asked.slice(0, 1200)}）`, scopes: m.scopes, big: true });
  m.approved = true;
  j.chat.push({ role: "sys", text: "已同意，开始修改", at: Date.now() });
  saveJobs();
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
    const rev = j.revision;
    // Codex 的 Windows 沙箱里 yt-dlp（PyInstaller 单文件版）解压临时文件会失败，所以由服务先下好原片再交给它
    let predownloaded = false;
    if (!rev && auth.engine === "codex") {
      const orig = path.join(j.dir, "original.mp4");
      if (!existsSync(orig)) {
        j.last = "下载原片"; j.stage = 0; saveJobs();
        await new Promise((ok, bad) => {
          const p = spawn(needYtdlp(), ["-f", "bv*[height>=1080]+ba/b", "--merge-output-format", "mp4", "-o", "original.mp4", "--no-playlist", j.url], { cwd: j.dir, windowsHide: true, env: withTmp(BASE_ENV, j.dir) });
          current = { id: j.id, proc: p };
          let err = "";
          p.stderr.on("data", (d) => { err = (err + d).slice(-400); });
          p.on("error", bad);
          p.on("close", (c) => (c === 0 && existsSync(orig) ? ok() : bad(new Error(`下载原片失败：${err.trim() || c}`))));
        });
      }
      predownloaded = true;
    }
    const codex = auth.engine === "codex";
    if (codex) j.helperToken = randomUUID();
    const light =rev && rev.scopes.length && rev.scopes.every((k) => k === "caption" || k === "cover");
    await agent((rev ? revisePrompt(j) : jobPrompt(j) + (predownloaded ? "\n- 视频已经下载好，就是当前目录的 original.mp4：跳过下载那一步，不要再运行 yt-dlp，直接从第 2 步开始。" : "")) + (codex ? helperNote(j) : ""), {
      cwd: j.dir,
      ...(rev ? { model: rev.scopes.length === 1 && rev.scopes[0] === "caption" ? "sonnet" : undefined, effort: light ? "low" : "medium" } : {}),
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
  if (j.revision) {
    // 修改失败也不能把作品弄没：旧成片还在就回到作品库，错误记在这次修改里
    const r = j.revision;
    const out = path.join(j.dir, "out");
    // 成片被占用时渲染到了 成片_new.mp4：等文件释放（最多约 1 分钟）再替换
    const fresh = path.join(out, "成片_new.mp4");
    if (existsSync(fresh) && statSync(fresh).mtimeMs > r.at) {
      for (let i = 0; i < 30; i++) {
        try { renameSync(fresh, path.join(out, "成片.mp4")); break; } catch { await new Promise((s) => setTimeout(s, 2000)); }
      }
    }
    // 核对：按实际改了什么来判断，不按预判的范围（范围可能多判，比如"安全区"被归到样式，其实只改封面）。
    // 改了影响画面的源文件、成片却没重新渲染 → 没改成；封面同理；什么都没改 → 没改成
    const mtime = (f) => { try { return statSync(path.join(j.dir, f)).mtimeMs; } catch { return 0; } };
    const touched = (f) => mtime(path.join("out", f)) > r.at;
    const srcDir = path.join(j.dir, "src");
    let srcFiles = [];
    try { srcFiles = readdirSync(srcDir).filter((f) => /\.(tsx?|json)$/.test(f)); } catch {}
    const changedSrc = srcFiles.filter((f) => mtime(path.join("src", f)) > r.at);
    const cfgNow = readSafe(path.join(srcDir, "config.ts"), 200000);
    const nonCover = (s) => String(s || "").split("\n").filter((l) => !/COVER_/.test(l)).join("\n");
    const onlyCover = (s) => String(s || "").split("\n").filter((l) => /COVER_/.test(l)).join("\n");
    const videoSrcChanged = changedSrc.some((f) => f !== "Cover.tsx" && f !== "config.ts") || (changedSrc.includes("config.ts") && nonCover(cfgNow) !== nonCover(r.cfg0));
    const coverSrcChanged = changedSrc.includes("Cover.tsx") || (changedSrc.includes("config.ts") && onlyCover(cfgNow) !== onlyCover(r.cfg0));
    // AI 改了源文件却没重新出成片/封面时，服务自己补跑固定的渲染命令（不花 AI 额度），而不是判失败
    const aiNote = String(j.last || "").replace(/\*\*|`/g, "");
    if (j.status === "done" && videoSrcChanged && !touched("成片.mp4")) {
      const out1 = await runHelper(j, "render", new URLSearchParams());
      if (out1.startsWith("exit=0")) await runHelper(j, "pack", new URLSearchParams());
    }
    if (j.status === "done" && coverSrcChanged && !touched("封面_3比4.png")) await runHelper(j, "cover", new URLSearchParams());
    j.last = aiNote;
    const missed = [];
    if (j.status === "done") {
      if (videoSrcChanged && !touched("成片.mp4")) missed.push("成片重新渲染失败");
      if (coverSrcChanged && !touched("封面_3比4.png")) missed.push("封面重新生成失败");
      if (!changedSrc.length && !["成片.mp4", "封面_3比4.png", "小红书文案.txt", "summary.json"].some(touched)) missed.push("没有任何文件被修改");
    }
    if (existsSync(fresh) && missed.includes("成片重新渲染失败")) missed.splice(missed.indexOf("成片重新渲染失败"), 1, "新成片已渲染好，但旧成片被占用替换不了（关掉播放器后点重试）");
    if (missed.length) { j.status = "failed"; j.error = missed.join("；"); }
    const ok = j.status === "done";
    if (!ok) for (const f of ["成片.mp4", "封面_3比4.png", "小红书文案.txt", "summary.json"]) if (existsSync(path.join(r.backup, f))) try { copyFileSync(path.join(r.backup, f), path.join(out, f)); } catch {}
    (j.revisions ||= []).push({ text: r.text, scopes: r.scopes, by: r.by, big: r.big, at: r.at, ok, note: ok ? j.last : j.error, backup: r.backup });
    if (ok) learnFrom({ kind: r.big ? "chat" : "revise", text: r.text, job: j });
    // 对话里同意的修改，结果也回到对话里
    if (r.big) (j.chat ||= []).push({ role: "ai", text: ok ? `改好了。${String(j.last || "").slice(0, 300)}` : `没改成：${String(j.error || "").slice(0, 300)}`, at: Date.now() });
    if (existsSync(path.join(out, "成片.mp4"))) { j.status = "done"; j.error = undefined; }
    j.checked = false;
    delete j.revision;
  }
  current = null;
  delete j.helperToken;
  try { rmSync(path.join(j.dir, "work", "tmp"), { recursive: true, force: true }); } catch {}
  j.finishedAt = Date.now();
  saveJobs();
  busy = false;
  pump();
}

const JOBS_FILE = path.join(JOBS, "jobs.json");
const saveJobs = () => writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
if (existsSync(JOBS_FILE)) for (const j of JSON.parse(readFileSync(JOBS_FILE, "utf8")).map((x) => ({ ...x, chatBusy: false }))) jobs.push(j.status === "running" ? { ...j, status: "failed", error: "服务重启中断" } : j);

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
    return pipeline(createReadStream(file, { start, end }), res, () => {}); // 浏览器中途取消（拖进度、关弹窗）时也要关掉文件，否则句柄一直占着，下次渲染覆盖不了成片
  }
  res.writeHead(200, { "cache-control": "no-cache", "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  pipeline(createReadStream(file), res, () => {});
};

const tplApi = createTplApi({ JOBS, agent, jobs, saveJobs, send, body, serveFile, cfg });
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
      if (u.pathname === "/api/scout" && req.method === "POST") { const { id } = await body(req); if (scouted[id]) scouted[id].at = 0; queueScout(id); return send(res, 200, { categories: publicCats() }); }
      if (u.pathname === "/api/setup" && req.method === "GET") return send(res, 200, { platform: cfg.platform, dataDir: JOBS, items: cfg.checks() });
      if (u.pathname === "/api/setup" && req.method === "POST") { const { key, value } = await body(req); cfg.set(key, value); health.at = 0; return send(res, 200, { platform: cfg.platform, dataDir: JOBS, items: cfg.checks() }); }
      if (u.pathname === "/api/resolve") return send(res, 200, await resolveLink(u.searchParams.get("url") || ""));
      if (u.pathname === "/api/jobs/cancel" && req.method === "POST") { cancelJob((await body(req)).id); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/helper") {
        // 只给正在制作的那条用，凭这次制作的一次性 token；别的网页、别的作品都调不动
        const j = jobs.find((x) => x.id === u.searchParams.get("id"));
        if (!j || j.status !== "running" || current?.id !== j.id || !j.helperToken || u.searchParams.get("token") !== j.helperToken) return send(res, 403, { error: "不允许" });
        const text = await runHelper(j, u.searchParams.get("cmd") || "", u.searchParams);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        return res.end(text);
      }
      if (u.pathname === "/api/caption" && req.method === "POST") {
        const { id, text, source } = await body(req);
        const j = jobs.find((x) => x.id === id);
        if (!j?.dir || typeof text !== "string") throw new Error("找不到这条作品");
        const out = path.join(j.dir, "out");
        mkdirSync(out, { recursive: true });
        const file = path.join(out, "小红书文案.txt");
        const before = readSafe(file, 20000);
        const after = text.replace(/\r\n/g, "\n");
        writeFileSync(file, after);
        // 用户亲手改的文案才学（采纳 AI 检查的不算）；连续保存时等停手 60 秒再学一次，拿第一次改前和最后一次改后对比
        if (source !== "ai" && before.trim() !== after.trim()) {
          const p = (captionEdits[id] ||= { before });
          clearTimeout(p.timer);
          p.timer = setTimeout(() => { delete captionEdits[id]; if (p.before.trim() !== after.trim()) learnFrom({ kind: "caption-edit", before: p.before, after, job: j }); }, 60000);
        }
        return send(res, 200, { ok: true });
      }
      if (u.pathname === "/api/caption-check" && req.method === "POST") {
        const { id, text } = await body(req);
        const j = jobs.find((x) => x.id === id);
        if (!j?.dir || typeof text !== "string" || !text.trim()) throw new Error("文案是空的");
        let srt = "";
        try { srt = readFileSync(path.join(j.dir, "out", "双语字幕.srt"), "utf8").replace(/^\d+\r?\n[\d:,]+ --> [\d:,]+\r?\n/gm, "").slice(0, 6000); } catch {}
        const prompt = `你是小红书"韩语学习"账号的文案校对。检查下面这篇小红书文案，只找真正的问题：
1. 中文错别字、病句、标点错误
2. 韩语拼写、띄어쓰기、语法错误；韩语单词的中文释义或例句翻译不准确
3. 引用的台词和视频字幕对不上（字幕见下方）
4. 小红书违禁/限流词（如"最""第一"等绝对化用语、引流、站外平台名）
不要改写风格，不要挑没问题的地方，不要加原作者出处或"侵删"之类的话。${lessonsNote() ? `\n5. 违反了下面这些用户长期要求的地方也要指出：${lessonsNote()}` : ""}
只输出 JSON，不要其他文字；字符串里不要用英文双引号，引用请用「」：
{"issues":[{"where":"原文里有问题的片段","problem":"问题是什么（一句话）","fix":"改成什么"}],"revised":"把所有问题改好后的完整文案（没有问题就原样返回）"}

文案：
${text}

视频双语字幕：
${srt || "（没有）"}`;
        const r = await askJSON(prompt, { model: "sonnet", effort: "low" });
        return send(res, 200, { issues: Array.isArray(r.issues) ? r.issues : [], revised: typeof r.revised === "string" ? r.revised : text });
      }
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
      if (u.pathname === "/api/revise-scopes") return send(res, 200, reviseScopes(u.searchParams.get("text") || ""));
      if (u.pathname === "/api/health") return send(res, 200, await getHealth(u.searchParams.has("fresh")));
      if (u.pathname === "/api/login" && req.method === "POST") { startLogin(); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/auth-mode" && req.method === "POST") { setRoute(await body(req)); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/apis" && req.method === "POST") { await addApi(await body(req)); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/apis/delete" && req.method === "POST") { removeApi((await body(req)).id); return send(res, 200, await getHealth()); }
      if (u.pathname === "/api/search") return send(res, 200, await withRealThumbs(await search(u.searchParams.get("q") || "")));
      if (u.pathname === "/api/picks") { try { const saved = JSON.parse(readFileSync(path.join(JOBS, "picks.json"), "utf8")); return send(res, 200, { ...saved, picks: await withRealThumbs(saved.picks) }); } catch { return send(res, 200, { picks: [] }); } }
      if (u.pathname === "/api/retry" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j && j.status === "failed") { Object.assign(j, { status: "queued", error: undefined, steps: 0, stage: -1, last: "排队中" }); saveJobs(); pump(); } return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/revise" && req.method === "POST") { await reviseJob(await body(req)); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/lessons" && req.method === "GET") return send(res, 200, { rules: rankedRules(), log: lessons.log });
      if (u.pathname === "/api/lessons" && req.method === "POST") {
        // 经验本用户说了算：改、删、置顶、手动加
        const { action, id, rule } = await body(req);
        const r = lessons.rules.find((x) => x.id === id);
        const txt = String(rule || "").trim().slice(0, 80);
        if (action === "delete" && r) lessons.rules.splice(lessons.rules.indexOf(r), 1);
        else if (action === "pin" && r) r.pinned = !r.pinned;
        else if (action === "edit" && r && txt) { r.rule = txt; r.at = Date.now(); }
        else if (action === "history") { for (const j of jobs) for (const r of j.revisions || []) if (r.ok) learnFrom({ kind: r.big ? "chat" : "revise", text: r.text, job: j }); }
        else if (action === "add" && txt) lessons.rules.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, rule: txt, why: "你手动加的", hits: 1, pinned: true, from: [], at: Date.now() });
        else throw new Error("操作不对");
        saveLessons();
        return send(res, 200, { rules: rankedRules(), log: lessons.log });
      }
      if (u.pathname === "/api/chat" && req.method === "POST") return send(res, 200, await chatJob(await body(req)));
      if (u.pathname === "/api/chat/approve" && req.method === "POST") { await approveChat(await body(req)); return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/chat/clear" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j) { j.chat = []; saveJobs(); } return send(res, 200, []); }
      if (u.pathname === "/api/checked" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j) { j.checked = true; saveJobs(); } return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/buzz") return send(res, 200, (await buzz()).topics);
      if (u.pathname === "/api/trending") return send(res, 200, (await melonHot()).slice(0, 16).map((a) => ({ tag: a.name, query: a.query, views: a.score, best: a.best, songs: a.songs })));
      if (u.pathname === "/api/discover") return send(res, 200, await withRealThumbs(await discover(u.searchParams.get("cat"), { fresh: u.searchParams.has("fresh") })));
      if (u.pathname === "/api/recommend") return send(res, 200, await withRealThumbs(await recommend((u.searchParams.get("cats") || "").split(",").filter(catOf).length ? u.searchParams.get("cats").split(",").filter(catOf) : categories.map((c) => c.id))));
      if (u.pathname === "/api/jobs" && req.method === "GET") return send(res, 200, jobs.map((j) => ({ ...j, outputs: outputsOf(j) })));
      if (u.pathname === "/api/jobs" && req.method === "POST") {
        const missing = cfg.checks().filter((c) => /制作/.test(c.need) && c.id !== "ai" && !c.ok).map((c) => c.label);
        if (missing.length) throw new Error(`还不能制作，缺：${missing.join("、")}。点左下角「环境」按提示装好`);
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
      if (!existsSync(path.join(dist, "index.html"))) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<meta charset=utf-8><body style='font:16px system-ui;padding:40px'>页面还没构建。在工作台文件夹里运行 <code>npm start</code>（会自动构建再启动）。"); }
      const f = path.join(dist, u.pathname === "/" ? "index.html" : u.pathname);
      return serveFile(res, existsSync(f) ? f : path.join(dist, "index.html"), req);
    } catch (e) {
      send(res, 500, { error: String(e.message).slice(0, 500) });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`KCLIP Studio → http://localhost:${PORT}`);
    const lack = cfg.checks().filter((c) => !c.ok);
    if (lack.length) console.log(`环境还缺 ${lack.length} 项（${lack.map((c) => c.label).join("、")}），打开页面左下角「环境」看怎么装`);
    pump(); // 上次服务器关闭时还在排队的任务，接着做
  });
