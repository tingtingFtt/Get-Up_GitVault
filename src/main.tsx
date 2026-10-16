import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initializeCredentials } from './utils/credentialStorage';

async function start() {
  try {
    await initializeCredentials();
    createRoot(document.getElementById('root')!).render(<App />);
  } catch {
    // A failed secure-store read must never be treated as an empty account.
    const root = document.getElementById('root')!;
    root.textContent = '无法读取 Android 安全存储。原项目记录未清除，请关闭应用后重试。';
    const retry = document.createElement('button'); retry.textContent = '重新打开'; retry.onclick = () => location.reload(); root.appendChild(retry);
  }
}
void start();
