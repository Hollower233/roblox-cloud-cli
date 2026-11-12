import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeVersionNotes, saveNotesScriptPath, saveWithNotes, type SaveNotesSystem, type SaveNotesUiArgs, type SaveNotesUiResult } from '../src/index.js';
import { AppError } from '../src/core/errors.js';

const session = { pid: 42, placeId: '101', universeId: '7', title: 'Example Development - Roblox Studio' };

function fakeSystem(result: Partial<SaveNotesUiResult>) {
  const calls: SaveNotesUiArgs[] = [];
  const system: SaveNotesSystem = {
    runUi: async args => { calls.push(args); return { ok: true, stage: 'done', clicked: true, elapsedMs: 1234, menuPath: 'UIA', titleOcr: args.title, ...result }; },
    now: () => Date.parse('2026-01-05T00:00:00Z'),
  };
  return { system, calls };
}
async function tempDir() { return mkdtemp(join(tmpdir(), 'rbx-save-notes-')); }

test('notes are trimmed, details accept real or escaped line breaks, bad input is refused before any UI work', () => {
  assert.deepEqual(normalizeVersionNotes('  v1.2.3 修复  ', 'line one\\nline two\r\nline three '), { title: 'v1.2.3 修复', details: 'line one\nline two\nline three' });
  assert.deepEqual(normalizeVersionNotes('v1'), { title: 'v1', details: '' });
  assert.throws(() => normalizeVersionNotes('  '), (e: AppError) => e.code === 'ARGUMENT_ERROR' && /--title/.test(e.message));
  assert.throws(() => normalizeVersionNotes('a\nb'), (e: AppError) => /single line/.test(e.message));
  assert.throws(() => normalizeVersionNotes('a\tb'), (e: AppError) => /control characters/.test(e.message));
  assert.throws(() => normalizeVersionNotes('ok', 'x\u001by'), (e: AppError) => /control characters/.test(e.message));
});
test('UI success is the result: notes go to the UI and the local ledger is appended', async () => {
  const dir = await tempDir();
  try {
    const { system, calls } = fakeSystem({});
    const { result, warnings } = await saveWithNotes(system, session, { title: ' v1.2.3 ', details: '第一行\n第二行' }, { ledgerDirectory: dir });
    assert.deepEqual(calls, [{ pid: 42, title: 'v1.2.3', details: '第一行\n第二行', dryRun: false }]);
    assert.equal(result.saved, true); assert.deepEqual(warnings, []);
    assert.equal(result.ledger, join(dir, '101.jsonl'));
    const rows = (await readFile(result.ledger!, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(rows, [{ schemaVersion: 1, savedAt: '2026-01-05T00:00:00.000Z', placeId: '101', universeId: '7', title: 'v1.2.3', details: '第一行\n第二行' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('dry run writes no ledger and reports nothing saved', async () => {
  const dir = await tempDir();
  try {
    const { system, calls } = fakeSystem({ stage: 'dry-run', clicked: false });
    const { result } = await saveWithNotes(system, session, { title: 'v1', details: '' }, { dryRun: true, ledgerDirectory: dir });
    assert.equal(calls[0]!.dryRun, true); assert.equal(result.saved, false); assert.equal(result.ledger, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('UI failures are errors: before the click nothing was saved, after it the state is unknown', async () => {
  await assert.rejects(saveWithNotes(fakeSystem({ ok: false, stage: 'open-dialog', clicked: false, message: 'File > Save to Roblox with Notes is disabled' }).system, session, { title: 'v1', details: '' }),
    (e: AppError) => e.code === 'STUDIO_UI_ERROR' && /open-dialog before saving/.test(e.message) && /disabled/.test(e.message));
  await assert.rejects(saveWithNotes(fakeSystem({ ok: false, stage: 'save', clicked: true, message: 'Dialog is still open after Save.' }).system, session, { title: 'v1', details: '' }),
    (e: AppError) => e.code === 'STUDIO_UI_ERROR' && /clicked/.test(e.message) && /version history/.test(e.message));
});
test('the UI scripts are bundled next to the module and ASCII-only', async () => {
  const path = saveNotesScriptPath();
  for (const file of [path, join(path, '..', 'studio-ui.ps1')]) {
    const text = await readFile(file, 'utf8');
    assert.ok(/^[\x00-\x7f]*$/.test(text), file);
  }
  assert.match(await readFile(path, 'utf8'), /@@RESULT/);
});
