import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldUseArchive} from '../src/utils/transferPlan';
test('download plans favor large initial archives and preserve small incremental downloads',()=>{
 const mib=1024*1024;const huge={size:400*mib},small=Array.from({length:32},()=>({size:100}));
 assert.equal(shouldUseArchive([huge,...small],small),false);
 assert.equal(shouldUseArchive([huge,...small],[huge]),true);
 assert.equal(shouldUseArchive(small,small),true);
 assert.equal(shouldUseArchive(small,small.slice(0,13)),true);
 assert.equal(shouldUseArchive(small,[]),false);
 assert.equal(shouldUseArchive([{size:0}],[{size:0}]),false);
});
