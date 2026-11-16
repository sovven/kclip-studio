// 第一次使用：node scripts/setup.mjs（或 npm run setup）
// 做三件事：1) 没有出片模板就把它下载到 vendor/  2) 给模板装依赖  3) 打印环境检查清单
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createConfig } from "../config.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const JOBS = path.join(ROOT, "jobs");
mkdirSync(JOBS, { recursive: true });
const cfg = createConfig({ ROOT, JOBS });
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!cfg.skill) {
  console.log("下载出片模板 xhs-bilingual-clip → vendor/ …");
  mkdirSync(path.join(ROOT, "vendor"), { recursive: true });
  try { sh("git", ["clone", "--depth", "1", "https://github.com/sovven/xhs-bilingual-clip.git", "vendor/xhs-bilingual-clip"], ROOT); }
  catch { console.log("下载失败：检查网络和 git，或者手动把仓库放到 vendor/xhs-bilingual-clip"); }
}
if (cfg.skill && !cfg.skillModules) {
  console.log("给出片模板装依赖（Remotion，第一次要几分钟）…");
  try { sh("npm", ["install"], path.join(cfg.skill, "template")); } catch { console.log("依赖没装上，稍后在页面「环境」里看提示"); }
}

console.log("\n环境检查：");
for (const c of cfg.checks()) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.ok ? "" : `  ← ${c.need}需要`}`);
  if (!c.ok && c.cmd) console.log(`      ${c.cmd}`);
  if (!c.ok && c.url) console.log(`      ${c.url}`);
}
console.log(`\n${existsSync(path.join(ROOT, "dist/index.html")) ? "" : "还没构建页面，npm start 会自动构建。\n"}启动：npm start  →  http://localhost:5291`);
