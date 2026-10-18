# GitVault Android

Android 使用 Capacitor 打包 `dist` 中的网页资源，复用网页界面、配色和 GitHub 同步逻辑。安装包不是远程网站的快捷方式；发布网页不会自动更新已安装 APK。

## 构建

需要 Node.js 22+、JDK 21、Android SDK Platform 36、Build Tools 36.0.0。Android 最低系统版本为 7.0，WebView 需要 119+；版本过旧时显示更新说明。

```bash
npm ci
npm run android:sync
npm run android:open
```

`android:sync` 使用相对资源路径构建并同步原生插件，不影响 Pages 构建的 `/Get-Up_GitVault/` 路径。网页使用 `npm run build -- --base=/Get-Up_GitVault/`。

Linux/macOS 可运行 `npm run android:debug`。Windows 先运行 `npm run android:sync`，再运行 `android\gradlew.bat -p android assembleDebug`，或在 Android Studio 打开 `android/`。

输出：`android/app/build/outputs/apk/debug/app-debug.apk`。测试版包名为 `com.gitvault.app.debug`，正式版为 `com.gitvault.app`；两者数据空间独立。未配置固定签名 Secrets 的测试包可直接安装，但不同 CI 机器生成的调试签名可能不同，不能保证覆盖安装。不要用测试包存放唯一的数据副本。

GitHub Actions 的 **Build Android APK** 在相关 main 变更后自动运行，也可手动执行。完成后在该次运行的 Artifacts 下载 `GitVault-test-apk`；正式版输出为 `GitVault-release-apk`。没有签名 Secrets 时正式版为 unsigned，不能直接安装。

## 正式签名与升级

长期保存自己的签名密钥。GitHub 仓库 Settings → Secrets and variables → Actions 配置：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | JKS/keystore 文件的 Base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 签名别名 |
| `ANDROID_KEY_PASSWORD` | 该别名的密码 |

构建只在 runner 临时目录解码密钥，完成后删除；不要把密钥、密码或用户 GitHub Token 提交到仓库。配置齐全后工作流生成签名正式 APK。后续升级必须保持正式包名和签名，并增加 versionCode。CI 使用递增的运行编号；手工构建可设置 `GITVAULT_VERSION_CODE` 和 `GITVAULT_VERSION_NAME`。若重建工作流导致运行编号变小，需使用高于已安装版本的 versionCode。

