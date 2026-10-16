import {test} from 'node:test';import assert from 'node:assert/strict';
import {bindingLabel,switchedHistory} from '../src/utils/projectBinding';
const project={owner:'source',repo:'project',url:'https://github.com/source/project',branch:'main',latestCommitSha:'s1',uploadTarget:{id:77,owner:'me',repo:'project',branch:'main',private:true,purgeAfterUpload:false},remoteSnapshot:{repoId:77,owner:'me',repo:'project',branch:'main',sourceSha:'s1',commitSha:'t1',htmlUrl:''}};
test('labels use verified repository type, branch and receipt and preserve partial-cloud information',()=>{
 assert.equal(bindingLabel(project),'私人仓库已同步');assert.equal(bindingLabel({...project,uploadTarget:{...project.uploadTarget,private:false}}),'已关联仓库 · 已同步');assert.equal(bindingLabel({...project,forkScope:'full'}),'已分叉 · 已同步');assert.equal(bindingLabel({...project,remoteSnapshot:undefined}),'已绑定 · 待更新／待上传');assert.equal(bindingLabel({...project,cloudPending:[{}]}),'私人仓库已同步 · 账号记录待完成');assert.equal(bindingLabel({...project,pendingSwitch:{}}),'另存切换待完成');
 assert.equal(bindingLabel({...project,remoteSnapshot:{...project.remoteSnapshot,branch:'other'}}),'已绑定 · 待更新／待上传');
});
test('old-target history includes mappings and immutable identity without upload tokens',()=>{
 const history=switchedHistory({...project,branchTargets:{main:{...project.uploadTarget,token:'secret'},other:{...project.uploadTarget,branch:'other'}}},'now');assert.equal(history[0].target.id,77);assert.equal(history[0].bindings.other.branch,'other');assert.ok(!JSON.stringify(history).includes('secret'));
});
