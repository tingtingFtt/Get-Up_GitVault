import React, { useEffect, useRef, useState } from 'react';
import { appDialog, type DialogRequest } from '../utils/appDialog';

function ConfirmDialog({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState(request.value);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = form.current!;
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>('input,button')).filter(node => !node.hasAttribute('disabled'));
    (element.querySelector<HTMLElement>('input') || focusable()[0])?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); appDialog.cancelActive(); }
      if (event.key === 'Tab') {
        const nodes = focusable(), index = nodes.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); nodes.at(-1)?.focus(); }
        if (!event.shiftKey && (index === nodes.length - 1 || index === -1)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    };
    const focusin = (event: FocusEvent) => { if (!element.contains(event.target as Node)) focusable()[0]?.focus(); };
    document.addEventListener('keydown', keydown, true); document.addEventListener('focusin', focusin);
    return () => { document.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', focusin); if (previous?.isConnected) previous.focus(); };
  }, [request.id]);
  return <div className="app-dialog-overlay fixed inset-0 z-[100] bg-[#33302C]/40 backdrop-blur-xs flex items-center justify-center p-4">
    <form ref={form} role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-description" data-app-dialog={request.kind} className="app-dialog-panel bg-white border border-[#E2DBD0] rounded-3xl p-5 shadow-xl flex flex-col gap-4 w-full max-w-md" onSubmit={event => { event.preventDefault(); appDialog.answer(request.kind === 'confirm' ? true : value); }}>
      <h3 id="app-dialog-title" className="text-base font-bold text-[#2B2723]">{request.kind === 'confirm' ? '确认操作' : '填写信息'}</h3>
      <p id="app-dialog-description" className="text-xs whitespace-pre-wrap leading-relaxed text-[#554F45] overflow-y-auto">{request.message}</p>
      {request.kind === 'prompt' && <input aria-label={request.message} type={request.secret ? 'password' : 'text'} autoComplete="off" value={value} onChange={event => setValue(event.target.value)} className="w-full min-w-0 bg-[#FAF8F5] border border-[#DFD8CE] rounded-xl px-3 py-2.5 text-sm" />}
      <div className="flex flex-wrap justify-end gap-2 shrink-0">
        <button type="button" className="px-4 py-2 text-xs border border-[#DFD8CE] rounded-xl text-[#554F45]" onClick={() => appDialog.cancelActive()}>{request.cancel}</button>
        <button type="submit" className="px-4 py-2 text-xs bg-[#8E9F8B] text-white rounded-xl">{request.accept}</button>
      </div>
    </form>
  </div>;
}
export default function AppDialogs({ onLogs }: { onLogs: () => void }) {
  const [state, setState] = useState(appDialog.snapshot);
  useEffect(() => appDialog.subscribe(() => setState(appDialog.snapshot())), []);
  return <>
    {state.active && <ConfirmDialog key={state.active.id} request={state.active} />}
    <div className="app-notices fixed z-[110] right-3 bottom-4 flex flex-col gap-2 w-[calc(100%-1.5rem)] max-w-sm" aria-label="操作提示">
      {state.notices.map(notice => <div key={notice.id} role={notice.error ? 'alert' : 'status'} className="bg-[#FAF8F5] border border-[#DFD8CE] shadow-lg rounded-2xl p-3 text-xs text-[#474239]">
        <p className="whitespace-pre-wrap max-h-40 overflow-y-auto">{notice.message}</p>
        <div className="flex flex-wrap justify-end gap-2 mt-2">
          {notice.error && <button type="button" className="px-2 py-1 text-[#5D6F5A]" onClick={() => { appDialog.dismiss(notice.id); onLogs(); }}>查看日志</button>}
          <button type="button" className="px-2 py-1 text-[#7A7367]" onClick={() => appDialog.dismiss(notice.id)}>关闭提示</button>
        </div>
      </div>)}
    </div>
  </>;
}
