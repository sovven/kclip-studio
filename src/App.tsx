import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle, Check, Clapperboard, Compass, Copy, Eye, Film, FolderOpen, GripVertical, Library, Loader2,
  Monitor, Moon, Play, Plus, RotateCw, Search, Sparkles, Sun, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useStudio, type CoverStyle, type Draft, type Job, type Page, type Theme, type Video } from "@/store";

const COVER: Record<CoverStyle, { label: string; hint: string }> = {
  band: { label: "黑底大标题", hint: "外研社同款，稳" },
  poster: { label: "大字报", hint: "信息流最抢眼" },
  card: { label: "韩中对照卡", hint: "学习感最强" },
  reels: { label: "Reels 款", hint: "ins 爆款同款" },
};
const ACCENTS = [
  { c: "#8fd3ff", n: "浅蓝" }, { c: "#c6f432", n: "荧光绿" }, { c: "#ffde3b", n: "黄" }, { c: "#ff7ab6", n: "粉" }, { c: "#ffffff", n: "白" },
];
const STAGES = ["下载", "听写", "字幕", "渲染", "封面", "文案"];
const fmtViews = (n: number) => (!n ? "—" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));
const fmtDur = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

/* ============ 通用 ============ */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { v: T; icon?: React.ReactNode; label?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-full bg-secondary p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          aria-label={o.label}
          className={cn(
            "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-all [&_svg]:size-3.5",
            value === o.v && "bg-card text-foreground shadow-sm",
          )}
        >
          {o.icon}
          {o.label && !o.icon && o.label}
        </button>
      ))}
    </div>
  );
}

function SectionHead({ title, sub, action }: { title: string; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-end gap-3">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight">{title}</h2>
        {sub && <p className="mt-0.5 text-sm text-muted-foreground">{sub}</p>}
      </div>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

function PageTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-8">
      <p className="text-sm font-medium text-muted-foreground">{sub}</p>
      <h1 className="text-[34px] font-bold tracking-tight">{title}</h1>
    </div>
  );
}

function Empty({ icon, title, text, action }: { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-3xl bg-card px-6 py-14 text-center shadow-card [&>svg]:size-9 [&>svg]:text-muted-foreground/60">
      {icon}
      <div className="mt-1 font-semibold">{title}</div>
      <div className="max-w-sm text-sm text-muted-foreground">{text}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/* ============ 侧边栏 ============ */
function Sidebar() {
  const { page, setPage, theme, setTheme, drafts, jobs, loggedIn } = useStudio();
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length + drafts.length;
  const done = jobs.filter((j) => j.status === "done").length;
  const nav: { id: Page; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "discover", label: "发现", icon: <Compass /> },
    { id: "studio", label: "制作", icon: <Clapperboard />, count: active },
    { id: "library", label: "作品库", icon: <Library />, count: done },
  ];
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 py-5">
      <div className="mb-7 flex items-center gap-2.5 px-2">
        <div className="grid size-9 place-items-center rounded-[10px] bg-gradient-to-b from-[#3a3a3c] to-black text-[15px] font-bold text-white shadow-sm dark:from-white dark:to-[#d1d1d6] dark:text-black">K</div>
        <div className="leading-tight">
          <div className="text-[15px] font-semibold">KCLIP Studio</div>
          <div className="text-xs text-muted-foreground">韩语短视频工作台</div>
        </div>
      </div>
      <nav className="space-y-0.5">
        {nav.map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent [&_svg]:size-[18px]",
              page === n.id && "bg-sidebar-accent text-sidebar-foreground",
            )}
          >
            <span className={cn("text-muted-foreground", page === n.id && "text-primary")}>{n.icon}</span>
            {n.label}
            {!!n.count && <span className="ml-auto rounded-full bg-secondary px-2 text-xs tabular-nums text-muted-foreground">{n.count}</span>}
          </button>
        ))}
      </nav>
      <div className="mt-auto space-y-3">
        <div className="rounded-xl bg-card p-3 text-xs shadow-card">
          <div className="flex items-center gap-2 font-medium">
            <span className={cn("size-2 rounded-full", loggedIn ? "bg-[var(--success)]" : loggedIn === false ? "bg-[var(--warning)]" : "bg-muted-foreground")} />
            {loggedIn ? "Agent 就绪" : loggedIn === false ? "Agent 未登录" : "检查中…"}
          </div>
          <p className="mt-1 leading-relaxed text-muted-foreground">{loggedIn === false ? "终端运行 claude → /login" : "Claude Code · xhs-bilingual-clip"}</p>
        </div>
        <div className="flex items-center justify-between px-1">
          <span className="text-xs text-muted-foreground">外观</span>
          <Segmented<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { v: "light", icon: <Sun />, label: "浅色" },
              { v: "dark", icon: <Moon />, label: "深色" },
              { v: "system", icon: <Monitor />, label: "跟随系统" },
            ]}
          />
        </div>
      </div>
    </aside>
  );
}

