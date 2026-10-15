<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b4462d66-9b70-4b20-a34a-f5bf543cf034

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 完整项目同步与版本缓存

使用 Node.js 22，执行 `npm ci` 安装锁定依赖。`npm run lint` 检查类型，`npm test` 运行同步、存储和页面操作回归测试。

- 首次获取会固定源提交 SHA，校验完整文件清单和每个 Git blob；优先下载压缩包，失败时切换到 GitHub 文件接口。请求有超时，操作可取消。
- 浏览器会暂存已校验的下载片段；重试同一提交时复用已完成的文件。目录很多时完整遍历截断的 Git tree；目录导出不再截取前 100 个文件。
- 缓存按项目、提交和文件内容保存。旧版未绑定提交的缓存只有与快照校验一致时才迁移；保存失败会明确报错，不会把内存缓存显示为持久保存。
- 上传到选定分支时生成完整快照，包括来源已删除的文件；保留目标提交历史，不强制覆盖并发更改。首次上传和重试都验证目标提交及分支。
- 单次上传可选择保留或清理源码；批量上传开始时也会询问。只有远程验证成功、同步凭据和快照记录已持久保存后，才清理所选版本的源码。文件清单和远程提交链接继续保留。
- 上传成功会记住目标仓库、分支和清理选择。之后“一键更新”会下载新版本、归档旧版本，再同步到该目标；上传失败时保留新文件，可重新上传或再次点击更新重试。尚未配置目标时先下载，使用上传入口选择目标。
- 查看和上传历史版本使用该版本的源码；清理后的文件优先从保存的目标提交读取，不依赖源仓库的当前 HEAD。
- Fork 独立记录目标仓库身份，“同步上游”操作实际 Fork；GitHub 创建 Fork 是异步的，刚创建时可能需要稍后再同步。

本地快照不是完整 Git 克隆：保存的是指定提交的文件和本应用同步过的版本，不复制源仓库全部历史。包含子模块或 Git LFS 对象的项目当前会明确提示未能完整获取，不会错误标记为完整下载。

GitHub Pages 使用浏览器直连 GitHub；关闭页面后不会持续执行定时检测。清理浏览器缓存不会删除用户已导出的 ZIP 或文件夹。系统记录备份不包含源码缓存或 GitHub Token；恢复到其他设备后需重新填写凭证并获取源码。

## AI 日志与可选服务端

`npm run dev` 使用本地 Node 服务，AI 功能需要服务端 `GEMINI_API_KEY`（可通过 `GEMINI_MODEL` 指定模型）。纯静态 Pages 未配置 AI 服务时，原日志入口提供明确标注的本地提交摘要。

部署独立 AI 后端时，在构建环境设置 `VITE_API_BASE_URL` 为其地址，并由该后端配置正确的来源访问策略。生产同源 Node 部署可在构建时设置 `VITE_API_MODE=server`；运行时使用 `NODE_ENV=production npm start`。GitHub 或 AI 凭证均不应写入静态构建环境的 `VITE_*` 变量。

## 部署

GitHub Actions 使用 `package-lock.json` 和 `npm ci`；PR 自动检查类型、测试和 Pages 构建，合并 main 后再部署。Pages 构建路径为 `/Get-Up_GitVault/`。

浏览器、Electron 和 APK 的现有导出入口继续保留。桌面/手机打包应使用适合本地资源的 Vite base（通常为 `./`）；实际写入系统目录仍需要相应原生桥接能力。
