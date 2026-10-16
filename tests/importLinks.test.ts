import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportLinks } from '../src/utils/importLinks';

test('one-line records normalize links and separate invalid and duplicate repositories', () => {
  const links = parseImportLinks('备注一  https://github.com/demo/one/tree/feature/demo\nDEMO/one.git\ndemo/two\nhttps://example.com/demo/three\ninvalid');
  assert.deepEqual(links.map(link => link.status), ['pending', 'skipped', 'pending', 'error', 'error']);
  assert.equal(links[0].url, 'https://github.com/demo/one');
  assert.equal(links[0].remark, '备注一');
  assert.equal(links[2].url, 'https://github.com/demo/two');
  assert.equal(links[2].remark, '');
  assert.deepEqual(parseImportLinks(' \n \r\n '), []);
});

test('remarks can contain spaces, punctuation, numbers and slash text without becoming additional imports', () => {
  const links = parseImportLinks('111  https://github.com/demo/one.git\r\n生产环境 A/B, 模块 1  demo/two\nhttps://github.com/demo/three');
  assert.deepEqual(links.map(link => link.remark), ['111', '生产环境 A/B, 模块 1', '']);
  assert.ok(links.every(link => link.status === 'pending'));
});

test('multiple full links or comma-separated repositories in one line are rejected instead of silently dropping content', () => {
  const links = parseImportLinks('https://github.com/demo/one https://github.com/demo/two\ndemo/one,demo/two');
  assert.deepEqual(links.map(link => link.status), ['error', 'error']);
});
