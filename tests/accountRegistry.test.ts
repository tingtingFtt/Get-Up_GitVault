import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountRegistry, ExistingSourceError, REGISTRY_REPO, type AccountProject } from '../src/utils/accountRegistry';
import { GitHubError, beginGithubOperation } from '../src/utils/githubClient';
const source = { owner: 'upstream', repo: 'source', repositoryId: 42, branch: 'main', url: 'https://github.com/upstream/source' };
const project = (overrides: Partial<AccountProject> = {}): AccountProject => ({ source, target: { id: 77, owner: 'me', repo: 'fixed-name' }, kind: 'upload', state: 'active', createdByApp: true, bindings: { main: { branch: 'release', sourceSha: 'source-v1', commitSha: 'target-v1', updatedAt: 'now' } }, updatedAt: 'now', ...overrides });
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
function fixture(options: { exists?: boolean; owned?: any[]; document?: any; conflict?: boolean; occupied?: boolean; failList?: boolean; private?: boolean } = {}) {
  beginGithubOperation();
  let exists = options.exists || !!options.document, version = options.document ? 1 : 0;
  let document: any = options.document; let conflict = options.conflict;
  const snapshots = new Map<string, any>([[String(version), document]]);
  const requests: Array<{ path: string; value: any; method: string }> = [];
  const api = async (path: string, _token?: string, init: RequestInit = {}, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const method = init.method || 'GET', value = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, value, method });
    if (path === '/user') return { login: 'me' };
    if (path === `/repos/me/${REGISTRY_REPO}`) {
      if (!exists) throw new GitHubError('not found', 404);
      return { private: options.private !== false, owner: { login: 'me' }, default_branch: 'main', description: options.occupied ? 'unrelated' : 'GitVault account sync registry v1' };
    }
    if (path === '/user/repos' && method === 'POST') { exists = true; return { private: true, owner: { login: 'me' }, default_branch: 'main', description: 'GitVault account sync registry v1' }; }
    if (path === `/repos/me/${REGISTRY_REPO}/git/ref/heads/main`) return { object: { sha: String(version) } };
    if (path.startsWith(`/repos/me/${REGISTRY_REPO}/contents/gitvault.json`)) {
      if (method === 'PUT') {
        if (conflict) { conflict = false; document = { app: 'Get-Up_GitVault', version: 1, account: 'me', projects: [project({ source: { ...source, owner: 'other', repositoryId: 43 }, target: { id: 88, owner: 'me', repo: 'other-target' } })] }; version++; snapshots.set(String(version), document); throw new GitHubError('concurrent write', 409); }
        if (value.sha !== (version ? String(version) : undefined)) throw new GitHubError('stale sha', 409);
        document = JSON.parse(Buffer.from(value.content, 'base64').toString()); version++; snapshots.set(String(version), document); return { content: { sha: String(version) }, commit: { sha: String(version) } };
      }
      const ref = new URL(path, 'https://api.github.com').searchParams.get('ref') || String(version);
      const snapshot = snapshots.get(ref);
      if (!snapshot) throw new GitHubError('no file', 404);
      return { encoding: 'base64', content: encoded(snapshot), sha: ref, size: 100 };
    }
    if (path.startsWith('/user/repos?')) { if (options.failList) throw new GitHubError('API rate limit exceeded', 403, true); return options.owned || []; }
    if (/^\/repos\/me\/[^/]+$/.test(path)) throw new GitHubError('Not Found',404);
    throw new Error('unexpected API ' + path);
  };
  return { api, requests, document: () => document, registry: createAccountRegistry(api, async () => {}) };
}

