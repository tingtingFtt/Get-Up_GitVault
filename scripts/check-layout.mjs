import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

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
const scenarios = ['dashboard', 'projects', 'workbench', 'history', 'changelog', 'add', 'import', 'private', 'fork', 'push', 'folders', 'metadata', 'storage', 'settings', 'git-service', 'backup', 'apk', 'batch-fork', 'batch-update', 'batch-sync', 'batch-upload', 'import-match', 'import-compare', 'import-files', 'import-error', 'remote-target', 'remote-target-error', 'remote-target-detached', 'operation-logs', 'operation-logs-error', 'batch-upload-running', 'batch-upload-limited', 'batch-upload-error', 'batch-upload-cancelled', 'switch-create', 'switch-existing', 'switch-error', 'switch-pending', 'switch-history', 'app-confirm', 'app-prompt', 'task-recovery', 'release', 'records-storage-error', 'records-large'];
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
      const state = new URLSearchParams(location.search).get('audit-batch');
      if (state==='error') return new Response(JSON.stringify({message:'Resource not accessible '+ 'long-failure-reason-'.repeat(30)}),{status:403});
      if (state==='limited') return new Response(JSON.stringify({message:'You have exceeded a secondary rate limit'}),{status:403,headers:{'Retry-After':'120'}});
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
  window.__auditTarget = target;
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
  let button;
  // Database bootstrap and React rendering need a real readiness check,
  // especially after the large-record restore has triggered browser GC.
  for(let tries=0;tries<100&&!button;tries++){
    button=buttons(doc).find(button=>button.textContent.trim()===text||button.getAttribute('aria-label')===text);
    if(!button)await pause();
  }
  if (!button) throw new Error('Missing control: ' + text);
  button.click(); await pause();
}
function inspect(doc, width, scenario) {
  const header=doc.querySelector('.app-header'); if(header&&header.getBoundingClientRect().height>58) failures.push({width,scenario,issue:'header too tall',actual:header.getBoundingClientRect().height});
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
    document.documentElement.dataset.layoutProgress = encodeURIComponent(JSON.stringify({width,scenario,checks,failures}));
    await new Promise((resolve,reject) => { const request=indexedDB.deleteDatabase('GitVault_Records_v1'); request.onsuccess=resolve; request.onerror=()=>reject(request.error); request.onblocked=()=>reject(new Error('Previous layout fixture still holds the records database')); });
    localStorage.setItem('gitvault_repos_v8', JSON.stringify([fixture]));
    localStorage.removeItem('gitvault_operation_logs_v1');
    localStorage.removeItem('gitvault_tasks_v1');
    localStorage.removeItem('gitvault_global_token');
    // Each iframe is an independent layout fixture; production cooldowns survive reloads.
    for (const key of ['gitvault_github_cooldown_v1','gitvault_github_writes_v1','gitvault_github_last_write_v1','gitvault_git_service_v1']) localStorage.removeItem(key);
    if(scenario==='task-recovery')localStorage.setItem('gitvault_tasks_v1',JSON.stringify([{kind:'projects',action:'sync',updatedAt:'2026-10-16',items:[{id:fixture.id,label:fixture.remark,name:fixture.repo,status:'running',branch:fixture.branch,source:fixture.url}]}]));
    if (scenario === 'operation-logs-error') localStorage.setItem('gitvault_operation_logs_v1',JSON.stringify([{id:'audit-log',time:'2026-10-16T00:00:00Z',action:'批量分叉同步',status:'error',httpStatus:422,project:'owner/'+ 'long-project-'.repeat(20),branch:fixture.branch,target:'destination/'+ 'long-target-'.repeat(20),stage:'核对账号记录',message:'Update is not a fast forward；'+'很长的失败原因'.repeat(50)}]));
    const frame = document.createElement('iframe'); frame.style.cssText = 'border:0;width:' + width + 'px;height:900px';
    document.body.appendChild(frame);
    try {
      await new Promise((resolve,reject) => { frame.onload=resolve; frame.onerror=reject; frame.src='/Get-Up_GitVault/' + (scenario.startsWith('import-') ? '?audit-import=' + (scenario==='import-error'?'error':'match') : scenario.startsWith('batch-upload-') ? '?audit-batch='+scenario.replace('batch-upload-','') : scenario.startsWith('switch-') ? '?audit-target='+(scenario==='switch-error'?'error':'available')+'&audit-switch='+scenario : scenario.startsWith('remote-target') ? '?audit-target='+(scenario==='remote-target'?'available':scenario==='remote-target-error'?'error':'detached') : ''); }); await pause();
      let doc = frame.contentDocument;
      for(let tries=0;tries<100&&!doc.querySelector('.app-header');tries++)await pause();
      if(!doc.querySelector('.app-header'))throw new Error('App bootstrap did not finish: '+doc.body.textContent.slice(0,250));
      if (['projects','batch-fork','batch-update','batch-sync','batch-upload'].includes(scenario) || scenario.startsWith('batch-upload-')) {
        await click(doc,'仓库已有项目 (1)');
        if (scenario === 'projects') {
          for (const text of ['仅选未上传','仅选未分叉','仅选有更新','仅选可分叉同步']) {
            if (!buttons(doc).some(button => button.textContent.trim() === text)) throw new Error('Missing quick selection: ' + text);
          }
          inspect(doc,width,'projects-unselected');
          await click(doc,'仅选未上传');
        }
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
          const target=frame.contentWindow.__auditTarget;
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
      } else if(['settings','git-service','backup','apk'].includes(scenario)) {
        await click(doc,'设置');
        if(scenario==='git-service'){const select=doc.querySelector('[aria-label="源码传输方式"]');Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLSelectElement.prototype,'value').set.call(select,'git');select.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));await pause();}
        if(scenario==='backup') await click(doc,'数据备份与恢复');
        if(scenario==='apk') await click(doc,'APK 下载存储目录');
      }
      if (scenario === 'records-storage-error') {
        frame.contentWindow.dispatchEvent(new frame.contentWindow.CustomEvent('gitvault-secure-storage-error',{detail:'项目记录保存未完成；源码缓存已保留。'+'很长的存储失败原因'.repeat(40)}));
        await pause();
        for (const text of ['重试保存记录','导出当前记录备份']) if(!buttons(doc).some(button=>button.textContent===text)) throw new Error('Missing storage recovery control: '+text);
      }
      if (scenario === 'records-large') {
        await click(doc,'设置');await click(doc,'数据备份与恢复');
        const large={...fixture,id:'large-record-audit',remark:'large-record-reloaded',retainedMetadata:'x'.repeat(6*1024*1024)};
        const files=new frame.contentWindow.DataTransfer();
        files.items.add(new frame.contentWindow.File([JSON.stringify({projects:[large]})],'large-record.json',{type:'application/json'}));
        const input=doc.querySelector('input[type=file]');input.files=files.files;input.dispatchEvent(new frame.contentWindow.Event('change',{bubbles:true}));
        for(let tries=0;tries<100&&!doc.querySelector('[data-app-dialog=confirm]');tries++)await pause();
        await click(doc,'合并导入');
        for(let tries=0;tries<100&&!doc.body.textContent.includes('备份恢复完成');tries++)await pause();
        if(!doc.body.textContent.includes('备份恢复完成'))throw new Error('Large metadata restore did not finish');
        if(frame.contentWindow.localStorage.getItem('gitvault_repos_v8')!==null)throw new Error('Large records still mirrored to localStorage');
        await new Promise((resolve,reject)=>{const request=frame.contentWindow.indexedDB.open('GitVault_Records_v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,transaction=db.transaction('projects'),row=transaction.objectStore('projects').get(large.id);transaction.oncomplete=()=>{db.close();try{if(JSON.parse(row.result.json).retainedMetadata.length!==6*1024*1024)throw new Error('Large database record changed');resolve();}catch(error){reject(error);}};transaction.onabort=()=>{db.close();reject(transaction.error);};};});
        await new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=reject;frame.contentWindow.location.reload();});
        doc=frame.contentDocument;
        for(let tries=0;tries<100&&!doc.querySelector('.app-header');tries++)await pause();
        if(!doc.body.textContent.includes('large-record-reloaded'))throw new Error('Large metadata did not survive a real page reload');
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
        if(scenario==='batch-upload-error') { for(let tries=0;tries<100&&!doc.body.textContent.includes('Resource not accessible');tries++) await pause(); if(!doc.body.textContent.includes('Resource not accessible')) throw new Error('Expected visible bulk failure'); }
        if(scenario==='batch-upload-limited') { for(let tries=0;tries<100&&!doc.body.textContent.includes('GitHub 请求已暂停');tries++) await pause(); if(!doc.body.textContent.includes('GitHub 请求已暂停')) throw new Error('Expected visible bulk cooldown'); }
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
  // Use real time: --virtual-time-budget can run to completion while an
  // IndexedDB open/delete IPC is still pending, leaving the audit half finished.
  const args = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-background-networking', '--disable-extensions', `--user-data-dir=${profile}`, '--window-size=1600,1000', '--remote-debugging-port=0', 'about:blank'];
  const child = spawn(chrome, args);
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  child.stdout.resume();
  let socket;
  try {
    let port;
    for (let attempt=0; attempt<100 && !port; attempt++) {
      if (child.exitCode !== null) throw new Error('Chrome exited: ' + stderr);
      try { port = Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]); }
      catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    if (!port) throw new Error('Chrome debugging endpoint did not open: ' + stderr);
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'});
    if (!response.ok) throw new Error('Cannot create Chrome audit tab: ' + response.status);
    const target = await response.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket,'open');
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data)),request=pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);clearTimeout(request.timer);
      if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result);
    });
    const call=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Chrome command timed out: '+method));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });
    await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/audit`});
    let encoded,progress;
    const deadline=Date.now()+300000;
    while(Date.now()<deadline&&!encoded){
      if(child.exitCode!==null)throw new Error('Chrome exited during audit: '+stderr);
      const result=await call('Runtime.evaluate',{expression:'JSON.stringify({report:document.documentElement.dataset.layoutReport,progress:document.documentElement.dataset.layoutProgress})',returnByValue:true});
      const state=JSON.parse(result.result.value||'{}');encoded=state.report;progress=state.progress;
      if(!encoded)await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(!encoded)throw new Error('Layout audit did not finish; last fixture: '+(progress?decodeURIComponent(progress):'no browser progress'));
    const report=JSON.parse(decodeURIComponent(encoded));
    console.log(JSON.stringify(report,null,2));
    // The projects scene checks both the initial toolbar and its selected state.
    const expectedChecks=widths.length*(scenarios.length+1);
    if(report.failures.length||report.checks!==expectedChecks)process.exitCode=1;
  } finally {
    socket?.close();
    if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}
  }
} finally { server.closeAllConnections(); server.close(); await rm(profile, { recursive: true, force: true }); }
