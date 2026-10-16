# Git 源码传输

仓库创建、原生 Fork、重命名、Token 校验、跨设备账号记录仍使用 GitHub REST API。源码拉取和推送可在设置 → GitHub 凭证与连接 → 源码传输方式切换到 **Git 推送／拉取（使用自有服务）**。默认继续使用带限速的 REST 模式，切换不改变项目 ID、固定目标、标签、备注或分支映射。

## GitHub Pages 与 APK

GitHub Pages 只承载静态页面，不能启动服务器上的 Git 命令。仓库包含可单独部署的 Node/Git 服务，网页和 APK 都可以连接这个服务。它不是浏览器直连 GitHub 的 Git 协议，也不是 APK 内置原生 Git。

填写你自己部署或信任的 HTTPS 服务根地址，例如 `https://git.example.com`；“检查 Git 服务”访问 `/api/git/health`，不发送 Token。保存 Git 模式后，源码操作会把本次所需的 GitHub Token 和文件发送给该服务。服务不设置 Token 到远端 URL、磁盘配置或日志；只在 Git 子进程环境中短暂使用。传输失败不会自动改用 REST 再推送，避免重复或不明确的写入。

源码通过 `git fetch` 获取对象，通过 `git push` 发送 Git pack。服务每次创建独立临时裸仓库，完成、失败或取消后删除；不保留服务端长期源码副本或增量对象缓存。用户选择是否销毁本地源码，仍只作用于浏览器／APK 原有缓存，已有远端历史和快照保留。

## 部署服务

需要 Node.js 22+ 和可运行的 Git CLI（建议 Git 2.39+）。Git 不需要预先配置用户账号、凭据助手或 SSH Key。

```bash
npm ci
npm run build
GITVAULT_GIT_ENABLED=1 \
GITVAULT_ALLOWED_ORIGINS=https://tingtingftt.github.io,https://localhost \
NODE_ENV=production npm start
```

服务默认端口 3000。用自己的 HTTPS 反向代理转发到这个端口；代理需允许较大的 JSON 请求，并将传输超时设为至少十分钟。`GITVAULT_ALLOWED_ORIGINS` 填完整来源，多个以逗号分隔：GitHub Pages 来源是 `https://tingtingftt.github.io`（不带项目路径），Android APK 来源是 `https://localhost`。同源页面默认可用，其他来源需要明确配置。无需开放通用 URL 代理。

也可使用随附镜像配置：

```bash
docker build -f Dockerfile.git -t gitvault-git .
docker run --rm -p 3000:3000 \
  -e GITVAULT_GIT_ENABLED=1 \
  -e GITVAULT_ALLOWED_ORIGINS=https://tingtingftt.github.io,https://localhost \
  gitvault-git
```

镜像和仓库都不包含用户 Token。服务默认不启用；只有设置 `GITVAULT_GIT_ENABLED=1` 才开放传输。服务每次先向 GitHub 验证仓库访问权和固定仓库 ID，推送前再次确认身份。源码模式不需要给服务提供 GitHub App、组织管理或其他额外权限。

在设置中填服务根地址，选择 Git 模式，检查连接后保存。部署网页和 APK 不会自动创建、发布或购买这个服务。未配置时，线上页面继续使用 REST；`VITE_GIT_SERVICE_URL` 只用于构建时预填服务地址，不自动启用或发送凭证。

## 分支和历史

- 读取目标分支时，404、明确的 `422 No commit found for SHA` 或空仓库 409，都先重新确认仓库 ID 和真实分支列表。只有列表确认没有该分支时才允许后续创建；权限错误、其他 422 或已列出的分支不能被当作空分支。
- 推送使用已固定的目标分支。目标分支不存在时创建该分支；已有分支时，读取最新目标提交，以它为父提交保存完整文件快照，包含来源中的删除操作。
- 使用普通 `git push`，不强推、不删除其他分支。明确允许冲突接续的任务最多重新读取并接续三次；并发产生的提交仍保留在历史中。
- 推送回执还要通过 GitHub API 核对目标分支、提交树、文件 SHA 和模式；校验完成后才保存上传回执或清理本地源码。同一快照重试会复用已有目标提交。
- 拉取固定到完整提交 SHA，检查文件清单和每个 blob 的字节哈希。二进制、可执行文件和符号链接内容保留；服务不会在工作目录展开或执行这些文件。子模块、LFS 实体内容仍不在完整下载支持范围，遇到时明确停止。

当前服务按单次源码总大小 100 MiB、请求体 150 MiB、同时两个传输和十分钟任务超时限制资源。取消浏览器请求会中断服务上的 Git 进程并清理临时目录；已经到达 GitHub 的提交不能回滚，重试时重新验证目标。

## 验证

`npm test` 包含真实本地裸 Git 仓库测试：新分支、连续历史、删除文件、空仓库、Unicode／二进制／可执行模式／符号链接、并发接续、拒绝强推、取消与临时目录清理。HTTP 集成测试验证跨域来源、健康检查不带 Token、固定 ID、错误不降级、前端清单校验及取消传递。测试不向外部 GitHub 仓库推送。
