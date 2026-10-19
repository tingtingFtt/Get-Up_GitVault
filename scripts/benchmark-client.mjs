// Real browser client + durable IndexedDB, with a local GitHub-shaped HTTP peer.
// No external writes or credentials. Delays/pacing are explicit in the report.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {zipSync} from 'fflate';
import {JSDOM} from 'jsdom';
import {indexedDB,IDBObjectStore} from 'fake-indexeddb';
import {gitBlobSha,gitTreeSha} from '../src/utils/gitFiles.ts';

export async function benchmarkClient(original){
 const dom=new JSDOM('',{url:'https://benchmark.invalid'}), globals=new Map();
 for(const [name,value] of Object.entries({window:dom.window,localStorage:dom.window.localStorage,CustomEvent:dom.window.CustomEvent,indexedDB})){
  globals.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,configurable:true});
 }
 const {githubClient,beginGithubOperation}=await import('../src/utils/githubClient.ts');
 const {githubTransport,createGithubTransport}=await import('../src/utils/githubTransport.ts');
 const {localCache,transferCache}=await import('../src/utils/localCache.ts');
 const {transferFailureKind}=await import('../src/utils/transferFailure.ts');
 const savedTransport={...githubTransport},originalFetch=globalThis.fetch;
 Object.assign(githubTransport,createGithubTransport({writeInterval:0,requestInterval:0,shareAcrossTabs:false,retries:0}));
 localStorage.setItem('gitvault_git_service_v1',JSON.stringify({mode:'rest',url:''}));
 let source=original,sourceCommit='source-1',sequence=0,partialZip=false,dropRead=false,dropWriteAt=0,blobWrites=0;
 let stats,handlerFailure;
 const originalDigest=crypto.subtle.digest.bind(crypto.subtle),originalPut=IDBObjectStore.prototype.put;
 crypto.subtle.digest=async(...args)=>{if(stats)stats.hashCalls++;return originalDigest(...args);};
 IDBObjectStore.prototype.put=function(...args){if(stats&&this.name==='file_contents')stats.bodyWrites++;return originalPut.apply(this,args);};
 const empty=await gitTreeSha([]),trees=new Map([[empty,[]]]),commits=new Map([['seed',{tree:{sha:empty},parents:[]}]]),blobs=new Map();
 const targets=new Map([['target',{id:77,refs:new Map([['main','seed']])}],['resume-target',{id:78,refs:new Map([['main','seed']])}]]);
 const manifest=files=>files.map(({path,sha,mode,size})=>({path,sha,mode,size,type:'blob'}));
 const refresh=async()=>{const tree=await gitTreeSha(source);trees.set(tree,manifest(source));commits.set(sourceCommit,{tree:{sha:tree},message:'source',author:{}});for(const file of source)blobs.set(file.sha,file.bytes);};
 await refresh();let zip=zipSync(Object.fromEntries(source.map(file=>['root/'+file.path,file.bytes])),{level:1});
 const server=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);stats.requests++;stats.requestBytes+=body.length;
   await new Promise(resolve=>setTimeout(resolve,15));
   const path=decodeURIComponent(new URL(req.url,'http://local').pathname),method=req.method,payload=body.length?JSON.parse(body):undefined;
   const send=(value,status=200)=>{const bytes=Buffer.from(JSON.stringify(value));stats.responseBytes+=bytes.length;res.writeHead(status,{'content-type':'application/json'});res.end(bytes);};
   if(method!=='GET'){stats.mutations++;}
   if(path==='/repos/source/project')return send({id:42,default_branch:'main'});
   if(path.startsWith('/repos/source/project/commits/'))return send({sha:sourceCommit,commit:commits.get(sourceCommit)});
   if(path.includes('/zipball/')){stats.archives++;const bytes=partialZip?zipSync(Object.fromEntries(source.slice(0,48).map(file=>['root/'+file.path,file.bytes])),{level:1}):zip;stats.responseBytes+=bytes.length;return res.end(bytes);}
   const match=/^\/repos\/me\/([^/]+)(.*)$/.exec(path),target=match?targets.get(match[1]):undefined,suffix=match?.[2];
   if(target&&!suffix)return send({id:target.id,owner:{login:'me'},name:match[1],default_branch:'main',private:true});
   if(target&&suffix.startsWith('/git/ref/heads/')){const sha=target.refs.get(suffix.slice('/git/ref/heads/'.length));return sha?send({object:{sha}}):send({message:'Not Found'},404);}
   if(target&&suffix==='/git/blobs'&&method==='POST'){
    if(dropWriteAt&&++blobWrites===dropWriteAt){stats.interruptions++;req.socket.destroy();return;}
    const bytes=Buffer.from(payload.content,payload.encoding==='base64'?'base64':'utf8'),sha=await gitBlobSha(bytes);blobs.set(sha,bytes);stats.blobWrites++;return send({sha});
   }
   if(path.includes('/git/blobs/')){
    if(dropRead){stats.interruptions++;req.socket.destroy();return;}
    const sha=path.split('/').at(-1),bytes=blobs.get(sha);stats.blobReads++;return bytes?send({sha,encoding:'base64',content:Buffer.from(bytes).toString('base64')}):send({message:'Not Found'},404);
   }
   if(target&&suffix==='/git/trees'&&method==='POST'){
    const entries=[];for(const item of payload.tree){let sha=item.sha;if(item.content!==undefined){const bytes=Buffer.from(item.content);sha=await gitBlobSha(bytes);blobs.set(sha,bytes);}entries.push({path:item.path,sha,mode:item.mode,size:blobs.get(sha).length,type:'blob'});}
    const sha=await gitTreeSha(entries);trees.set(sha,entries);return send({sha});
   }
   if(path.includes('/git/trees/'))return send({tree:trees.get(path.split('/').at(-1)),truncated:false});
   if(target&&suffix==='/git/commits'&&method==='POST'){const sha=createHash('sha1').update(JSON.stringify(payload)+ ++sequence).digest('hex');commits.set(sha,{tree:{sha:payload.tree},parents:payload.parents});return send({sha});}
   if(path.includes('/git/commits/'))return send(commits.get(path.split('/').at(-1)));
   if(target&&suffix==='/git/refs'&&method==='POST'){assert.ok(!target.refs.has(payload.ref.slice(11)));target.refs.set(payload.ref.slice(11),payload.sha);return send({object:{sha:payload.sha}});}
   if(target&&suffix.startsWith('/git/refs/heads/')&&method==='PATCH'){
    assert.equal(payload.force,false);const branch=suffix.slice('/git/refs/heads/'.length);assert.equal(commits.get(payload.sha).parents[0],target.refs.get(branch));target.refs.set(branch,payload.sha);return send({object:{sha:payload.sha}});
   }
   throw new Error('Unexpected local endpoint '+method+' '+path);
  }catch(error){handlerFailure=error;res.writeHead(500);res.end('benchmark peer failed');}
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=`http://127.0.0.1:${server.address().port}`;
 globalThis.fetch=(url,init)=>{const parsed=new URL(String(url));assert.equal(parsed.hostname,'api.github.com');return originalFetch(address+parsed.pathname+parsed.search,init);};
 const results=[];
 const measure=async(scenario,run,expectedError=false)=>{
  stats={hashCalls:0,bodyWrites:0,requests:0,mutations:0,requestBytes:0,responseBytes:0,archives:0,blobReads:0,blobWrites:0,interruptions:0};beginGithubOperation();const start=performance.now();let value,error;
  try{value=await run();}catch(e){error=e;}
  assert.equal(!!error,expectedError,error?.stack);if(error)assert.equal(transferFailureKind(error),'network',error.stack);if(handlerFailure)throw handlerFailure;
  results.push({scenario,...stats,totalMs:Math.round((performance.now()-start)*100)/100,...(error?{failure:transferFailureKind(error)}:{})});return value;
 };
 const check=async(files)=>assert.equal(await gitTreeSha(files),await gitTreeSha(source));
 const cached=files=>files.map(({path,sha,mode,bytes})=>{
  try{assert.ok(!bytes.includes(0));const content=new TextDecoder('utf8',{fatal:true}).decode(bytes);assert.equal(Buffer.byteLength(content),bytes.length);return{path,sha,mode,content,isBase64:false};}
  catch{return{path,sha,mode,content:Buffer.from(bytes).toString('base64'),isBase64:true};}
 });
 const push=(repo,files)=>githubClient.push('me',repo,'release','benchmark-placeholder',files,'Benchmark snapshot',undefined,undefined,undefined,{expectedRepoId:targets.get(repo).id});
 try{
  const first=await measure('first-pull',()=>githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder'));await check(first.files);await localCache.saveProjectFiles('source',first.files,sourceCommit);
  const unchanged=await measure('unchanged-pull',()=>githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder',{cachedFiles:first.files}));await check(unchanged.files);assert.equal(results.at(-1).blobReads+results.at(-1).archives,0);
  const initial=await measure('first-upload',()=>push('target',cached(source)));assert.equal(initial.treeSha,await gitTreeSha(source));
  const unchangedUpload=await measure('unchanged-upload',()=>push('target',cached(source)));assert.equal(unchangedUpload.commitSha,initial.commitSha);assert.equal(results.at(-1).mutations,0);
  const pipeline=await measure('pull-save-unchanged-upload',async()=>{
   const fetched=await githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder',{cachedFiles:first.files});
   await localCache.saveProjectFiles('source',fetched.files,sourceCommit);
   return push('target',fetched.files);
  });assert.equal(pipeline.commitSha,initial.commitSha);assert.equal(results.at(-1).mutations,0);
  source=await Promise.all(original.map(async(file,i)=>{if(i>=4)return file;const bytes=file.bytes.slice();bytes[0]^=255;return{...file,bytes,sha:await gitBlobSha(bytes)};}));sourceCommit='source-2';await refresh();
  const small=await measure('small-update-pull',()=>githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder',{cachedFiles:first.files}));await check(small.files);assert.equal(results.at(-1).blobReads,4);assert.equal(results.at(-1).archives,0);
  const updated=await measure('small-update-upload',()=>push('target',cached(source)));assert.equal(commits.get(updated.commitSha).parents[0],initial.commitSha);assert.equal(results.at(-1).blobWrites,4);
  dropWriteAt=9;blobWrites=0;await measure('interrupted-upload',()=>push('resume-target',cached(source)),true);assert.ok(!targets.get('resume-target').refs.has('release'));
  dropWriteAt=0;const resumedUpload=await measure('resume-upload',()=>push('resume-target',cached(source)));assert.equal(resumedUpload.treeSha,await gitTreeSha(source));assert.equal(results.at(-1).blobWrites,new Set(cached(source).filter(file=>file.isBase64).map(file=>file.sha)).size-8);assert.equal(results.at(-1).blobReads,8);
  await transferCache.clearAll();partialZip=true;dropRead=true;
  await measure('interrupted-pull',()=>githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder'),true);
  const checkpoint=await transferCache.load('source/project@'+sourceCommit);
  for(const file of source.slice(0,48))assert.equal(checkpoint.find(saved=>saved.path===file.path)?.sha,file.sha);
  for(const file of checkpoint)assert.equal(file.sha,source.find(expected=>expected.path===file.path)?.sha);
  results.at(-1).verifiedFiles=checkpoint.length;
  // A failed attempt must leave the old published version selected.
  assert.equal((await localCache.getProjectFiles('source'))[0].sha,first.files[0].sha);
  partialZip=false;dropRead=false;
  const resumed=await measure('resume-pull',()=>githubClient.fetchRepo('source/project',undefined,'benchmark-placeholder'));await check(resumed.files);assert.equal(results.at(-1).archives,0);assert.equal(results.at(-1).blobReads,new Set(source.slice(48).map(file=>file.sha).filter(sha=>!source.slice(0,48).some(file=>file.sha===sha))).size);
  assert.equal(targets.get('target').refs.get('main'),'seed');assert.equal(targets.get('resume-target').refs.get('main'),'seed');
  return{note:'Production REST client, fake IndexedDB + localhost HTTP, 15 ms per response; request/write pacing disabled for repeatable latency. Normal GitHub write pacing/limits still apply. These are not device or Internet speed promises.',results};
 }finally{
  crypto.subtle.digest=originalDigest;IDBObjectStore.prototype.put=originalPut;
  globalThis.fetch=originalFetch;Object.assign(githubTransport,savedTransport);server.close();server.closeAllConnections();dom.window.close();
  for(const [name,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
 }
}
