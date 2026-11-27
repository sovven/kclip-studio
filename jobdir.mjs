// 作品文件夹准备：模板、字体、依赖链接、原片复用
import { existsSync, mkdirSync, copyFileSync, cpSync, lstatSync, rmdirSync, rmSync, symlinkSync, linkSync, readlinkSync } from "node:fs";
import path from "node:path";
import { FONT_FILES } from "./config.mjs";

export function createJobDir({ cfg, getJobs }) {
  // 出片依赖（Remotion，约 600 MB）整台电脑只装一份：每个作品的 node_modules 只是指向它的链接，不复制、不重装。
  // 由服务自己建链接，不交给 AI；AI 万一装了或复制了一份，跑完会被换回链接
  function linkModules(dir) {
    const target = cfg.skillModules;
    if (!target) throw new Error("出片模板的依赖还没装：点左下角「环境」按提示装一次（整台电脑只需要装一次）");
    const nm = path.join(dir, "node_modules");
    let st = null;
    try { st = lstatSync(nm); } catch {}
    if (st?.isSymbolicLink()) {
      let to = "";
      try { to = readlinkSync(nm); } catch {}
      if (path.resolve(to).toLowerCase() === path.resolve(target).toLowerCase()) return "ok";
      rmdirSync(nm);
    } else if (st) rmSync(nm, { recursive: true, force: true });
    symlinkSync(target, nm, process.platform === "win32" ? "junction" : "dir");
    return st ? "relinked" : "linked";
  }

  // 新作品的项目文件夹由服务准备好：模板（不含依赖）、字体、依赖链接
  function prepareJobDir(dir) {
    const tpl = path.join(cfg.skill, "template");
    const skip = path.resolve(tpl, "node_modules");
    if (!existsSync(path.join(dir, "src"))) cpSync(tpl, dir, { recursive: true, force: false, filter: (s) => path.resolve(s) !== skip });
    const fonts = path.join(dir, "public", "fonts");
    mkdirSync(fonts, { recursive: true });
    for (const f of Object.values(FONT_FILES)) if (cfg.fonts && !existsSync(path.join(fonts, f)) && existsSync(path.join(cfg.fonts, f))) copyFileSync(path.join(cfg.fonts, f), path.join(fonts, f));
    linkModules(dir);
  }

  // 同一条视频以前下过原片就直接复用（同盘硬链接，不占第二份空间），不再联网下载
  function reuseOriginal(j, orig) {
    const src = getJobs().filter((x) => x !== j && x.vid && x.vid === j.vid).map((x) => path.join(x.dir, "original.mp4")).find((f) => existsSync(f));
    if (!src) return false;
    try { linkSync(src, orig); } catch { copyFileSync(src, orig); }
    return true;
  }

  return { linkModules, prepareJobDir, reuseOriginal };
}
