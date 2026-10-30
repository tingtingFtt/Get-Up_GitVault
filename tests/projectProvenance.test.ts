import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMetadataSource, sourceMarker } from '../src/utils/projectProvenance';

test('metadata reads only the legacy final source, never links in descriptions or remarks', () => {
  assert.deepEqual(readMetadataSource('# copy\n\nhttps://github.com/original/project\n\nhttps://github.com/modified/project.git\n'), {owner:'modified',repo:'project'});
  assert.equal(readMetadataSource('# copy\nhttps://github.com/original/project\nnot a source'), undefined);
  assert.equal(readMetadataSource('https://other.example/original/project'), undefined);
});
test('explicit source markers win over prose, and ambiguous or malformed markers fail closed', () => {
  const marker=sourceMarker('https://github.com/modified/project');
  assert.deepEqual(readMetadataSource(`# copy\nhttps://github.com/original/project\n${marker}\nhttps://github.com/other/project`), {owner:'modified',repo:'project'});
  for(const bad of [marker+'\n'+marker,'<!-- gitvault-source:v1 {} -->','<!-- gitvault-source:v1 null -->','<!-- gitvault-source:v1 invalid -->']) assert.equal(readMetadataSource('https://github.com/original/project\n'+bad),undefined);
});
