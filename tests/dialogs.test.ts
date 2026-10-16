import { dom } from './dom';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AppDialogs from '../src/components/AppDialogs';
import { appDialog } from '../src/utils/appDialog';
let root: Root;
beforeEach(async () => {
  while (appDialog.cancelActive()) { }
  appDialog.snapshot().notices.forEach(notice => appDialog.dismiss(notice.id));
  document.body.innerHTML = '<button id="previous">原按钮</button><div id="root"></div>';
  document.getElementById('previous')!.focus();
  root = createRoot(document.getElementById('root')!);
  await act(async () => root.render(React.createElement(AppDialogs, { onLogs: () => {} })));
});
afterEach(async () => { await act(async () => { while (appDialog.cancelActive()) { } root.unmount(); }); });
test('confirmation waits for an explicit choice and cancel restores focus', async () => {
  let result: Promise<boolean>;
  await act(async () => { result = appDialog.confirm('清理源码？'); });
  assert.ok(document.querySelector('[data-app-dialog="confirm"]'));
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-app-dialog] button[type="button"]')!.click(); });
  assert.equal(await result!, false);
  assert.equal(document.activeElement?.id, 'previous');
});
test('Token input is masked and returns the edited value only on submit', async () => {
  let result: Promise<string | null>;
  await act(async () => { result = appDialog.prompt('请输入 GitHub Token：'); });
  const input = document.querySelector<HTMLInputElement>('[data-app-dialog] input')!;
  assert.equal(input.type, 'password'); assert.equal(document.activeElement, input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'private-test-token');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal(await result!, 'private-test-token');
});
test('Escape cancels a prompt without executing the queued confirmation', async () => {
  let first: Promise<string | null>, second: Promise<boolean>;
  await act(async () => { first = appDialog.prompt('仓库名', 'old'); second = appDialog.confirm('确认覆盖？'); });
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(await first!, null);
  assert.match(document.querySelector('[data-app-dialog]')!.textContent!, /确认覆盖/);
  await act(async () => { appDialog.cancelActive(); }); assert.equal(await second!, false);
});
test('failures remain visible with an action to open operation logs', async () => {
  let opened = false;
  await act(async () => { root.render(React.createElement(AppDialogs, { onLogs: () => { opened = true; } })); appDialog.notify('上传失败：无权限'); });
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /无权限/);
  await act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === '查看日志')!.click(); });
  assert.equal(opened, true); assert.equal(appDialog.snapshot().notices.length, 0);
});
