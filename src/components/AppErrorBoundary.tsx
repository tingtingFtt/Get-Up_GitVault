import React from 'react';
import {diagnosticEvent,diagnosticReport} from '../utils/diagnostics';
import {saveDownload} from '../utils/nativePlatform';
export default class AppErrorBoundary extends React.Component<React.PropsWithChildren,{failed:boolean;exporting:boolean;message:string}>{
 state={failed:false,exporting:false,message:''};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidCatch(error:Error,info:React.ErrorInfo){diagnosticEvent('react-error',{message:error.message,stack:error.stack+'\n'+info.componentStack});}
 render(){return this.state.failed?<main className="p-6 min-h-screen bg-[#F8F6F1] text-[#33302C] flex flex-col gap-4"><h1>界面暂时无法显示</h1><p>本地项目没有被清除。请先导出诊断报告，再重新打开。</p><div className="flex flex-wrap gap-3"><button onClick={()=>location.reload()}>重新打开</button><button disabled={this.state.exporting} onClick={async()=>{this.setState({exporting:true});try{await saveDownload(new Blob([JSON.stringify(await diagnosticReport(),null,2)],{type:'application/json'}),'gitvault-diagnostics.json');}catch(error){this.setState({message:(error as Error).message});}finally{this.setState({exporting:false});}}}>导出诊断报告</button></div><p>{this.state.message}</p></main>:this.props.children;}
}
