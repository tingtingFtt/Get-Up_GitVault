export async function runStatusChecks<T>(items:T[],options:{signal:AbortSignal;run:(item:T)=>Promise<void>;onProgress?:(done:number,total:number)=>void}) {
  let next=0,done=0;const errors:unknown[]=[];
  await Promise.all(Array.from({length:Math.min(3,items.length)},async()=>{
    while(!options.signal.aborted){
      const index=next++;if(index>=items.length)return;
      try{await options.run(items[index]);}catch(error){errors.push(error);}finally{done++;options.onProgress?.(done,items.length);}
    }
  }));
  if(errors.length&&!options.signal.aborted)throw new AggregateError(errors,'部分项目检测未完成，请查看操作日志');
  return {done,total:items.length,cancelled:options.signal.aborted};
}