/* ============ 发现 ============ */
function PickCard({ v }: { v: Video }) {
  const { openDetail } = useStudio();
  const ai = v.ai!;
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={() => openDetail(v)}
      className="group flex gap-4 rounded-3xl bg-card p-3 text-left shadow-card transition-transform hover:-translate-y-0.5"
    >
      <div className="relative aspect-[4/5] w-32 shrink-0 overflow-hidden rounded-2xl bg-muted">
        <img src={v.thumb} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-1.5 text-[11px] font-medium text-white backdrop-blur">{fmtDur(v.duration)}</span>
      </div>
      <div className="min-w-0 flex-1 py-1">
        <div className="flex items-center gap-2">
          <span className="text-[17px] font-semibold tracking-tight">{ai.zh_title}</span>
          <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary">{ai.score}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-foreground/80">{ai.summary}</p>
        <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">“{ai.why}”</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {ai.tags.map((t) => <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{t}</span>)}
        </div>
      </div>
    </motion.button>
  );
}

function GalleryCard({ v }: { v: Video }) {
  const { openDetail, jobs } = useStudio();
  const job = jobs.find((j) => j.vid === v.id);
  const title = v.ai?.zh_title || v.title.replace(/#[^\s#]+/g, "").trim() || v.title;
  return (
    <motion.button layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={() => openDetail(v)} className="group text-left">
      <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-muted shadow-card">
        <img src={v.thumb} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-3 pt-12">
          <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-white">{title}</div>
          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-white/75">
            <Eye className="size-3" />{fmtViews(v.views)}
            <span className="ml-auto max-w-[60%] truncate">{v.channel}</span>
          </div>
        </div>
        {job && <span className="absolute left-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-black">{job.status === "done" ? "已制作" : "制作中"}</span>}
      </div>
    </motion.button>
  );
}

function Discover() {
  const { categories, selected, toggleCat, videos, loading, picks, picking, recommend, query, search, searching, results, loggedIn, trending, buzz } = useStudio();
  const [q, setQ] = useState(query);
  const [dur, setDur] = useState<"all" | "60">("60");
  const [sort, setSort] = useState<"hot" | "mix">("hot");
  const pool = useMemo(() => {
    const base = query ? results : selected.flatMap((c) => videos[c] || []);
    const seen = new Set<string>();
    let list = base.filter((v) => !seen.has(v.id) && seen.add(v.id));
    if (dur === "60") list = list.filter((v) => v.duration == null || v.duration <= 60);
    return sort === "hot" ? [...list].sort((a, b) => b.views - a.views) : list;
  }, [query, results, selected, videos, dur, sort]);
  const isLoading = searching || selected.some((c) => loading[c]);

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageTitle title="发现" sub={today} />

      <form
        onSubmit={(e) => { e.preventDefault(); search(q); }}
        className="relative mb-5"
      >
        <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜韩国短视频，比如：수상소감、숏박스、아이돌 예능…"
          className="h-12 rounded-full border-0 bg-card pl-11 pr-24 text-[15px] shadow-card focus-visible:ring-2"
        />
        {query && (
          <button type="button" onClick={() => { setQ(""); search(""); }} className="absolute right-20 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="清除"><X className="size-4" /></button>
        )}
        <Button type="submit" className="absolute right-1.5 top-1/2 h-9 -translate-y-1/2 rounded-full px-4">搜索</Button>
      </form>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {categories.map((c) => {
          const on = selected.includes(c.id);
          return (
            <button
              key={c.id}
              onClick={() => toggleCat(on ? selected.filter((x) => x !== c.id) : [...selected, c.id])}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors",
                on ? "bg-foreground text-background" : "bg-card text-foreground/80 shadow-card hover:bg-accent",
              )}
            >
              {on && <Check className="size-3.5" />}
              {c.label}
              {loading[c.id] && <Loader2 className="size-3 animate-spin" />}
            </button>
          );
        })}
      </div>

      {buzz.length > 0 && (
        <div className="mb-3 flex items-center gap-3 overflow-hidden">
          <span className="w-28 shrink-0 text-xs font-semibold text-muted-foreground">韩网热议 · theqoo</span>
          <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
            {buzz.map((t) => (
              <button key={t.ko} title={t.why} onClick={() => { setQ(t.ko); search(t.ko); }} className="shrink-0 rounded-full bg-card px-3 py-1 text-xs shadow-card transition-colors hover:bg-accent">
                {t.zh}
              </button>
            ))}
          </div>
        </div>
      )}
      {trending.length > 0 && (
        <div className="mb-10 flex items-center gap-3 overflow-hidden">
          <span className="w-28 shrink-0 text-xs font-semibold text-muted-foreground">音源榜 · Melon</span>
          <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
            {trending.slice(0, 16).map((t, i) => (
              <button
                key={t.tag}
                onClick={() => { setQ(t.query); search(t.query); }}
                title={`Melon 最高第 ${t.best} 名：${t.songs.join("、")}`}
                className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-secondary"
              >
                <span className={cn("tabular-nums", i < 3 ? "font-semibold text-primary" : "text-muted-foreground")}>{i + 1}</span>
                {t.tag}
                <span className="text-muted-foreground">《{t.songs[0]}》</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!trending.length && <div className="mb-10" />}

      <section className="mb-12">
        <SectionHead
          title="今日推荐"
          sub={<span className="flex items-center gap-1"><Sparkles className="size-3.5 text-primary" /> Claude 从已选板块里挑出有梗、容易共鸣的片段</span>}
          action={
            <Button variant="secondary" className="rounded-full" disabled={picking || !selected.length || loggedIn === false} onClick={recommend}>
              {picking ? <Loader2 className="animate-spin" /> : <RotateCw />} {picks.length ? "重新挑选" : "帮我挑 8 条"}
            </Button>
          }
        />
        {picking ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-44 rounded-3xl" />)}</div>
        ) : picks.length ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{picks.map((v) => <PickCard key={v.id} v={v} />)}</div>
        ) : (
          <Empty
            icon={<Sparkles />}
            title="还没想好做什么？"
            text={loggedIn === false ? "Agent 还没登录：在终端运行 claude，输入 /login 后刷新本页。" : "让 Claude 帮你挑 8 条，每条写好内容简介和推荐理由，大约 1 分钟。"}
            action={<Button className="rounded-full" disabled={picking || !selected.length || loggedIn === false} onClick={recommend}><Sparkles /> 帮我挑 8 条</Button>}
          />
        )}
      </section>

      <section>
        <SectionHead
          title={query ? `“${query}” 的搜索结果` : "素材广场"}
          sub={isLoading ? "正在从 YouTube 抓取…" : `${pool.length} 条短视频 · 2 分钟以内 · 已排除体育和时政`}
          action={
            <div className="flex gap-2">
              <Segmented value={dur} onChange={setDur} options={[{ v: "all", label: "全部时长" }, { v: "60", label: "≤ 60 秒" }]} />
              <Segmented value={sort} onChange={setSort} options={[{ v: "hot", label: "最热" }, { v: "mix", label: "默认" }]} />
            </div>
          }
        />
        {isLoading && !pool.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[9/16] rounded-2xl" />)}</div>
        ) : pool.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">{pool.map((v) => <GalleryCard key={v.id} v={v} />)}</div>
        ) : (
          <Empty icon={<Compass />} title="选一个板块开始" text="点上面的胶囊标签，或者直接搜索关键词。" />
        )}
      </section>
    </div>
  );
}

