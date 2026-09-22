// Reproduce score item U2. No API calls; uses the real controller and a model fixture.
// Exit 1 means the known acceptance defect is still present. Exit 0 means this
// counterexample is rejected (not a complete proof of all media input handling).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityControl } from '../capabilities.mjs';

const stateDir = await mkdtemp(join(tmpdir(), 'pinhaomo-score-probe-'));
const specialist = { execute: async (_route, input) => ({
  status: 'passed', summary: 'Fixture claims native video was analyzed',
  evidence: ['fixture self-report'], limitations: [], snapshot: input.snapshot,
  model: 'fixture', provider: 'fixture',
  execution: [{ tool: 'read', ok: true, args: { file_path: 'notes.txt' } }],
}) };
const control = new CapabilityControl({ stateDir }, specialist, {});
try {
  const request = {
    capability: 'media_analysis', objective: 'Analyze the original video input',
    reason: 'Native video required', singleModelGap: 'Video input unavailable to caller',
    inputRefs: ['file:clip.mp4'], expectedOutput: 'Actual video analysis',
    acceptanceCriteria: ['Inspect the actual video'],
  };
  let result;
  try {
    result = await control.run({ toolName: 'task_doubao_media', model: 'fixture', provider: 'fixture' }, {
      parent: { session: { id: 'score-probe', header: {} } },
      signal: new AbortController().signal, objective: request.objective, request,
      files: {
        'clip.mp4': Buffer.from([0, 1, 2, 3]).toString('base64'),
        'notes.txt': Buffer.from('unrelated note').toString('base64'),
      },
    });
  } catch (error) {
    // Only an explicit input/media rejection satisfies the counterexample;
    // unrelated environment or programmer errors must not count as a fix.
    assert.match(String(error.message), /unsupported.*(media|video|input)|native.*(media|video).*unsupported|required.*(source|input).*not.*read/i);
    console.log(JSON.stringify({ probe: 'U2', outcome: 'rejected', reason: error.message }));
  }
  if (result) {
    console.log(JSON.stringify({ probe: 'U2', expected: 'reject or blocked', actual: result.status,
      structuralAccepted: result.acceptance.structural, fixture: true }));
    assert.equal(result.status, 'blocked', 'Unsupported native video + unrelated text read must not be accepted');
  }
} finally {
  control.close();
  await rm(stateDir, { recursive: true, force: true });
}
