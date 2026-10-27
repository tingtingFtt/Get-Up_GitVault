import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeCredentials, readProjectRecoveryBackup } from './utils/credentialStorage';

import { saveDownload } from './utils/nativePlatform';

async function start() {
  try {
    await initializeCredentials();
    createRoot(document.getElementById('root')!).render(<App />);
  } catch (error) {
    // A failed secure-store read must never be treated as an empty account.
    const root = document.getElementById('root')!;
    root.style.cssText='padding:1rem;overflow-wrap:anywhere;color:#2E2B27;background:#F8F6F1';
    root.textContent = '无法读取或迁移本地项目记录。原数据未清除，请检查可用空间并关闭其他页面后重试。' + (error instanceof Error ? error.message : '');
    const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload(); const controls=document.createElement('div');controls.style.cssText='display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem';controls.append(retry);root.append(controls);
    const backup=readProjectRecoveryBackup();
    if(backup){
      const exportButton=document.createElement('button');exportButton.textContent='导出可读取记录备份';
      const status=document.createElement('p');
      exportButton.onclick=async()=>{exportButton.disabled=true;try{await saveDownload(new Blob([backup],{type:'application/json;charset=utf-8'}),'GitVault_Recovery_Backup.json');status.textContent='备份已导出，原记录仍保留。';}catch(error){status.textContent='备份未导出：'+(error as Error).message;}finally{exportButton.disabled=false;}};
      controls.append(exportButton);root.append(status);
    }
  }
}
void start();
