# 发版与代码签名（维护者向）

发版流程本身见 [ARCHITECTURE.md](ARCHITECTURE.md) 的「发布（打 tag 即发版）」一节。这份文档只管一件事：**两个平台的代码签名怎么开、开了会怎样、怎么验**。

一句话现状：签名**完全条件化**——证书没有时两条路都照常出包（只是未签名），证书到手后只需要往 GitHub Secrets 里放几个值，**不改代码、不改配置**。

> 为什么「放了 secrets 就自动生效」这句在本仓库成立：mac 侧靠 `CSC_LINK` 触发的 identity 自动发现 + `afterSign` 公证钩子；win 侧靠 `electron-builder` 的默认行为（`win` 段刻意不写 `signExecutable`，见 `electron-builder.yml` 那段注释）——**有 cscInfo 就签，没有就只打一条 debug 跳过签名**，而图标/版本元数据是另一条路径，未签名构建照样写。这两条路都在 workflow 里做的只是「把空值的 secrets 变量从环境里摘掉」。

## 1. 现状（读代码可得）

| 平台 | 无 secrets（仓库默认） | 配了证书 |
|---|---|---|
| macOS | 未签名。首次打开要**右键 → 打开**（Gatekeeper 拦一次）；**不能自动更新**（见下） | Developer ID 签名 + notarytool 公证 + `xcrun stapler staple` 把 ticket 钉进 `.app`；首次直接打开；自动更新这才可用 |
| Windows | 未签名。SmartScreen 会拦（「更多信息 → 仍要运行」） | 应用 exe、asar 外的 exe/dll、NSIS 安装器与卸载器都签名，并默认带 RFC3161 时间戳 |

- mac 链路：`electron-builder.yml` 的 `mac` 段（`hardenedRuntime` + `build/entitlements.mac.plist`）→ `CSC_LINK` 触发 identity 自动发现 → 根级 `afterSign: electron/notarize.cjs` 提交公证 → staple（best-effort，失败只告警）。三件套 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 不齐时钩子直接 return，构建照常成功。
- win 链路：`WIN_CSC_LINK`（.pfx 的 base64）→ 每次 `packager.signIf()` 调用（应用 exe、asar 外 exe/dll、`NsisTarget` 里 `buildInstaller` 的安装器与 `computeScriptAndSignUninstaller` 的卸载器、`nsisUtil` 的 `elevate.exe`）→ signtool + `/tr http://timestamp.digicert.com`（时间戳默认开，无需配置）。
- **未签名 mac 包无法自动更新**：Squirrel.Mac 要求新旧包签名一致，而仓库默认发布的正是未签名包，`electron-updater` 在 mac 上只会静默失败（升级走手动下载 Release 产物）。这条也写在 `docs/ARCHITECTURE.md` 的「已知限制」里。
- `.dmg` 本身**不签名**（`dmg.sign` 默认 `false`，官方说明它与公证要求叠加会产生多余错误）——验签名验的是 dmg 里的 `.app`。

## 2. 怎么开启

### 2.1 先准备证书

**macOS：Apple Developer Program（个人 $99/年）**

1. developer.apple.com → Certificates, Identifiers & Profiles → Certificates → **+** → 选 **Developer ID Application**。
   - 不要选 Apple Development / Apple Distribution（那是 App Store 与开发调试用的）；**也不是** Developer ID Installer（我们不打 `.pkg`）。
   - 生成时要上传一个 CSR：钥匙串访问 → 证书助理 → 「从证书颁发机构请求证书」→ 存到磁盘 → 上传。
2. 下载签发的 `.cer` → 双击导入钥匙串 → 在「登录」钥匙串的**我的证书**里找到它（条目里必须**带私钥**）。
3. 右键该证书 → 导出 → 存成 `.p12`，设一个**导出密码**（就是后面的 `CSC_KEY_PASSWORD`）。

**Windows：OV 或 EV 代码签名证书（从 CA 买：DigiCert / Sectigo / GlobalSign 等）**

- 拿到 `.pfx`（含私钥 + 密码）。**EV 立刻有 SmartScreen 信誉，OV 要靠下载量累积**——这是花钱买时间的那部分，与技术无关。
- 如果证书只以**云签名**形态提供（Azure Trusted Signing / KeyLocker 之类，拿不到 .pfx），本仓库当前的 env 方案**不适用**（见 §5）。

### 2.2 把证书转成 base64

```bash
# macOS
base64 -i cert.p12 | pbcopy

# Linux
base64 -w0 cert.p12

# Windows PowerShell（.pfx）
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard
```

`CSC_LINK` / `WIN_CSC_LINK` 都接受 base64 内容（也接受本地路径或 https URL，但 CI 里用 base64）。

