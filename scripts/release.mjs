// 发布构建：产出签名安装包，并生成 updater 所需的 latest.json。
//
// 用法：npm run release
// 密钥密码可用环境变量 TAURI_KEY_PASSWORD 覆盖，缺省使用生成密钥时的密码。
//
// 产出（src-tauri/target/release/bundle/nsis/）：
//   FloatingNotepad_x.x.x_x64-setup.exe   安装包（上传 GitHub Release）
//   <安装包>.sig                          签名（供核对，无需上传）
//   latest.json                           更新清单（上传 GitHub Release）
//
// 之后在 GitHub 新建 Release（tag 形如 v0.1.0），上传安装包与 latest.json 即可，
// 应用内「检查更新」会读取该清单。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = path.join(os.homedir(), ".tauri", "floatingnotepad.key");
const password = process.env.TAURI_KEY_PASSWORD ?? "floatingnotepad";
const repo = "https://github.com/Noodles-Lover/FloatingNotepad";

if (!fs.existsSync(keyPath)) {
  console.error(`[release] 未找到签名私钥: ${keyPath}`);
  console.error("[release] 请用 `npm run tauri -- signer generate` 生成后重试。");
  process.exit(1);
}

const keyContent = fs.readFileSync(keyPath, "utf8");

// tauri-winres 需要 Windows SDK 的 rc.exe 来嵌入图标与版本信息，
// 而它通常不在 PATH 中（只有 VS 开发者命令行才会注入）。这里主动找出来。
//
// 注意键名：Windows 上 PATH 的真实键名通常是 `Path`，而展开 `process.env`
// 得到的是原始键名（即 `Path`），此时读 `env.PATH` 会是 undefined。
// 若直接 `env.PATH = 新值` 就会把 PATH 覆盖成只剩 SDK 目录，
// 导致子进程找不到 node（报错形如 "'node' is not recognized"）。
const env = {
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: keyContent,
  TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath,
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
};
if (process.platform === "win32") {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (fs.existsSync(kits)) {
    const rc = fs
      .readdirSync(kits)
      .sort()
      .reverse()
      .map((v) => path.join(kits, v, "x64", "rc.exe"))
      .find((p) => fs.existsSync(p));
    if (rc) {
      env.RC = rc;
      const pathKey =
        Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      env[pathKey] = `${path.dirname(rc)}${path.delimiter}${env[pathKey] ?? ""}`;
    }
  }
}

// Windows 下 .cmd 必须由 shell 解释，否则 spawn 会失败（EINVAL）且 status 为 null。
const tauriBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const built = spawnSync(tauriBin, ["build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env,
});
if (built.error) {
  console.error(`[release] 无法启动构建: ${built.error.message}`);
  process.exit(1);
}
if (built.status !== 0) process.exit(built.status ?? 1);

const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
if (!fs.existsSync(bundleDir)) {
  console.error(`[release] 未找到产物目录: ${bundleDir}`);
  process.exit(1);
}

const { version } = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);

// 产物目录会累积历次构建的安装包，必须按当前版本号挑选：
// 若只取目录里第一个 .exe，会把旧版本的文件名和它的签名写进清单，
// 表现为「检测到了新版本，但下载 404」。
const exe = fs
  .readdirSync(bundleDir)
  .find((f) => f.endsWith(".exe") && f.includes(version));
if (!exe) {
  console.error(`[release] 未找到版本号为 ${version} 的安装包（.exe）。`);
  console.error("[release] 请确认构建成功，或清理 bundle 目录中的旧产物后重试。");
  process.exit(1);
}

const sigPath = path.join(bundleDir, `${exe}.sig`);
if (!fs.existsSync(sigPath)) {
  console.error(`[release] 未找到签名文件: ${sigPath}`);
  console.error("[release] 构建未产出签名，更新将无法通过校验。请检查：");
  console.error("  1. tauri.conf.json 的 bundle.createUpdaterArtifacts 是否为 true（默认为 false）");
  console.error("  2. TAURI_SIGNING_PRIVATE_KEY 私钥与密码是否正确");
  process.exit(1);
}

const signature = fs.readFileSync(sigPath, "utf8").trim();

const manifest = {
  version,
  notes: `v${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${repo}/releases/download/v${version}/${exe}`,
    },
  },
};

const out = path.join(bundleDir, "latest.json");
fs.writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n[release] 已生成更新清单: ${out}`);
console.log(`[release] 上传 ${exe} 与 latest.json 到 Release v${version} 后，更新即可生效。`);
console.log(`[release] 下载链接需与清单一致: ${manifest.platforms["windows-x86_64"].url}`);
