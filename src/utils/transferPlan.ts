interface SizedEntry { size?:number }
/** Avoid downloading a large unchanged archive for a small incremental update.
 * Large initial snapshots also use ZIP when they contain only a few huge files. */
export function shouldUseArchive(entries:SizedEntry[],missing:SizedEntry[],incremental=false) {
  if(!missing.length)return false;
  const bytes=(files:SizedEntry[])=>files.reduce((sum,file)=>sum+(Number.isSafeInteger(file.size)&&file.size!>=0?file.size!:0),0);
  const total=bytes(entries),needed=bytes(missing),large=32*1024*1024;
  // An existing snapshot opts into exact delta transfer when any bodies survive.
  if(incremental&&missing.length<entries.length)return false;
  if(total>large&&needed<total/4)return false;
  if(needed>=large)return true;
  if(missing.length<=12)return false;
  // For smaller archives the shared API pacing usually costs more than the
  // extra compressed bytes. Keep the existing small-project ZIP fast path.
  return true;
}

interface FileIdentity {path:string;sha?:string;mode?:string;size?:number;type?:string}
/** Exact pinned manifests, independent of the selected transport. */
export function planFileChanges(previous: FileIdentity[], next: FileIdentity[]) {
  const old = new Map(previous.filter(f=>!f.type||f.type==='blob').map(f=>[f.path,f]));
  const plan = {added:[] as string[],modified:[] as string[],removed:[] as string[],unchanged:[] as string[]};
  for (const file of next.filter(f=>!f.type||f.type==='blob')) {
    const before=old.get(file.path); old.delete(file.path);
    if(!before) plan.added.push(file.path);
    else if(before.sha!==file.sha||(before.mode||'100644')!==(file.mode||'100644')) plan.modified.push(file.path);
    else plan.unchanged.push(file.path);
  }
  plan.removed.push(...old.keys()); return plan;
}
