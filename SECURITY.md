# 安全政策

## 这是个什么软件

bunkiten（分岐点）是一个**本机运行**的开源桌面应用（MIT）：Electron 壳 + React 前端，叙事引擎是你自己机器上已登录的 `grok` CLI（ACP 协议）。它没有我们运营的服务端，不收集遥测，不上传你的剧本、存档或对话。

因此，安全责任边界是清楚的：

- **你的本机数据由你自理**：`state/`（进度、摘要、剧情树）与 `presets/`（剧本与美术资产）都写在你的磁盘上，请自行备份。
- **API key / 登录凭据由你自理**：模型凭据属于本机 `grok` CLI，本仓库不存也不代管。报告问题时，请先删掉日志、配置、截图里的 key、token 和带用户名的绝对路径。
- **第三方剧本与素材**：从别处拿到的 `presets/` 与美术资产，其内容与来源由你判断；随附 preset 保持全年龄向，接入自己模型生成的内容由玩家自行负责。

## 报告漏洞

请使用 GitHub 的 **Security Advisories** 私密渠道，**不要开公开 issue**：

👉 https://github.com/Jackela/bunkiten/security/advisories/new

适合走这条渠道的问题举例（本应用相关的攻击面）：

- 本机 HTTP 服务的越权 / 目录穿越（`/img`、`/api/*` 的资源白名单绕过）
- 不受信任的剧本内容或引擎输出导致本机任意文件读写、命令执行
- Electron 侧的上下文隔离 / preload 暴露面问题
- 依赖链或打包产物中的供应链问题

`SECURITY.md` / 依赖更新之外的一般性 bug（闪退、协议不匹配、界面错乱等）请走公开 issue 的缺陷模板。

## 支持范围

- 只支持**最新 release**（[Releases](https://github.com/Jackela/bunkiten/releases)，版本号见 `package.json`）：旧版本的问题请先升级再复现。
- 从源码运行（`main` 分支）也受理，但请附 commit hash。
- 安装包未签名：macOS 首次打开需右键「打开」，Windows 会有 SmartScreen 提示——这是分发形态限制，不算漏洞。
