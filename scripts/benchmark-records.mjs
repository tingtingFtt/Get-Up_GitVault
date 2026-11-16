// Real production record client against a local encrypted-file fixture, not Android timing.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {nativeRecordsBridge,createNativeProjectRecords} from '../src/utils/nativeProjectRecords.ts';
import {prepareRecords,recordsJSON} from '../src/utils/projectRecordStore.ts';
export async function benchmarkRecords(){
 const saved={...nativeRecordsBridge},directory=await mkdtemp(join(tmpdir(),'gitvault-records-')),key=randomBytes(32);let stats,revision=1;
 const tree=Array.from({length:96},(_,i)=>({path:`resources/${i}/`+'long-file-name-'.repeat(4)+'.jpg',sha:String(i).padStart(40,'0'),mode:'100644',type:'blob',size:1024}));
 const projects=Array.from({length:120},(_,i)=>({id:'p'+i,owner:'source',repo:'project-'+i,branch:'main',latestCommitSha:'source-current',tree,backups:Array.from({length:4},(_,j)=>({id:'history-'+j,commitSha:'old-'+j,tree})),uploadTarget:{id:77+i,owner:'me',repo:'fixed-'+i,branch:'dev',token:'fixture-only'}}));
 const order=projects.map(p=>p.id),results=[];
 const encode=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);};
 const decode=value=>{const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString();};
 const full=()=>JSON.stringify({gitvault_repos_v8:recordsJSON(prepareRecords(projects)),gitvault_global_token:'fixture-only'});
 await writeFile(join(directory,'legacy'),encode(full()));for(const p of projects)await writeFile(join(directory,p.id),encode(JSON.stringify(p)));
 const measure=async(scenario,work)=>{stats={projectRowsRead:0,projectRowsWritten:0,serializedWriteBytes:0};const start=performance.now();await work();results.push({scenario,...stats,totalMs:Math.round((performance.now()-start)*100)/100});};
 nativeRecordsBridge.index=async()=>({revision,order:[...order]});
 nativeRecordsBridge.read=async({revision:expected,offset})=>{assert.equal(expected,revision);const rows=[];let bytes=0,next=offset;while(next<order.length&&rows.length<32&&(bytes<512*1024||!rows.length)){const id=order[next++],json=decode(await readFile(join(directory,id)));rows.push({id,json});stats.projectRowsRead++;bytes+=json.length*2;}return{revision,rows,next};};
 nativeRecordsBridge.commit=async request=>{assert.equal(request.revision,revision);for(const row of request.rows){stats.projectRowsWritten++;stats.serializedWriteBytes+=Buffer.byteLength(row.json);await writeFile(join(directory,row.id),encode(row.json));}return{revision:++revision};};
 try{
  await measure('previous-startup-full-vault-rewrite',async()=>{const values=JSON.parse(decode(await readFile(join(directory,'legacy')))),all=JSON.parse(values.gitvault_repos_v8);values.gitvault_repos_v8=recordsJSON(prepareRecords(all));const json=JSON.stringify(values);stats.projectRowsRead=all.length;stats.projectRowsWritten=all.length;stats.serializedWriteBytes=Buffer.byteLength(json);await writeFile(join(directory,'legacy'),encode(json));});
  const client=createNativeProjectRecords();let loaded;
  await measure('encrypted-row-startup-no-rewrite',async()=>{loaded=await client.load();});assert.equal(stats.projectRowsWritten,0);assert.deepEqual(loaded.projects,projects);
  await measure('previous-single-project-update-full-vault-rewrite',async()=>{projects[17]={...projects[17],remark:'edited'};const json=full();stats.projectRowsWritten=projects.length;stats.serializedWriteBytes=Buffer.byteLength(json);await writeFile(join(directory,'legacy'),encode(json));});
  await measure('encrypted-row-single-project-update',async()=>{const all=[...loaded.projects];all[17]={...all[17],remark:'edited'};await client.save(prepareRecords(all));loaded.projects=all;});assert.equal(stats.projectRowsWritten,1);
  await measure('unchanged-save',()=>client.save(prepareRecords(loaded.projects)));assert.equal(stats.projectRowsWritten,0);assert.equal(stats.serializedWriteBytes,0);
  assert.deepEqual(JSON.parse(decode(await readFile(join(directory,'p17')))),projects[17]);
  return {note:'120 projects, 96 files and four historical manifests each. Production JS client; local Node AES-GCM encrypted files stand in for Android SQLite/Keystore. Write counts/bytes and preservation are asserted; times are not a phone launch guarantee.',results};
 }finally{Object.assign(nativeRecordsBridge,saved);await rm(directory,{recursive:true,force:true});}
}
