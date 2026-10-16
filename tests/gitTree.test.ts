import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gitBlobSha,gitTreeSha} from '../src/utils/gitFiles';
test('browser tree hashes match real Git ordering, UTF-8, nested paths, binary and executable modes',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'gitvault-tree-'));const git=(args:string[],input?:string|Buffer)=>execFileSync('git',['-C',folder,...args],{input,encoding:'utf8'}).trim();
 try{git(['init','--bare','.']);const values=[['a.txt','hello','100644'],['a/b','中文\n','100644'],['a.c','run','100755'],['目录/x','link-target','120000'],['bin','\0\xff','100644']];
 const files=await Promise.all(values.map(async([path,content,mode])=>({path,mode,sha:await gitBlobSha(new TextEncoder().encode(content))})));
 values.forEach(([,content])=>git(['hash-object','-w','--stdin'],Buffer.from(content)));
 git(['update-index','-z','--index-info'],files.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path))).map(f=>`${f.mode} ${f.sha}\t${f.path}\0`).join(''));
 assert.equal(await gitTreeSha(files),git(['write-tree']));assert.equal(await gitTreeSha([]),'4b825dc642cb6eb9a060e54bf8d69288fbee4904');
 }finally{rmSync(folder,{recursive:true,force:true});}
});
