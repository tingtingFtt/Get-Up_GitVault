interface SizedEntry { size?:number }
/** Avoid downloading a large unchanged archive for a small incremental update.
 * Large initial snapshots also use ZIP when they contain only a few huge files. */
export function shouldUseArchive(entries:SizedEntry[],missing:SizedEntry[]) {
  if(!missing.length)return false;
  const bytes=(files:SizedEntry[])=>files.reduce((sum,file)=>sum+(Number.isSafeInteger(file.size)&&file.size!>=0?file.size!:0),0);
  const total=bytes(entries),needed=bytes(missing),large=32*1024*1024;
  if(total>large&&needed<total/4)return false;
  if(needed>=large)return true;
  if(missing.length<=12)return false;
  // For smaller archives the shared API pacing usually costs more than the
  // extra compressed bytes. Keep the existing small-project ZIP fast path.
  return true;
}
