import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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
const scenarios = ['dashboard', 'projects', 'workbench', 'history', 'changelog', 'add', 'import', 'private', 'fork', 'push', 'folders', 'metadata', 'storage', 'settings', 'backup', 'apk', 'batch-fork', 'batch-update', 'batch-sync', 'batch-upload', 'import-match', 'import-compare', 'import-files', 'import-error', 'remote-target', 'remote-target-error', 'remote-target-detached', 'operation-logs', 'operation-logs-error', 'batch-upload-running', 'batch-upload-error', 'batch-upload-cancelled', 'switch-create', 'switch-existing', 'switch-error', 'switch-pending', 'switch-history', 'app-confirm', 'app-prompt', 'task-recovery', 'release'];
const widths = [320, 375, 480, 640, 768, 1024, 1440];
const mockBlob = createHash('sha1').update('blob 3\0new').digest('hex');
// Inject before the production bundle: real UI interactions, synthetic GitHub reads only.
const importMock = `<script>
if (new URLSearchParams(location.search).has('audit-batch')) {
  const original = window.fetch;
  window.fetch = async (input, init = {}) => {
    if (!String(input).includes('api.github.com')) return original(input,init);
    const url = new URL(String(input));
    if (init.method && init.method !== 'GET') throw new Error('Writes are prohibited in the layout audit');
    if (url.pathname === '/user') return new Response(JSON.stringify({login:'audit-account'}),{status:200});
    if (url.pathname === '/user/repos') {
      if (new URLSearchParams(location.search).get('audit-batch')==='error') return new Response(JSON.stringify({message:'API rate limit exceeded '+ 'long-failure-reason-'.repeat(30)}),{status:403});
      return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
    }
    return new Response(JSON.stringify({message:'Not Found'}),{status:404});
  };
}
if (new URLSearchParams(location.search).has('audit-import') || new URLSearchParams(location.search).has('audit-target')) {
  const fixture = ${JSON.stringify(fixture)};
  const target = { id: 77, owner: 'destination-with-a-long-owner-name', repo: 'renamed-repository-'.repeat(6), branch: 'release/' + 'long-branch-'.repeat(8), purgeAfterUpload: false };
  fixture.url = 'https://github.com/' + fixture.owner + '/' + fixture.repo;
  fixture.uploadTarget = target;
  const switchScene=new URLSearchParams(location.search).get('audit-switch');
  if(switchScene==='switch-pending')fixture.pendingSwitch={reservationId:'audit',sourceSha:fixture.latestCommitSha,sourceBranch:fixture.branch,oldTarget:target,request:{mode:'existing',name:target.owner+'/new-'+target.repo,branch:target.branch,purge:false},result:{verified:true,repoId:99,owner:target.owner,repo:'new-'+target.repo,branch:target.branch,commitSha:'saved-new',htmlUrl:'https://github.com/example/new'}};
  if(switchScene==='switch-history')fixture.targetHistory=[{target:{id:98,owner:target.owner,repo:'old-'+target.repo},kind:'upload',bindings:{main:{branch:'release',updatedAt:'2026-10-16T00:00:00Z'}},changedAt:'2026-10-16T00:00:00Z'}];

  if(new URLSearchParams(location.search).has('audit-target')) fixture.privateRepoUrl = 'https://github.com/'+target.owner+'/'+target.repo;
  localStorage.setItem('gitvault_repos_v8', JSON.stringify([fixture]));
  const sourceRoot = '/repos/' + fixture.owner + '/' + fixture.repo, targetRoot = '/repos/' + target.owner + '/' + target.repo;
  const original = window.fetch;
  window.fetch = async (input, init = {}) => {
    const url = String(input), path = new URL(url, location.href).pathname;
    if (!url.includes('api.github.com') && !url.includes('codeload.github.com')) return original(input, init);
    if (init.method && init.method !== 'GET') throw new Error('Writes are prohibited in the layout audit');
    const reply = value => new Response(JSON.stringify(value), {headers:{'Content-Type':'application/json'}});
    if (path === sourceRoot) return reply({id:42, default_branch:fixture.branch, owner:{login:fixture.owner}, name:fixture.repo, html_url:fixture.url});
    if (path === targetRoot) {
      const state = new URLSearchParams(location.search).get('audit-target');
      if(state==='error'||state==='detached') return new Response(JSON.stringify({message:'Not Found'}),{status:404});
      return reply({...target, id:new URLSearchParams(location.search).get('audit-import')==='error'?99:77, owner:{login:target.owner}, name:target.repo});
    }
    if (path.startsWith(sourceRoot + '/commits/')) return reply({sha:'source-new', commit:{tree:{sha:'audit-source-tree'},message:'new',author:{}}});
    if (path.startsWith(targetRoot + '/commits/')) return reply({sha:'target-old', commit:{tree:{sha:'audit-target-tree'},message:'old',author:{}}});
    if (path.includes('/git/trees/audit-source-tree')) return reply({tree:[{...fixture.tree[0], sha:${JSON.stringify(mockBlob)}}]});
    if (path.includes('/git/trees/audit-target-tree')) return reply({tree:[fixture.tree[0], {...fixture.tree[0], path:'removed/'.repeat(20)+'old.txt'}]});
    if (path.includes('/git/blobs/')) return reply({encoding:'base64',content:'bmV3'});
    if (path.includes('/zipball/') || url.includes('codeload.github.com')) throw new TypeError('Synthetic archive fallback');
    return new Response(JSON.stringify({message:'Unexpected mock request'}),{status:404});
  };
}
</script>`;
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
    localStorage.setItem('gitvault_repos_v8', JSON.stringify([fixture]));
    localStorage.removeItem('gitvault_operation_logs_v1');
    localStorage.removeItem('gitvault_tasks_v1');
    localStorage.removeItem('gitvault_global_token');
    if(scenario==='task-recovery')localStorage.setItem('gitvault_tasks_v1',JSON.stringify([{kind:'projects',action:'sync',updatedAt:'2026-10-16',items:[{id:fixture.id,label:fixture.remark,name:fixture.repo,status:'running',branch:fixture.branch,source:fixture.url}]}]));
    if (scenario === 'operation-logs-error') localStorage.setItem('gitvault_operation_logs_v1',JSON.stringify([{id:'audit-log',time:'2026-10-16T00:00:00Z',action:'批量分叉同步',status:'error',httpStatus:422,project:'owner/'+ 'long-project-'.repeat(20),branch:fixture.branch,target:'destination/'+ 'long-target-'.repeat(20),stage:'核对账号记录',message:'Update is not a fast forward；'+'很长的失败原因'.repeat(50)}]));
    const frame = document.createElement('iframe'); frame.style.cssText = 'border:0;width:' + width + 'px;height:900px';
    document.body.appendChild(frame);
    try {
      await new Promise((resolve,reject) => { frame.onload=resolve; frame.onerror=reject; frame.src='/Get-Up_GitVault/' + (scenario.startsWith('import-') ? '?audit-import=' + (scenario==='import-error'?'error':'match') : scenario.startsWith('batch-upload-') ? '?audit-batch='+scenario.replace('batch-upload-','') : scenario.startsWith('switch-') ? '?audit-target='+(scenario==='switch-error'?'error':'available')+'&audit-switch='+scenario : scenario.startsWith('remote-target') ? '?audit-target='+(scenario==='remote-target'?'available':scenario==='remote-target-error'?'error':'detached') : ''); }); await pause();
      const doc = frame.contentDocument;
      if (['projects','batch-fork','batch-update','batch-sync','batch-upload'].includes(scenario) || scenario.startsWith('batch-upload-')) {
        await click(doc,'仓库已有项目 (1)');
        if (scenario.startsWith('batch-')) { await click(doc,'全选所有'); await click(doc,{'batch-fork':'批量分叉','batch-update':'批量更新','batch-sync':'批量分叉同步','batch-upload':'批量上传至私人仓库'}[scenario] || '批量上传至私人仓库'); }
      } else if (['workbench','history','changelog','private','fork','push','folders','metadata','storage'].includes(scenario)) {
        await click(doc,'工作台');
        if (scenario==='history') await click(doc,'版本归档库 (1)');
        if (scenario==='changelog') await click(doc,'智能更新日志');
        if (scenario==='private'||scenario==='fork') { await click(doc,'分叉与私有仓'); if (scenario==='fork') await click(doc,'板块二：创建分叉与上游同步'); }
        if (scenario==='push') await click(doc,'上传指定仓库');
        if (scenario==='folders'||scenario==='storage') { await click(doc,'下载自选文件夹'); if(scenario==='storage') await click(doc,'本地存储与缓存'); }
        if (scenario==='metadata') await click(doc,'编辑备注与描述');
      } else if(scenario.startsWith('switch-')) {
        await click(doc,'工作台');await click(doc,'另存并切换固定仓库');
        const dialog=doc.querySelector('[aria-label="另存并切换固定仓库"]');if(!dialog)throw new Error('Missing save and switch dialog');
        if(scenario==='switch-existing'||scenario==='switch-error') {
          const set=(field,value,kind='input')=>{Object.getOwnPropertyDescriptor(kind==='select'?frame.contentWindow.HTMLSelectElement.prototype:frame.contentWindow.HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new frame.contentWindow.Event(kind==='select'?'change':'input',{bubbles:true}));};
          const target=JSON.parse(frame.contentWindow.localStorage.getItem('gitvault_repos_v8'))[0].uploadTarget;
          set(dialog.querySelector('[aria-label="另存方式"]'),'existing','select');await pause();
          set(dialog.querySelector('[aria-label="另存目标仓库"]'),target.owner+'/'+target.repo);set(dialog.querySelector('[aria-label="另存目标分支"]'),target.branch);await pause();
          await click(doc,'比较新目标代码');
          for(let tries=0;tries<100&&!dialog.querySelector('[role="status"],[role="alert"]');tries++)await pause();
          if(!dialog.querySelector('[role="status"],[role="alert"]'))throw new Error('Missing switch comparison outcome');
        }
        if(scenario==='switch-history'){dialog.querySelector('summary').click();await pause();}
      } else if(scenario.startsWith('remote-target')) {
        await click(doc,'工作台'); await click(doc,'管理远端目标');
        if(!doc.querySelector('[aria-label="管理远端目标"]')) throw new Error('Target manager did not open');
        if(scenario==='remote-target-error'&&!doc.body.textContent.includes('可能已删除')) throw new Error('Missing inaccessible target explanation');
        if(scenario==='remote-target-detached') { await click(doc,'解除此目标的所有绑定'); await click(doc,'确定'); if(!doc.body.textContent.includes('重新设置上传')) throw new Error('Missing target recovery controls'); }
      } else if(scenario.startsWith('import-')) {
        await click(doc,'新建链接/拉取项目');
        const fields = [...doc.querySelectorAll('input')];
        const set = (field,value) => { Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLInputElement.prototype,'value').set.call(field,value); field.dispatchEvent(new frame.contentWindow.Event('input',{bubbles:true})); };
        set(fields.find(field=>field.placeholder.startsWith('https://github.com/owner/repo')), fixture.owner+'/'+fixture.repo);
        set(fields.find(field=>field.placeholder==='例如: 生产核心源码 / 模块A'), '对比项目长备注'.repeat(10)); await pause();
        await click(doc,'确认拉取进入本地');
        for(let tries=0;tries<100&&!doc.querySelector('[aria-label="选择已有项目作为同步基础"]');tries++) await pause();
        if(!doc.querySelector('[aria-label="选择已有项目作为同步基础"]')) throw new Error('Import match dialog did not open');
        if(scenario!=='import-match') {
          await click(doc,'对比此项目');
          for(let tries=0;tries<100&&doc.body.textContent.includes('正在校验仓库身份并对比文件');tries++) await pause();
          if(scenario==='import-error'&&!doc.body.textContent.includes('身份已变化')) throw new Error('Expected identity comparison error');
          if(scenario!=='import-error'&&!doc.body.textContent.includes('新增 0 · 修改 1 · 删除 1')) throw new Error('Expected file comparison counts');
          if(scenario==='import-files') { const detail=[...doc.querySelectorAll('summary')].find(el=>el.textContent==='查看文件差异'); detail.click(); await pause(); }
        }
      } else if(scenario==='add'||scenario==='import') {
        await click(doc,'新建链接/拉取项目'); if (scenario==='import') await click(doc,'批量导入链接');
      } else if(['settings','backup','apk'].includes(scenario)) {
        await click(doc,'设置');
        if(scenario==='backup') await click(doc,'数据备份与恢复');
        if(scenario==='apk') await click(doc,'APK 下载存储目录');
      }
      if(scenario==='app-confirm'){await click(doc,'操作日志');await click(doc,'清空日志');}
      if(scenario==='app-prompt'){await click(doc,'仓库已有项目 (1)');await click(doc,'全选所有');await click(doc,'批量上传至私人仓库');await click(doc,'开始批量上传');}
      if(scenario==='task-recovery'){if(!doc.body.textContent.includes('发现上次未完成'))throw new Error('Missing recovery banner');await click(doc,'查看并继续');}
      if(scenario==='release'){await click(doc,'工作台');await click(doc,'版本归档库 (1)');await click(doc,'全选所有');await click(doc,'批量发布 Release 到 GitHub');}
      if (scenario.startsWith('operation-logs')) await click(doc,'操作日志');
      if (scenario.startsWith('batch-upload-')) {
        await click(doc,'开始批量上传');
        const prompt=doc.querySelector('[data-app-dialog=prompt] input');
        if(prompt){Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLInputElement.prototype,'value').set.call(prompt,'audit-token');prompt.dispatchEvent(new frame.contentWindow.Event('input',{bubbles:true}));await pause();prompt.form.requestSubmit();await pause();}
        if(doc.querySelector('[data-app-dialog=confirm]'))await click(doc,'保留源码');
        if(scenario==='batch-upload-cancelled') await click(doc,'取消剩余上传');
        if(scenario==='batch-upload-error') { for(let tries=0;tries<100&&!doc.body.textContent.includes('API rate limit exceeded');tries++) await pause(); if(!doc.body.textContent.includes('API rate limit exceeded')) throw new Error('Expected visible bulk failure'); }
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
    response.setHeader('Content-Type', type);
    const content = await readFile(file);
    response.end(extname(file) === '.html' ? content.toString().replace('<head>', '<head>' + importMock) : content);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(resolve(tmpdir(), 'gitvault-layout-'));
try {
  const args = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-extensions', `--user-data-dir=${profile}`, '--window-size=1600,1000', '--virtual-time-budget=90000', '--dump-dom', `http://127.0.0.1:${server.address().port}/audit`];
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