本地正式构建设置 `ANDROID_KEYSTORE_PATH`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`，再运行 `npm run android:release`；Windows 使用 `gradlew.bat -p android assembleRelease`。没有签名配置时产生未签名正式 APK。

## 弹窗与手机操作

- 确认和文字输入使用异步应用内弹窗，沿用原配色；Token 输入隐藏字符。取消不会当作确认。备份覆盖需要单独确认。
- 成功提示自动消失；失败提示保留至关闭，并提供查看日志入口。
- 系统文件／目录选择器仍由 Android 展示，不伪造授权。返回键优先关闭当前应用弹窗，再回项目列表／首页；运行中的任务先询问取消，退出前检查安全存储。
- 不锁定方向；软键盘出现时根据可见视口限制弹窗高度，Android 原生处理系统栏与屏幕缺口。

系统栏避让放在原生内容父容器：状态栏／刘海占用顶部和侧边区域，底部使用导航栏与键盘高度的较大值，再把已处理的 Insets 消费掉。不能只设置 WebView padding，否则 HTML 的固定导航、顶栏和弹窗仍可能绘制在系统栏下方。Android 16 模拟器测试直接检查 WebView 屏幕坐标、横竖屏与键盘区域，并保存截图。

启动器和启动画面使用顶栏同款灰绿渐变、白色衬线 GV 标识。源文件在 `assets/gitvault-icon.svg`，文字已转为路径；安装 Inkscape 后运行 `python scripts/generate-android-icons.py` 可生成各密度 PNG 与 Android 自适应图标。网页布局和顶栏样式不受影响。

Capacitor 的 `SystemBars.insetsHandling` 设为 `disable`，由 `MainActivity` 的内容父容器统一处理 Insets；否则默认插件还会给 DecorView 增加键盘高度，导致重复避让。

源码可选连接自有 Git 服务，配置与网页一致，见 [Git 传输说明](GIT_TRANSPORT.md)。此模式使用 HTTPS 服务执行 Git，不声称 APK 内置了 Git CLI。仓库、分支绑定、快照和本地清理选择继续使用现有逻辑。

## 缓存、目录与下载

未授权目录时继续使用 IndexedDB 源码缓存。选择设置 → APK 下载存储目录 → **选择并授权目录**后，已授权目录成为本机项目主存储。源码直接写入软件创建的子目录，内部数据库只保存文件引用、快照、绑定和任务记录。目录位置不跨设备同步，Token 保留在 Keystore 加密存储。

目录结构为 `GitVault-安装标识/项目名-来源分支摘要/提交-版本标识/files/源码路径`，版本目录包含 `.gitvault-snapshot.json` 清单。测试版与正式版使用不同安装标识，互不清理对方目录。符号链接保存为链接文本，文件模式保存在清单。

- 下载先写候选目录，逐文件核对 Git blob SHA，完整核验后才切换引用。中断可重试并复用核验通过的文件，损坏检查点重新下载。原生 Git 的临时对象在任务结束后释放。
- 原生 Git 上传每批最多提交 256 个文件引用，由原生层共享目录索引、连续读取并校验文件流，不把整个项目正文传进 WebView。预览只读取选定文件（8 MiB 预览范围），ZIP 在原生层流式归档。可选 REST 模式逐文件读取；可选外部 JSON Git 服务仍需要聚合请求，适合较小项目，建议 APK 使用默认原生 Git。
- 选择目录后逐文件迁移现有版本，完成后切换引用并清理内部正文。失败保留旧缓存，记录原因；可点击 **迁移现有项目** 重试。旧版未标明提交的缓存必须先与项目清单匹配。历史快照和 GitHub 提交仍保留，正文按需恢复。
- 同一分支切换新版本后清理无本地修改的旧目录。被其他项目引用或专门下载的历史版本按引用保留。发现手动修改、额外文件或删除，拉取／清理会要求选择，不静默覆盖。上传会显示确认并使用实际文件清单，新增、删除一同进入对应分支提交。
- **清理项目缓存**同时清理软件管理目录文件、内部正文与相关下载进度；单版本清理限该版本。项目记录、固定仓库、分支映射、快照和 GitHub 历史保留。删除失败不会显示清理完成。上传后清理仅在上传核验、账号记录持久化成功后执行；目录发生新改动则保留，除非当前实际清单与成功上传的清单完全一致。
- **清理临时缓存**删除未绑定候选目录和下载进度，保留已绑定文件。不能在传输期间清理。系统撤销目录权限、移动文件或空间不足时会显示原因，需重新授权原目录或恢复文件；不会把授权错误当作空目录上传。

“导出当前项目”从原生文件流写入 `GitVault-exports/` 下的独立目录，不通过界面传输大文件正文，避免与原缓存混淆或覆盖既有副本；ZIP／备份 JSON／日志等使用系统另存为选择器。独立导出的副本及旧版额外导出的目录需要自行管理，不会被项目缓存清理误删。Android 11+ 对部分根目录授权有限制，请选择系统允许的子目录。

## Token 与恢复

Android 将全局及项目专用 Token 连同完整项目记录加密保存：AES-GCM，密钥由 Android Keystore 管理。WebView 的普通项目记录去掉嵌套 Token；启动时先读取安全存储，再进入界面。首次迁移只有在加密保存成功后才清除旧明文凭证。读取失败停止启动，避免把错误当作空账号；保存失败显示提示，并在清理源码前阻止继续。系统自动备份关闭，JSON 导出继续排除 Token。

网页、测试 APK、正式 APK 不共享本地存储。首次使用 APK 需重新填写 Token；已有 GitHub 账号记录可在导入链接时恢复固定目标与标签。已清理的源码仍按原快照和远端凭据恢复。

批量导入、上传、分叉、更新、分叉同步和归档发布逐项保存任务队列。应用被关闭或系统结束后，重开会显示恢复入口；不会自动写 GitHub。已成功项保留，处理中及未执行项转为可手动重试。继续任务时检查来源／分支／固定目标；发生变化时要求重新建立任务，避免写错分支。恢复记录不包含 Token、错误响应或请求内容；错误详情进入已脱敏的操作日志。

任务取消不能回滚已经到达 GitHub 的请求。上传／分叉仍先检查账号索引与原目标；归档发布重试会核验已有标签及 Release，不把其他提交当作成功。APK 不提供锁屏后的持续传输保证；需要长时间后台传输时应另行实现 Android 后台任务方案。

Node/Express 服务不打入 APK。默认 AI 入口使用本地提交摘要；如配置 AI 后端，使用 `VITE_API_BASE_URL` 指向受控 HTTPS 服务，不把 AI 服务密钥写进前端。

## 验证

```bash
npm run lint
npm test
npm run build -- --base=/Get-Up_GitVault/
npm run test:layout
npm run android:sync
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

自动验证包括异步弹窗取消／输入、凭证迁移失败、文件路径与二进制导出、取消清理暂存、队列中断恢复、分支变化阻止续办、Release 重试及原有同步用例。响应式检查覆盖新增弹窗和恢复界面。

仍需真机验收：系统目录授权及撤销、横屏键盘、返回键、后台切回／进程结束后的续办、签名升级保留数据，以及真实账号双设备导入和对应分支更新。测试不使用用户 Token 创建验收仓库。


## 应用内更新与覆盖安装

设置 → APK 下载存储目录 → 应用更新，可以检查版本、下载安装包、取消下载以及打开 Android 安装界面。默认启动检查，自动下载可单独开启；下载交给 Android DownloadManager，可跨页面和重启继续。系统可能因网络或电量暂停，恢复网络后由 DownloadManager 续办。应用不会静默安装，首次可能需要允许“安装未知应用”，授权返回后再次点击安装。