### 2.3 往 GitHub Secrets 里加值

仓库 → Settings → Secrets and variables → Actions → New repository secret。**名字逐字照抄**：

| Secret | 平台 | 值 |
|---|---|---|
| `CSC_LINK` | mac | Apple `.p12` 的 base64 |
| `CSC_KEY_PASSWORD` | mac | 导出 `.p12` 时设的密码 |
| `APPLE_ID` | mac | Apple 账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | mac | appleid.apple.com → 登录与安全 → **App 专用密码**（不是账号密码） |
| `APPLE_TEAM_ID` | mac | developer.apple.com → Membership → Team ID（10 位） |
| `WIN_CSC_LINK` | win | Windows `.pfx` 的 base64 |
| `WIN_CSC_KEY_PASSWORD` | win | `.pfx` 的密码 |

- **两把钥匙不能互换**：Apple `.p12` 与 Windows `.pfx`。win job 里刻意不出现 `CSC_LINK`，Windows 签名只由 `WIN_CSC_LINK` 决定（`getCscLink("WIN_CSC_LINK")` 本来还会回退读 `CSC_LINK`，而空串会盖住回退值——所以两个 job 各管各的变量，别串线）。
- **不需要改任何配置文件**：条件判断在 electron-builder 自己身上（有没有 cscInfo）。workflow 只负责把空值的 secrets 变量从环境里摘掉——**改 workflow 时务必保留那两行 unset**，空字符串会被当成「证书配了」而不是「没配」。
- mac 侧只加 `CSC_LINK` / `CSC_KEY_PASSWORD` 会「签名但不公证」（能过 Gatekeeper 的下载校验，但首次启动仍会被拦）；要完整体验就五件套齐全。win 侧两个都加，只加 `WIN_CSC_LINK` 会拿空密码去签（大概率失败）。

### 2.4 加完怎么确认走了哪条路

不要为了试签名去 `workflow_dispatch` 重跑**已经发布过的 tag**——那会把既有 Release 重写一遍。正常做法是下一个版本发版时看日志：

- win job 的 `Package（win nsis + portable，x64）` 步骤会先打一行：`签名路径：WIN_CSC_LINK 已配置 …` 或 `未签名路径：没有 WIN_CSC_LINK …`；
- mac job 未签名时是 `[notarize] 跳过公证：缺少 …`，签名+公证时会看到 `[notarize] 提交公证：…` / `[notarize] 公证完成` / `已 staple`。

### 2.5 常见失败

- `Env WIN_CSC_LINK is not correct, cannot resolve: …` / `not a file`：base64 粘错或值里混了换行。
- `Cannot extract publisher name from code signing certificate`：`.pfx` 读不出来（密码不对，或不是 PKCS12）。报错里给的 workaround 是设 `win.publisherName`，**我们默认不设**——先修证书。
- 时间戳服务偶发不可达：electron-builder 自带重试（signtool 这一层 2 次 / 15s 间隔；下载/网络层另有一次），失败信息里会带 `The specified timestamp server either could not be reached`。
- `CSC_IDENTITY_AUTO_DISCOVERY` **只对 mac 生效**（Windows 签名不受它影响），别指望它在 win 侧起什么作用，也别在 win job 里加它。

## 3. 开启后会发生什么

- **mac**：首启不再拦截；**自动更新这才可用**。这是一扇**单向门**：一旦某个版本签名发布，后续版本必须继续签名——Squirrel.Mac 校验新旧包签名一致，中途把 secrets 删掉会让老客户端更新失败（只能手动下载）。
- **win**：安装器与应用 exe 都有签名；SmartScreen 对 EV 立即放行、对 OV 需要一段信誉累积期；签名带 RFC3161 时间戳，**证书过期后已发布的旧版本仍然有效**（没有时间戳的签名在证书过期当日全线失效）。
- **win 更新链多一道校验**：有证书时 `app-update.yml` 会多出 `publisherName`（取自证书 CN），`electron-updater` 从此会校验下载到的安装器签名；未签名时该键不存在、校验直接跳过（`NsisUpdater.verifySignature` 在 `publisherName == null` 时 return null）。所以**换证书（CN 变）= 换发布链**：老客户端会因为签名校验不过而更新失败，需要手动升级一次。

## 4. 怎么验一次发布

### macOS

```bash
# 从 Release 的 .dmg 装出 App（或解压 .zip），然后：
codesign --verify --deep --strict --verbose=2 /Applications/Bunkiten.app   # 期望：不报错
codesign -dv --verbose=4 /Applications/Bunkiten.app                        # 期望：Authority=Developer ID Application: <你的名字> (TEAMID)
spctl -a -vv /Applications/Bunkiten.app                                    # 期望：accepted / source=Notarized Developer ID
xcrun stapler validate /Applications/Bunkiten.app                          # 期望：The validate action worked!
```

