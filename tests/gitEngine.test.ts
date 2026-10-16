import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitEngine, GitTransferError } from '../server/gitEngine';
const exec = promisify(execFile);
let root: string, remote: string, sessions: string, work: string;
const identity = { id:77, owner:'me', repo:'project' }, token = 'fake-test-token';
const signal = () => new AbortController().signal;
const file = (path: string, content: string, mode = '100644') => ({path,content,mode,isBase64:false});
const git = async (...args: string[]) => (await exec('git',args,{env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.com'}})).stdout.trim();
const engine = (maxBytes?:number) => createGitEngine({remote:()=>remote,allowLocal:true,workspaceRoot:sessions,maxBytes});
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'gitvault-engine-test-'));remote=join(root,'remote.git');sessions=join(root,'sessions');work=join(root,'work');
  await mkdir(sessions);await mkdir(work);await git('init','--bare',remote);await git('-C',work,'init','-b','main');
  await writeFile(join(work,'initial.txt'),'original');await git('-C',work,'add','.');await git('-C',work,'commit','-m','initial');await git('-C',work,'push',remote,'HEAD:refs/heads/main');
});
afterEach(async()=>{assert.deepEqual(await readdir(sessions),[],'Every transfer must remove temporary Git data');await rm(root,{recursive:true,force:true});});
test('Git creates only the requested branch, appends updates to its history and reuses an unchanged snapshot',async()=>{
  const main=await git('--git-dir',remote,'rev-parse','main');const e=engine();
  const first=await e.push(identity,'dev',token,[file('a.txt','first'),file('remove.txt','remove')],'first',signal());
  assert.equal(await git('--git-dir',remote,'rev-parse','main'),main);
  const second=await e.push(identity,'dev',token,[file('a.txt','second')],'second',signal());
  assert.equal(await git('--git-dir',remote,'rev-parse','dev^'),first.commitSha);
  assert.equal(await git('--git-dir',remote,'show','dev:a.txt'),'second');
  assert.equal(await git('--git-dir',remote,'ls-tree','--name-only','dev'),'a.txt');
  const retry=await e.push(identity,'dev',token,[file('a.txt','second')],'retry response loss',signal());
  assert.equal(retry.commitSha,second.commitSha);assert.equal(await git('--git-dir',remote,'rev-list','--count','dev'),'2');
  assert.equal(await git('--git-dir',remote,'rev-parse','main'),main);
});
test('Git transfers pinned files byte accurately, including Unicode, executable modes, binary data and symlinks',async()=>{
  const e=engine();const binary=Buffer.from([0,255,128,1]);
  const result=await e.push(identity,'feature/demo',token,[file('源码.txt','中文\n'),file('run.sh','#!/bin/sh\necho test\n','100755'),file('link','../outside.txt','120000'),{path:'binary.dat',content:binary.toString('base64'),isBase64:true,mode:'100644'}],'files',signal());
  const pulled=await e.fetch(identity,result.commitSha,token,signal());
  assert.equal(pulled.treeSha,result.treeSha);
  assert.equal(Buffer.from(pulled.files.find(f=>f.path==='源码.txt')!.content,'base64').toString(),'中文\n');
  assert.deepEqual(Buffer.from(pulled.files.find(f=>f.path==='binary.dat')!.content,'base64'),binary);
  assert.equal(pulled.files.find(f=>f.path==='run.sh')!.mode,'100755');
  assert.equal(pulled.files.find(f=>f.path==='link')!.mode,'120000');
  assert.equal(Buffer.from(pulled.files.find(f=>f.path==='link')!.content,'base64').toString(),'../outside.txt');
});
test('a concurrent target update is retained as the parent when explicit conflict retry is enabled',async()=>{
  const e=engine();await e.push(identity,'dev',token,[file('a','one')],'one',signal());
  let competing='';
  const result=await e.push(identity,'dev',token,[file('a','three')],'three',signal(),async()=>{if(!competing)competing=(await e.push(identity,'dev',token,[file('a','two')],'two',signal())).commitSha;},true);
  assert.equal(await git('--git-dir',remote,'rev-parse',result.commitSha+'^'),competing);
  assert.equal(await git('--git-dir',remote,'rev-list','--count','dev'),'3');
});
test('a concurrent change is rejected without forcing when conflict retry was not requested',async()=>{
  const e=engine();await e.push(identity,'dev',token,[file('a','one')],'one',signal());let competing='';
  await assert.rejects(e.push(identity,'dev',token,[file('a','three')],'three',signal(),async()=>{competing=(await e.push(identity,'dev',token,[file('a','two')],'two',signal())).commitSha;}));
  assert.equal(await git('--git-dir',remote,'rev-parse','dev'),competing);
});
test('identity failure or cancellation before pushing leaves the existing branch unchanged',async()=>{
  const e=engine(),old=await git('--git-dir',remote,'rev-parse','main');
  await assert.rejects(e.push(identity,'main',token,[file('new','new')],'new',signal(),async()=>{throw new GitTransferError('identity changed',409);}),/identity changed/);
  const controller=new AbortController();
  await assert.rejects(e.push(identity,'main',token,[file('new','new')],'new',controller.signal,async()=>{controller.abort();}),{name:'AbortError'});
  assert.equal(await git('--git-dir',remote,'rev-parse','main'),old);
});
test('unsafe paths, duplicate files, corrupt hashes and oversized snapshots never create a branch',async()=>{
  for(const files of [[file('../outside','bad')],[file('.git/config','bad')],[file('a','one'),file('a','two')],[{...file('a','bytes'),sha:'0'.repeat(40)}]]){
    await assert.rejects(engine().push(identity,'bad',token,files,'bad',signal()));
  }
  await assert.rejects(engine(1).push(identity,'bad',token,[file('a','large')],'bad',signal()),/大小上限/);
  assert.equal(await git('--git-dir',remote,'for-each-ref','--format=%(refname)','refs/heads'),'refs/heads/main');
});
test('empty snapshots and empty target repositories support a first commit',async()=>{
  const empty=join(root,'empty.git');await git('init','--bare',empty);
  const e=createGitEngine({remote:()=>empty,allowLocal:true,workspaceRoot:sessions});
  const result=await e.push(identity,'dev',token,[],'empty',signal());
  assert.equal(await git('--git-dir',empty,'rev-parse','dev'),result.commitSha);
  assert.deepEqual((await e.fetch(identity,result.commitSha,token,signal())).files,[]);
});
test('Git LFS pointers are rejected instead of being reported as complete source downloads',async()=>{
  const e=engine();const result=await e.push(identity,'lfs',token,[file('large','version https://git-lfs.github.com/spec/v1\noid sha256:test\nsize 100\n')],'pointer',signal());
  await assert.rejects(e.fetch(identity,result.commitSha,token,signal()),/LFS/);
});