test('read-only discovery does not create a repository and quota errors never imply no existing source', async () => {
  const f = fixture(); assert.deepEqual((await f.registry.candidates(source, 'token')).recorded, []);
  assert.ok(f.requests.every(request => request.method === 'GET'));
  const limited = fixture({ failList: true }); await assert.rejects(limited.registry.candidates(source, 'token'), (error: any) => error.rateLimited);
  assert.ok(limited.requests.every(request => request.method === 'GET'));
});
test('first reservation creates a private account index with no tokens or source bytes and locks the chosen name across clients', async () => {
  const f = fixture();
  const reservation = await f.registry.reserve({ ...source, token: 'secret-source-token' } as any, 'fixed-name', 'upload', 'secret-access-token');
  assert.equal(reservation.state, 'reserved');
  const create = f.requests.find(request => request.path === '/user/repos' && request.method === 'POST');
  assert.equal(create?.value.private, true); assert.equal(create?.value.name, REGISTRY_REPO);
  assert.ok(!JSON.stringify(f.document()).includes('secret'));
  const secondDevice = createAccountRegistry(f.api);
  await assert.rejects(secondDevice.reserve(source, 'duplicate-name', 'full', 'token'), (error: any) => error instanceof ExistingSourceError && error.existing.target.repo === 'fixed-name');
  assert.equal(f.document().projects.length, 1);
});
test('registry CAS retries merge concurrent changes without losing the other source', async () => {
  const f = fixture({ conflict: true });
  await f.registry.save(project(), 'token');
  assert.equal(f.document().projects.length, 2);
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 2);
});
test('concurrent clients and different tokens for one account serialize writes and retain both branches', async () => {
  const f = fixture();
  const second = createAccountRegistry(f.api, async () => {});
  await Promise.all([
    f.registry.save(project(), 'token-a'),
    second.save(project({ source: { ...source, branch: 'feature/x' }, bindings: { 'feature/x': { branch: 'feature/x', updatedAt: 'later' } } }), 'token-b'),
  ]);
  assert.deepEqual(Object.keys(f.document().projects[0].bindings).sort(), ['feature/x', 'main']);
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 2);
  assert.ok(f.requests.filter(request => request.path.includes('/contents/') && request.method === 'GET').every(request => /ref=\d+$/.test(request.path)));
});
test('verification pins our commit even when another device writes a different project before the response arrives', async () => {
  const f = fixture(); let followed = false;
  const api = async (path: string, token?: string, init: RequestInit = {}, signal?: AbortSignal) => {
    const response: any = await f.api(path, token, init, signal);
    if (init.method === 'PUT' && !followed) {
      followed = true;
      const other = project({ source: { ...source, repositoryId: 43, repo: 'other' }, target: { id: 88, owner: 'me', repo: 'other' } });
      await f.api(path, token, { method: 'PUT', body: JSON.stringify({ sha: response.content.sha, content: encoded({ ...f.document(), projects: [...f.document().projects, other] }) }) }, signal);
    }
    return response;
  };
  await createAccountRegistry(api, async () => { assert.fail('A later valid commit must not trigger a retry'); }).save(project(), 'token');
  assert.equal(f.document().projects.length, 2);
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 2);
});
test('a lost successful reservation response is reconciled without reserving twice or rejecting our own reservation', async () => {
  const f = fixture(); let lost = false, waits = 0;
  const api = async (path: string, token?: string, init: RequestInit = {}, signal?: AbortSignal) => {
    const response: any = await f.api(path, token, init, signal);
    if (init.method === 'PUT' && !lost) { lost = true; throw new TypeError('response lost'); }
    return response;
  };
  const reserved = await createAccountRegistry(api, async () => { waits++; }).reserve(source, 'fixed-name', 'upload', 'token');
  assert.equal(reserved.reservationId, f.document().projects[0].reservationId);
  assert.equal(f.document().projects.length, 1);
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 1);
  assert.equal(waits, 1);
});
test('repeated SHA conflicts wait and reload before merging, with a bounded failure preserving the cause', async () => {
  for (const failures of [4, 6]) {
    const f = fixture(); let puts = 0; const waits: number[] = [];
    const registry = createAccountRegistry(async (path, token, init = {}, signal) => {
      if (init.method === 'PUT' && puts++ < failures) throw new GitHubError('gitvault.json does not match latest-sha', 409);
      return f.api(path, token, init, signal);
    }, async attempt => { waits.push(attempt); });
    if (failures === 4) {
      await registry.save(project(), 'token');
      assert.equal(f.document().projects[0].target.id, 77);
    } else {
      await assert.rejects(registry.save(project(), 'token'), (error: any) => /请稍后使用更新/.test(error.message) && error.cause.status === 409);
      assert.equal(f.document(), undefined);
    }
    assert.deepEqual(waits, Array.from({ length: failures === 4 ? 4 : 5 }, (_, i) => i));
    assert.equal(f.requests.filter(request => request.path.includes('/git/ref/')).length, failures === 4 ? 5 : 6);
  }
});
test('cancelling conflict backoff stops further requests and frees the account queue', async () => {
  const f = fixture(), controller = new AbortController(); let puts = 0;
  const registry = createAccountRegistry(async (path, token, init = {}, signal) => {
    if (init.method === 'PUT') { puts++; throw new GitHubError('stale sha', 409); }
    return f.api(path, token, init, signal);
  }, async (_attempt, signal) => { controller.abort(); signal.throwIfAborted(); });
  await assert.rejects(registry.save(project(), 'token', controller.signal), { name: 'AbortError' });
  assert.equal(puts, 1);
  await f.registry.save(project(), 'token');
  assert.equal(f.document().projects.length, 1);
});
test('queued cancellation returns promptly and never starts the cancelled write', async () => {
  const f = fixture(); let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const registry = createAccountRegistry(async (path, token, init = {}, signal) => {
    if (init.method === 'PUT') { started(); await blocked; }
    return f.api(path, token, init, signal);
  });
  const first = registry.save(project(), 'token'); await waiting;
  const controller = new AbortController();
  const second = registry.reserve({ ...source, repositoryId: 100 }, 'cancelled-target', 'upload', 'token', controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  release(); await first;
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 1);
});
test('permissions and validation failures are not retried and an unchanged receipt creates no extra commit', async () => {
  for (const status of [403, 422]) {
    const f = fixture(); let puts = 0;
    const registry = createAccountRegistry(async (path, token, init = {}, signal) => {
      if (init.method === 'PUT') { puts++; throw new GitHubError('permission or invalid content', status); }
      return f.api(path, token, init, signal);
    }, async () => { assert.fail('Non-conflict errors must not be retried'); });
    await assert.rejects(registry.save(project(), 'token'), (error: any) => error.status === status);
    assert.equal(puts, 1);
  }
  const f = fixture(); await f.registry.save(project(), 'token'); await f.registry.save(project(), 'token');
  assert.equal(f.requests.filter(request => request.method === 'PUT').length, 1);
});
test('branch receipts merge into one immutable target and duplicate destination branches are rejected', async () => {
  const f = fixture(); await f.registry.save(project(), 'token');
  await f.registry.save(project({ source: { ...source, branch: 'feature/x' }, bindings: { 'feature/x': { branch: 'feature/x', sourceSha: 's2', commitSha: 't2', updatedAt: 'later' } } }), 'token');
  assert.equal(f.document().projects.length, 1); assert.deepEqual(Object.keys(f.document().projects[0].bindings).sort(), ['feature/x', 'main']);
  await assert.rejects(f.registry.save(project({ target: { id: 99, owner: 'me', repo: 'another' } }), 'token'), ExistingSourceError);
  await assert.rejects(f.registry.save(project({ bindings: { develop: { branch: 'release', updatedAt: 'later' } } }), 'token'), /同一目标分支/);
  assert.equal(f.document().projects[0].target.id, 77);
});
test('two different sources cannot reserve or attach the same fixed target', async () => {
  const f = fixture(); await f.registry.save(project(), 'token');
  const other = { ...source, repo: 'other', repositoryId: 123 };
  await assert.rejects(f.registry.reserve(other, 'fixed-name', 'upload', 'token'), /其他来源/);
  await assert.rejects(f.registry.save(project({ source: other }), 'token'), /其他来源/);
});
test('source and destination links resolve the same cross-device record by repository ID after a rename', async () => {
  const f = fixture(); await f.registry.save(project(), 'token');
  assert.equal((await f.registry.candidates({ ...source, owner: 'renamed', repo: 'renamed' }, 'token')).recorded[0].target.id, 77);
  const targetLink = { ...source, owner: 'me', repo: 'fixed-name', repositoryId: 77, branch: 'release' };
  assert.equal((await f.registry.candidates(targetLink, 'token')).recorded[0].source.repositoryId, 42);
});
test('account index ownership, privacy and schema failures stop writes instead of replacing it', async () => {
  for (const f of [fixture({exists:true,occupied:true}), fixture({exists:true,private:false}), fixture({document:{app:'Get-Up_GitVault',version:1,account:'different',projects:[]}})]) {
    await assert.rejects(f.registry.save(project(), 'token'));
    assert.ok(!f.requests.some(request => request.method === 'PUT'));
  }
});
test('an aborted reservation never creates an account or project repository', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.registry.reserve(source, 'fixed-name', 'upload', 'token', controller.signal));
  assert.equal(f.requests.length, 0);
});
test('explicit detachment removes only that target and read-only absence does not create state', async () => {
  const f = fixture(); await f.registry.save(project(), 'token');
  await f.registry.remove({id:99,owner:'me',repo:'fixed-name'}, 'token'); assert.equal(f.document().projects.length, 1);
  await f.registry.remove(project().target, 'token'); assert.equal(f.document().projects.length, 0);
  const empty = fixture(); await empty.registry.remove(project().target, 'token'); assert.ok(empty.requests.every(request => request.method === 'GET'));
});
test('legacy native Forks and renamed app uploads require comparison and scan branch metadata', async () => {
  const f = fixture({ owned: [
    {id:77,name:'renamed-fork',owner:{login:'me'},fork:true},
    {id:78,name:'renamed-copy',owner:{login:'me'},description:'[GitVault 托管]'},
  ] });
  const legacyApi = async (path: string, ...args: any[]) => {
    if (path === '/repos/me/renamed-fork') return {parent:{id:42,full_name:'upstream/source'}};
    if (path.startsWith('/repos/me/renamed-copy/branches?')) return [{name:'main'},{name:'feature/x'}];
    if (path.endsWith('GITVAULT_METADATA.md?ref=main')) throw new GitHubError('missing',404);
    if (path.endsWith('GITVAULT_METADATA.md?ref=feature%2Fx')) return {encoding:'base64',size:100,content:Buffer.from('# copy\n\nhttps://github.com/upstream/source').toString('base64')};
    return f.api(path, ...args);
  };
  const result = await createAccountRegistry(legacyApi).candidates(source,'token');
  assert.equal(result.recorded.length,0); assert.equal(result.legacy.length,2); assert.equal(result.legacy[0].kind,'full');
  assert.ok(result.legacy.every(entry=>!entry.createdByApp));
  assert.ok(f.requests.every(request=>request.method==='GET'));
});
test('legacy provenance is reused during a batch instead of querying every Fork and branch for each source', async()=>{
  const f=fixture({owned:[{id:77,name:'forked-copy',owner:{login:'me'},fork:true},{id:78,name:'saved-copy',owner:{login:'me'},description:'[GitVault 托管]'}]});
  let parents=0,branches=0,files=0;
  const api=async(path:string,...args:any[])=>{
    if(path==='/repos/me/forked-copy'){parents++;return {parent:{id:42}};}
    if(path.startsWith('/repos/me/saved-copy/branches?')){branches++;return [{name:'main'}];}
    if(path.includes('GITVAULT_METADATA.md')){files++;return {encoding:'base64',size:10,content:Buffer.from('https://github.com/upstream/source').toString('base64')};}
    return f.api(path,...args);
  };
  const registry=createAccountRegistry(api);
  await registry.candidates(source,'token');await registry.candidates({...source,repo:'different',repositoryId:123},'token');
  assert.equal(parents,1);assert.equal(branches,1);assert.equal(files,1);
});
test('a switch lease preserves the old target until verified completion and rejects stale or competing moves',async()=>{
  const f=fixture();await f.registry.save(project(),'token');
  const target={owner:'me',repo:'new-copy'};
  const lease=await f.registry.reserveSwitch(source,target,'main',project().target,'token');
  assert.equal(f.document().projects[0].target.id,77);assert.equal(f.document().projects[0].switchReservation.id,lease.id);
  await assert.rejects(f.registry.reserveSwitch(source,{owner:'me',repo:'other-copy'},'main',project().target,'token'),/另存任务/);
  const next=project({target:{...target,id:99},kind:'upload',bindings:{main:{branch:'main',sourceSha:'s2',commitSha:'t2',updatedAt:'later'}}});
  await assert.rejects(f.registry.completeSwitch(next,'stale','token'),/预留已改变/);
  await f.registry.completeSwitch(next,lease.id,'token');
  assert.equal(f.document().projects[0].target.id,99);assert.equal(f.document().projects[0].primary,true);assert.equal(f.document().projects[0].history[0].target.id,77);
  await f.registry.completeSwitch(next,lease.id,'token');assert.equal(f.document().projects[0].history.length,1);
  await assert.rejects(f.registry.reserveSwitch(source,{owner:'me',repo:'third'},'main',project().target,'token'),ExistingSourceError);
});
test('a same-name owned repository is discovered without an index or a whole-account scan',async()=>{
  const f=fixture();const api=async(path:string,...args:any[])=>path==='/repos/me/source'?{id:77,name:'source',owner:{login:'me'},private:true,fork:false}:f.api(path,...args);
  const candidates=await createAccountRegistry(api).candidates(source,'token');assert.equal(candidates.legacy[0].target.private,true);assert.equal(candidates.legacy[0].target.id,77);assert.ok(!f.requests.some(request=>request.path.startsWith('/user/repos?')));
});
test('profile-only changes retain branch receipts and store no target credentials',async()=>{
  const f=fixture();await f.registry.save(project(),'token');
  await f.registry.save(project({target:{...project().target,token:'never-store'} as any,profile:{tags:['B'],remark:'name',description:'description',updatedAt:'2026-10-16T09:00:00Z'},bindings:{main:{branch:'release',updatedAt:'later'}}}),'token');
  assert.equal(f.document().projects[0].bindings.main.commitSha,'target-v1');assert.deepEqual(f.document().projects[0].profile.tags,['B']);assert.ok(!JSON.stringify(f.document()).includes('never-store'));
});