/* ============ 详情抽屉 ============ */
function CoverMock({ s }: { s: CoverStyle }) {
  if (s === "band")
    return (
      <div className="flex h-full flex-col bg-black p-1.5">
        <div className="mx-auto mt-1 h-1.5 w-3/4 rounded-full bg-white" /><div className="mx-auto mt-1 h-1.5 w-1/2 rounded-full bg-sky-300" />
        <div className="my-2 flex-1 rounded-sm bg-neutral-500" />
        <div className="mx-auto h-1 w-2/3 rounded-full bg-yellow-300" /><div className="mx-auto mb-1 mt-1 h-1 w-1/2 rounded-full bg-white/80" />
      </div>
    );
  if (s === "poster")
    return (
      <div className="relative h-full bg-gradient-to-b from-neutral-400 to-neutral-800 p-1.5">
        <div className="absolute inset-x-1.5 bottom-2 space-y-1"><div className="h-1 w-1/2 rounded-full bg-yellow-300" /><div className="h-2.5 w-full rounded-sm bg-white" /><div className="h-2.5 w-4/5 rounded-sm bg-yellow-300" /></div>
      </div>
    );
  if (s === "reels")
    return (
      <div className="relative h-full bg-gradient-to-b from-neutral-300 via-neutral-500 to-neutral-900">
        <div className="absolute inset-x-1.5 bottom-3 space-y-1"><div className="h-1.5 w-4/5 rounded-full bg-white" /><div className="h-1.5 w-3/5 rounded-full bg-lime-300" /><div className="h-1 w-2/5 rounded-full bg-white/60" /></div>
      </div>
    );
  return (
    <div className="flex h-full flex-col bg-[#f6f3ec]">
      <div className="h-3/5 bg-neutral-500" />
      <div className="space-y-1 p-1.5"><div className="h-1 w-1/3 rounded-full bg-red-500" /><div className="h-2 w-full rounded-sm bg-neutral-900" /><div className="h-1 w-2/3 rounded-full bg-neutral-400" /></div>
    </div>
  );
}

