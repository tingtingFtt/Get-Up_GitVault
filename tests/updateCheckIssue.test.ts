import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GitHubError} from '../src/utils/githubTransport';
import {activeUpdateCheckIssue,scheduledUpdateCheck,updateCheckFailure,updateCheckSourceKey} from '../src/utils/updateCheckIssue';
const source={owner:'Owner',repo:'Project',branch:'feature/UI',url:'https://github.com/Owner/Project',repositoryId:42};
test('source availability and identity failures are isolated without claiming a repository was deleted',()=>{
 for(const [status,kind] of [[404,'unavailable'],[410,'unavailable'],[401,'permission'],[403,'permission'],[301,'address'],[308,'address'],[409,'identity']] as const){
  const issue=updateCheckFailure(new GitHubError(status===409?'来源仓库身份已变化':'GitHub request failed',status),source);
  assert.equal(issue?.kind,kind);assert.equal(issue?.sourceKey,updateCheckSourceKey(source));
 }
 assert.equal(updateCheckFailure(Object.assign(new GitHubError('Not Found',404),{sourceCheckKind:'branch'}),source)?.kind,'branch');
});
test('network, TLS, cancellation and rate limits do not quarantine healthy sources',()=>{
 for(const error of [new TypeError('Failed to fetch'),Object.assign(new Error('TLS connection closed'),{code:'GIT_TLS_NETWORK'}),new GitHubError('temporary error',500),new GitHubError('API rate limit exceeded',403,true),new GitHubError('secondary rate limit',403),new GitHubError('Too many requests',429),new DOMException('cancelled','AbortError'),new Error('unexpected response')])assert.equal(updateCheckFailure(error,source),undefined);
});
test('saved source issues survive reload and suppress scheduled checks until the actual source changes',()=>{
 const project={...source,checkInterval:1,lastCheckedAt:'2020-01-01T00:00:00Z',updateCheckIssue:updateCheckFailure(new GitHubError('Not Found',404),source),checkError:'Not Found'};
 const loaded=JSON.parse(JSON.stringify(project));assert.ok(activeUpdateCheckIssue(loaded));assert.equal(scheduledUpdateCheck(loaded,Date.now()),false);
 loaded.branch='other';assert.equal(activeUpdateCheckIssue(loaded),undefined);assert.equal(scheduledUpdateCheck(loaded,Date.now()),true);
 const following={...source,primarySource:{...source,repo:'private-copy',repositoryId:77},...{updateCheckIssue:project.updateCheckIssue,checkError:'Not Found'}};assert.equal(activeUpdateCheckIssue(following),undefined);
});
test('legacy definitive errors migrate conservatively and issue messages redact credentials',()=>{
 assert.equal(activeUpdateCheckIssue({...source,checkError:'GitHub (404): Not Found'})?.kind,'unavailable');
 assert.equal(activeUpdateCheckIssue({...source,checkError:'Resource not accessible'})?.kind,'permission');
 assert.equal(activeUpdateCheckIssue({...source,checkError:'GitHub (403): secondary rate limit'}),undefined);
 assert.equal(activeUpdateCheckIssue({...source,checkError:'GitHub 请求超时，请重试'}),undefined);
 assert.ok(!updateCheckFailure(new GitHubError('denied custom-secret',403),source,undefined,['custom-secret'])!.message.includes('custom-secret'));
});
