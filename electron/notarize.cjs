// electron-builder afterSign 钩子：mac 公证（notarytool）+ staple。
// electron-builder.yml 的 mac.afterSign 指向本文件；CommonJS（.cjs），因为 package.json 是 "type": "module"。
//
// 三件套（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID）不齐时**直接 return**：
// 本地未签名构建（npm run dist:mac / dist:mac:dir）与「CI 未配 secrets 的未签名发布」都必须照常成功。
// 未签名包无法自动更新（Squirrel.Mac 要求签名一致），以 docs/ARCHITECTURE.md 为准。
//
// 公证成功后还会 xcrun stapler staple 把 ticket 钉进 .app（best-effort，见 staple 注释）。
"use strict";

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

/**
 * 公证后 staple（best-effort）：把 notarization ticket 附到 .app 上，装到离线机器首次启动也能过 Gatekeeper
 * 的公证检查（否则系统只能联网回查 Apple，离线首启会被拦）。
 *
 * 故意不抛错：spctl/stapler 在未签名或被 Gatekeeper 缓存干扰的环境下可能失败，而这不该让已经产出的包作废
 * —— 失败只打日志，构建照常成功（staple 缺失只影响离线首启体验，在线首启仍会回查公证结果）。
 * @param {string} appPath 打包出来的 .app 绝对路径
 */
function staple(appPath) {
  try {
    execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
    console.log(`[notarize] 已 staple：${appPath}`);
  } catch (err) {
    console.warn(
      `[notarize] staple 失败（不 fail 构建，包仍可联网首启校验）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** @param {import("electron-builder").AfterPackContext & { appOutDir: string }} context */
exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      "[notarize] 跳过公证：缺少 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID 之一（未签名或未配置 secrets 的构建）",
    );
    return;
  }

  // productName = Bunkiten（electron-builder.yml），appInfo.productFilename 与之同源；
  // 兜底 fallback 只是防御 packager.appInfo 异常时拼出 undefined.app 这种路径。
  const productFilename = (packager && packager.appInfo && packager.appInfo.productFilename) || "Bunkiten";
  const appPath = path.join(appOutDir, `${productFilename}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`[notarize] 找不到 .app（跳过公证与 staple）：${appPath}`);
    return;
  }

  // 延迟加载：未装 devDeps 或只做配置预检（--dir）时不因缺模块而失败
  const { notarize } = require("@electron/notarize");
  console.log(`[notarize] 提交公证：${appPath}`);
  await notarize({
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log("[notarize] 公证完成");

  // 只有公证成功才会走到这里 → 此时才值得 staple。
  staple(appPath);
};
