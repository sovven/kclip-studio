import { create } from "zustand";
import { toast } from "sonner";

export type Video = {
  id: string;
  url: string;
  title: string;
  channel: string;
  views: number;
  duration: number | null;
  thumb: string;
  platform: string;
  category: string;
  topic?: string; // 今日热点里它对应的话题或艺人
  vertical?: boolean;
  meta?: { speech?: "ko" | "none" | "other"; desc?: string };
  ai?: { zh_title: string; summary: string; why: string; tags: string[]; cover_style: CoverStyle; score: number };
};
export type CoverStyle = "band" | "poster" | "card" | "reels";
export type Draft = { video: Video; coverStyle: CoverStyle; note: string; accent?: string; again?: boolean };
export type Job = {
  id: string;
  vid: string;
  url: string;
  title: string;
  coverStyle: CoverStyle;
  status: "queued" | "running" | "done" | "failed";
  steps: number;
  stage?: number;
  createdAt?: number;
  last: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  checked?: boolean;
  outputs: { video?: string | null; cover?: string | null; caption?: string | null; summary?: { title?: string; summary?: string; uncertain?: string[] } | null; folder?: string };
};
export type Category = { id: string; label: string; kind?: string; custom?: boolean; sources: string[] };

const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = <T,>(url: string, data: unknown) => api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const fail = (e: unknown) => { toast.error((e as Error).message); };

export type Page = "discover" | "studio" | "library" | "template";
export type Theme = "light" | "dark" | "system";

// 本机偏好：刷新后还在。无痕模式读写会抛错，一律吞掉
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; } };
const keep = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 无痕模式 */ } };

const applyTheme = (t: Theme) => {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
};
const savedTheme = (() => { try { return (localStorage.getItem("kclip-theme") as Theme) || "light"; } catch { return "light" as Theme; } })();
applyTheme(savedTheme);

export type Engine = "claude" | "codex";
export type Route = { id: string; label: string; custom?: boolean };
export type NewApi = { engine: Engine; name: string; baseUrl: string; apiKey: string; model: string };
type Health = { loggedIn: boolean; engine: Engine; route: string; routes: Record<Engine, Route[]>; loginCmd: string };
const pickHealth = (h: Health) => ({ loggedIn: h.loggedIn, engine: h.engine, route: h.route, routes: h.routes, loginCmd: h.loginCmd });

export const ALL = "all"; // 「推荐」页签：所有栏目混在一起

type State = {
  buzz: { zh: string; ko: string; why: string }[];
  trending: { tag: string; query: string; views: number; best: number; songs: string[] }[];
  loadTrending: () => void;
  page: Page;
  setPage: (p: Page) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  loggedIn: boolean | null;
  engine: Engine;
  route: string;
  routes: Record<Engine, Route[]>;
  loginCmd: string;
  recheck: () => Promise<void>;
  setEngine: (e: Engine) => Promise<void>;
  setRoute: (r: string) => Promise<void>;
  addApi: (a: NewApi) => Promise<void>;
  removeApi: (id: string) => Promise<void>;
  query: string;
  searching: boolean;
  results: Video[];
  search: (q: string) => Promise<void>;
  resolving: boolean;
  openLink: (url: string) => Promise<void>;
  detail: Video | null;
  openDetail: (v: Video | null) => void;
  categories: Category[];
  tab: string;
  setTab: (id: string) => void;
  videos: Record<string, Video[]>;
  loading: Record<string, boolean>;
  loadCat: (id: string, fresh?: boolean) => Promise<void>;
  loadAll: () => Promise<void>;
  addCategory: (label: string, sources: string) => Promise<void>;
  removeCategory: (id: string) => Promise<void>;
  resetCategories: () => Promise<void>;
  hidden: string[];
  hide: (id: string) => void;
  unhideAll: () => void;
  picks: Video[];
  picking: boolean;
  recommend: () => Promise<void>;
  drafts: Draft[];
  addDraft: (d: Draft) => void;
  updateDraft: (id: string, patch: Partial<Draft>) => void;
  removeDraft: (id: string) => void;
  reorder: (from: number, to: number) => void;
  produce: (drafts?: Draft[]) => Promise<void>;
  jobs: Job[];
  pollJobs: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  deleteJob: (id: string) => Promise<void>;
  init: () => Promise<void>;
};

