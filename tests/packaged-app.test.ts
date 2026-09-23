// 打包产物定位与垫片写法（tests/helpers/packaged-app.mjs）的单测。
// 为什么专门测它：win 产物只能在 Windows runner 上验（本机 macOS 交叉出不了），这几段纯逻辑是
// 「CI 第一次跑就红在路径上」的唯一防线——平台可注入，三个分支在本地都能跑。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPackagedApp, packagedSkipHint, writeCliShim } from "./helpers/packaged-app.mjs";

/** 临时仓库根 @returns {string} */
function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-packaged-app-"));
}

/** 造一个文件（含父目录） @param {string} file 绝对路径 */
function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

/** macOS --dir 产物 @param {string} root 仓库根 @param {string} [name] release 下的目录名 */
function macApp(root: string, name = "mac-arm64"): string {
  const exe = path.join(root, "release", name, "Bunkiten.app", "Contents", "MacOS", "Bunkiten");
  touch(exe);
  return exe;
}

describe("findPackagedApp：三平台的 --dir 产物布局", () => {
  it("macOS：exe 在 Contents/MacOS/，资源在 Contents/Resources/", () => {
    const root = tmpRoot();
    const exe = macApp(root);
    expect(findPackagedApp(root, "darwin")).toEqual({
      exe,
      resources: path.join(root, "release", "mac-arm64", "Bunkiten.app", "Contents", "Resources"),
      label: "mac-arm64/Bunkiten.app",
    });
  });

  it("macOS：跳过 x64/ia32 目录（历史遗留的 release/mac-x64 不该顶着跑，即使它更新）", () => {
    const root = tmpRoot();
    const arm = macApp(root, "mac-arm64");
    const old = macApp(root, "mac-x64");
    const future = Date.now() + 60_000; // 故意让 x64 那份「更新」：跳过规则必须压过 mtime
    fs.utimesSync(old, future / 1000, future / 1000);
    expect(findPackagedApp(root, "darwin")?.exe).toBe(arm);
  });

  it("Windows：exe 与 resources 同级（release/win-unpacked/）", () => {
    const root = tmpRoot();
    const exe = path.join(root, "release", "win-unpacked", "Bunkiten.exe");
    touch(exe);
    expect(findPackagedApp(root, "win32")).toEqual({
      exe,
      resources: path.join(root, "release", "win-unpacked", "resources"),
      label: "win-unpacked/Bunkiten.exe",
    });
  });

  it("Linux：release/linux-unpacked/bunkiten（未发布，留口子）", () => {
    const root = tmpRoot();
    const exe = path.join(root, "release", "linux-unpacked", "bunkiten");
    touch(exe);
    expect(findPackagedApp(root, "linux")?.exe).toBe(exe);
  });

  it("多个产物：取 mtime 最新的那个（重打过的那份才算数）", () => {
    const root = tmpRoot();
    const first = macApp(root, "mac-arm64");
    const second = macApp(root, "mac");
    const future = Date.now() + 60_000;
    fs.utimesSync(second, future / 1000, future / 1000);
    expect(findPackagedApp(root, "darwin")?.exe).toBe(second);
    fs.utimesSync(first, future / 1000 + 60, future / 1000 + 60);
    expect(findPackagedApp(root, "darwin")?.exe).toBe(first);
  });

  it("没有产物：null（调用方据此整组 skip，不该让没打包的人跑测试先失败）", () => {
    const root = tmpRoot();
    expect(findPackagedApp(root, "darwin")).toBeNull();
    fs.mkdirSync(path.join(root, "release"), { recursive: true });
    expect(findPackagedApp(root, "darwin")).toBeNull();
  });
});

describe("writeCliShim：垫片按平台给对形态", () => {
  it("当前平台：写在给定目录、返回绝对路径、内容指向给定的 node 与脚本", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bunkiten-shim-"));
    const shim = writeCliShim(dir, "grok", process.execPath, "/tmp/fake-engine.mjs");
    const expectedName = process.platform === "win32" ? "grok.cmd" : "grok";
    expect(path.basename(shim)).toBe(expectedName);
    expect(path.dirname(shim)).toBe(dir);
    const body = fs.readFileSync(shim, "utf8");
    expect(body).toContain(process.execPath);
    expect(body).toContain("/tmp/fake-engine.mjs");
    if (process.platform !== "win32") {
      expect(body.startsWith("#!/bin/sh")).toBe(true);
      expect(fs.statSync(shim).mode & 0o111).toBeGreaterThan(0); // 可执行位：少了它 spawn 直接 EACCES
    }
  });
});

describe("packagedSkipHint：按平台给对应的打包命令", () => {
  it("mac / win / 其它", () => {
    expect(packagedSkipHint("darwin")).toContain("npm run dist:mac:dir");
    expect(packagedSkipHint("win32")).toContain("npm run dist:win:dir");
    expect(packagedSkipHint("linux")).toContain("npm run dist:linux:dir");
  });
});