仅从本项目的 HTTPS Release 下载 APK；安装前核对 SHA-256、大小、包名、更高 versionCode 和与当前安装相同的签名，防止安装错误渠道、旧版本或其他证书的包。使用安装器覆盖保留原有应用数据。只有检查状态，不会自动卸载应用。

### 必须一次配置固定签名

以前每个 Actions runner 临时生成的 debug key 无法从 APK 恢复，所以旧包不能通过代码变成同签名；迁移到固定签名包可能需要先导出记录与源码，再卸载旧测试包。新包配置以下 repository Actions Secrets 后，debug 和 release 各自固定包名并一直使用同一密钥：

- ANDROID_KEYSTORE_BASE64：你自己保管的密钥库的 Base64。
- ANDROID_KEYSTORE_PASSWORD：密钥库密码。
- ANDROID_KEY_ALIAS：签名别名。
- ANDROID_KEY_PASSWORD：密钥密码。

不要把私钥提交到仓库、放进公共缓存或发布到 Release。公开的证书摘要不包含私钥。未配置 Secrets 时仍构建普通测试 APK、正式 APK 为 unsigned，但**不发布自动更新渠道，不承诺跨构建覆盖**。GitHub 连接器不提供 Secrets 写入能力，因此本次代码不能替你完成仓库签名密钥的配置。

配置完成后，main 构建通过回归、Android Git/界面检查和覆盖安装保留数据检查，再发布 android-v1.0.N 的预发布 Release，包含 GitVault-debug.apk、GitVault-release.apk 及 SHA-256 清单。Pages 在 Android workflow 完成后重新部署，将经过校验的清单放到 android/latest-debug.json 和 android/latest-release.json。用户只需点击应用内更新，无需填写服务地址或 Token。不要删除现用密钥或重置工作流 versionCode。

## 大小写冲突与目录校验修复

Git 仓库可以同时包含 `资源/应用/Bubble` 和 `资源/应用/bubble`，手机内部存储的目录提供者可能将它们合并。新下载候选在写入前规划可逆的物理名称映射：仅对大小写／Unicode 规范化冲突的同级名称添加稳定的 `~gv-` 后缀，普通路径保持原样。项目列表、预览、分支上传和 ZIP 导出仍使用 Git 原始路径；独立目录导出也采用兼容布局，在 `.gitvault-export.json` 中保存映射。候选的 `.gitvault-snapshot.json` 与私有索引均保存映射，覆盖更新安装保留这些数据。旧版不兼容的失败候选不被直接复用或删除；成功重新拉取后可用“清理临时缓存”释放旧目录，出现改动提示时由用户确认。

最终校验按固定提交的清单回读实际字节，不把存储提供者返回的陈旧文件大小直接当作文件内容变化。缺失、内容不同、额外文件与读取失败分别显示数量和前 20 条路径；完整差异在该版本目录的 `.gitvault-diagnostic.json`，不包含 Token 或源码正文。遇到额外文件时保留并停止发布，移出本次 `files` 目录后可重试；不会静默删除用户文件。权限失败继续保留原目录和快照。

仅尚未绑定的下载候选可自动修复一次：原生 Git 利用本次已有 Git 对象补写损坏／缺失文件，无需再次下载整个项目；REST 只补拉报告列出的可信路径。修复后必须再次完整校验，持续变化会停止并保留具体差异。旧快照、已绑定目录与历史文件不会被自动修复覆盖。清理项目文件前会预检同源旧候选；旧失败目录存在变化时先保留全部项目文件，提示用户使用“清理临时缓存”确认处理，避免删完当前目录才遇到旧目录异常。完整写入但尚未记入检查点的文件，可在重试时通过 SHA 验证后恢复进度。

Android 测试包含固定的 `xiaolongbao0709/ai-virtual-phone-share` main 提交 `10b575d509609add902d9ea4bf943f8674583ba3`：完整获取 2952 个文件、478289170 字节，在大小写折叠的文件提供者模型和内部共享存储文件目录写入、回读后，重新暂存生成的 Git 树必须仍为 `ee2d5e570ada4b19cedd901e081ec3f13cc567f1`。该测试不向用户的 GitHub 仓库推送，也不替代用户手机具体 SAF 提供者的实机验收。


## 可选 Git 加速缓存

“GitHub 凭证与连接”中可启用“保留 Git 加速缓存”，默认关闭；需保存设置。APK 原生 Git 后续任务可复用应用私有 Git 对象，空闲缓存合计 512 MiB，超过 7 天未使用的缓存于后续任务回收。限额不包含正在传输的临时空间，仍需预留传输所需存储空间。系统移除缓存后正常重新获取。

关闭该选项、清理项目源码、上传后销毁和“清理临时缓存”都会清除全部 Git 加速对象，避免来源／目标历史中留下可还原副本；不会删除其他项目已下载的主目录、独立导出或 GitHub 历史。缓存删除失败时保留错误提示，不显示清理完成。传输未结束时不能清理。具体传输、验证和测试边界见 [GIT_TRANSPORT.md](GIT_TRANSPORT.md#后续优化可选对象缓存与性能对照)。
