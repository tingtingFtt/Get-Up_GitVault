import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';

// Runs against the production build with synthetic local records and no GitHub writes.
const dist = resolve('dist');
const chrome = process.env.CHROME_BIN || ['google-chrome', 'chromium', 'chromium-browser'].find(name => spawnSync('which', [name]).status === 0);
if (!chrome) throw new Error('Chrome is required for the layout audit. Set CHROME_BIN to its executable path.');
const fixture = {
  id: 'layout-audit', owner: 'owner-with-a-long-name', repo: 'repository-with-a-very-long-name-for-responsive-layout-checking', branch: 'feature/responsive-layout-audit',
  url: 'https://github.com/example/layout-audit', remark: '这是用于边界检查的长备注'.repeat(6), description: '项目说明和长链接 https://example.com/' + 'long-path-'.repeat(25), tags: ['很长的项目标签'.repeat(8)],
  checkInterval: 0, latestCommitSha: 'audit-current', commitMessage: 'Layout audit', commitAuthor: 'author', commitDate: '2026-10-16T00:00:00Z', lastSyncedAt: '2026-10-16T00:00:00Z', repoMeta: { htmlUrl: 'https://github.com/example/layout-audit' }, hasUpdate: true,
  tree: [{ path: 'folder/'.repeat(20) + 'source.ts', sha: 'audit-blob', type: 'blob', mode: '100644', size: 100 }],
  backups: [{ id: 'audit-backup', branch: 'main', versionNumber: 1, tag: 'very-long-version-tag-'.repeat(8), annotation: '历史版本说明'.repeat(15), commitSha: 'audit-old', commitMessage: 'old', commitAuthor: 'author', commitDate: '2026-10-15T00:00:00Z', backedUpAt: '2026-10-15T00:00:00Z', tree: [], isCachePurged: true }],
};
const scenarios = ['dashboard', 'projects', 'workbench', 'history', 'changelog', 'add', 'import', 'private', 'fork', 'push', 'folders', 'metadata', 'storage', 'settings', 'backup', 'apk', 'batch-fork', 'batch-update', 'batch-sync', 'batch-upload'];
const widths = [320, 375, 480, 640, 768, 1024, 1440];
const html = `<!doctype html><meta charset="utf-8"><title>GitVault layout audit</title><body><script>
const fixture = ${JSON.stringify(fixture)};
localStorage.clear();
localStorage.setItem('gitvault_repos_v8', JSON.stringify([fixture]));
const widths = ${JSON.stringify(widths)}, scenarios = ${JSON.stringify(scenarios)};
const failures = []; let checks = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 60));
function buttons(doc) { return [...doc.querySelectorAll('button')]; }
async function click(doc, text) {
  const button = buttons(doc).find(button => button.textContent.trim() === text);
  if (!button) throw new Error('Missing control: ' + text);
  button.click(); await pause();
}
function inspect(doc, width, scenario) {
  if (doc.documentElement.scrollWidth > width + 1) failures.push({width, scenario, issue:'document overflow', actual:doc.documentElement.scrollWidth});
  for (const el of doc.querySelectorAll('button,input,textarea,select,p,h1,h2,h3,label,a,.workbench-banner,.batch-toolbar')) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.left < -1 || rect.right > width + 1) failures.push({width, scenario, issue:'element outside viewport', tag:el.tagName, text:el.textContent.trim().slice(0,60), left:rect.left, right:rect.right});
    if (['BUTTON','P','H1','H2','H3'].includes(el.tagName) && el.scrollWidth > el.clientWidth + 1) failures.push({width, scenario, issue:'text overflow', text:el.textContent.trim().slice(0,60)});
    if (el.tagName === 'BUTTON') {
      const container = el.parentElement.closest('div.rounded-3xl,div.rounded-2xl,div.rounded-xl,[role="dialog"]');
      if (container) {
        const boundary = container.getBoundingClientRect();
        if (rect.left < boundary.left - 1 || rect.right > boundary.right + 1) failures.push({width,scenario,issue:'button outside container',text:el.textContent.trim().slice(0,60)});
      }
    }
  }
  const actions = [...doc.querySelectorAll('.workbench-actions button')].map(el => el.getBoundingClientRect());
  actions.forEach((a,i) => actions.slice(i+1).forEach(b => {
    if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1) failures.push({width,scenario,issue:'overlapping actions'});
  }));
  checks++;
}
(async () => {
  for (const width of widths) for (const scenario of scenarios) {
    const frame = document.createElement('iframe'); frame.style.cssText = 'border:0;width:' + width + 'px;height:900px';
    document.body.appendChild(frame);
    try {
      await new Promise((resolve,reject) => { frame.onload=resolve; frame.onerror=reject; frame.src='/Get-Up_GitVault/'; }); await pause();
      const doc = frame.contentDocument;
      if (['projects','batch-fork','batch-update','batch-sync','batch-upload'].includes(scenario)) {
        await click(doc,'仓库已有项目 (1)');
        if (scenario.startsWith('batch-')) { await click(doc,'全选所有'); await click(doc,{'batch-fork':'批量分叉','batch-update':'批量更新','batch-sync':'批量分叉同步','batch-upload':'批量上传至私人仓库'}[scenario]); }
      } else if (['workbench','history','changelog','private','fork','push','folders','metadata','storage'].includes(scenario)) {
        await click(doc,'工作台');
        if (scenario==='history') await click(doc,'版本归档库 (1)');
        if (scenario==='changelog') await click(doc,'智能更新日志');
        if (scenario==='private'||scenario==='fork') { await click(doc,'分叉与私有仓'); if (scenario==='fork') await click(doc,'板块二：创建分叉与上游同步'); }
        if (scenario==='push') await click(doc,'上传指定仓库');
        if (scenario==='folders'||scenario==='storage') { await click(doc,'下载自选文件夹'); if(scenario==='storage') await click(doc,'本地存储与缓存'); }
        if (scenario==='metadata') await click(doc,'编辑备注与描述');
      } else if(scenario==='add'||scenario==='import') {
        await click(doc,'新建链接/拉取项目'); if (scenario==='import') await click(doc,'批量导入链接');
      } else if(['settings','backup','apk'].includes(scenario)) {
        await click(doc,'设置');
        if(scenario==='backup') await click(doc,'数据备份与恢复');
        if(scenario==='apk') await click(doc,'APK 下载存储目录');
      }
      inspect(doc,width,scenario);
    } catch(error) { failures.push({width,scenario,issue:error.message}); }
    frame.remove();
  }
  document.documentElement.dataset.layoutReport = encodeURIComponent(JSON.stringify({checks,failures}));
})().catch(error => { document.documentElement.dataset.layoutReport = encodeURIComponent(JSON.stringify({checks,failures:[{issue:error.message}]})); });
</script>`;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/audit') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    const relative = pathname.replace(/^\/Get-Up_GitVault\/?/, '').replace(/^\/+/, '');
    const file = resolve(dist, relative || 'index.html');
    if (file !== dist && !file.startsWith(dist + '/')) { response.writeHead(403).end(); return; }
    const type = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    response.setHeader('Content-Type', type); response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(resolve(tmpdir(), 'gitvault-layout-'));
try {
  const args = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-extensions', `--user-data-dir=${profile}`, '--window-size=1600,1000', '--virtual-time-budget=60000', '--dump-dom', `http://127.0.0.1:${server.address().port}/audit`];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(chrome, args); let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Layout audit timed out: ' + stderr.slice(-1500))); }, 90000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code ? reject(new Error(stderr.slice(-2000))) : resolve(stdout); });
  });
  const match = output.match(/data-layout-report="([^"]+)"/);
  if (!match) throw new Error('Layout audit did not finish; no browser report was returned.');
  const report = JSON.parse(decodeURIComponent(match[1]));
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length || report.checks !== widths.length * scenarios.length) process.exitCode = 1;
} finally { server.closeAllConnections(); server.close(); await rm(profile, { recursive: true, force: true }); }