`spctl` 显示 `source=Developer ID`（没有 Notarized 字样）= 签了但没公证；三条里只要 staple 缺失，离线首启仍会被拦（联网首启会回查 Apple）。

### Windows

```powershell
# signtool 来自 Windows SDK；没装 SDK 就用 Get-AuthenticodeSignature
signtool verify /pa /v "Bunkiten Setup <version>.exe"     # 期望：Successfully verified
signtool verify /pa /v "Bunkiten <version>.exe"           # portable 与应用 exe 同理
Get-AuthenticodeSignature "Bunkiten <version>.exe" | Format-List Status,SignerCertificate,TimeStamperCertificate
```

`signtool verify /pa /v` 的输出里应能看到 `Timestamp Verified by:`（时间戳）。`/pa` 不能省——它是「按默认验证策略」，缺了会对自签/未知 CA 误报。

### 应用内 updater（唯一的真验收）

1. 装上一个**已签名**的旧版本（例如 Release 里的 v1.10.0）。
2. 打一个**已签名**的新版本 tag 并发布。
3. 启动旧版本：打包态 `electron/main.js` 会调 `checkForUpdatesAndNotify()`（逃生门 `BUNKITEN_DISABLE_UPDATE=1`，开发态不查）。
4. 期望：mac 下载后替换并重启到新版；win 下载后校验 `publisherName` 再拉起安装器。

**必须成对**：未签名 → 未签名在 win 上能更新（只是没有签名校验，mac 上不行）；签名 → 签名才通。所以「验更新」这件事只有在证书到齐之后才有意义。

### 本地不签名跑法（现在就是这么跑的）

```bash
npm run dist:mac      # dmg + zip，arm64 + x64
npm run dist:mac:dir  # 只出 .app 目录（不含 app-update.yml，不能用来验更新）
npm run dist:win      # nsis + portable，x64
```

- 三个脚本都带 `CSC_IDENTITY_AUTO_DISCOVERY=false`。注意这个变量**只关 mac 的 identity 自动发现**，对 Windows 没有影响——跑之前先确认 shell 里没有 `export` 过 `CSC_LINK` / `WIN_CSC_LINK`（`env | grep -i csc` 看一眼），否则本地构建会真去用那把证书。
- 本地产物未签名：mac 首次打开要右键 → 打开；Windows 是 SmartScreen「更多信息 → 仍要运行」。
- **签名只能在有真证书的环境验证**。本机没证书时 `codesign --verify` 会说 `code object is not signed at all`、`signtool verify` 会说 `No signature found`——那是预期结果，不是坏了。CI 上也验不了（secrets 不进 fork/PR，也不该为了验签名在 CI 里塞证书）。

## 5. 我们不做的事

- **不把证书入库**：`.p12` / `.pfx` / 各种密码 / `APPLE_*` 只进 GitHub Secrets，永远不提交、不为它们开 `.gitignore` 例外。
- **不在未签名产物上假装签名**：不加「跳过签名但写点什么」的步骤，不用自签证书（self-signed）冒充开发者签名，不打开 `forceCodeSigning`——证书没到也必须能发版。
- **不改玩家的 Gatekeeper / SmartScreen 设置**：文档只给系统自带的两条途径（右键 → 打开；更多信息 → 仍要运行），不教 `spctl --master-disable`，也不写「请关闭系统安全策略」这类步骤。
- **不跨平台串钥匙**：Apple `.p12` 不喂给 Windows 构建（win job 只认 `WIN_CSC_LINK`），Windows `.pfx` 也不喂给 mac。
- **不为了试签名重跑已发布的 tag**：`workflow_dispatch` 会更新既有 Release；验证走下一个版本，或本地有真证书的环境。
- **不做云签名**（Azure Trusted Signing / KeyLocker 等）：当前实现只支持 pfx + env；要换形态是 ADR 级别的事（连同「证书不由 CI 托管」这个前提一起重开讨论）。

## 6. 相关文件

| 文件 | 管什么 |
|---|---|
| `electron-builder.yml` | `win` 段（为什么不写 `signExecutable`）、`mac` 段（`hardenedRuntime` / entitlements）、根级 `afterSign` |
| `.github/workflows/release.yml` | `build-mac` 的 `CSC_LINK` + 三件套条件 env、`build-win` 的 `WIN_CSC_LINK` 条件 env（两处都先 unset 空值） |
| `electron/notarize.cjs` | 公证 + staple 钩子（三件套不齐直接 return，不 fail 构建） |
| `docs/ARCHITECTURE.md` | 「打包布局」与「已知限制」（未签名 mac 无法自动更新） |
