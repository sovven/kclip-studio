// KCLIP Studio 后端：发现韩国短视频 → AI 推荐 → 排队制作（调用本机 Claude Code + xhs-bilingual-clip skill）
// 运行：node server.mjs   （端口 5291；前端 dev 在 5290，build 后由本服务直接托管 dist/）
import { spawn, execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = 5291;
const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const JOBS = path.join(ROOT, "jobs");
const YTDLP = "D:/Tools/yt-dlp/yt-dlp.exe";
const SKILL = "D:/Agent/Claude/workpalce/work/xhs-bilingual-clip";
const NODE_MODULES = "D:/Agent/Claude/workpalce/work/vedio/sejong-video/node_modules";
mkdirSync(JOBS, { recursive: true });

// ---------- 板块 → 搜索词 / 频道 ----------
// 板块按小红书受众设计（韩语学习 / 韩娱粉 / K-pop 追星 / 综艺爱好者）。
// 频道由 scripts/scout-channels.mjs 按"最新 12 条 Shorts 播放量中位数"筛出来（2026-10 数据），过一段时间重跑一次更新。
// ch：官方频道 Shorts 页（最新在前）→ 每个频道取最新 12 条，再按播放量排 = 最近火的；q：搜索补充
export const CATEGORIES = {
  idol: { label: "爱豆日常·综艺", ch: ["https://www.youtube.com/@BLACKPINK/shorts", "https://www.youtube.com/@BABYMONSTER/shorts", "https://www.youtube.com/@NewJeans_official/shorts", "https://www.youtube.com/@StrayKids/shorts", "https://www.youtube.com/@ILLIT_official/shorts", "https://www.youtube.com/@cortis_bighit/shorts", "https://www.youtube.com/@TXT_bighit/shorts", "https://www.youtube.com/@BTS/shorts", "https://www.youtube.com/@RESCENE_official/shorts", "https://www.youtube.com/@aespa/shorts", "https://www.youtube.com/@TWICE/shorts", "https://www.youtube.com/@ATEEZofficial/shorts", "https://www.youtube.com/@IVEstarship/shorts", "https://www.youtube.com/@LESSERAFIM_official/shorts", "https://www.youtube.com/@NCTDREAM/shorts", "https://www.youtube.com/@pledis17/shorts"] },
  kpop: { label: "K-POP 舞台·挑战", ch: ["https://www.youtube.com/@SMTOWN/shorts", "https://www.youtube.com/@theblacklabel/shorts", "https://www.youtube.com/@BOYNEXTDOOR_official/shorts", "https://www.youtube.com/@TWS_PLEDIS/shorts", "https://www.youtube.com/@NCTsmtown/shorts", "https://www.youtube.com/@ITZY/shorts", "https://www.youtube.com/@PLAVE_official/shorts", "https://www.youtube.com/@jypentertainment/shorts", "https://www.youtube.com/@KBSKpop/shorts"] },
  variety: { label: "韩综名场面", ch: ["https://www.youtube.com/@ddeunddeun/shorts", "https://www.youtube.com/@SBSRunningMan/shorts", "https://www.youtube.com/@JTBCVoyage/shorts", "https://www.youtube.com/@workman/shorts", "https://www.youtube.com/@WassupMan/shorts", "https://www.youtube.com/@mmtg_official/shorts", "https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@mbicnews/shorts"] },
  drama: { label: "热播韩剧", ch: ["https://www.youtube.com/@SBSCatch/shorts", "https://www.youtube.com/@netflixkcontent/shorts", "https://www.youtube.com/@NetflixKorea/shorts", "https://www.youtube.com/@jtbcdrama/shorts"] },
  relate: { label: "恋爱·职场共鸣", ch: ["https://www.youtube.com/@shortbox/shorts", "https://www.youtube.com/@nerdult/shorts", "https://www.youtube.com/@workman/shorts"] },
  china: { label: "韩国人×中国", ch: ["https://www.youtube.com/@WayV/shorts", "https://www.youtube.com/@NCT127/shorts", "https://www.youtube.com/@NCTsmtown/shorts"], q: ["아이돌 중국어 shorts", "중국어 하는 아이돌", "한국인 중국 음식 먹방 shorts"] },
  speech: { label: "感动·获奖感言", q: ["수상소감 shorts", "백상예술대상 수상소감", "청룡영화상 수상소감"] },
  wys: { label: "外研社同款来源", ch: ["https://www.youtube.com/@ddeunddeun/shorts", "https://www.youtube.com/@SBSRunningMan/shorts", "https://www.youtube.com/@WassupMan/shorts", "https://www.youtube.com/@shortbox/shorts", "https://www.youtube.com/@nerdult/shorts", "https://www.youtube.com/@mbicnews/shorts"] },
};


const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000, ...opts }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))),
  );

const ytList = async (src, n) => {
  const url = src.startsWith("http") ? src : `ytsearch${n}:${src}`;
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
    thumb: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    platform: "youtube",
  }));
};

