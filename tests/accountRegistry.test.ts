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
    if (path.startsWith(`/repos/me/${REGISTRY_REPO}/contents/gitvault.json`)) {
      if (method === 'PUT') {
        if (conflict) { conflict = false; document = { app: 'Get-Up_GitVault', version: 1, account: 'me', projects: [project({ source: { ...source, owner: 'other', repositoryId: 43 }, target: { id: 88, owner: 'me', repo: 'other-target' } })] }; version++; throw new GitHubError('concurrent write', 409); }
        if (value.sha !== (version ? String(version) : undefined)) throw new GitHubError('stale sha', 409);
        document = JSON.parse(Buffer.from(value.content, 'base64').toString()); version++; return { content: { sha: String(version) } };
      }
      if (!document) throw new GitHubError('no file', 404);
      return { encoding: 'base64', content: encoded(document), sha: String(version), size: 100 };
    }
    if (path.startsWith('/user/repos?')) { if (options.failList) throw new GitHubError('API rate limit exceeded', 403, true); return options.owned || []; }
    throw new Error('unexpected API ' + path);
  };
  return { api, requests, document: () => document, registry: createAccountRegistry(api) };
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
