// 模板视频：单词 → AI 填内容 → 配图 → 配音 → 分轨工程；导出时前端逐帧画好传上来，这里合成 mp4 并写入作品库
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const UA = "KCLIPStudio/1.0 (local video tool)";
const newId = (p = "") => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const execp = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, out, err) => (e ? rej(new Error(String(err || e.message).slice(-400))) : res(out))));
const probeDuration = async (file) => parseFloat(await execp("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])) || 0;

export const VOICES = { sunhi: "ko-KR-SunHiNeural", injun: "ko-KR-InJunNeural" };
export const QUESTIONS = ["이게 뭐예요?", "뭐 하고 있어요?", "무슨 운동하세요?", "여기가 어디예요?"];

// 版式和节奏量自系列成片（1080×1920，每题 5.3 秒）
const STYLE = { bg: "#BBD0C9", ink: "#1E3D2C", count: "#5F706A" };
const T = { period: 5.3, questionAt: 0.1, tickAt: 1.2, digits: [1.6, 2.4, 3.2], answerAt: 4.35 };

function buildTimeline({ title, question, footnote, items, questionVoice, tick }) {
  const tracks = [
    { id: "title", name: "标题", kind: "text" },
    { id: "question", name: "问题", kind: "text" },
    { id: "ko", name: "韩语", kind: "text" },
    { id: "zh", name: "中文", kind: "text" },
    { id: "count", name: "倒计时", kind: "text" },
    { id: "note", name: "提示", kind: "text" },
    { id: "media", name: "配图", kind: "media" },
    { id: "voice", name: "配音", kind: "audio" },
    { id: "sfx", name: "音效", kind: "audio" },
    { id: "bgm", name: "音乐", kind: "audio" },
  ];
  const clips = [];
  const text = (track, start, dur, props) => clips.push({ id: newId("c"), track, kind: "text", start, dur, x: 540, color: STYLE.ink, weight: 500, ...props });
  let t = 0;
  items.forEach((it) => {
    const period = Math.max(T.period, T.answerAt + (it.voiceDur || 0) + 0.2);
    clips.push({ id: newId("c"), track: "media", kind: "media", start: t, dur: period, src: it.image || "", mediaType: "image", x: 155, y: 668, w: 770, h: 585, fit: "cover", item: it.id });
    if (questionVoice) clips.push({ id: newId("c"), track: "voice", kind: "audio", start: t + T.questionAt, dur: questionVoice.dur, src: questionVoice.src, srcDur: questionVoice.dur, volume: 0.75, offset: 0, name: question, voiceText: question });
    if (tick) clips.push({ id: newId("c"), track: "sfx", kind: "audio", start: t + T.tickAt, dur: tick.dur, src: tick.src, srcDur: tick.dur, volume: 1, offset: 0, name: "倒计时" });
    ["3", "2", "1"].forEach((d, i) => {
      const end = i < 2 ? T.digits[i + 1] : T.answerAt;
      text("count", t + T.digits[i], end - T.digits[i], { text: d, y: 1425, size: 280, weight: 900, color: STYLE.count, anim: "wipe" });
    });
    text("ko", t + T.answerAt, period - T.answerAt, { text: it.ko, y: 1365, size: 125, maxW: 1000, item: it.id });
    text("zh", t + T.answerAt, period - T.answerAt, { text: it.zh, y: 1515, size: 100, maxW: 1000, item: it.id });
    if (it.voice) clips.push({ id: newId("c"), track: "voice", kind: "audio", start: t + T.answerAt, dur: it.voiceDur, src: it.voice, srcDur: it.voiceDur, volume: 1, offset: 0, name: it.ko, voiceText: it.ko, item: it.id });
    t += period;
  });
  text("title", 0, t, { text: title.join("\n"), y: 300, size: 96, label: true, maxW: 1000 });
  text("question", 0, t, { text: question, y: 582, size: 130, maxW: 1000 });
  if (footnote) text("note", 0, t, { text: footnote, y: 1777, size: 32 });
  return { tracks, clips, duration: t };
}

export function createTplApi({ JOBS, agent, jobs, saveJobs, send, body, serveFile, cfg }) {
  const DIR = path.join(JOBS, "_tpl");
  const PROJECTS = path.join(DIR, "projects");
  const ASSETS = path.join(DIR, "assets");
  mkdirSync(PROJECTS, { recursive: true });
  mkdirSync(ASSETS, { recursive: true });
  const builds = new Map(); // 进行中的生成：{ stage, done, total, error, warnings }
  const exportsMap = new Map();

  const pdir = (id) => {
    if (!/^[\w-]+$/.test(id || "")) throw new Error("项目 id 不对");
    return path.join(PROJECTS, id);
  };
  const fileUrl = (id, name) => `/files/_tpl/projects/${id}/assets/${encodeURIComponent(name)}`;
  const urlToFile = (u) => path.join(JOBS, decodeURIComponent(String(u).replace(/^\/files\//, "")));
  const load = (id) => JSON.parse(readFileSync(path.join(pdir(id), "project.json"), "utf8"));
  const save = (p) => {
    mkdirSync(path.join(pdir(p.id), "assets"), { recursive: true });
    writeFileSync(path.join(pdir(p.id), "project.json"), JSON.stringify(p, null, 1));
  };

  // 倒计时音效：优先用系列成片里提取的 jobs/_tpl/assets/tick.wav，没有就现场合成
  async function ensureTick() {
    const f = path.join(ASSETS, "tick.wav");
    if (!existsSync(f)) await execp("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc='0.25*sin(2*PI*1800*t)*exp(-60*mod(t,0.2))':d=2.68:s=44100", "-ac", "2", f]);
    return { src: "/files/_tpl/assets/tick.wav", dur: await probeDuration(f) };
  }

  // ---------- 配音 ----------
  // 问题句用系列原来的音频（jobs/_tpl/assets/question-*.mp3），保持每条视频开头同一个声音；没有录音的句子才现场合成
  const QUESTION_AUDIO = { "이게 뭐예요?": "question-1.mp3", "뭐 하고 있어요?": "question-2.mp3", "무슨 운동하세요?": "question-3.mp3" };
  async function questionVoice(id, question, voice) {
    const name = QUESTION_AUDIO[question];
    const file = name && path.join(ASSETS, name);
    if (file && existsSync(file)) return { src: `/files/_tpl/assets/${name}`, dur: await probeDuration(file) };
    return tts(id, question, voice);
  }
  async function tts(id, text, voice = "sunhi") {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
    const client = new MsEdgeTTS();
    await client.setMetadata(VOICES[voice] || VOICES.sunhi, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const assets = path.join(pdir(id), "assets");
    const name = `voice-${newId()}`;
    const raw = path.join(assets, `${name}.raw.mp3`), out = path.join(assets, `${name}.mp3`);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("配音超时")), 25000);
      const { audioStream } = client.toStream(text);
      const w = createWriteStream(raw);
      audioStream.on("error", rej);
      w.on("error", rej);
      w.on("finish", () => { clearTimeout(timer); res(); });
      audioStream.on("end", () => w.end());
      audioStream.pipe(w, { end: false });
    });
    try { client.close(); } catch {}
    if (!statSync(raw).size) throw new Error("配音服务没有返回音频");
    // 裁掉首尾静音，节奏才能和模板对齐
    await execp("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse", "-b:a", "128k", out]);
    rmSync(raw, { force: true });
    return { src: fileUrl(id, `${name}.mp3`), dur: await probeDuration(out) };
  }

  // ---------- 配图 ----------
  const fetchTo = async (url, file, init) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: "follow", ...init, headers: { "user-agent": UA, ...init?.headers } });
    if (!r.ok) throw new Error(`下载失败 ${r.status}`);
    const type = r.headers.get("content-type") || "";
    if (!type.startsWith("image/")) throw new Error("返回的不是图片");
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return type;
  };
  const extOf = (type) => (type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg");

  // 维基共享资源：免 Key，只留公有领域/CC0，可以直接商用；其它协议只能用来垫图
  async function searchPhotos(q, { freeOnly = true, limit = 12 } = {}) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=30&gsrsearch=${encodeURIComponent(`${q} filetype:bitmap`)}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1280&iiextmetadatafilter=LicenseShortName`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "user-agent": UA } });
    if (!r.ok) throw new Error(`图库搜索失败 ${r.status}`);
    const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
    return pages.map((p) => {
      const i = p.imageinfo?.[0] || {};
      return { title: p.title?.replace(/^File:/, ""), url: i.thumburl || i.url, width: i.width, height: i.height, license: i.extmetadata?.LicenseShortName?.value || "" };
    }).filter((x) => x.url && x.width >= 500 && x.width / x.height > 0.8 && x.width / x.height < 2.2 && !/\.(svg|tiff?|pdf|djvu)/i.test(x.title || "") && (!freeOnly || /^(public domain|pd|cc0)/i.test(x.license))).slice(0, limit);
  }

  const imagePrompt = (it) => `${it.prompt || it.en || it.zh}. True-to-life everyday photo: correct real-world shape, size, count and use, physically plausible, placed where it would really be in daily life, nothing surreal or distorted, correct anatomy if hands appear. Soft natural daylight, gentle soft shadow, clean uncluttered bright background, subject centered and fully visible, no window visible, landscape 4:3. No text, no watermark, no logo.`;

  // 免费默认：Hugging Face 上官方的 FLUX.1 schnell，免 Key、无水印；同一时间只能跑一张，失败就等一下重试
  const FLUX = "https://black-forest-labs-flux-1-schnell.hf.space/gradio_api";
  async function genFlux(it, file) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * 2500));
      try {
        const seed = Math.floor(Math.random() * 1e9);
        const start = await fetch(`${FLUX}/call/infer`, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ data: [imagePrompt(it), seed, false, 1024, 768, 4] }), signal: AbortSignal.timeout(30000) });
        if (!start.ok) throw new Error(`生图服务 ${start.status}`);
        const { event_id } = await start.json();
        const r = await fetch(`${FLUX}/call/infer/${event_id}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(120000) });
        const text = await r.text();
        const url = /event: completes+data: .*?"url": "([^"]+)"/s.exec(text)?.[1];
        if (!url) throw new Error("生图服务暂时忙");
        const img = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60000) });
        const buf = Buffer.from(await img.arrayBuffer());
        if (!img.ok || buf.length < 2000) throw new Error("生图结果下载失败");
        writeFileSync(file, buf);
        return;
      } catch (e) { last = e; }
    }
    throw last;
  }

  // 只自动用免费 AI 生图。图库的搜索结果经常跑题，只给用户手动挑，绝不自动塞进视频
  async function makeImage(id, it) {
    const name = `image-${newId()}.webp`;
    await genFlux(it, path.join(pdir(id), "assets", name));
    return { src: fileUrl(id, name) };
  }

  // ---------- 选词 ----------
  // 用户系列用过的词（素材文件名）和这里做过的词，不再推荐
  const SERIES_DIR = cfg.seriesDir; // 可选：以前做过的系列素材文件夹，在 jobs/config.json 里填 seriesDir
  function usedWords() {
    const used = new Set();
    const walk = (dir, depth) => {
      let names = [];
      try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        if (e.isDirectory()) { if (depth < 4) walk(path.join(dir, e.name), depth + 1); continue; }
        if (!/\.(png|jpe?g|webp)$/i.test(e.name)) continue;
        const w = e.name.replace(/\.[^.]+$/, "").replace(/[\d\s()（）_-]+$/, "");
        if (/^[\u4e00-\u9fa5]{1,8}$/.test(w)) used.add(w);
      }
    };
    walk(SERIES_DIR, 0);
    for (const d of readdirSync(PROJECTS)) {
      try { for (const it of load(d).items || []) if (it.zh) used.add(it.zh); } catch {}
    }
    return [...used];
  }

  const BANK_FILE = path.join(DIR, "wordbank.json");
  const bank = (() => { try { return JSON.parse(readFileSync(BANK_FILE, "utf8")); } catch { return {}; } })();
  const refilling = new Map();
  const PAGE = 30;
  function refill(topic) {
    if (refilling.has(topic)) return refilling.get(topic);
    const job = generateWords(topic, (bank[topic] || []).map((x) => x.zh)).then((fresh) => {
      const old = bank[topic] || [];
      const known = new Set(old.map((x) => x.zh));
      bank[topic] = [...old, ...fresh.filter((x) => !known.has(x.zh))];
      writeFileSync(BANK_FILE, JSON.stringify(bank, null, 1));
    }).finally(() => refilling.delete(topic));
    refilling.set(topic, job);
    return job;
  }
  async function suggestWords(topic, exclude) {
    const used = new Set([...usedWords(), ...exclude]);
    const fresh = () => (bank[topic] || []).filter((x) => !used.has(x.zh));
    if (fresh().length < 12) await refill(topic);
    const rest = fresh().sort(() => Math.random() - 0.5);
    if (rest.length < PAGE * 2) refill(topic).catch(() => {}); // 后台补货，下次换一批还是秒出
    return rest.slice(0, PAGE);
  }

  async function generateWords(topic, exclude) {
    const skip = [...new Set([...usedWords(), ...exclude])].slice(0, 400);
    const prompt = `你在帮小红书账号"韩语快问快答"选词：观众看一张图，猜这个东西的韩语怎么说。
主题：${topic || "随机：从家里、街上、店里、学校、公司等不同场景各挑一些"}

列出 30 个词。逐条自查，不符合就换掉：
1. ${topic ? "每个词都必须是这个主题的场景里真实常见的东西。在别的地方更常见的不要（比如主题是浴室，就不要裤子、手表、圆珠笔）。" : "各场景混合，不要集中在一个场景。"}
2. 难度：天天见、一看图就认识，但多数韩语学习者说不出来。好的例子：粘毛器、美妆蛋、保鲜袋、门把手、搓澡巾、指甲刀、晾衣架、插线板、防滑垫、牙线。
3. 不要初级课本就会的词。坏的例子：镜子、毛巾、牙膏、袜子、雨伞、剪刀、钥匙、杯子、苹果、手机。
4. 必须是具体、能拍成一张照片看懂的东西；不要专业术语、品牌名、抽象概念、家电型号。
5. ko 用韩国人日常实际说的词，不要生造，不确定的词就换一个；zh 用简体中文，尽量短。
6. 不要用这些已经做过的词：${skip.join("、") || "（无）"}

只输出 JSON 数组，不要其他文字：[{"zh":"","ko":""}]`;
    const o = JSON.parse(await agent(prompt, { model: "sonnet", effort: "low" }));
    if (o.is_error) throw new Error(o.result || "Agent 调用失败");
    const t = o.result || "";
    const skipSet = new Set(skip);
    const seen = new Set();
    if (!t.includes("[")) throw new Error(`AI 没有返回词表：${t.slice(0, 120)}`);
    return JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1))
      .filter((x) => x?.zh && x?.ko && !skipSet.has(x.zh) && !seen.has(x.zh) && seen.add(x.zh))
      .map((x) => ({ zh: String(x.zh).trim(), ko: String(x.ko).trim() }));
  }

  // ---------- AI 填内容 ----------
  const parseLines = (raw) => String(raw || "").split(/[\n,，、]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12);

  async function aiFill(lines, question) {
    const prompt = `你在帮小红书账号做"韩语快问快答"短视频。用户输入了下面这些词（可能是中文、韩文，或者一个主题，比如"5个厨房用品"）：
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

输出这条视频的内容。如果输入是一个主题，就挑 5 个最常用、适合用一张图表达的词；否则按输入逐条输出，不增不减。
- ko：韩国人日常实际使用的韩语单词（不要拼音、不要括号）
- zh：简体中文词，尽量短
- en：英文名词，用来搜图
- prompt：英文的一句生图描述，主体明确，必须符合日常生活逻辑：画这个东西在现实中真实的样子和合理的摆放（比如蔬菜放在案板或木桌上、插头插在插座上；动作词要画出手正在做这个动作），不要奇怪、夸张或不合常理的组合
- promptZh：同样内容的中文生图提示词，给即梦用，格式："<主体和合理场景>，写实摄影，自然光影，干净背景，符合日常生活逻辑，4:3 横图，不要文字和水印"
- title：两行标题。第一行固定"韩语快问快答"；第二行总结这组词，比如"这些蔬菜你都知道吗?"，不超过 12 个字
- question：韩语提问。物品用"이게 뭐예요?"，动作用"뭐 하고 있어요?"，运动用"무슨 운동하세요?"${question ? `；这次用户指定用"${question}"` : ""}
- caption：小红书正文，80-150 字，口语化、带少量 emoji，最后一行 4-6 个话题标签

只输出 JSON，不要其他文字，字符串里不要用英文双引号：
{"title":["韩语快问快答","第二行"],"question":"이게 뭐예요?","items":[{"ko":"","zh":"","en":"","prompt":"","promptZh":""}],"caption":""}`;
    const o = JSON.parse(await agent(prompt, { model: "haiku" }));
    if (o.is_error) throw new Error(o.result || "Agent 调用失败");
    const t = o.result || "";
    const data = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    if (!Array.isArray(data.items) || !data.items.length || data.items.some((x) => !x.ko || !x.zh)) throw new Error("AI 返回的内容不完整");
    return data;
  }
  // 韩网校对：让 AI 真的去搜韩语网页；词和来源都必须出现在搜索结果里才算确认，不信它的自述
  const VERIFIED_FILE = path.join(DIR, "verified.json");
  const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
  const verifiedCache = readJson(VERIFIED_FILE, {});

  async function verifyWord(it) {
    const prompt = `你是韩国母语者，在给韩语学习视频校对单词。图片内容是：${it.zh}（${it.en || it.zh}）。现在配的韩语是：${it.ko}

用 WebSearch 搜韩语网页确认，查询词用韩语。优先看 쿠팡、네이버 쇼핑、네이버 블로그、나무위키、다이소몰 这类韩国人真实在用的地方。
判断标准：韩国人在生活里指着这个东西实际会怎么说，要自然、不要翻译腔、不要中文直译、不要只在词典里出现的说法。现在的词如果指的是别的东西，或者有更常用的叫法，就换掉。

规则：
- ko 只写一个最自然的词，不带括号和解释
- source 必须是这次搜索结果里真实出现的韩语网页地址，不要编造
- 没有搜到足够依据时 verified 写 false
- note 用一句中文说明依据或改动原因

最后只输出 JSON，不要其他文字：{"ko":"","verified":true,"source":"https://...","alternatives":[],"note":""}`;
    const o = JSON.parse(await agent(prompt, { model: "sonnet", effort: "low", web: true }));
    if (o.is_error) throw new Error(o.result || "Agent 调用失败");
    const t = o.result || "";
    if (!t.includes("{")) throw new Error(`校对没有返回结果：${t.slice(0, 80)}`);
    const r = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    const ko = String(r.ko || "").replace(/[(（].*$/, "").trim();
    if (!ko) throw new Error("校对结果是空的");
    // 只看搜索工具返回的内容，并去掉查询词本身，避免 AI 自己搜的词被当成证据
    const evidence = String(o.raw || "").split(/\r?\n/).filter((l) => l.includes("tool_result")).join("\n").replace(/Web search results for query: \\"[^\n]*?\\"/g, "");
    const source = String(r.source || "");
    let inResults = false;
    try { const u = new URL(source); inResults = evidence.includes(u.hostname) && evidence.includes(u.pathname.slice(0, 30)); } catch {}
    return {
      koDraft: it.ko, ko,
      verified: r.verified === true && inResults && evidence.includes(ko),
      source: inResults ? source : "",
      alternatives: Array.isArray(r.alternatives) ? r.alternatives.map(String).slice(0, 4) : [],
      note: String(r.note || "").slice(0, 120),
    };
  }

  async function verifyWords(items, onDone) {
    const queue = [...items];
    let done = 0;
    await Promise.all([0, 1].map(async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const cached = verifiedCache[it.zh];
        if (cached) Object.assign(it, cached);
        else {
          let result = null;
          for (let attempt = 0; attempt < 2 && !result?.verified; attempt++) {
            try { result = await verifyWord(it); } catch (e) { it.note = String(e.message).slice(0, 120); }
          }
          if (result) Object.assign(it, result);
          else it.verified = false;
          if (result?.verified) {
            verifiedCache[it.zh] = result;
            writeFileSync(VERIFIED_FILE, JSON.stringify(verifiedCache, null, 1));
          }
        }
        onDone(++done);
      }
    }));
  }
  // 用户自己写了"감자 土豆"这样的对照时，AI 不可用也能继续
  function manualFill(lines, question) {
    const items = lines.map((l) => {
      const ko = (l.match(/[가-힣][가-힣\s]*/) || [""])[0].trim();
      const zh = l.replace(/[가-힣]/g, "").replace(/[\s/|:：-]+/g, " ").trim();
      return { ko, zh, en: zh, prompt: zh, promptZh: `${zh}，写实摄影，自然光影，干净背景，符合日常生活逻辑，4:3 横图，不要文字和水印` };
    });
    if (items.some((x) => !x.ko || !x.zh)) return null;
    return { title: ["韩语快问快答", "这些词你都知道吗?"], question: question || QUESTIONS[0], items, caption: "" };
  }

  async function build(id, input) {
    const b = builds.get(id);
    const step = (stage, done = 0, total = 0) => Object.assign(b, { stage, done, total });
    const p = load(id);
    try {
      step("content");
      const lines = parseLines(input.words);
      let fill;
      try { fill = await aiFill(lines, input.question); }
      catch (e) {
        fill = manualFill(lines, input.question);
        if (!fill) throw new Error(`AI 填内容失败：${e.message}。可以按「감자 土豆」的格式把韩语和中文都写上再试。`);
        b.warnings.push("AI 没连上，已按你写的韩语和中文制作。");
      }
      const title = input.title?.filter((x) => x?.trim()).length ? input.title.filter((x) => x?.trim()) : fill.title;
      const question = input.question || fill.question || QUESTIONS[0];
      const items = fill.items.map((x) => ({ ...x, id: newId("i") }));
      step("verify", 0, items.length);
      await verifyWords(items, (n) => step("verify", n, items.length));
      const unverified = items.filter((x) => !x.verified);
      if (unverified.length) {
        b.hold = true; // 有没确认的词就不自动导出，留给用户看
        b.warnings.push(`这些词没查到韩网依据，导出前请确认：${unverified.map((x) => `${x.zh} ${x.ko}`).join("、")}`);
      }
      p.name = title[title.length - 1] || p.name;
      p.caption = fill.caption || "";
      save(p);

      if (input.imageSource !== "jimeng") {
        step("images", 0, items.length);
        let failures = 0, doneImages = 0;
        for (const it of items) { // 免费生图同一时间只能跑一张；额度用完后后面的也不用再试
          if (failures < 2) {
            try { it.image = (await makeImage(id, it)).src; }
            catch { failures++; }
          }
          step("images", ++doneImages, items.length);
        }
        const missing = items.filter((x) => !x.image).length;
        if (missing) b.hold = true;
        if (missing) b.warnings.push(`免费 AI 有 ${missing} 张图没生成出来（可能今天额度用完了），可以用即梦出图后拖进来。`);
      }

      step("voice", 0, items.length + 1);
      const voice = input.voice || "sunhi";
      const qVoice = await questionVoice(id, question, voice);
      let doneVoices = 1;
      for (const it of items) {
        const v = await tts(id, it.ko, voice);
        it.voice = v.src;
        it.voiceDur = v.dur;
        step("voice", ++doneVoices, items.length + 1);
      }

      step("timeline");
      const footnote = "图片为AI生成内容，仅供创作参考";
      const tl = buildTimeline({ title, question, footnote, items, questionVoice: qVoice, tick: await ensureTick() });
      save({ ...load(id), status: "ready", voice, bg: STYLE.bg, items, tracks: tl.tracks, clips: tl.clips, cover: items.find((x) => x.image)?.image || "", updatedAt: Date.now() });
      step("done");
      b.finished = true;
    } catch (e) {
      b.error = String(e.message).slice(0, 400);
      b.finished = true;
      save({ ...load(id), status: "failed", error: b.error });
    }
  }

  // ---------- 导出：前端传帧，这里拼起来 ----------
  const readRaw = (req, limit = 600 * 1024 * 1024) => new Promise((res, rej) => {
    const parts = []; let size = 0;
    req.on("data", (d) => { size += d.length; if (size > limit) { rej(new Error("文件太大")); req.destroy(); } else parts.push(d); });
    req.on("end", () => res(Buffer.concat(parts)));
    req.on("error", rej);
  });

  async function finishExport(id, session) {
    const p = load(id);
    const dur = session.frames.reduce((s, f) => s + f.repeat, 0) / session.fps;
    const list = session.frames.map((f) => `file '${f.file.replace(/\\/g, "/")}'\nduration ${(f.repeat / session.fps).toFixed(6)}`).join("\n");
    const last = session.frames[session.frames.length - 1];
    const listFile = path.join(session.dir, "list.txt");
    writeFileSync(listFile, `ffconcat version 1.0\n${list}\nfile '${last.file.replace(/\\/g, "/")}'\n`);
    const muted = new Set(p.tracks.filter((t) => t.muted).map((t) => t.id));
    const audio = p.clips.filter((c) => c.kind === "audio" && c.src && !muted.has(c.track) && c.start < dur);
    const args = ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile];
    audio.forEach((c) => args.push("-i", urlToFile(c.src)));
    const filters = audio.map((c, i) => `[${i + 1}:a]atrim=start=${c.offset || 0}:duration=${c.dur},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${c.volume ?? 1},adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`);
    if (audio.length) {
      filters.push(`${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,apad[aout]`);
      args.push("-filter_complex", filters.join(";"), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
    }
    args.push("-vf", "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-r", String(session.fps), "-t", dur.toFixed(3), "-movflags", "+faststart");
    // 写进作品库：和一键制作的任务同样的目录结构
    const jobId = p.jobId && jobs.some((j) => j.id === p.jobId) ? p.jobId : `tpl-${id}`;
    const dir = path.join(JOBS, jobId);
    const out = path.join(dir, "out");
    mkdirSync(out, { recursive: true });
    await new Promise((res, rej) => {
      const ff = spawn("ffmpeg", [...args, path.join(out, "成片.mp4")], { windowsHide: true });
      let err = "";
      ff.stderr.on("data", (d) => (err += d));
      ff.on("error", rej);
      ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg ${code}: ${err.slice(-400)}`))));
    });
    if (session.cover) {
      writeFileSync(path.join(out, "封面.jpg"), session.cover);
      rmSync(path.join(out, "封面_3比4.png"), { force: true }); // 旧版导出的封面会露答案
    }
    writeFileSync(path.join(out, "小红书文案.txt"), p.caption || "");
    writeFileSync(path.join(out, "summary.json"), JSON.stringify({ title: p.name, summary: "模板视频：韩语快问快答", uncertain: [] }));
    let job = jobs.find((j) => j.id === jobId);
    if (!job) {
      job = { id: jobId, vid: jobId, url: "", title: p.name, note: "", coverStyle: "band", accent: "", status: "done", steps: 0, stage: 5, last: "模板导出完成", dir, createdAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now() };
      jobs.push(job);
    }
    Object.assign(job, { title: p.name, status: "done", finishedAt: Date.now(), checked: false });
    saveJobs();
    save({ ...p, jobId, exportedAt: Date.now() });
    rmSync(session.dir, { recursive: true, force: true });
    return { video: `/files/${jobId}/out/${encodeURIComponent("成片.mp4")}`, folder: out };
  }

  // ---------- 路由 ----------
  return async function handle(req, res, u) {
    if (!u.pathname.startsWith("/api/tpl/")) return false;
    const seg = u.pathname.split("/").slice(3); // ["projects", id, action]
    const M = req.method;

    if (seg[0] === "font") {
      const f = { kr: "NotoSansKR-VF.ttf", sc: "NotoSansSC-VF.ttf" }[seg[1]];
      if (!f) { send(res, 404, { error: "no font" }); return true; }
      serveFile(res, path.join(cfg.fonts || "", f), req); // 没装字体时 404，页面退回系统字体
      return true;
    }
    if (seg[0] === "suggest" && M === "POST") {
      const { topic, exclude } = await body(req);
      send(res, 200, await suggestWords(String(topic || "").trim().slice(0, 30), Array.isArray(exclude) ? exclude.map(String).slice(0, 200) : []));
      return true;
    }
    if (seg[0] === "search") {
      send(res, 200, await searchPhotos(u.searchParams.get("q") || ""));
      return true;
    }
    if (seg[0] !== "projects") return false;

    const id = seg[1], action = seg[2];
    if (!id) {
      if (M === "GET") {
        const list = readdirSync(PROJECTS).filter((d) => existsSync(path.join(PROJECTS, d, "project.json"))).map((d) => {
          const p = load(d);
          return { id: p.id, name: p.name, status: p.status === "building" && !builds.has(d) ? "failed" : p.status, cover: p.cover, updatedAt: p.updatedAt, exportedAt: p.exportedAt, count: p.items?.length || 0 };
        }).sort((a, b) => b.updatedAt - a.updatedAt);
        send(res, 200, list);
        return true;
      }
      if (M === "POST") {
        const input = await body(req);
        if (!parseLines(input.words).length) throw new Error("先输入至少一个单词");
        const pid = newId("p");
        save({ id: pid, name: "新视频", template: "quickquiz", status: "building", w: 1080, h: 1920, fps: 30, bg: STYLE.bg, tracks: [], clips: [], items: [], caption: "", createdAt: Date.now(), updatedAt: Date.now() });
        builds.set(pid, { stage: "content", done: 0, total: 0, warnings: [] });
        build(pid, input);
        send(res, 200, { id: pid });
        return true;
      }
    }

    if (!action) {
      if (M === "GET") { send(res, 200, { project: load(id), build: builds.get(id) || null }); return true; }
      if (M === "PUT") {
        const next = await body(req);
        const cur = load(id);
        save({ ...cur, name: next.name ?? cur.name, bg: next.bg ?? cur.bg, caption: next.caption ?? cur.caption, tracks: next.tracks ?? cur.tracks, clips: next.clips ?? cur.clips, cover: next.cover ?? cur.cover, id: cur.id, updatedAt: Date.now() });
        send(res, 200, { ok: true });
        return true;
      }
      if (M === "DELETE") { rmSync(pdir(id), { recursive: true, force: true }); builds.delete(id); send(res, 200, { ok: true }); return true; }
    }

    if (action === "upload" && M === "POST") {
      const raw = u.searchParams.get("name") || "file";
      const ext = (path.extname(raw).toLowerCase().match(/^\.(png|jpe?g|webp|mp4|webm|mov|mp3|wav|m4a|aac)$/) || [])[0];
      if (!ext) throw new Error("只支持图片、视频和音频文件");
      const name = `up-${newId()}${ext}`;
      const file = path.join(pdir(id), "assets", name);
      writeFileSync(file, await readRaw(req));
      const mediaType = /png|jpe?g|webp/.test(ext) ? "image" : /mp3|wav|m4a|aac/.test(ext) ? "audio" : "video";
      send(res, 200, { src: fileUrl(id, name), mediaType, dur: mediaType === "image" ? 0 : await probeDuration(file), name: path.basename(raw, ext) });
      return true;
    }
    if (action === "tts" && M === "POST") {
      const { text, voice } = await body(req);
      if (!String(text || "").trim()) throw new Error("没有要配音的文字");
      send(res, 200, await tts(id, String(text).trim().slice(0, 200), voice || load(id).voice));
      return true;
    }
    if (action === "image" && M === "POST") {
      const { url, en, zh, prompt } = await body(req);
      if (url) {
        if (!/^https:\/\/([\w-]+\.)*wikimedia\.org\//.test(url)) throw new Error("只能使用图库搜索结果里的图片");
        const name = `image-${newId()}`;
        const tmp = path.join(pdir(id), "assets", `${name}.jpg`);
        const type = await fetchTo(url, tmp);
        const final = `${name}.${extOf(type)}`;
        if (final !== `${name}.jpg`) writeFileSync(path.join(pdir(id), "assets", final), readFileSync(tmp));
        send(res, 200, { src: fileUrl(id, final) });
      } else send(res, 200, await makeImage(id, { en, zh, prompt }));
      return true;
    }
    if (action === "export") {
      const sub = seg[3];
      if (sub === "start" && M === "POST") {
        const { fps } = await body(req);
        const dir = path.join(pdir(id), `_export-${newId()}`);
        mkdirSync(dir, { recursive: true });
        exportsMap.set(id, { dir, fps: fps || 30, frames: [], cover: null });
        send(res, 200, { ok: true });
        return true;
      }
      const session = exportsMap.get(id);
      if (!session) throw new Error("导出还没有开始");
      if (sub === "frame" && M === "POST") {
        const n = session.frames.length;
        const type = req.headers["content-type"]?.includes("jpeg") ? "jpg" : "png";
        const file = path.join(session.dir, `f${String(n).padStart(6, "0")}.${type}`);
        writeFileSync(file, await readRaw(req, 80 * 1024 * 1024));
        session.frames.push({ file, repeat: Math.max(1, Number(u.searchParams.get("repeat")) || 1) });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "cover" && M === "POST") { session.cover = await readRaw(req, 80 * 1024 * 1024); send(res, 200, { ok: true }); return true; }
      if (sub === "finish" && M === "POST") {
        exportsMap.delete(id);
        try { send(res, 200, await finishExport(id, session)); }
        catch (e) { rmSync(session.dir, { recursive: true, force: true }); throw e; }
        return true;
      }
    }
    return false;
  };
}
