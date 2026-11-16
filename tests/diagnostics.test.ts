import './dom';
import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticEvent,diagnosticTask,diagnosticPhase,diagnosticTaskResult,diagnosticReport,diagnosticSecrets,readDiagnostics,startupStage,redactDiagnosticData} from '../src/utils/diagnostics';
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
test('diagnostic export preserves bounded native stacks past 5000 characters and redacts their tails',async()=>{
 diagnosticSecrets(['custom-stack-secret']);
 const stack='frame\n'.repeat(1000)+'Caused by: EOFException: connection closed custom-stack-secret ghp_hiddenStackToken';
 const system=redactDiagnosticData({lastGitFailure:{stack},events:[{stack}],exitInfo:[{trace:'t'.repeat(16000)+'custom-stack-secret'}]}) as any;
 assert.ok(system.lastGitFailure.stack.length>5000);assert.match(system.lastGitFailure.stack,/Caused by: EOFException: connection closed/);assert.ok(system.lastGitFailure.stack.length<=8000);assert.equal(system.events[0].stack,system.lastGitFailure.stack);assert.ok(system.exitInfo[0].trace.length>15000);
 assert.ok(!JSON.stringify(system).includes('custom-stack-secret'));assert.ok(!JSON.stringify(system).includes('ghp_hiddenStackToken'));
 diagnosticEvent('javascript-error',{stack});const report=await diagnosticReport();assert.match(report.events.at(-1)!.stack!,/Caused by: EOFException/);
});
