import './dom';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvent,diagnosticTask,diagnosticPhase,diagnosticTaskResult,diagnosticReport,diagnosticSecrets,readDiagnostics,startupStage} from '../src/utils/diagnostics';
beforeEach(()=>{localStorage.clear();diagnosticSecrets([]);});
test('diagnostics persist task phase before failure and redact credentials at capture and export',async()=>{
 diagnosticSecrets(['custom-private-secret']);diagnosticTask('owner/project','dev','更新');diagnosticPhase('上传 Git 对象');diagnosticEvent('javascript-error',{message:'custom-private-secret Bearer fake-auth-token token=not-a-query',stack:'https://user:password@example.com/?access_token=hidden&value=1 ghp_secret123'});
 const report=JSON.stringify(await diagnosticReport());assert.ok(report.includes('owner/project'));for(const secret of ['custom-private-secret','fake-auth-token','password','ghp_secret123','access_token=hidden'])assert.ok(!report.includes(secret),secret);assert.equal(readDiagnostics().at(-2)?.stage,'上传 Git 对象');diagnosticTaskResult('error');
});
test('diagnostic history and messages are bounded and never serialize arbitrary payload fields',()=>{
 for(let i=0;i<110;i++)diagnosticEvent('test',{message:'x'.repeat(12000)});
 assert.equal(readDiagnostics().length,80);assert.ok(JSON.stringify(readDiagnostics()).length<110000);
});
test('startup progress is visible before the React application and reports elapsed time',()=>{
 document.body.innerHTML='<div id="boot-stage"></div>';startupStage('读取安全存储');assert.equal(document.getElementById('boot-stage')?.textContent,'读取安全存储');assert.ok(typeof readDiagnostics().at(-1)?.elapsedMs==='number');
});
