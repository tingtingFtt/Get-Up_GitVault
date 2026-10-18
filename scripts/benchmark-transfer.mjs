// Reproducible local comparison, not a GitHub/phone bandwidth claim.
// Run: node --import tsx scripts/benchmark-transfer.mjs [report.json]
import {createServer} from 'node:http';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {zipSync} from 'fflate';
import assert from 'node:assert/strict';
import {readArchive} from '../src/utils/archiveDownload.ts';
import {gitBlobSha,gitTreeSha} from '../src/utils/gitFiles.ts';
import {shouldUseArchive} from '../src/utils/transferPlan.ts';

let seed=77;
const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed&255;};
const original=await Promise.all(Array.from({length:64},async(_,i)=>{
 const bytes=new Uint8Array(65536);for(let j=0;j<bytes.length;j++)bytes[j]=i%2?random():97+(i%26);
 return{path:`files/${i}.bin`,mode:'100644',size:bytes.length,sha:await gitBlobSha(bytes),bytes};
}));
let source=original,archive;
const server=createServer(async(req,res)=>{
 await new Promise(resolve=>setTimeout(resolve,15));
 if(req.url==='/archive'){res.end(archive);return;}
 const file=source[Number(req.url.slice(1))];if(!file){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:Buffer.from(file.bytes).toString('base64')}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=`http://127.0.0.1:${server.address().port}`;
const report={environment:{node:process.version,platform:process.platform,localResponseDelayMs:15,files:64,bytes:4194304,seed:77},note:'Local HTTP, three read workers, no GitHub throttling. Timings are observations, not speed guarantees.',results:[]};
try{
 for(const [scenario,changed] of [['initial',64],['unchanged',0],['small-update',4],['partial-update',16]]){
  source=await Promise.all(original.map(async(file,i)=>{
   if(scenario==='initial'||i>=changed)return file;
   const bytes=file.bytes.slice();bytes[0]^=255;return{...file,bytes,sha:await gitBlobSha(bytes)};
  }));
  archive=zipSync(Object.fromEntries(source.map(file=>['root/'+file.path,file.bytes])),{level:1});
  for(const strategy of ['per-file','previous-stream','planned-stream']){
   const saved=new Map(scenario==='initial'?[]:original.map(file=>[file.path,file]));
   const missing=source.filter(file=>saved.get(file.path)?.sha!==file.sha);let requests=0,received=0;
   const start=performance.now();
   const accept=async(entry,bytes)=>{assert.equal(await gitBlobSha(bytes),entry.sha);saved.set(entry.path,{...entry,bytes});};
   if(strategy==='previous-stream'&&missing.length>12||strategy==='planned-stream'&&shouldUseArchive(source,missing)){
    requests++;await readArchive(await fetch(address+'/archive'),missing,new AbortController().signal,accept,bytes=>{received=bytes;});
   }else{
    let next=0;await Promise.all(Array.from({length:Math.min(3,missing.length)},async()=>{
     while(next<missing.length){const file=missing[next++];requests++;const response=await fetch(address+'/'+source.indexOf(file));const text=await response.text();received+=Buffer.byteLength(text);await accept(file,Buffer.from(JSON.parse(text).content,'base64'));}
    }));
   }
   assert.equal(saved.size,source.length);for(const file of source)assert.equal(saved.get(file.path).sha,file.sha);
   const tree=await gitTreeSha(Array.from(saved.values()));assert.equal(tree,await gitTreeSha(source));
   report.results.push({scenario,strategy,requests,receivedBytes:received,totalMs:Math.round((performance.now()-start)*100)/100,tree});
  }
 }
}finally{server.close();server.closeAllConnections();}
console.log(JSON.stringify(report,null,2));if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