function DetailSheet() {
  const { detail: v, openDetail, produce, addDraft, jobs, loggedIn } = useStudio();
  const [cover, setCover] = useState<CoverStyle>("band");
  const [note, setNote] = useState("");
  const [accent, setAccent] = useState(ACCENTS[0].c);
  useEffect(() => { if (v) { setCover(v.ai?.cover_style || "band"); setNote(""); } }, [v]);
  const job = v && jobs.find((j) => j.vid === v.id && j.status !== "failed");
  return (
    <Sheet open={!!v} onOpenChange={(o) => !o && openDetail(null)}>
      <SheetContent className="w-full gap-0 overflow-y-auto border-l-0 p-0 sm:max-w-[520px]">
        {v && (
          <>
            <div className="aspect-video w-full bg-black">
              <iframe className="size-full" src={`https://www.youtube.com/embed/${v.id}`} title={v.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
            </div>
            <div className="space-y-6 p-6">
              <SheetHeader className="p-0">
                <SheetTitle className="text-xl font-semibold leading-snug tracking-tight">{v.ai?.zh_title || v.title}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {v.ai && <span className="line-clamp-1">{v.title}</span>}
                  <span>{v.channel}</span>
                  {!!v.views && <span>{fmtViews(v.views)} 次观看</span>}
                  {v.duration != null && <span>{fmtDur(v.duration)}</span>}
                </SheetDescription>
              </SheetHeader>

              {v.ai && (
                <div className="space-y-2 rounded-2xl bg-secondary/60 p-4 text-sm">
                  <div className="flex items-center gap-1.5 font-semibold"><Sparkles className="size-4 text-primary" /> AI 解读 <span className="ml-auto text-xs font-medium text-primary">推荐度 {v.ai.score}/10</span></div>
                  <p>{v.ai.summary}</p>
                  <p className="text-muted-foreground">{v.ai.why}</p>
                </div>
              )}

              <div>
                <div className="mb-2.5 text-sm font-semibold">封面样式</div>
                <div className="grid grid-cols-4 gap-2.5">
                  {(Object.keys(COVER) as CoverStyle[]).map((s) => (
                    <button key={s} onClick={() => setCover(s)} className="text-left">
                      <div className={cn("aspect-[3/4] overflow-hidden rounded-xl ring-2 ring-transparent transition", cover === s ? "ring-primary" : "hover:ring-border")}>
                        <CoverMock s={s} />
                      </div>
                      <div className="mt-1.5 text-xs font-medium">{COVER[s].label}</div>
                      <div className="text-[11px] text-muted-foreground">{COVER[s].hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2.5 text-sm font-semibold">高亮色 <span className="font-normal text-muted-foreground">（标题关键词、封面）</span></div>
                <div className="flex gap-2.5">
                  {ACCENTS.map((x) => (
                    <Tooltip key={x.c}>
                      <TooltipTrigger asChild>
                        <button onClick={() => setAccent(x.c)} aria-label={x.n} className={cn("size-8 rounded-full ring-2 ring-offset-2 ring-offset-background transition", accent === x.c ? "ring-primary" : "ring-transparent")} style={{ background: x.c, boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }} />
                      </TooltipTrigger>
                      <TooltipContent>{x.n}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm font-semibold">给 Agent 的备注 <span className="font-normal text-muted-foreground">（可选）</span></div>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：标题想突出“获奖感言”；重点讲 주눅 들다 这个词…" className="min-h-20 rounded-xl" />
              </div>

              <div className="space-y-2">
                <Button
                  size="lg"
                  className="h-12 w-full rounded-full text-[15px]"
                  disabled={!!job || loggedIn === false}
                  onClick={() => produce([{ video: v, coverStyle: cover, note, accent }]).then(() => { toast.success("已交给 Agent 制作", { description: "在「制作」里看进度" }); openDetail(null); })}
                >
                  <Clapperboard /> {job ? (job.status === "done" ? "已经做过了" : "正在制作中") : "一键制作"}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  className="h-12 w-full rounded-full text-[15px]"
                  onClick={() => { addDraft({ ...v, ai: v.ai ? { ...v.ai, cover_style: cover } : v.ai }); toast("已加入待制作清单"); }}
                >
                  <Plus /> 加入清单，稍后批量做
                </Button>
                <p className="pt-1 text-center text-xs text-muted-foreground">产出：成片 · 3:4 封面 · 小红书文案 · 剪映分层素材 ｜ 约 10–20 分钟</p>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ============ 制作 ============ */
function DraftRow({ d }: { d: Draft }) {
  const { updateDraft, removeDraft } = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: d.video.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-3 rounded-2xl bg-card p-2.5 shadow-card", isDragging && "z-10 shadow-xl")}>
      <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground/60 hover:text-foreground" aria-label="拖动排序"><GripVertical className="size-4" /></button>
      <img src={d.video.thumb} alt="" className="h-12 w-20 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{d.video.ai?.zh_title || d.video.title}</div>
        <div className="mt-1 flex gap-1">
          {(Object.keys(COVER) as CoverStyle[]).map((s) => (
            <button key={s} onClick={() => updateDraft(d.video.id, { coverStyle: s })} className={cn("rounded-full px-2 py-0.5 text-[11px]", d.coverStyle === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{COVER[s].label}</button>
          ))}
        </div>
      </div>
      <button onClick={() => removeDraft(d.video.id)} className="p-1 text-muted-foreground/60 hover:text-destructive" aria-label="移除"><Trash2 className="size-4" /></button>
    </div>
  );
}

function Pipeline({ j }: { j: Job }) {
  const { retry } = useStudio();
  const stage = j.status === "done" ? STAGES.length : Math.max(0, j.stage ?? 0);
  const mins = j.startedAt ? Math.max(1, Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 60000)) : 0;
  return (
    <div className="rounded-2xl bg-card p-4 shadow-card">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold">{j.outputs?.summary?.title || j.title}</div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {j.status === "queued" ? "排队中" : j.status === "running" ? `已用 ${mins} 分钟` : j.status === "failed" ? "失败" : "完成"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-6 gap-1.5">
        {STAGES.map((s, i) => {
          const doneStep = i < stage, cur = i === stage && j.status === "running";
          return (
            <div key={s}>
              <div className={cn("h-1.5 rounded-full bg-secondary", doneStep && "bg-primary", cur && "animate-pulse bg-primary/50", j.status === "failed" && i === stage && "bg-destructive")} />
              <div className={cn("mt-1.5 text-center text-[11px] text-muted-foreground", (doneStep || cur) && "text-foreground")}>{s}</div>
            </div>
          );
        })}
      </div>
      {j.status === "running" && <p className="mt-3 truncate text-xs text-muted-foreground">正在：{j.last}</p>}
      {j.status === "failed" && (
        <div className="mt-3 flex items-start gap-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="flex-1">{j.error}</span>
          <Button size="xs" variant="secondary" className="rounded-full" onClick={() => retry(j.id)}><RotateCw /> 重试</Button>
        </div>
      )}
    </div>
  );
}

function Studio() {
  const { drafts, jobs, reorder, produce, setPage, loggedIn } = useStudio();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    reorder(drafts.findIndex((d) => d.video.id === e.active.id), drafts.findIndex((d) => d.video.id === e.over!.id));
  };
  const live = jobs.filter((j) => j.status !== "done");
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageTitle title="制作" sub="Agent 一次做一条，每条约 10–20 分钟，电脑别休眠" />
      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <SectionHead
            title="待制作清单"
            sub="拖动调整先后顺序"
            action={drafts.length > 0 && <Button className="rounded-full" disabled={loggedIn === false} onClick={() => produce().then(() => toast.success(`${drafts.length} 条已开始排队`))}><Clapperboard /> 全部开始（{drafts.length}）</Button>}
          />
          {drafts.length ? (
            <div className="space-y-2.5">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={drafts.map((d) => d.video.id)} strategy={verticalListSortingStrategy}>
                  {drafts.map((d) => <DraftRow key={d.video.id} d={d} />)}
                </SortableContext>
              </DndContext>
            </div>
          ) : (
            <Empty icon={<Plus />} title="清单是空的" text="在「发现」里打开视频，点「加入清单」。" action={<Button variant="secondary" className="rounded-full" onClick={() => setPage("discover")}>去发现</Button>} />
          )}
        </section>
        <section>
          <SectionHead title="进行中" sub={`${live.length} 个任务`} />
          {live.length ? <div className="space-y-3">{live.map((j) => <Pipeline key={j.id} j={j} />)}</div> : <Empty icon={<Film />} title="没有进行中的任务" text="完成的作品会出现在「作品库」。" />}
        </section>
      </div>
    </div>
  );
}

/* ============ 作品库 ============ */
function WorkCard({ j }: { j: Job }) {
  const o = j.outputs || {};
  const [showCap, setShowCap] = useState(false);
  return (
    <div className="group">
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-muted shadow-card">
        {o.cover ? <img src={o.cover} alt="封面" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-muted-foreground"><Film /></div>}
        {!!o.summary?.uncertain?.length && (
          <Tooltip>
            <TooltipTrigger asChild><span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-[var(--warning)] px-2 py-0.5 text-[11px] font-semibold text-black"><AlertTriangle className="size-3" /> 待检查 {o.summary.uncertain.length}</span></TooltipTrigger>
            <TooltipContent className="max-w-xs">有 {o.summary.uncertain.length} 句听不清已删掉，发之前看一遍：{o.summary.uncertain.join(" / ")}</TooltipContent>
          </Tooltip>
        )}
        <div className="absolute inset-x-2 bottom-2 flex gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          {o.video && <Button size="sm" className="flex-1 rounded-full" asChild><a href={o.video} target="_blank" rel="noreferrer"><Play className="fill-current" /> 播放</a></Button>}
          {o.caption && <Button size="icon-sm" variant="secondary" className="rounded-full" aria-label="复制文案" onClick={() => { navigator.clipboard.writeText(o.caption!); toast.success("文案已复制"); }}><Copy /></Button>}
          {o.folder && <Button size="icon-sm" variant="secondary" className="rounded-full" aria-label="复制文件夹路径" onClick={() => { navigator.clipboard.writeText(o.folder!); toast("路径已复制", { description: "剪映素材在 剪映素材 文件夹里" }); }}><FolderOpen /></Button>}
        </div>
      </div>
      <div className="mt-2.5 line-clamp-2 text-sm font-medium">{o.summary?.title || j.title}</div>
      <div className="mt-0.5 flex items-center text-xs text-muted-foreground">
        {j.finishedAt && new Date(j.finishedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        {o.caption && <button className="ml-auto hover:text-foreground" onClick={() => setShowCap(!showCap)}>{showCap ? "收起文案" : "看文案"}</button>}
      </div>
      <AnimatePresence>
        {showCap && o.caption && (
          <motion.pre initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-2 overflow-hidden whitespace-pre-wrap rounded-xl bg-card p-3 font-sans text-xs leading-relaxed shadow-card">
            {o.caption}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  );
}

function LibraryPage() {
  const { jobs, setPage } = useStudio();
  const done = jobs.filter((j) => j.status === "done");
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageTitle title="作品库" sub={`${done.length} 条成片 · 发布前记得看一遍字幕`} />
      {done.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-8">{done.map((j) => <WorkCard key={j.id} j={j} />)}</div>
      ) : (
        <Empty icon={<Library />} title="还没有作品" text="在「发现」里挑一条，点「一键制作」。" action={<Button className="rounded-full" onClick={() => setPage("discover")}>去发现</Button>} />
      )}
    </div>
  );
}

/* ============ 根 ============ */
export default function App() {
  const { init, pollJobs, error, page, loggedIn, theme, setTheme } = useStudio();
  useEffect(() => {
    init();
    const t = setInterval(pollJobs, 3000);
    return () => clearInterval(t);
  }, [init, pollJobs]);
  useEffect(() => { if (error) toast.error(error); }, [error]);
  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme, setTheme]);

  return (
    <TooltipProvider>
      <div className="flex h-screen bg-background text-foreground">
        <Sidebar />
        <main className="min-w-0 flex-1">
          {loggedIn === false && (
            <div className="flex items-center gap-2 border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-6 py-2 text-sm">
              <AlertTriangle className="size-4 text-[var(--warning)]" />
              Agent 还没登录，AI 推荐和制作暂时用不了。在终端运行 <code className="rounded bg-card px-1.5 font-mono text-xs">claude</code>，输入 <code className="rounded bg-card px-1.5 font-mono text-xs">/login</code>，完成后刷新本页。
            </div>
          )}
          <ScrollArea className="h-full">
            <AnimatePresence mode="wait">
              <motion.div key={page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                {page === "discover" ? <Discover /> : page === "studio" ? <Studio /> : <LibraryPage />}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>
        </main>
      </div>
      <DetailSheet />
      <Toaster position="top-center" />
    </TooltipProvider>
  );
}
