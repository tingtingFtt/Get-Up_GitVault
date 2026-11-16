import {androidPlugin} from './androidPlugin';
import {prepareRecords,rememberRecordJSON,type PreparedRecords,type ProjectRecord} from './projectRecordStore';

export const nativeRecordsBridge={
 begin:()=>androidPlugin.beginRecordMigration() as Promise<{id:string}>,
 stage:(options:{id:string;rows:Array<{id:string;json:string}>})=>androidPlugin.stageRecordMigration(options),
 finish:(options:{id:string;order:string[]})=>androidPlugin.finishRecordMigration(options) as Promise<{revision:number}>,
 archive:(value:string)=>androidPlugin.archiveRecordBackup({value}),
 index:()=>androidPlugin.recordIndex() as Promise<{revision:number;order:string[]}>,
 read:(options:{revision:number;offset:number})=>androidPlugin.readRecords(options) as Promise<{revision:number;rows:Array<{id:string;json:string}>;next:number}>,
 commit:(options:{revision:number;order:string[];rows:Array<{id:string;json:string}>;removed:string[]})=>androidPlugin.commitRecords(options) as Promise<{revision:number}>,
};
/** Native encrypted rows: no complete-vault serialization on an ordinary edit. */
export function createNativeProjectRecords(){
 let revision=0,persisted:PreparedRecords={rows:new Map(),order:[]};
 const load=async(onProgress?:(stage:string)=>void)=>{
  const index=await nativeRecordsBridge.index();
  if(!Number.isSafeInteger(index.revision)||index.revision<0||!Array.isArray(index.order)||new Set(index.order).size!==index.order.length)throw new Error('原生项目索引无效，原数据未清除');
  const rows=new Map<string,string>(),projects:ProjectRecord[]=[];let offset=0;
  while(offset<index.order.length){
   const page=await nativeRecordsBridge.read({revision:index.revision,offset});
   if(page.revision!==index.revision||page.next<=offset||page.next>index.order.length||page.rows.length!==page.next-offset)throw new Error('项目读取期间记录已变化，请重新打开');
   for(const row of page.rows){const project=JSON.parse(row.json);if(row.id!==index.order[offset++]||project?.id!==row.id||rows.has(row.id))throw new Error('原生项目身份不一致，原数据未清除');rows.set(row.id,row.json);rememberRecordJSON(project,row.json);projects.push(project);}
   onProgress?.(`读取项目记录 ${offset}/${index.order.length}`);await new Promise(resolve=>setTimeout(resolve,0));
  }
  revision=index.revision;persisted={rows,order:index.order};return {revision,records:persisted,projects};
 };
 const save=async(next:PreparedRecords)=>{
  const rows=Array.from(next.rows,([id,json])=>({id,json})).filter(row=>persisted.rows.get(row.id)!==row.json),removed=persisted.order.filter(id=>!next.rows.has(id));
  if(revision&&rows.length===0&&removed.length===0&&JSON.stringify(next.order)===JSON.stringify(persisted.order))return;
  const result=await nativeRecordsBridge.commit({revision,order:next.order,rows,removed});
  if(result.revision!==revision+1)throw new Error('项目保存回执无效，请重新打开核对；未清理源码');
  revision=result.revision;persisted=next;
 };
 return {load,save,async initialize(legacy:()=>ProjectRecord[],onProgress?:(stage:string)=>void){
  let loaded=await load(onProgress);
  if(!loaded.revision){
   onProgress?.('迁移旧项目记录（仅首次执行）');const next=prepareRecords(legacy()),lease=await nativeRecordsBridge.begin();
   let batch:Array<{id:string;json:string}>=[],bytes=0,done=0;
   const flush=async()=>{if(!batch.length)return;await nativeRecordsBridge.stage({id:lease.id,rows:batch});done+=batch.length;batch=[];bytes=0;onProgress?.(`迁移项目记录 ${done}/${next.order.length}`);await new Promise(resolve=>setTimeout(resolve,0));};
   for(const [id,json] of next.rows){if(batch.length&&(batch.length>=32||bytes+json.length*2>512*1024))await flush();batch.push({id,json});bytes+=json.length*2;}await flush();
   await nativeRecordsBridge.finish({id:lease.id,order:next.order});loaded=await load(onProgress);
   if(next.rows.size!==loaded.records.rows.size||next.order.some((id,i)=>loaded.records.order[i]!==id||next.rows.get(id)!==loaded.records.rows.get(id)))throw new Error('原生项目迁移校验失败，旧记录未清除');
  }
  return loaded;
 }};
}
