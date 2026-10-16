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

源码缓存仍使用应用 WebView 内的 IndexedDB；快照、绑定、任务队列和日志也保留在本设备。Android 应用不是本地 git clone，远端历史仍由 GitHub 保存。

默认不会任意写入手机共享目录。在设置 → APK 下载存储目录，使用“选择并授权目录”调用 Storage Access Framework。用户选择目录后保存持久 URI 授权，新导入项目会额外导出至：

`账号/仓库/编码后的分支/提交 SHA/files/源码路径`

版本目录中的 `.gitvault-export.json` 最后写入，包含文件模式和完成时间；缺少该文件说明首次导出未完成。符号链接按链接内容文本导出，不创建 Android 符号链接。系统目录提供者可能限制文件名或撤销权限，失败会记录日志，已保存的项目缓存不会撤销。

用户可在设置中“导出当前项目”，或通过原有文件夹／历史 ZIP 入口再次导出。**更新不会自动覆盖用户之前导出的目录**；需要导出新快照时手动操作。“停止自动导出”停止后续自动写入，不删除已导出文件。

清理源码只处理应用缓存，不删除共享目录中的导出文件。APK 内 ZIP、备份 JSON、日志和打包配置下载均通过原生分块暂存与系统“另存为”选择器导出；取消选择会清理应用暂存。Android 11+ 不允许授权部分根目录，请在系统选择器中选可授权的子目录。

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
