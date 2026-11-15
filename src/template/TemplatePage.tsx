import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Clapperboard, Dices, Loader2, Plus, RefreshCw, Sparkles, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Editor } from "./Editor";
import type { Project } from "./render";

type Summary = { id: string; name: string; status: Project["status"]; cover?: string; updatedAt: number; exportedAt?: number; count: number };
// 放在组件外：切到别的页面再回来，生成进度不会丢
let activeBuild: { id: string; build: Build; autoExport: boolean } | null = null;
type Build = { stage: string; done: number; total: number; error?: string; warnings: string[]; finished?: boolean; hold?: boolean };
const STAGES = [
  { id: "content", label: "翻译单词、写标题和文案" },
  { id: "verify", label: "查韩网确认韩国人的说法" },
  { id: "images", label: "生成配图" },
  { id: "voice", label: "生成韩语配音" },
  { id: "timeline", label: "排进轨道" },
];
const TOPICS = ["随机", "厨房", "浴室", "卧室", "办公桌", "文具", "便利店", "美妆", "穿搭配饰", "清洁家务", "数码配件", "旅行", "医院药店", "健身", "宠物", "餐桌"];
const TARGET = 5;
const MAX_WORDS = 8;
type Word = { zh: string; ko?: string };
// 切到别的页面再回来，选好的词还在
const picker: { topic: string; words: Word[]; selected: string[] } = { topic: "", words: [], selected: [] };
const QUESTIONS = ["이게 뭐예요?", "뭐 하고 있어요?", "무슨 운동하세요?", "여기가 어디예요?"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} className={cn("h-8 rounded-full px-3 text-xs font-medium transition-colors", value === o.v ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TemplatePage() {
  const [topic, setTopic] = useState(picker.topic);
  const [words, setWordList] = useState<Word[]>(picker.words);
  const [selected, setSelected] = useState<string[]>(picker.selected);
  const [suggesting, setSuggesting] = useState(false);
  const [custom, setCustom] = useState("");
  const shown = useRef(new Set<string>());
  const requestId = useRef(0);
  useEffect(() => { Object.assign(picker, { topic, words, selected }); }, [topic, words, selected]);
  const [question, setQuestion] = useState("");
  const [voice, setVoice] = useState<"sunhi" | "injun">("sunhi");
  const [imageSource, setImageSource] = useState<"free" | "jimeng">("free");
  const [line2, setLine2] = useState("");
  const [list, setList] = useState<Summary[]>([]);
  const [building, setBuildingState] = useState(activeBuild);
  const setBuilding = useCallback((next: typeof activeBuild | ((b: typeof activeBuild) => typeof activeBuild)) => {
    activeBuild = typeof next === "function" ? next(activeBuild) : next;
    setBuildingState(activeBuild);
  }, []);
  const [open, setOpen] = useState<null | { project: Project; autoExport: boolean }>(null);

  const refresh = useCallback(() => { api<Summary[]>("/api/tpl/projects").then(setList).catch(() => {}); }, []);
  useEffect(refresh, [refresh]);

  const openProject = useCallback(async (id: string, autoExport = false) => {
    const { project } = await api<{ project: Project }>(`/api/tpl/projects/${id}`);
    setOpen({ project, autoExport });
  }, []);

  const start = async (autoExport: boolean) => {
    if (!selected.length) { toast("先选几个词"); return; }
    const lines = selected.join("\n");
    try {
      const { id } = await api<{ id: string }>("/api/tpl/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ words: lines, question, voice, imageSource, title: line2.trim() ? ["韩语快问快答", line2.trim()] : undefined }),
      });
      setBuilding({ id, autoExport: autoExport && imageSource !== "jimeng", build: { stage: "content", done: 0, total: 0, warnings: [] } });
    } catch (e) { toast.error((e as Error).message); }
  };

  // 换一批：保留选中的词，其余换新；同一主题下出现过的不再出现
  const suggest = async (nextTopic: string) => {
    const label = nextTopic === "随机" ? "" : nextTopic;
    if (nextTopic !== topic) shown.current.clear();
    setTopic(nextTopic);
    setSuggesting(true);
    const id = ++requestId.current;
    try {
      const fresh = await api<Word[]>("/api/tpl/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: label, exclude: [...shown.current, ...selected] }),
      });
      if (id !== requestId.current) return;
      fresh.forEach((w) => shown.current.add(w.zh));
      setWordList((old) => [...old.filter((w) => selected.includes(w.zh)), ...fresh]);
      if (!fresh.length) toast("这次没有新词了，换个主题试试");
    } catch (e) {
      if (id === requestId.current) toast.error(`出词失败：${(e as Error).message}`);
    } finally {
      if (id === requestId.current) setSuggesting(false);
    }
  };
  const toggleWord = (zh: string) => {
    if (selected.includes(zh)) { setSelected(selected.filter((x) => x !== zh)); return; }
    if (selected.length >= MAX_WORDS) { toast(`一条视频最多 ${MAX_WORDS} 个词`); return; }
    setSelected([...selected, zh]);
  };
  const pickRandom = () => {
    const rest = words.map((w) => w.zh).filter((zh) => !selected.includes(zh)).sort(() => Math.random() - 0.5);
    setSelected([...selected, ...rest.slice(0, Math.max(0, TARGET - selected.length))]);
  };
  const addCustom = () => {
    const zh = custom.trim();
    if (!zh) return;
    setCustom("");
    if (selected.length >= MAX_WORDS && !selected.includes(zh)) { toast(`一条视频最多 ${MAX_WORDS} 个词`); return; }
    setWordList((old) => (old.some((w) => w.zh === zh) ? old : [{ zh }, ...old]));
    setSelected((old) => (old.includes(zh) ? old : [...old, zh]));
  };

  // 跟进生成进度
  useEffect(() => {
    if (!building || building.build.finished) return;
    const timer = setInterval(async () => {
      try {
        const { build } = await api<{ build: Build | null }>(`/api/tpl/projects/${building.id}`);
        if (!build) return;
        setBuilding((b) => (b ? { ...b, build } : b));
        if (build.finished) {
          clearInterval(timer);
          refresh();
          build.warnings.forEach((w) => toast.warning(w));
          if (!build.error) {
            setBuilding(null);
            setSelected([]);
            openProject(building.id, building.autoExport && !build.hold);
          }
        }
      } catch { /* 下一轮再试 */ }
    }, 800);
    return () => clearInterval(timer);
  }, [building?.id, building?.build.finished, building?.autoExport, openProject, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (id: string) => {
    if (!window.confirm("删除这个项目和它的素材？已导出到作品库的成片不受影响。")) return;
    await api(`/api/tpl/projects/${id}`, { method: "DELETE" });
    refresh();
  };

  if (open) return <Editor initial={open.project} autoExport={open.autoExport} onBack={() => { setOpen(null); refresh(); }} />;

  const stageIdx = building ? STAGES.findIndex((s) => s.id === building.build.stage) : -1;
  return (
    <div className="mx-auto max-w-[920px] px-10 py-10">
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">输入单词，直接出片</p>
        <h1 className="text-[34px] font-bold tracking-tight">模板</h1>
      </div>

      <section className="rounded-3xl bg-card p-6 shadow-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-[72px] w-[41px] shrink-0 place-items-center rounded-md bg-[#BBD0C9] text-[8px] font-medium leading-tight text-[#1E3D2C]">이게<br />뭐예요?</div>
          <div>
            <h2 className="font-semibold">韩语快问快答</h2>
            <p className="text-sm text-muted-foreground">看图猜单词，3 秒倒计时后揭晓答案。每题约 5 秒，5 题约 26 秒。</p>
          </div>
        </div>

        {building ? (
          <div className="rounded-2xl bg-secondary/60 p-5">
            {building.build.error ? (
              <>
                <p className="font-medium text-destructive">没有做成</p>
                <p className="mt-1 text-sm text-muted-foreground">{building.build.error}</p>
                <Button variant="outline" size="sm" className="mt-3 rounded-full" onClick={() => setBuilding(null)}>回去修改</Button>
              </>
            ) : (
              <ol className="space-y-2.5">
                {STAGES.map((s, i) => (
                  <li key={s.id} className={cn("flex items-center gap-2.5 text-sm", i > stageIdx && stageIdx >= 0 && "text-muted-foreground")}>
                    {i < stageIdx || stageIdx < 0 ? <Check className="size-4 text-[var(--success)]" /> : i === stageIdx ? <Loader2 className="size-4 animate-spin text-primary" /> : <span className="grid size-4 place-items-center"><span className="size-1.5 rounded-full bg-muted-foreground/50" /></span>}
                    {s.label}
                    {i === stageIdx && building.build.total > 0 && <span className="tabular-nums text-muted-foreground">{building.build.done}/{building.build.total}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); suggest(topic.trim() || "随机"); }}>
                <Input aria-label="主题" value={topic === "随机" ? "" : topic} onChange={(e) => setTopic(e.target.value)} placeholder="输入主题，比如：露营、理发店、搬家" className="h-10 flex-1 rounded-full text-sm" />
                <Button type="submit" variant="secondary" className="h-10 rounded-full" disabled={suggesting}>{suggesting ? <Loader2 className="animate-spin" /> : <Sparkles />}出词</Button>
              </form>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {TOPICS.map((x) => (
                  <button key={x} type="button" onClick={() => suggest(x)} className={cn("flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors", topic === x ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground")}>
                    {x === "随机" && <Dices className="size-3.5" />}{x}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-secondary/50 p-3.5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">选词</span>
                <span className={cn("text-xs tabular-nums", selected.length === TARGET ? "font-medium text-[var(--success)]" : "text-muted-foreground")}>已选 {selected.length} / {TARGET}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" className="h-7 rounded-full text-xs" disabled={!words.length} onClick={pickRandom}><Dices />随机选满</Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 rounded-full text-xs" disabled={!topic || suggesting} onClick={() => suggest(topic)}><RefreshCw className={cn(suggesting && "animate-spin")} />换一批</Button>
                </div>
              </div>
              {words.length > 0 ? (
                <div className={cn("flex max-h-72 flex-wrap gap-1.5 overflow-y-auto transition-opacity", suggesting && "opacity-50")}>
                  {words.map((w) => {
                    const on = selected.includes(w.zh);
                    return (
                      <button key={w.zh} type="button" aria-pressed={on} onClick={() => toggleWord(w.zh)} className={cn("flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors", on ? "border-foreground bg-foreground text-background" : "border-transparent bg-card hover:border-border")}>
                        {on && <Check className="size-3.5" />}
                        <span className="font-medium">{w.zh}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="grid min-h-28 place-items-center text-center text-sm text-muted-foreground">
                  {suggesting ? <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在想词，第一次大约 15 秒…</span> : "点一个主题，或者试试「随机」"}
                </div>
              )}
              <form className="mt-3 flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); addCustom(); }}>
                <Input aria-label="自己加一个词" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="自己加一个词，回车" className="h-8 w-44 rounded-full bg-card text-xs" />
                <button type="submit" aria-label="添加这个词" disabled={!custom.trim()} className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:opacity-35 [&_svg]:size-4"><Plus /></button>
              </form>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">问题</span>
                <Choice value={question} onChange={setQuestion} options={[{ v: "", label: "自动" }, ...QUESTIONS.map((q) => ({ v: q, label: q }))]} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid content-start gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">配音</span>
                  <Choice value={voice} onChange={setVoice} options={[{ v: "sunhi", label: "女声" }, { v: "injun", label: "男声" }]} />
                </div>
                <div className="grid content-start gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">配图</span>
                  <Choice value={imageSource} onChange={setImageSource} options={[{ v: "free", label: "免费 AI" }, { v: "jimeng", label: "我用即梦" }]} />
                </div>
              </div>
            </div>
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              标题第二行（不填就自动写）
              <Input value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="这些蔬菜你都知道吗?" className="text-sm text-foreground" />
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button className="rounded-full" disabled={!selected.length} onClick={() => start(true)}><Wand2 />一键出片</Button>
              <Button variant="outline" className="rounded-full" disabled={!selected.length} onClick={() => start(false)}><Clapperboard />生成后先剪辑</Button>
              <span className="self-center text-xs text-muted-foreground"><Sparkles className="mr-1 inline size-3.5" />配图和配音都免费。选「我用即梦」时会先进剪辑器补图</span>
            </div>
          </div>
        )}
      </section>

      {list.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-[22px] font-semibold tracking-tight">我的项目</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {list.map((p) => (
              <div key={p.id} className="group relative overflow-hidden rounded-2xl bg-card shadow-card">
                <button className="block w-full text-left" disabled={p.status !== "ready"} onClick={() => openProject(p.id)}>
                  <div className="aspect-[4/3] bg-secondary">{p.cover && <img src={p.cover} alt="" className="size-full object-cover" />}</div>
                  <div className="p-3">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{p.status === "failed" ? "没有生成成功" : p.status === "building" ? "生成中…" : p.exportedAt ? "已导出" : "草稿"}{p.count ? ` · ${p.count} 个词` : ""}</div>
                  </div>
                </button>
                <button aria-label={`删除 ${p.name}`} onClick={() => remove(p.id)} className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 [&_svg]:size-3.5"><Trash2 /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