const setDrafts = (drafts: Draft[]) => { keep("kclip-drafts", drafts); return { drafts }; };

export const useStudio = create<State>((set, get) => ({
  buzz: [],
  trending: [],
  loadTrending: () => {
    if (!get().trending.length) api<State["trending"]>("/api/trending").then((trending) => set({ trending })).catch(() => {});
    if (!get().buzz.length) api<State["buzz"]>("/api/buzz").then((buzz) => set({ buzz })).catch(() => {});
  },
  page: load<Page>("kclip-page", "discover"),
  setPage: (page) => { keep("kclip-page", page); set({ page }); },
  theme: savedTheme,
  setTheme: (theme) => { try { localStorage.setItem("kclip-theme", theme); } catch { /* 无痕模式 */ } applyTheme(theme); set({ theme }); },
  loggedIn: null,
  engine: "claude",
  route: "relay",
  routes: { claude: [], codex: [] },
  loginCmd: "claude /login",
  recheck: async () => {
    set({ loggedIn: null });
    try { set(pickHealth(await api<Health>("/api/health?fresh=1"))); } catch (e) { fail(e); }
  },
  setEngine: async (engine) => {
    set({ engine, loggedIn: null });
    set(pickHealth(await post<Health>("/api/auth-mode", { engine })));
  },
  setRoute: async (route) => {
    set({ route, loggedIn: null });
    set(pickHealth(await post<Health>("/api/auth-mode", { route })));
  },
  addApi: async (a) => set(pickHealth(await post<Health>("/api/apis", a))),
  removeApi: async (id) => set(pickHealth(await post<Health>("/api/apis/delete", { id }))),

  query: "",
  searching: false,
  results: [],
  search: async (q) => {
    set({ query: q });
    if (!q.trim()) return set({ results: [] });
    set({ searching: true, results: [] });
    try { set({ results: await api<Video[]>(`/api/search?q=${encodeURIComponent(q)}`) }); }
    catch (e) { fail(e); }
    finally { set({ searching: false }); }
  },
  resolving: false,
  openLink: async (url) => {
    set({ resolving: true });
    try { set({ detail: await api<Video>(`/api/resolve?url=${encodeURIComponent(url)}`) }); }
    catch (e) { fail(e); }
    finally { set({ resolving: false }); }
  },
  detail: null,
  openDetail: (detail) => set({ detail }),

  categories: [],
  tab: load<string>("kclip-tab", ALL),
  setTab: (tab) => {
    keep("kclip-tab", tab);
    set({ tab, query: "", results: [] });
    if (tab === ALL) get().loadAll();
    else get().loadCat(tab);
    if (get().categories.find((c) => c.id === tab)?.kind === "hot") get().loadTrending();
  },
  videos: {},
  loading: {},
  loadCat: async (id, fresh) => {
    if (get().loading[id] || (!fresh && get().videos[id])) return;
    set((s) => ({ loading: { ...s.loading, [id]: true } }));
    try {
      const list = await api<Video[]>(`/api/discover?cat=${encodeURIComponent(id)}${fresh ? "&fresh=1" : ""}`);
      set((s) => ({ videos: { ...s.videos, [id]: list } }));
    } catch (e) {
      fail(e);
    } finally {
      set((s) => ({ loading: { ...s.loading, [id]: false } }));
    }
  },
  // 一个一个来：同时抓太多会触发 YouTube 的人机验证
  // 热点要先问榜单和 AI，最慢，放最后
  loadAll: async () => { for (const c of [...get().categories].sort((x, y) => Number(x.kind === "hot") - Number(y.kind === "hot"))) await get().loadCat(c.id); },
  addCategory: async (label, sources) => {
    const r = await post<{ id: string; categories: Category[] }>("/api/categories", { label, sources });
    set({ categories: r.categories });
    get().setTab(r.id);
  },
  removeCategory: async (id) => {
    const r = await post<{ categories: Category[] }>("/api/categories/delete", { id });
    set((s) => ({ categories: r.categories, videos: Object.fromEntries(Object.entries(s.videos).filter(([k]) => k !== id)) }));
    if (get().tab === id) get().setTab(ALL);
  },
  resetCategories: async () => {
    const r = await post<{ categories: Category[] }>("/api/categories/reset", {});
    set({ categories: r.categories });
    get().setTab(ALL);
  },
  hidden: load<string[]>("kclip-hidden", []),
  hide: (id) => set((s) => { const hidden = [...s.hidden, id].slice(-500); keep("kclip-hidden", hidden); return { hidden }; }),
  unhideAll: () => { keep("kclip-hidden", []); set({ hidden: [] }); },

  picks: [],
  picking: false,
  recommend: async () => {
    set({ picking: true });
    try {
      const { tab, categories } = get();
      const cats = tab === ALL ? categories.map((c) => c.id) : [tab];
      set({ picks: await api<Video[]>(`/api/recommend?cats=${cats.join(",")}`) });
    } catch (e) {
      fail(e);
    } finally {
      set({ picking: false });
    }
  },

  drafts: load<Draft[]>("kclip-drafts", []),
  addDraft: (d) => set((s) => setDrafts(s.drafts.some((x) => x.video.id === d.video.id) ? s.drafts.map((x) => (x.video.id === d.video.id ? d : x)) : [...s.drafts, d])),
  updateDraft: (id, patch) => set((s) => setDrafts(s.drafts.map((d) => (d.video.id === id ? { ...d, ...patch } : d)))),
  removeDraft: (id) => set((s) => setDrafts(s.drafts.filter((d) => d.video.id !== id))),
  reorder: (from, to) =>
    set((s) => {
      const d = [...s.drafts];
      const [m] = d.splice(from, 1);
      d.splice(to, 0, m);
      return setDrafts(d);
    }),
  produce: async (drafts) => {
    const list = drafts || get().drafts;
    if (!list.length) return;
    await post("/api/jobs", {
      items: list.map((d) => ({ id: d.video.id, url: d.video.url, title: d.video.ai?.zh_title || d.video.title, coverStyle: d.coverStyle, note: d.note, accent: d.accent, again: d.again })),
    });
    set((s) => setDrafts(drafts ? s.drafts.filter((d) => !list.some((x) => x.video.id === d.video.id)) : []));
    get().pollJobs();
  },

  jobs: [],
  pollJobs: async () => {
    try {
      const prev = get().jobs;
      const jobs = (await api<Job[]>("/api/jobs")).reverse();
      // 做完或失败时提醒一下：制作要十几分钟，人一般不在这个页面等
      for (const j of jobs) {
        const was = prev.find((p) => p.id === j.id)?.status;
        if (was !== "running" || j.status === was) continue;
        const name = j.outputs?.summary?.title || j.title;
        if (j.status === "done") toast.success(`做好了：${name}`, { duration: 10000, action: { label: "去看看", onClick: () => get().setPage("library") } });
        else if (j.status === "failed" && j.error !== "已取消") toast.error(`没做成：${name}`, { description: j.error, duration: 10000, action: { label: "查看", onClick: () => get().setPage("studio") } });
      }
      set({ jobs });
    } catch {
      /* 后端暂时没响应，下次再试 */
    }
  },
  retry: async (id) => { await post("/api/retry", { id }).catch(fail); get().pollJobs(); },
  cancelJob: async (id) => { await post("/api/jobs/cancel", { id }).catch(fail); get().pollJobs(); },
  deleteJob: async (id) => { await post("/api/jobs/delete", { id }).then(() => toast("已删除", { description: "文件夹移到了 jobs/_trash，需要时可以找回" })).catch(fail); get().pollJobs(); },

  init: async () => {
    try {
      const categories = await api<Category[]>("/api/categories");
      set({ categories });
      get().pollJobs();
      api<Health>("/api/health").then((h) => set(pickHealth(h))).catch(() => {});
      api<{ picks: Video[] }>("/api/picks").then((p) => p.picks?.length && set({ picks: p.picks })).catch(() => {});
      const tab = categories.some((c) => c.id === get().tab) ? get().tab : ALL;
      get().setTab(tab);
    } catch (e) {
      toast.error(`后端没连上：${(e as Error).message}`);
    }
  },
}));
