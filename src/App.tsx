import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle, Check, Clapperboard, Compass, Copy, Download, Eye, FileArchive, Film, FolderOpen, GripVertical, LayoutTemplate, Library, Link2, Loader2, LogIn,
  MessageSquare, Monitor, Moon, MoreHorizontal, PenLine, Send, Play, Plus, RotateCw, Search, Settings2, Sparkles, Sun, Trash2, Wrench, X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TemplatePage } from "@/template/TemplatePage";
import { ALL, post, useStudio, type Engine, type SetupItem, type CaptionCheck, type ChatMsg, type CoverStyle, type Draft, type Job, type Page, type Theme, type Video } from "@/store";

const COVER: Record<CoverStyle, { label: string; hint: string }> = {
  band: { label: "黑底大标题", hint: "外研社同款，稳" },
  poster: { label: "大字报", hint: "信息流最抢眼" },
  card: { label: "韩中对照卡", hint: "学习感最强" },
  reels: { label: "Reels 款", hint: "ins 爆款同款" },
};
// 配色预设，和 xhs-bilingual-clip 模板 config.ts 的 PALETTES 一致（黑底上用低饱和高明度色）
const PALETTES = [
  { id: "yellow", n: "字幕黄", c: "#ffde3b", zh: "#ffffff" },
  { id: "apricot", n: "奶油杏", c: "#f6c790", zh: "#f2e2c1" },
  { id: "mint", n: "薄荷", c: "#a3ede5", zh: "#f4f2e6" },
  { id: "rose", n: "雾粉", c: "#f2b3c3", zh: "#f7ecef" },
  { id: "haze", n: "灰蓝", c: "#b0c8d3", zh: "#f3e3d3" },
];
const STAGES = ["下载", "听写", "字幕", "渲染", "封面", "文案"];
const fmtViews = (n: number) => (!n ? "—" : n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : String(n));
const fmtDur = (s: number | null) => (s == null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

/* ============ 通用 ============ */
// YouTube 没有的封面尺寸会返回 404 + 120×90 的灰色占位图，浏览器照常显示且不触发 onError，所以还要看实际尺寸。
// 横版视频没有竖版封面（oardefault），退到 hq720（部分视频没有），最后是必有且不带黑边的 mqdefault。
function Thumb({ v, className, loading }: { v: Video; className?: string; loading?: "lazy" }) {
  const srcs = v.platform === "youtube" ? [v.thumb, `https://i.ytimg.com/vi/${v.id}/hq720.jpg`, `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`].filter(Boolean) : [v.thumb];
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [v.id, v.thumb]);
  const next = () => setI((n) => Math.min(n + 1, srcs.length - 1));
  return <img src={srcs[i]} alt="" loading={loading} className={className} onError={next} onLoad={(e) => { if (e.currentTarget.naturalWidth <= 120) next(); }} />;
}

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
const ENGINE_NAME: Record<Engine, string> = { claude: "Claude Code", codex: "Codex" };

function AddApiSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { engine, addApi } = useStudio();
  const [form, setForm] = useState({ name: "", baseUrl: "", apiKey: "", model: "" });
  const [saving, setSaving] = useState(false);
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await addApi({ engine, ...form });
      setForm({ name: "", baseUrl: "", apiKey: "", model: "" });
      onOpenChange(false);
      toast.success("API 已添加并切换");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full border-l-0 sm:max-w-[400px]">
        <SheetHeader>
          <SheetTitle>添加 {ENGINE_NAME[engine]} API</SheetTitle>
          <SheetDescription>填中转站或官方 API 的地址和 Key。Key 只保存在这台电脑上。</SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex flex-col gap-4 px-4">
          <label className="grid gap-1.5 text-sm font-medium">名称<Input placeholder="比如：我的中转站" {...field("name")} /></label>
          <label className="grid gap-1.5 text-sm font-medium">API 地址<Input required placeholder={engine === "codex" ? "https://example.com/v1" : "https://example.com"} {...field("baseUrl")} /></label>
          <label className="grid gap-1.5 text-sm font-medium">API Key<Input required type="password" autoComplete="off" {...field("apiKey")} /></label>
          <label className="grid gap-1.5 text-sm font-medium">模型<Input placeholder="可不填，用默认模型" {...field("model")} /></label>
          <Button type="submit" disabled={saving}>{saving && <Loader2 className="animate-spin" />}添加并使用</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function AgentCard() {
  const { loggedIn, engine, setEngine, route, setRoute, routes, removeApi } = useStudio();
  const [adding, setAdding] = useState(false);
  const fail = (e: unknown) => toast.error((e as Error).message);
  const routeLabel = routes[engine].find((r) => r.id === route)?.label;
  return (
    <div className="rounded-xl bg-card p-3 text-xs shadow-card">
      <div className="flex items-center gap-2 font-medium">
        <span className={cn("size-2 shrink-0 rounded-full", loggedIn ? "bg-[var(--success)]" : loggedIn === false ? "bg-[var(--warning)]" : "bg-muted-foreground")} />
        {loggedIn ? "AI 就绪" : loggedIn === false ? "AI 未连接" : "检查中…"}
        {routeLabel && <span className="truncate font-normal text-muted-foreground">{routeLabel}</span>}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-1">
        <Segmented<Engine>
          value={engine}
          onChange={(e) => e !== engine && setEngine(e).catch(fail)}
          options={[
            { v: "claude", label: "Claude Code" },
            { v: "codex", label: "Codex" },
          ]}
        />
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="线路和 API" className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56">
            <DropdownMenuLabel>{ENGINE_NAME[engine]} 线路</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={route} onValueChange={(r) => r !== route && setRoute(r).catch(fail)}>
              {routes[engine].map((r) => (
                <DropdownMenuRadioItem key={r.id} value={r.id} className="group">
                  <span className="truncate">{r.label}</span>
                  {r.custom && (
                    <button
                      type="button"
                      aria-label={`删除 ${r.label}`}
                      onClick={(e) => { e.stopPropagation(); removeApi(r.id).catch(fail); }}
                      className="mr-5 ml-auto rounded p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setAdding(true)}><Plus />添加 API</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AddApiSheet open={adding} onOpenChange={setAdding} />
    </div>
  );
}

/* ============ 环境检查 ============ */
// 别人下载下来第一次打开时，告诉他缺什么、怎么装；路径也可以在这里手填
function SetupRow({ it }: { it: SetupItem }) {
  const { saveSetup } = useStudio();
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => toast.success("命令已复制", { description: "打开终端粘贴运行，装完回来点「重新检查」" })).catch(() => toast(t));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try { await saveSetup(it.edit!, path); setPath(""); toast.success("已保存"); }
    catch (err) { toast.error((err as Error).message); }
    finally { setSaving(false); }
  };
  return (
    <li className="px-3.5 py-3 text-sm">
      <div className="flex items-center gap-2">
        {it.ok ? <Check className="size-4 shrink-0 text-[var(--success)]" /> : <AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />}
        <span className="font-medium">{it.label}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{it.need}</span>
      </div>
      {it.ok ? (
        it.detail && <div className="mt-0.5 truncate pl-6 font-mono text-[11px] text-muted-foreground" title={it.detail}>{it.detail}</div>
      ) : (
        <div className="mt-1.5 space-y-2 pl-6">
          {it.hint && <p className="text-xs leading-relaxed text-muted-foreground">{it.hint}</p>}
          {it.cmd && (
            <button type="button" onClick={() => copy(it.cmd!)} title="点击复制" className="flex w-full items-center gap-2 rounded-lg bg-secondary px-2.5 py-1.5 text-left font-mono text-xs hover:bg-accent">
              <span className="min-w-0 flex-1 truncate">{it.cmd}</span><Copy className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          )}
          {it.url && <a href={it.url} target="_blank" rel="noreferrer" className="inline-block text-xs text-primary underline underline-offset-2">打开下载页</a>}
          {it.edit && (
            <form onSubmit={save} className="flex gap-1.5">
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="已经装了？把路径粘贴到这里" className="h-8 flex-1 font-mono text-xs" />
              <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={saving || !path.trim()}>保存</Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

function SetupSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { setup, loadSetup, recheck } = useStudio();
  const [busy, setBusy] = useState(false);
  const again = async () => { setBusy(true); await Promise.all([loadSetup(), recheck()]); setBusy(false); };
  const lack = setup?.items.filter((i) => !i.ok) || [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto border-l-0 sm:max-w-[460px]">
        <SheetHeader>
          <SheetTitle>环境</SheetTitle>
          <SheetDescription>{!setup ? "正在检查…" : lack.length ? `还差 ${lack.length} 项。只想逛「发现」的话，装好 yt-dlp 就够了；要出片再装其余的。` : "都装好了，所有功能可用。"}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <ul className="divide-y divide-border rounded-2xl bg-card shadow-card">{setup?.items.map((it) => <SetupRow key={it.id} it={it} />)}</ul>
          <Button variant="secondary" className="w-full rounded-full" disabled={busy} onClick={again}><RotateCw className={cn(busy && "animate-spin")} /> 重新检查</Button>
          {setup && <p className="break-all text-xs leading-relaxed text-muted-foreground">作品、缓存和设置都存在这台电脑的 <span className="font-mono">{setup.dataDir}</span>，不会上传。</p>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// 经验本：后台自己学，这里只是给你看、改、删、置顶；平时不用打开
type Lesson = { id: string; rule: string; why: string; hits: number; pinned: boolean; at: number };
type LessonLog = { at: number; action: "add" | "merge" | "skip" | "error"; rule?: string; why: string; src?: { title?: string; text?: string } };
const LOG_LABEL: Record<string, string> = { add: "记住", merge: "合并", skip: "跳过", error: "出错" };
function LessonsSheet({ open, onOpenChange, data, setData }: { open: boolean; onOpenChange: (o: boolean) => void; data: { rules: Lesson[]; log: LessonLog[] }; setData: (d: { rules: Lesson[]; log: LessonLog[] }) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const [showLog, setShowLog] = useState(false);
  const act = async (b: Record<string, unknown>) => { try { setData(await post("/api/lessons", b)); } catch (e) { toast.error((e as Error).message); } };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto border-l-0 sm:max-w-[460px]">
        <SheetHeader>
          <SheetTitle>经验</SheetTitle>
          <SheetDescription>你每次纠正，它会自己判断值不值得记住；记住的规则，Claude 和 Codex 以后做视频都会遵守。学歪了就删掉或改一下。</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4 pb-6">
          <ul className="divide-y divide-border rounded-2xl bg-card shadow-card">
            {!data.rules.length && <li className="p-4 text-xs text-muted-foreground">还没学到东西。成片后写修改意见、或者手改文案，它就会开始学。</li>}
            {data.rules.map((r) => (
              <li key={r.id} className="group p-3 text-[13px]">
                {editing === r.id ? (
                  <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); act({ action: "edit", id: r.id, rule: draft }); setEditing(null); }}>
                    <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 flex-1 text-[13px]" />
                    <Button type="submit" size="sm" className="h-8">保存</Button>
                  </form>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="leading-relaxed">{r.pinned && <span className="mr-1 text-primary">●</span>}{r.rule}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{r.hits > 1 ? `被提到 ${r.hits} 次 · ` : ""}{r.why}</div>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button size="xs" variant="ghost" onClick={() => act({ action: "pin", id: r.id })}>{r.pinned ? "取消置顶" : "置顶"}</Button>
                      <Button size="icon-xs" variant="ghost" aria-label="修改" onClick={() => { setEditing(r.id); setDraft(r.rule); }}><PenLine /></Button>
                      <Button size="icon-xs" variant="ghost" aria-label="删除" className="hover:text-destructive" onClick={() => act({ action: "delete", id: r.id })}><Trash2 /></Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (adding.trim()) { act({ action: "add", rule: adding }); setAdding(""); } }}>
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="自己加一条，比如：字幕中文用口语，别太书面" className="h-8 flex-1 text-xs" />
            <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={!adding.trim()}><Plus /> 加</Button>
          </form>
          {data.log.length > 0 && (
            <div>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowLog((v) => !v)}>{showLog ? "收起" : "看看"}最近的判断（{data.log.length}）</button>
              {showLog && (
                <ul className="mt-2 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
                  {data.log.map((l, i) => (
                    <li key={i}>
                      <span className={cn("mr-1 rounded px-1", l.action === "skip" ? "bg-secondary" : l.action === "error" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")}>{LOG_LABEL[l.action]}</span>
                      {l.rule && <span className="text-foreground">{l.rule} · </span>}{l.why}
                      {l.src?.text && <div className="line-clamp-1 opacity-70">来自「{l.src.title}」：{l.src.text}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// 后台每 20 秒看一眼经验本（学到什么在「制作」页「最近学到」里看，不弹窗打扰）
function useLessons() {
  const [data, setData] = useState<{ rules: Lesson[]; log: LessonLog[] }>({ rules: [], log: [] });
  useEffect(() => {
    const tick = () => fetch("/api/lessons").then((r) => r.json()).then(setData).catch(() => {});
    tick();
    const t = setInterval(tick, 20000);
    return () => clearInterval(t);
  }, []);
  return [data, setData] as const;
}

function Sidebar() {
  const { page, setPage, theme, setTheme, drafts, jobs, setup } = useStudio();
  const lack = setup?.items.filter((i) => !i.ok).length || 0;
  const [setupOpen, setSetupOpen] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [lessonData, setLessonData] = useLessons();
  useEffect(() => { const o = () => setLessonsOpen(true); window.addEventListener("open-lessons", o); return () => window.removeEventListener("open-lessons", o); }, []);
  // 第一次打开且连找视频都做不了时，直接把环境面板弹出来
  useEffect(() => { if (setup?.items.some((i) => i.id === "ytdlp" && !i.ok)) setSetupOpen(true); }, [setup?.platform]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued").length + drafts.length;
  const done = jobs.filter((j) => j.status === "done").length;
  const nav: { id: Page; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "discover", label: "发现", icon: <Compass /> },
    { id: "template", label: "模板", icon: <LayoutTemplate /> },
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
        <AgentCard />
        <button onClick={() => setSetupOpen(true)} className="flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
          <Wrench className="size-3.5" />环境
          {setup && <span className={cn("ml-auto", lack ? "font-medium text-[var(--warning)]" : "")}>{lack ? `还差 ${lack} 项` : "已就绪"}</span>}
        </button>
        <SetupSheet open={setupOpen} onOpenChange={setSetupOpen} />
        <button onClick={() => setLessonsOpen(true)} className="-mt-2 flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
          <Sparkles className="size-3.5" />经验
          <span className="ml-auto">{lessonData.rules.length ? `${lessonData.rules.length} 条` : "还没有"}</span>
        </button>
        <LessonsSheet open={lessonsOpen} onOpenChange={setLessonsOpen} data={lessonData} setData={setLessonData} />
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
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());
// 值不值得做：播放量取对数（10 万和 100 万差一档，不是差十倍），有韩语台词才做得了字幕，60 秒内更适合小红书
const worth = (v: Video) => Math.log10(v.views + 10) * 10 + (v.meta?.speech === "ko" ? 8 : 0) + (v.duration != null && v.duration <= 60 ? 4 : 0);
// 推荐页：每个栏目按值得做排好，再轮流各取一条，免得被播放量最大的那个栏目占满
function mix(lists: Video[][]) {
  const sorted = lists.map((l) => [...l].sort((a, b) => worth(b) - worth(a)));
  const out: Video[] = [];
  for (let i = 0; sorted.some((l) => i < l.length); i++) for (const l of sorted) if (l[i]) out.push(l[i]);
  return out;
}

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
        <Thumb v={v} className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
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

function GalleryCard({ v, label }: { v: Video; label?: string }) {
  const { openDetail, jobs, hide } = useStudio();
  const job = jobs.find((j) => j.vid === v.id && j.status !== "failed");
  const title = v.ai?.zh_title || v.title.replace(/#[^\s#]+/g, "").trim() || v.title;
  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="group relative">
      <button onClick={() => openDetail(v)} className="block w-full text-left">
        <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-muted shadow-card">
          <Thumb v={v} loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-transparent px-3 pb-3 pt-12">
            {(v.topic || label) && <div className="mb-1 truncate text-[11px] font-medium text-white/80">{v.topic || label}</div>}
            <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-white">{title}</div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-white/75">
              <Eye className="size-3 shrink-0" /><span className="shrink-0 whitespace-nowrap">{fmtViews(v.views)}</span>
              {v.duration != null && <span className="ml-1.5 shrink-0">{fmtDur(v.duration)}</span>}
              <span className="ml-auto min-w-0 truncate pl-2">{v.channel}</span>
            </div>
          </div>
          <div className="absolute left-2 top-2 flex gap-1">
            {job && <span className="rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-black">{job.status === "done" ? "已制作" : "制作中"}</span>}
            {v.meta?.speech === "ko" && <span className="rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">有台词</span>}
          </div>
        </div>
      </button>
      <button onClick={() => hide(v.id)} aria-label="不感兴趣" title="不感兴趣，以后不再出现" className="absolute right-2 top-2 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100"><X className="size-3.5" /></button>
    </motion.div>
  );
}

function CategorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { categories, addCategory, removeCategory, resetCategories } = useStudio();
  const [label, setLabel] = useState("");
  const [sources, setSources] = useState("");
  const [saving, setSaving] = useState(false);
  const oops = (e: unknown) => { toast.error((e as Error).message); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await addCategory(label, sources);
      setLabel(""); setSources("");
      onOpenChange(false);
      toast.success("栏目已添加，正在抓取视频");
    } catch (err) { oops(err); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto border-l-0 sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>栏目</SheetTitle>
          <SheetDescription>栏目决定去哪儿找视频。按你自己账号的内容方向来设：一个栏目 = 几个搜索词或几个频道。</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          <form onSubmit={submit} className="space-y-3 rounded-2xl bg-secondary/60 p-4">
            <label className="grid gap-1.5 text-sm font-medium">栏目名<Input required maxLength={12} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="比如：韩国美食" className="bg-card" /></label>
            <label className="grid gap-1.5 text-sm font-medium">
              搜索词或频道链接，每行一个
              <Textarea required value={sources} onChange={(e) => setSources(e.target.value)} placeholder={"먹방 shorts\n편의점 신상 shorts\nhttps://www.youtube.com/@频道名"} className="min-h-28 rounded-xl bg-card font-mono text-xs" />
            </label>
            <p className="text-xs text-muted-foreground">搜索词用韩文效果最好；频道链接会自动取它的 Shorts。</p>
            <Button type="submit" className="w-full rounded-full" disabled={saving}>{saving ? <Loader2 className="animate-spin" /> : <Plus />}添加栏目</Button>
          </form>
          <div>
            <div className="mb-2 flex items-center text-sm font-semibold">现有栏目<button type="button" onClick={() => { if (window.confirm("恢复成默认的 6 个栏目？你自己加的栏目会被删掉。")) resetCategories().catch(oops); }} className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground">恢复默认</button></div>
            <ul className="divide-y divide-border rounded-2xl bg-card shadow-card">
              {categories.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-3.5 py-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.label}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.kind === "hot" ? "Melon 实时榜 + theqoo 热帖，自动更新" : c.sources.map((s) => s.replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/\/shorts$/, "").replace(/ shorts$/, "")).join("、")}</div>
                    {c.kind !== "hot" && <div className="truncate text-xs text-primary/80">{c.scouting ? "正在找这类内容的频道…" : c.found?.length ? `自动找到的频道：${c.found.join("、")}` : "会自动去找做这类短视频的频道"}</div>}
                  </div>
                  <button type="button" aria-label={`删除栏目 ${c.label}`} onClick={() => removeCategory(c.id).catch(oops)} className="p-1 text-muted-foreground/60 hover:text-destructive"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Discover() {
  const { categories, tab, setTab, videos, loading, loadCat, picks, picking, recommend, query, search, searching, results, resolving, openLink, loggedIn, trending, buzz, hidden, unhideAll, jobs } = useStudio();
  const [q, setQ] = useState(query);
  useEffect(() => setQ(query), [query]);
  const [dur, setDur] = useState<"all" | "60">("60");
  const [sort, setSort] = useState<"worth" | "hot">("worth");
  const [hideMade, setHideMade] = useState(true);
  const [managing, setManaging] = useState(false);
  const cat = categories.find((c) => c.id === tab);
  const made = useMemo(() => new Set(jobs.filter((j) => j.status !== "failed").map((j) => j.vid)), [jobs]);
  const { pool, cut } = useMemo(() => {
    const seen = new Set<string>();
    const uniq = (l: Video[]) => l.filter((v) => !seen.has(v.id) && seen.add(v.id));
    const base = query ? uniq(results) : tab === ALL ? uniq(mix(categories.map((c) => videos[c.id] || []))) : uniq(videos[tab] || []);
    let list = base.filter((v) => !hidden.includes(v.id));
    if (dur === "60") list = list.filter((v) => v.duration == null || v.duration <= 60);
    if (hideMade) list = list.filter((v) => !made.has(v.id));
    if (sort === "hot") list = [...list].sort((a, b) => b.views - a.views);
    else if (query || tab !== ALL) list = [...list].sort((a, b) => worth(b) - worth(a));
    return { pool: list, cut: base.length - list.length };
  }, [query, results, tab, categories, videos, dur, sort, hideMade, hidden, made]);
  const isLoading = searching || (tab === ALL ? categories.some((c) => loading[c.id]) : !!loading[tab]);
  const labelOf = (v: Video) => (tab === ALL && !query ? categories.find((c) => c.id === v.category)?.label : undefined);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isUrl(q)) { openLink(q.trim()); setQ(""); } else search(q);
  };

  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageTitle title="发现" sub={today} />

      <form onSubmit={submit} className="relative mb-5">
        {isUrl(q) ? <Link2 className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-primary" /> : <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-muted-foreground" />}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索或粘贴链接"
          placeholder="搜关键词（韩文最准），或者直接粘贴视频链接"
          className="h-12 rounded-full border-0 bg-card pl-11 pr-28 text-[15px] shadow-card focus-visible:ring-2"
        />
        {(query || q) && (
          <button type="button" onClick={() => { setQ(""); if (query) search(""); }} className="absolute right-24 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="清除"><X className="size-4" /></button>
        )}
        <Button type="submit" className="absolute right-1.5 top-1/2 h-9 -translate-y-1/2 rounded-full px-4" disabled={resolving || !q.trim()}>{resolving && <Loader2 className="animate-spin" />}{isUrl(q) ? "做这条" : "搜索"}</Button>
      </form>

      <div className="mb-6 flex items-center gap-1 border-b border-border">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist">
          {[{ id: ALL, label: "推荐" }, ...categories].map((c) => {
            const on = !query && tab === c.id;
            return (
              <button key={c.id} role="tab" aria-selected={on} onClick={() => setTab(c.id)} className={cn("relative flex h-10 shrink-0 items-center gap-1.5 px-3 text-[15px] font-medium text-muted-foreground transition-colors hover:text-foreground", on && "text-foreground")}>
                {c.label}
                {loading[c.id] && <Loader2 className="size-3 animate-spin" />}
                {on && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-foreground" />}
              </button>
            );
          })}
        </div>
        <button onClick={() => setManaging(true)} className="flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"><Settings2 className="size-3.5" />栏目</button>
      </div>

      {!query && cat?.kind === "hot" && (buzz.length > 0 || trending.length > 0) && (
        <div className="mb-8 space-y-2.5">
          {buzz.length > 0 && (
            <div className="flex items-center gap-3 overflow-hidden">
              <span className="w-24 shrink-0 text-xs font-semibold text-muted-foreground">韩网在聊</span>
              <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
                {buzz.map((t) => <button key={t.ko} title={t.why} onClick={() => search(t.ko)} className="shrink-0 rounded-full bg-card px-3 py-1 text-xs shadow-card transition-colors hover:bg-accent">{t.zh}</button>)}
              </div>
            </div>
          )}
          {trending.length > 0 && (
            <div className="flex items-center gap-3 overflow-hidden">
              <span className="w-24 shrink-0 text-xs font-semibold text-muted-foreground">音源榜艺人</span>
              <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
                {trending.slice(0, 16).map((t, i) => (
                  <button key={t.tag} onClick={() => search(t.query)} title={`Melon 最高第 ${t.best} 名：${t.songs.join("、")}`} className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-secondary">
                    <span className={cn("tabular-nums", i < 3 ? "font-semibold text-primary" : "text-muted-foreground")}>{i + 1}</span>{t.tag}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!query && tab === ALL && (
        <section className="mb-12">
          <SectionHead
            title="AI 精选"
            sub={<span className="flex items-center gap-1"><Sparkles className="size-3.5 text-primary" /> 从所有栏目里挑 8 条最适合发小红书的，写好中文标题和理由</span>}
            action={(picks.length > 0 || picking) && <Button variant="secondary" className="rounded-full" disabled={picking || loggedIn === false} onClick={recommend}>{picking ? <Loader2 className="animate-spin" /> : <RotateCw />} 重新挑选</Button>}
          />
          {picking ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-44 rounded-3xl" />)}</div>
          ) : picks.length ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{picks.filter((v) => !hidden.includes(v.id)).map((v) => <PickCard key={v.id} v={v} />)}</div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-card px-5 py-4 shadow-card">
              <Sparkles className="size-5 shrink-0 text-muted-foreground/60" />
              <div className="min-w-0 flex-1 text-sm text-muted-foreground">{loggedIn === false ? "AI 还没连上，先在下面自己挑；连上后可以让它帮你选。" : "不知道做哪条？让 AI 看一遍所有候选，大约 1 分钟。"}</div>
              <Button className="rounded-full" disabled={loggedIn === false} onClick={recommend}><Sparkles /> 帮我挑 8 条</Button>
            </div>
          )}
        </section>
      )}

      <section>
        <SectionHead
          title={query ? `“${query}” 的搜索结果` : tab === ALL ? "全部候选" : cat?.label || ""}
          sub={isLoading && !pool.length ? "正在从 YouTube 抓取，第一次要等一会儿…" : (
            <span>
              {pool.length} 条{cut > 0 && `，另有 ${cut} 条被筛掉`}
              {hidden.length > 0 && <button onClick={unhideAll} className="ml-2 underline underline-offset-2 hover:text-foreground">恢复 {hidden.length} 条不感兴趣</button>}
            </span>
          )}
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button onClick={() => setHideMade(!hideMade)} aria-pressed={hideMade} className={cn("flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors", hideMade ? "bg-foreground text-background" : "bg-secondary text-muted-foreground")}>{hideMade && <Check className="size-3.5" />}隐藏已做</button>
              <Segmented value={dur} onChange={setDur} options={[{ v: "60", label: "≤ 60 秒" }, { v: "all", label: "不限时长" }]} />
              <Segmented value={sort} onChange={setSort} options={[{ v: "worth", label: "值得做" }, { v: "hot", label: "播放量" }]} />
              {!query && tab !== ALL && <Button size="icon-sm" variant="secondary" className="size-8 rounded-full" aria-label="重新抓取" title="重新抓取这个栏目" disabled={!!loading[tab]} onClick={() => loadCat(tab, true)}><RotateCw className={cn(loading[tab] && "animate-spin")} /></Button>}
            </div>
          }
        />
        {isLoading && !pool.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[9/16] rounded-2xl" />)}</div>
        ) : pool.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-3">{pool.map((v) => <GalleryCard key={v.id} v={v} label={labelOf(v)} />)}</div>
        ) : (
          <Empty icon={<Compass />} title={query ? "没搜到合适的" : "这里暂时没有视频"} text={cut > 0 ? "都被筛掉了：试试「不限时长」或关掉「隐藏已做」。" : query ? "换个韩文关键词试试，或者直接粘贴视频链接。" : "点右上角的刷新重新抓取，或者在「栏目」里换一批搜索词。"} />
        )}
      </section>
      <CategorySheet open={managing} onOpenChange={setManaging} />
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
  const { detail: v, openDetail, produce, addDraft, jobs, drafts, loggedIn, setPage } = useStudio();
  const [cover, setCover] = useState<CoverStyle>("band");
  const [note, setNote] = useState("");
  const [accent, setAccent] = useState(PALETTES[0].id);
  useEffect(() => {
    if (!v) return;
    const d = useStudio.getState().drafts.find((x) => x.video.id === v.id);
    setCover(d?.coverStyle || v.ai?.cover_style || "band");
    setNote(d?.note || "");
    setAccent(d?.accent || PALETTES[0].id);
  }, [v]);
  const active = v && jobs.find((j) => j.vid === v.id && (j.status === "queued" || j.status === "running"));
  const done = v && jobs.find((j) => j.vid === v.id && j.status === "done");
  const inList = v && drafts.some((d) => d.video.id === v.id);
  // Shorts 是竖的：用竖播放器，不要在 16:9 的框里缩成一小条
  const vertical = !!v && (v.vertical ?? (/\/shorts\//.test(v.url) || /oar/.test(v.thumb) || v.category !== "link"));
  const draft = (): Draft => ({ video: v!.ai ? { ...v!, ai: { ...v!.ai, cover_style: cover } } : v!, coverStyle: cover, note, accent, again: !!done });
  return (
    <Sheet open={!!v} onOpenChange={(o) => !o && openDetail(null)}>
      <SheetContent className="w-full gap-0 overflow-y-auto border-l-0 p-0 sm:max-w-[520px]">
        {v && (
          <>
            <div className="grid w-full place-items-center bg-black">
              <div className={cn("overflow-hidden", vertical ? "aspect-[9/16] h-[min(56vh,480px)]" : "aspect-video w-full")}>
                {v.platform === "youtube"
                  ? <iframe className="size-full" src={`https://www.youtube.com/embed/${v.id}`} title={v.title} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen />
                  : v.thumb ? <a href={v.url} target="_blank" rel="noreferrer" title="在原网站打开"><img src={v.thumb} alt="" className="size-full object-cover" /></a> : null}
              </div>
            </div>
            <div className="space-y-6 p-6">
              <SheetHeader className="p-0">
                <SheetTitle className="text-xl font-semibold leading-snug tracking-tight">{v.ai?.zh_title || v.title}</SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {v.ai && <span className="line-clamp-1">{v.title}</span>}
                  <span>{v.channel}</span>
                  {!!v.views && <span>{fmtViews(v.views)} 次观看</span>}
                  {v.duration != null && <span>{fmtDur(v.duration)}</span>}
                  {v.meta?.speech === "none" && <span className="text-[var(--warning)]">没识别到台词，可能做不出字幕</span>}
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
                <div className="mb-2.5 text-sm font-semibold">配色 <span className="font-normal text-muted-foreground">（标题关键词、字幕、单词卡、封面）</span></div>
                <div className="flex gap-2.5">
                  {PALETTES.map((x) => (
                    <Tooltip key={x.id}>
                      <TooltipTrigger asChild>
                        <button onClick={() => setAccent(x.id)} aria-label={x.n} className={cn("flex h-9 w-11 flex-col items-center justify-center gap-0.5 rounded-lg bg-black ring-2 ring-offset-2 ring-offset-background transition", accent === x.id ? "ring-primary" : "ring-transparent")}>
                          <span className="text-[13px] font-black leading-none" style={{ color: x.c }}>字</span>
                          <span className="h-1 w-6 rounded-full" style={{ background: x.zh }} />
                        </button>
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
                  disabled={!!active || loggedIn === false}
                  onClick={() => produce([draft()]).then(() => { toast.success("已交给 Agent 制作", { description: "做好会提醒你", action: { label: "看进度", onClick: () => setPage("studio") } }); openDetail(null); }).catch((e) => toast.error((e as Error).message))}
                >
                  <Clapperboard /> {active ? "正在制作中" : done ? "换个样式再做一版" : "一键制作"}
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  className="h-12 w-full rounded-full text-[15px]"
                  disabled={!!active}
                  onClick={() => { addDraft(draft()); toast(inList ? "清单里的设置已更新" : "已加入待制作清单"); openDetail(null); }}
                >
                  <Plus /> {inList ? "更新清单里的设置" : "加入清单，稍后批量做"}
                </Button>
                <p className="pt-1 text-center text-xs text-muted-foreground">{loggedIn === false ? "AI 还没连上，暂时不能制作：看页面顶部的提示。" : "产出：成片 · 3:4 封面 · 小红书文案 · 剪映分层素材 ｜ 约 10–20 分钟"}</p>
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
  const { updateDraft, removeDraft, openDetail } = useStudio();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: d.video.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-3 rounded-2xl bg-card p-2.5 shadow-card", isDragging && "z-10 shadow-xl")}>
      <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground/60 hover:text-foreground" aria-label="拖动排序"><GripVertical className="size-4" /></button>
      <button onClick={() => openDetail(d.video)} title="改备注和设置" className="shrink-0"><Thumb v={d.video} className="h-16 w-12 rounded-lg object-cover" /></button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{d.video.ai?.zh_title || d.video.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {(Object.keys(COVER) as CoverStyle[]).map((s) => (
            <button key={s} onClick={() => updateDraft(d.video.id, { coverStyle: s })} className={cn("rounded-full px-2 py-0.5 text-[11px]", d.coverStyle === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{COVER[s].label}</button>
          ))}
          <span className="mx-1 h-3 w-px bg-border" />
          {PALETTES.map((x) => (
            <button key={x.id} aria-label={`配色 ${x.n}`} title={x.n} onClick={() => updateDraft(d.video.id, { accent: x.id })} className={cn("size-4 rounded-full ring-2 ring-offset-1 ring-offset-card", (d.accent || PALETTES[0].id) === x.id ? "ring-primary" : "ring-transparent")} style={{ background: x.c }} />
          ))}
        </div>
        {d.note && <div className="mt-1 truncate text-[11px] text-muted-foreground">备注：{d.note}</div>}
      </div>
      <button onClick={() => removeDraft(d.video.id)} className="p-1 text-muted-foreground/60 hover:text-destructive" aria-label="移除"><Trash2 className="size-4" /></button>
    </div>
  );
}

function Pipeline({ j }: { j: Job }) {
  const { retry, cancelJob, deleteJob } = useStudio();
  const stage = j.status === "done" ? STAGES.length : Math.max(0, j.stage ?? 0);
  const mins = j.startedAt ? Math.max(1, Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 60000)) : 0;
  const live = j.status === "queued" || j.status === "running";
  return (
    <div className="rounded-2xl bg-card p-4 shadow-card">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold">{j.outputs?.summary?.title || j.title}</div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {j.status === "queued" ? "排队中" : j.status === "running" ? `已用 ${mins} 分钟` : j.error === "已取消" ? "已取消" : "失败"}
        </span>
        {live && <Button size="xs" variant="secondary" className="rounded-full" onClick={() => { if (j.status === "queued" || window.confirm("停止制作这条？已经做的部分会保留，之后可以重试。")) cancelJob(j.id); }}><X /> {j.status === "queued" ? "移出队列" : "停止"}</Button>}
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
        <div className="mt-3 flex items-start gap-2 text-xs">
          {j.error !== "已取消" && <><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" /><span className="flex-1 break-all text-destructive">{j.error}</span></>}
          <div className="ml-auto flex shrink-0 gap-1.5">
            <Button size="xs" variant="secondary" className="rounded-full" onClick={() => retry(j.id)}><RotateCw /> 重试</Button>
            <Button size="xs" variant="ghost" className="rounded-full text-muted-foreground" onClick={() => deleteJob(j.id)}><Trash2 /> 删除</Button>
          </div>
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
  const recent = jobs.filter((j) => j.status === "done").slice(0, 3);
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <PageTitle title="制作" sub="Agent 一次做一条，每条约 10–20 分钟，电脑别休眠" />
      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <SectionHead
            title="待制作清单"
            sub="拖动调整先后顺序，点封面改备注"
            action={drafts.length > 0 && <Button className="rounded-full" disabled={loggedIn === false} onClick={() => { const n = drafts.length; produce().then(() => toast.success(`${n} 条已开始排队`)).catch((e) => toast.error((e as Error).message)); }}><Clapperboard /> 全部开始（{drafts.length}）</Button>}
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
            <Empty icon={<Plus />} title="清单是空的" text="在「发现」里打开视频，点「加入清单」；或者把视频链接粘贴到搜索框。" action={<Button variant="secondary" className="rounded-full" onClick={() => setPage("discover")}>去发现</Button>} />
          )}
        </section>
        <section>
          <SectionHead title="进行中" sub={`${live.length} 个任务`} />
          {live.length ? <div className="space-y-3">{live.map((j) => <Pipeline key={j.id} j={j} />)}</div> : <Empty icon={<Film />} title="没有进行中的任务" text="做好会弹提醒，成片在「作品库」。" />}
          {recent.length > 0 && (
            <div className="mt-6">
              <div className="mb-2 flex items-center text-sm font-semibold">刚做好<button onClick={() => setPage("library")} className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground">全部作品</button></div>
              <div className="divide-y divide-border rounded-2xl bg-card shadow-card">
                {recent.map((j) => (
                  <button key={j.id} onClick={() => setPage("library")} className="flex w-full items-center gap-3 px-3 py-2 text-left">
                    {j.outputs?.cover ? <img src={j.outputs.cover} alt="" className="h-12 w-9 rounded-md object-cover" /> : <div className="h-12 w-9 rounded-md bg-muted" />}
                    <span className="min-w-0 flex-1 truncate text-sm">{j.outputs?.summary?.title || j.title}</span>
                    <Check className="size-4 text-[var(--success)]" />
                  </button>
                ))}
              </div>
            </div>
          )}
          <LearnedList />
        </section>
      </div>
    </div>
  );
}

/* ============ 作品库 ============ */
// 有些内嵌浏览器不给 clipboard 权限，退回 execCommand
const copyText = async (text: string) => {
  try { await navigator.clipboard.writeText(text); return; } catch { /* 走下面的退路 */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;opacity:0";
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
};
const postId = async (url: string, id: string) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
};
const copyZip = (id: string) => { toast.promise(postId("/api/pack/copy", id), { loading: "正在打包…", success: "zip 已复制，到邮箱或微信里按 Ctrl+V", error: (e: Error) => e.message }); };
const openFolder = (id: string) => { postId("/api/open", id).catch((e) => toast.error((e as Error).message)); };
const copyCaption = (text: string) => { copyText(text).then(() => toast.success("文案已复制")).catch(() => toast.error("复制失败，请手动选中文案")); };
const jobTitle = (j: Job) => j.outputs?.summary?.title || j.title;
const jobDate = (j: Job) => (j.finishedAt ? new Date(j.finishedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

// 修改意见：按内容只返工对应那一块，不整条重做
const REVISE_LABEL: Record<string, string> = { subs: "字幕", style: "样式", cut: "剪辑", cover: "封面", caption: "文案" };
const REVISE_COST: Record<string, string> = { caption: "只改文案，不渲染", cover: "只重出封面", subs: "改字幕后重渲染", style: "改样式后重渲染", cut: "改时长后重渲染" };
function ReviseBox({ j, onSent }: { j: Job; onSent: () => void }) {
  const { pollJobs } = useStudio();
  const [text, setText] = useState("");
  const [auto, setAuto] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { fetch(`/api/revise-scopes?text=${encodeURIComponent(text)}`).then((r) => r.json()).then(setAuto).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [text]);
  const scopes = picked ?? auto;
  const toggle = (k: string) => setPicked((p) => { const cur = p ?? auto; return cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]; });
  const send = async () => {
    setSending(true);
    try {
      const r = await fetch("/api/revise", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: j.id, text, scopes }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      toast.success("已排队修改，在「制作」页看进度");
      await pollJobs();
      onSent();
    } catch (e) { toast.error((e as Error).message); }
    setSending(false);
  };
  const history = j.revisions || [];
  return (
    <div className="rounded-2xl border border-border/70 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold"><PenLine className="size-3.5" /> 修改意见</div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="比如：第 3 句中文翻错了，应该是“我们连生日都不过”；封面字再大一点" className="min-h-16 rounded-xl text-[13px]" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground" title="AI 以你写的文字为准，勾选只作参考">参考：</span>
        {Object.keys(REVISE_LABEL).map((k) => (
          <button key={k} onClick={() => toggle(k)} title={REVISE_COST[k]} className={cn("rounded-full px-2 py-0.5 text-[11px]", scopes.includes(k) ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground")}>{REVISE_LABEL[k]}</button>
        ))}
        <Button size="xs" className="ml-auto rounded-full" disabled={!text.trim() || sending} onClick={send}>{sending ? <Loader2 className="animate-spin" /> : <RotateCw />} 按意见重做</Button>
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground">
        {text.trim() ? `${scopes.length ? scopes.map((k) => REVISE_COST[k]).join(" · ") : "没认出改哪块，AI 会先判断再改"} · 以你写的文字为准` : "小问题写这里；大改点上面「对话」先和 AI 商量。不会重新下载和听写，改前自动备份"}
      </div>
      {history.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          {history.slice(-3).reverse().map((h, i) => (
            <li key={i} className="flex gap-1.5"><span className={h.ok ? "text-emerald-600" : "text-destructive"}>{h.ok ? "✓" : "✕"}</span><span className="line-clamp-2">{h.text}{h.note ? ` → ${h.note}` : ""}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// 文案：点铅笔进入编辑，直接打字；保存写回 out/小红书文案.txt，打包和复制都用改过的。「AI 检查」只挑错，给出修改建议，点「全部采用」才替换
function CaptionEditor({ j, caption }: { j: Job; caption: string }) {
  const { saveCaption, checkCaption } = useStudio();
  const [text, setText] = useState(caption);
  const [saved, setSaved] = useState(caption);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<CaptionCheck | null>(null);
  useEffect(() => { setText(caption); setSaved(caption); setEditing(false); setCheck(null); }, [j.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = text !== saved;
  const save = async (t = text, source?: "ai") => {
    if (t === saved || saving) return true;
    setSaving(true);
    const ok = await saveCaption(j.id, t, source);
    if (ok) { setSaved(t); toast.success("文案已保存"); }
    setSaving(false);
    return ok;
  };
  const done = async () => { if (await save()) setEditing(false); };
  const cancel = () => { setText(saved); setEditing(false); };
  const runCheck = async () => {
    setChecking(true); setCheck(null);
    const r = await checkCaption(j.id, text);
    setChecking(false);
    if (!r) return;
    if (!r.issues.length) { toast.success("AI 检查完了，没发现问题"); return; }
    setCheck(r);
  };
  const adopt = async () => { if (!check) return; setText(check.revised); setCheck(null); await save(check.revised, "ai"); };
  return (
    <div className="flex shrink-0 flex-col">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        小红书文案
        {editing && <span className="text-xs font-normal text-muted-foreground">{saving ? "保存中…" : dirty ? "未保存 · Ctrl+S 保存" : "编辑中"}</span>}
        <div className="ml-auto flex gap-1.5">
          {editing ? (
            <>
              <Button size="xs" variant="ghost" className="rounded-full" onClick={cancel} disabled={saving}>取消</Button>
              <Button size="xs" className="rounded-full" onClick={done} disabled={saving}><Check /> 完成</Button>
            </>
          ) : (
            <>
              {text.trim() && <Button size="xs" variant="secondary" className="rounded-full" onClick={runCheck} disabled={checking}>{checking ? <Loader2 className="animate-spin" /> : <Sparkles />} {checking ? "检查中…" : "AI 检查"}</Button>}
              {text && <Button size="xs" variant="secondary" className="rounded-full" onClick={() => copyCaption(text)}><Copy /> 复制</Button>}
              <Button size="icon-xs" variant="secondary" className="rounded-full" aria-label="修改文案" title="修改文案" onClick={() => { setEditing(true); setCheck(null); }}><PenLine /></Button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <Textarea
          autoFocus
          aria-label="小红书文案"
          value={text}
          placeholder="在这里写文案"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => { if (!e.relatedTarget?.closest("button")) save(); }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save(); } }}
          className="field-sizing-fixed h-72 resize-y rounded-2xl bg-background p-3 text-[13px] leading-relaxed"
        />
      ) : (
        <pre onDoubleClick={() => setEditing(true)} title="双击也可以修改" className="max-h-56 min-h-24 cursor-text overflow-y-auto whitespace-pre-wrap rounded-2xl bg-secondary/60 p-3 font-sans text-[13px] leading-relaxed">{text || "这条没有文案，点右上角铅笔写一段"}</pre>
      )}
      {check && (
        <div className="mt-2 rounded-2xl border p-3 text-xs leading-relaxed">
          <div className="mb-2 flex items-center gap-1 font-semibold"><Sparkles className="size-3.5 text-primary" /> AI 发现 {check.issues.length} 处可以改</div>
          <ul className="space-y-2">
            {check.issues.map((it, i) => (
              <li key={i}>
                <span className="rounded bg-destructive/10 px-1 text-destructive line-through">{it.where}</span>
                <span className="mx-1 text-muted-foreground">→</span>
                <span className="rounded bg-primary/10 px-1">{it.fix}</span>
                <div className="mt-0.5 text-muted-foreground">{it.problem}</div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-1.5">
            <Button size="xs" className="rounded-full" onClick={adopt} disabled={saving}><Check /> 全部采用</Button>
            <Button size="xs" variant="secondary" className="rounded-full" onClick={() => { setText(check.revised); setCheck(null); setEditing(true); }}><PenLine /> 采用后再手改</Button>
            <Button size="xs" variant="ghost" className="rounded-full" onClick={() => setCheck(null)}>不用了</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// 大改的对话框：AI 只说理解和打算，不动文件；点「同意，开始改」才排队修改
function ChatPanel({ j, onClose, onStarted }: { j: Job; onClose: () => void; onStarted: () => void }) {
  const { pollJobs } = useStudio();
  const [msgs, setMsgs] = useState<ChatMsg[]>(j.chat || []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "talk" | "go">("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);
  const say = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy("talk"); setText("");
    setMsgs((m) => [...m, { role: "user", text: t, at: Date.now() }]);
    try { setMsgs(await post<ChatMsg[]>("/api/chat", { id: j.id, text: t })); }
    catch (e) { toast.error((e as Error).message); setMsgs((m) => m.slice(0, -1)); setText(t); }
    setBusy("");
  };
  const approve = async () => {
    setBusy("go");
    try { await post("/api/chat/approve", { id: j.id }); toast.success("已同意，开始修改，在「制作」页看进度"); await pollJobs(); onStarted(); }
    catch (e) { toast.error((e as Error).message); }
    setBusy("");
  };
  const clear = async () => { setMsgs(await post<ChatMsg[]>("/api/chat/clear", { id: j.id }).catch(() => msgs)); };
  const last = [...msgs].reverse().find((m) => m.role !== "user");
  const canGo = last?.role === "ai" && !!last.plan && !last.approved;
  return (
    <div className="flex w-[340px] shrink-0 flex-col border-l border-border/70">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 text-sm font-semibold">
        <MessageSquare className="size-4" /> 对话大改
        {msgs.length > 0 && <button className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground" onClick={clear} disabled={!!busy}>清空</button>}
        <button aria-label="收起对话" className={cn("grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary", !msgs.length && "ml-auto")} onClick={onClose}><X className="size-3.5" /></button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[13px] leading-relaxed">
        {!msgs.length && <div className="text-xs text-muted-foreground">说说想怎么大改，比如「整体字幕太密，前 10 秒剪掉，标题换成更有冲击力的」。AI 会先讲它的理解和打算，你同意了才动手。</div>}
        {msgs.map((m, i) => m.role === "sys" ? (
          <div key={i} className="text-center text-[11px] text-muted-foreground">— {m.text} —</div>
        ) : (
          <div key={i} className={cn("max-w-[92%] whitespace-pre-wrap rounded-2xl px-3 py-2", m.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-secondary")}>
            {m.text.replace(/\*\*|`/g, "")}
            {m.plan && <div className="mt-1.5 text-[11px] opacity-70">要改：{(m.scopes || []).map((k) => REVISE_LABEL[k]).join("、") || "AI 判断"}{m.approved ? " · 已同意" : ""}</div>}
          </div>
        ))}
        {busy === "talk" && <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> AI 在想怎么改…</div>}
        <div ref={end} />
      </div>
      <div className="border-t border-border/70 p-3">
        {canGo && <Button className="mb-2 w-full rounded-full" onClick={approve} disabled={!!busy}>{busy === "go" ? <Loader2 className="animate-spin" /> : <Check />} 同意，开始改</Button>}
        <div className="flex items-end gap-1.5">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={canGo ? "不对的话接着说…" : "想怎么改？"} className="min-h-10 rounded-xl text-[13px]" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); say(); } }} />
          <Button size="icon-sm" className="shrink-0 rounded-full" aria-label="发送" onClick={say} disabled={!text.trim() || !!busy}><Send /></Button>
        </div>
      </div>
    </div>
  );
}

// 在页面里直接看成片、对文案，不用跳新标签页
function Viewer({ j, onClose }: { j: Job; onClose: () => void }) {
  const { deleteJob } = useStudio();
  const [chat, setChat] = useState(!!j.chat?.length);
  const canChat = !j.id.startsWith("tpl-");
  const o = j.outputs || {};
  const uncertain = o.summary?.uncertain || [];
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content aria-describedby={undefined} className={cn("fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl bg-card shadow-2xl outline-none", chat ? "w-[min(1220px,96vw)]" : "w-[min(880px,94vw)]")}>
          <div className="grid shrink-0 place-items-center bg-black">
            {o.video ? <video src={o.video} poster={o.cover || undefined} controls autoPlay className="aspect-[9/16] h-[min(92vh,720px)]" /> : <div className="grid aspect-[9/16] h-[min(92vh,720px)] place-items-center text-white/50"><Film /></div>}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold leading-snug tracking-tight">{jobTitle(j)}</Dialog.Title>
                <div className="mt-1 text-xs text-muted-foreground">{jobDate(j)}{o.summary?.summary && ` · ${o.summary.summary}`}</div>
              </div>
              {canChat && !chat && <Button size="xs" variant="secondary" className="mt-1 shrink-0 rounded-full" onClick={() => setChat(true)}><MessageSquare /> 对话大改</Button>}
              <Dialog.Close aria-label="关闭" className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="size-4" /></Dialog.Close>
            </div>
            {uncertain.length > 0 && (
              <div className="rounded-2xl bg-[var(--warning)]/12 p-3 text-xs leading-relaxed">
                <div className="mb-1 flex items-center gap-1 font-semibold"><AlertTriangle className="size-3.5 text-[var(--warning)]" /> 发之前对一下这 {uncertain.length} 句（听不清，已删掉或不确定）</div>
                <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
              </div>
            )}
            <CaptionEditor j={j} caption={o.caption || ""} />
            {!j.id.startsWith("tpl-") && <ReviseBox j={j} onSent={onClose} />}
            <div className="flex flex-wrap items-center gap-2">
              {o.video && <Button className="rounded-full" asChild><a href={`/api/pack?id=${encodeURIComponent(j.id)}`} download><Download /> 下载 zip</a></Button>}
              {o.video && <Button variant="secondary" className="rounded-full" onClick={() => copyZip(j.id)}><FileArchive /> 复制 zip</Button>}
              <Button variant="secondary" className="rounded-full" onClick={() => openFolder(j.id)}><FolderOpen /> 打开文件夹</Button>
              <Button variant="ghost" className="ml-auto rounded-full text-muted-foreground hover:text-destructive" onClick={() => { if (window.confirm("从作品库删除这条？文件会移到 jobs/_trash，需要时还能找回。")) { onClose(); setTimeout(() => deleteJob(j.id), 300); } }}><Trash2 /> 删除</Button>
            </div>
          </div>
          {canChat && chat && <ChatPanel j={j} onClose={() => setChat(false)} onStarted={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkCard({ j, onOpen }: { j: Job; onOpen: () => void }) {
  const o = j.outputs || {};
  const pending = !j.checked && !!o.summary?.uncertain?.length;
  return (
    <div className="group">
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-muted shadow-card">
        <button onClick={onOpen} aria-label={`播放 ${jobTitle(j)}`} className="block size-full">
          {o.cover ? <img src={o.cover} alt="" className="size-full object-cover object-[50%_30%] transition-transform duration-500 group-hover:scale-[1.03]" /> : <div className="grid size-full place-items-center text-muted-foreground"><Film /></div>}
          <span className="absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"><Play className="size-4 fill-current" /></span>
        </button>
        {pending && <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-full bg-[var(--warning)] px-2 py-0.5 text-[11px] font-semibold text-black"><AlertTriangle className="size-3" /> 待检查 {o.summary!.uncertain!.length}</span>}
        <div className="absolute bottom-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Button size="icon-sm" variant="secondary" className="size-7 rounded-full bg-background/90 shadow-sm [&_svg]:size-3.5" aria-label="打开文件夹" title="打开文件夹（剪映素材也在里面）" onClick={() => openFolder(j.id)}><FolderOpen /></Button>
          {o.video && <Button size="icon-sm" variant="secondary" className="size-7 rounded-full bg-background/90 shadow-sm [&_svg]:size-3.5" aria-label="下载 zip" title="下载 zip（成片、封面、文案）" asChild><a href={`/api/pack?id=${encodeURIComponent(j.id)}`} download><Download /></a></Button>}
          {o.video && <Button size="icon-sm" variant="secondary" className="size-7 rounded-full bg-background/90 shadow-sm [&_svg]:size-3.5" aria-label="复制 zip" title="复制 zip（成片、封面、文案）" onClick={() => copyZip(j.id)}><FileArchive /></Button>}
        </div>
      </div>
      <div className="mt-2.5 line-clamp-2 text-sm font-medium">{jobTitle(j)}</div>
      <div className="mt-0.5 flex items-center text-xs text-muted-foreground">
        {jobDate(j)}
        {o.caption && <button className="ml-auto flex items-center gap-1 hover:text-foreground" onClick={() => copyCaption(o.caption!)}><Copy className="size-3" />复制文案</button>}
      </div>
    </div>
  );
}

// 「制作」页「刚做好」下面的"最近学到"：和刚做好一样的列表，默认露 3 条，展开就在页面里往下展开全部
function LearnedList() {
  const [data] = useLessons();
  const [open, setOpen] = useState(false);
  // 只列现在有效的规则（删掉的、被覆盖的不显示），最近学到或更新的在前
  const learned = [...data.rules].sort((a, b) => b.at - a.at);
  if (!learned.length) return null;
  const shown = open ? learned : learned.slice(0, 3);
  const day = (t: number) => new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Sparkles className="size-3.5 text-primary" />最近学到
        <span className="text-xs font-normal text-muted-foreground">你纠正过的，以后自动遵守</span>
        <button onClick={() => window.dispatchEvent(new Event("open-lessons"))} className="ml-auto text-xs font-normal text-muted-foreground hover:text-foreground">管理</button>
      </div>
      <div className="divide-y divide-border rounded-2xl bg-card shadow-card">
        {shown.map((l) => (
          <div key={l.id} className="flex items-start gap-3 px-4 py-2.5 text-[13px]">
            <span className={cn("mt-0.5 shrink-0 rounded px-1.5 text-[10px] leading-4", l.hits > 1 ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary")}>{l.hits > 1 ? `${l.hits} 次` : "新"}</span>
            <span className="min-w-0 flex-1 leading-relaxed">{l.pinned && <span className="mr-1 text-primary">●</span>}{l.rule}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{day(l.at)}</span>
          </div>
        ))}
        {learned.length > 3 && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-center gap-1 py-2 text-xs text-muted-foreground hover:text-foreground">
            {open ? "收起" : `展开全部 ${learned.length} 条`}
          </button>
        )}
      </div>
    </div>
  );
}

function LibraryPage() {
  const { jobs, setPage, pollJobs } = useStudio();
  const [kind, setKind] = useState<"all" | "clip" | "tpl">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const done = jobs.filter((j) => j.status === "done");
  const isTpl = (j: Job) => j.id.startsWith("tpl-");
  const shown = done.filter((j) => kind === "all" || (kind === "tpl") === isTpl(j));
  const opened = done.find((j) => j.id === openId);
  const open = (j: Job) => {
    setOpenId(j.id);
    if (!j.checked) fetch("/api/checked", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: j.id }) }).then(pollJobs).catch(() => {});
  };
  return (
    <div className="mx-auto max-w-[1180px] px-10 py-10">
      <div className="flex items-end">
        <PageTitle title="作品库" sub={`${done.length} 条成片 · 点封面播放和对文案`} />
        {done.some(isTpl) && done.some((j) => !isTpl(j)) && <div className="mb-8 ml-auto"><Segmented value={kind} onChange={setKind} options={[{ v: "all", label: "全部" }, { v: "clip", label: "双语字幕" }, { v: "tpl", label: "快问快答" }]} /></div>}
      </div>
      {shown.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-5 gap-y-8">{shown.map((j) => <WorkCard key={j.id} j={j} onOpen={() => open(j)} />)}</div>
      ) : (
        <Empty icon={<Library />} title="还没有作品" text="在「发现」里挑一条，点「一键制作」。" action={<Button className="rounded-full" onClick={() => setPage("discover")}>去发现</Button>} />
      )}
      {opened && <Viewer j={opened} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/* ============ 根 ============ */
export default function App() {
  const { init, pollJobs, page, loggedIn, loginCmd, recheck, login, loggingIn, theme, setTheme } = useStudio();
  useEffect(() => {
    init();
    const t = setInterval(pollJobs, 3000);
    return () => clearInterval(t);
  }, [init, pollJobs]);
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
        <main className="flex min-w-0 flex-1 flex-col">
          {loggedIn === false && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-6 py-2 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1">{loggingIn ? "已在浏览器打开登录页：点「授权 / Authorize」，完成后这里会自动连上。" : "AI 还没连上：选片和看作品照常能用，AI 精选和制作要先登录。点「一键登录」，在弹出的网页上授权就行。"}</span>
              <Button size="sm" className="rounded-full" disabled={loggingIn} onClick={login}>{loggingIn ? <Loader2 className="animate-spin" /> : <LogIn />} {loggingIn ? "等待授权…" : "一键登录"}</Button>
              <Button size="sm" variant="ghost" className="rounded-full" onClick={() => copyText(loginCmd).then(() => toast.success("登录命令已复制", { description: "打开终端（PowerShell）粘贴运行" })).catch(() => toast(loginCmd))}><Copy /> 复制命令</Button>
              <Button size="sm" variant="ghost" className="rounded-full" onClick={recheck}><RotateCw /> 重新检查</Button>
            </div>
          )}
          <ScrollArea className="min-h-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div key={page} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                {page === "discover" ? <Discover /> : page === "template" ? <TemplatePage /> : page === "studio" ? <Studio /> : <LibraryPage />}
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