// 不做体育、政治：标题命中这些词就过滤
const BLOCK = /올림픽|금메달|은메달|동메달|선수|경기|축구|야구|농구|배구|골프|펜싱|양궁|KBO|K리그|월드컵|국가대표|대통령|국회|정치|선거|여당|야당|탄핵|정부|장관|의원|北|군사|전쟁/;
const keep = (v) => !BLOCK.test(v.title || "");

const cache = new Map(); // cat → {at, items}
async function discover(cat) {
  const c = CATEGORIES[cat];
  if (!c) throw new Error("unknown category");
  const hit = cache.get(cat);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.items;
  const lists = await Promise.allSettled([...(c.q || []).map((q) => ytList(q, 12)), ...(c.ch || []).map((u) => ytList(u, 12))]);
  const seen = new Set();
  const items = lists
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .filter((v) => v.id && !seen.has(v.id) && seen.add(v.id))
    .filter((v) => v.duration == null || (v.duration >= 10 && v.duration <= 120))
    .filter(keep)
    .map((v) => ({ ...v, category: cat }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 30);
  cache.set(cat, { at: Date.now(), items });
  return items;
}

async function search(q) {
  const key = "q:" + q;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.items;
  const items = (await ytList(q.includes("shorts") ? q : q + " #shorts", 30))
    .filter((v) => v.duration == null || (v.duration >= 10 && v.duration <= 120))
    .filter(keep)
    .map((v) => ({ ...v, category: "search" }));
  cache.set(key, { at: Date.now(), items });
  return items;
}

// Claude CLI 登录状态（制作和 AI 推荐都靠它）
let health = { loggedIn: null, at: 0 };
async function getHealth() {
  if (Date.now() - health.at < 60000) return health;
  try {
    const out = await run("claude", ["auth", "status"], { shell: true, timeout: 30000 });
    health = { loggedIn: !!JSON.parse(out).loggedIn, at: Date.now() };
  } catch {
    health = { loggedIn: false, at: Date.now() };
  }
  return health;
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

// ---------- Claude Code 无头调用 ----------
const claude = (prompt, { cwd = ROOT, json = true, onLine } = {}) =>
  new Promise((res, rej) => {
    const args = ["-p", "--output-format", onLine ? "stream-json" : "json"];
    if (onLine) args.push("--verbose"); // stream-json 必须带 verbose；json 模式带了会变成消息数组
    if (onLine) args.push("--allowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill", "--add-dir", SKILL, NODE_MODULES);
    const p = spawn("claude", args, { cwd, shell: true, windowsHide: true });
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
    p.on("close", (code) => (code === 0 ? res(all) : rej(new Error(`claude exit ${code}: ${all.slice(-500)}`))));
  });

async function recommend(cats) {
  const pool = (await Promise.all(cats.map((c) => discover(c).catch(() => [])))).flat();
  const list = pool.slice(0, 80).map((v) => ({ id: v.id, title: v.title, channel: v.channel, views: v.views, duration: v.duration, category: CATEGORIES[v.category].label }));
  const prompt = `你是小红书"韩语学习 + 韩娱"账号的选题编辑。目标观众是小红书上的：韩语学习者、韩国文化爱好者、K-pop 追星族、韩综爱好者（大多是 18–30 岁中国女生）。
下面是从 YouTube 抓到的、本月播放量高的韩国短视频候选（JSON）。挑出 8 条**放到小红书也会有很多人点赞收藏**的。

好选题的标准（按重要性）：
1. 中国观众**不需要韩国背景知识**也能看懂笑点或共鸣点（太"韩国人才懂"的梗、本土时事、冷门艺人要排除）
2. 有在中国知名度高的爱豆/演员/综艺（如 BTS、SEVENTEEN、Stray Kids、aespa、IVE、NewJeans、BLACKPINK、Running Man、地球娱乐室 等），或者情绪很强（爆笑、心动、感动、共鸣）
3. 和中国有关的内容（爱豆说中文、韩国人吃中国菜、谈中国）在小红书特别吃香
4. 有一两句好学、好用的韩语口语
5. 60 秒以内最好；播放量高说明最近火
硬性排除：体育（比赛、运动员、奥运等）、政治/时政、负面社会新闻、灾难事故、低俗擦边。

只输出 JSON 数组，不要其他文字；字符串里不要用英文双引号，引用请用「」。每项：{"id":原id,"zh_title":"中文小标题(≤14字，小红书风格)","summary":"一句话讲视频内容","why":"小红书用户为什么会喜欢（点出人群和情绪）","tags":["2-3个标签"],"cover_style":"band|poster|card|reels 之一","score":1-10}
`+`本周热门话题（按播放量）：${trending(15).map((t) => t.tag).join(" ")}
候选：${JSON.stringify(list)}`;
  const ask = async (p) => {
    const o = JSON.parse(await claude(p));
    if (o.is_error) throw new Error(o.result?.includes("login") ? "Claude CLI 未登录：在终端运行 claude 然后输入 /login" : o.result || "Claude 调用失败");
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

function jobPrompt(j) {
  return `用 xhs-bilingual-clip skill（在 ${SKILL}，先读 SKILL.md）把这个视频做成小红书双语字幕视频：${j.url}
- 当前目录就是项目目录：把 ${SKILL}/template 的内容复制到这里，node_modules 用 junction 指向 ${NODE_MODULES}（PowerShell New-Item -ItemType Junction），字体从 C:\\Windows\\Fonts 复制 NotoSansSC-VF.ttf / NotoSansKR-VF.ttf 到 public/fonts。
- 视频标题参考：${j.title}${j.note ? `；用户备注：${j.note}` : ""}
- 封面样式：${j.coverStyle}（config.ts 的 COVER_STYLE：band 黑底大标题 / poster 大字报 / card 韩中对照卡 / reels Reels 款）；高亮色 ACCENT = ${j.accent || "#8fd3ff"}。封面底图挑人物清楚、没有烧录大字幕的一帧。
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
    await claude(jobPrompt(j), {
      cwd: j.dir,
      onLine: (line) => {
        appendFileSync(log, line + "\n");
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant") {
            for (const c of ev.message?.content || []) {
              if (c.type === "tool_use") {
                j.steps++;
                j.last = c.input?.description || c.name;
                const cmd = JSON.stringify(c.input || {});
                const st = [[/yt-dlp/, 0], [/whisper/, 1], [/cues.ts|config.ts/, 2], [/remotion render/, 3], [/Cover|封面/, 4], [/文案|summary.json/, 5]].find(([re]) => re.test(cmd));
                if (st && st[1] > (j.stage ?? -1)) j.stage = st[1];
              }
              if (c.type === "text" && c.text.trim()) j.last = c.text.trim().slice(0, 120);
            }
          }
        } catch {}
      },
    });
    j.status = existsSync(path.join(j.dir, "out", "成片.mp4")) ? "done" : "failed";
    if (j.status === "failed") j.error = "没有生成 out/成片.mp4，看 log.jsonl";
  } catch (e) {
    j.status = "failed";
    j.error = String(e.message).slice(0, 300);
  }
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
    cover: has("封面_3比4.png") ? rel("封面_3比4.png") : null,
    caption,
    summary,
    folder: out,
  };
};

// ---------- HTTP ----------
const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };

const serveFile = (res, file, req) => {
  if (!existsSync(file) || statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
  const size = statSync(file).size;
  const type = MIME[path.extname(file)] || "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = Number(range[1] || 0), end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  createReadStream(file).pipe(res);
};

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      if (u.pathname === "/api/categories") return send(res, 200, Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label })));
      if (u.pathname === "/api/health") return send(res, 200, await getHealth());
      if (u.pathname === "/api/search") return send(res, 200, await search(u.searchParams.get("q") || ""));
      if (u.pathname === "/api/picks") { try { return send(res, 200, JSON.parse(readFileSync(path.join(JOBS, "picks.json"), "utf8"))); } catch { return send(res, 200, { picks: [] }); } }
      if (u.pathname === "/api/retry" && req.method === "POST") { const { id } = await body(req); const j = jobs.find((x) => x.id === id); if (j && j.status === "failed") { Object.assign(j, { status: "queued", error: undefined, steps: 0, stage: -1, last: "排队中" }); saveJobs(); pump(); } return send(res, 200, { ok: true }); }
      if (u.pathname === "/api/trending") return send(res, 200, trending());
      if (u.pathname === "/api/discover") return send(res, 200, await discover(u.searchParams.get("cat")));
      if (u.pathname === "/api/recommend") return send(res, 200, await recommend((u.searchParams.get("cats") || "idol,variety,kpop,relate").split(",")));
      if (u.pathname === "/api/jobs" && req.method === "GET") return send(res, 200, jobs.map((j) => ({ ...j, outputs: outputsOf(j) })));
      if (u.pathname === "/api/jobs" && req.method === "POST") {
        const items = (await body(req)).items || [];
        for (const it of items) {
          const id = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${it.id}`;
          if (jobs.some((j) => j.vid === it.id && j.status !== "failed")) continue;
          jobs.push({ id, vid: it.id, url: it.url, title: it.title, note: it.note || "", coverStyle: it.coverStyle || "band", accent: it.accent || "", status: "queued", steps: 0, stage: -1, last: "排队中", createdAt: Date.now(), dir: path.join(JOBS, id) });
        }
        saveJobs();
        pump();
        return send(res, 200, { ok: true });
      }
      if (u.pathname.startsWith("/files/")) return serveFile(res, path.join(JOBS, decodeURIComponent(u.pathname.slice(7))), req);
      // 前端（build 后）
      const dist = path.join(ROOT, "dist");
      const f = path.join(dist, u.pathname === "/" ? "index.html" : u.pathname);
      return serveFile(res, existsSync(f) ? f : path.join(dist, "index.html"), req);
    } catch (e) {
      send(res, 500, { error: String(e.message).slice(0, 500) });
    }
  })
  .listen(PORT, () => console.log(`KCLIP Studio API → http://localhost:${PORT}`));
