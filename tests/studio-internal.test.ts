import assert from 'node:assert/strict';
import test from 'node:test';
import { applyInternalPatch, inspectInternalPatch, planInternalPatch } from '../src/studio/internal.js';
import { AppError } from '../src/core/errors.js';

function peWithInternalHelper() {
  const imageBase = 0x140000000n;
  const textRva = 0x1000, rdataRva = 0x2000, textRaw = 0x400, rdataRaw = 0x600;
  const data = Buffer.alloc(0x800, 0xcc);
  data.write('MZ', 0);
  data.writeUInt32LE(0x80, 0x3c);
  data.write('PE\0\0', 0x80);
  data.writeUInt16LE(0x8664, 0x84);
  data.writeUInt16LE(2, 0x86);
  data.writeUInt16LE(0xf0, 0x80 + 20);
  data.writeUInt16LE(0x20b, 0x80 + 24);
  data.writeBigUInt64LE(imageBase, 0x80 + 24 + 24);
  const sec = 0x80 + 24 + 0xf0;
  data.write('.text\0\0\0', sec);
  data.writeUInt32LE(0x200, sec + 8);
  data.writeUInt32LE(textRva, sec + 12);
  data.writeUInt32LE(0x200, sec + 16);
  data.writeUInt32LE(textRaw, sec + 20);
  data.write('.rdata\0\0', sec + 40);
  data.writeUInt32LE(0x40, sec + 48);
  data.writeUInt32LE(rdataRva, sec + 52);
  data.writeUInt32LE(0x40, sec + 56);
  data.writeUInt32LE(rdataRaw, sec + 60);
  const marker = '[Internal]\0';
  data.write(marker, rdataRaw);
  const helperOff = textRaw;
  const flag1Va = imageBase + BigInt(rdataRva + 0x20), flag2Va = imageBase + BigInt(rdataRva + 0x21);
  const cmp = (off: number, target: bigint) => {
    const va = imageBase + BigInt(textRva + (off - textRaw));
    data[off] = 0x80; data[off + 1] = 0x3d;
    data.writeInt32LE(Number(target - (va + 7n)), off + 2);
    data[off + 6] = 0;
  };
  cmp(helperOff, flag1Va); data[helperOff + 7] = 0x74; data[helperOff + 8] = 0x0c;
  cmp(helperOff + 9, flag2Va); data[helperOff + 16] = 0x74; data[helperOff + 17] = 0x03;
  Buffer.from('b001c330c0c3', 'hex').copy(data, helperOff + 18);
  const guardOff = helperOff + 0x100;
  Buffer.from('4883ec48', 'hex').copy(data, guardOff);
  cmp(guardOff + 4, flag1Va); data[guardOff + 11] = 0x74; data[guardOff + 12] = 0x0d;
  cmp(guardOff + 13, flag2Va); data[guardOff + 20] = 0x74; data[guardOff + 21] = 0x04;
  Buffer.from('4883c448c3', 'hex').copy(data, guardOff + 22);
  const callOff = textRaw + 0x20;
  const helperVa = imageBase + BigInt(textRva + (helperOff - textRaw));
  const callVa = imageBase + BigInt(textRva + (callOff - textRaw));
  data[callOff] = 0xe8;
  data.writeInt32LE(Number(helperVa - (callVa + 5n)), callOff + 1);
  const leaOff = callOff + 5;
  const leaVa = imageBase + BigInt(textRva + (leaOff - textRaw));
  const markerVa = imageBase + BigInt(rdataRva + (rdataRaw - rdataRaw));
  data[leaOff] = 0x48; data[leaOff + 1] = 0x8d; data[leaOff + 2] = 0x15;
  data.writeInt32LE(Number(markerVa - (leaVa + 7n)), leaOff + 3);
  return { data, helperOff, guardOff };
}

test('the Internal helper and its retail guard are found and rewritten in place', () => {
  const { data, helperOff, guardOff } = peWithInternalHelper();
  const plan = planInternalPatch(data);
  assert.equal(plan.fileOffset, helperOff);
  assert.equal(plan.guardFileOffset, guardOff);
  assert.equal(plan.guardOriginalBytes, '4883ec48');
  const patched = applyInternalPatch(data, plan);
  assert.equal(patched.subarray(helperOff, helperOff + 8).toString('hex'), 'b0019090909090c3');
  assert.equal(patched.subarray(guardOff, guardOff + 4).toString('hex'), 'c3909090');
  assert.notEqual(patched, data);
});

test('a missing Internal marker is a hard patch failure', () => {
  const { data } = peWithInternalHelper();
  data.fill(0, 0x600, 0x610);
  assert.throws(() => planInternalPatch(data), (e: AppError) => e.code === 'STUDIO_PATCH_FAILED');
});

test('inspect reports the helper bytes when the prologue no longer matches', () => {
  const { data, helperOff } = peWithInternalHelper();
  const expected = Buffer.from(data.subarray(helperOff, helperOff + 8));
  expected[7] = 0x0f;
  data[helperOff + 7] = 0x0f;
  const inspection = inspectInternalPatch(data);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.helperOffset, helperOff);
  assert.equal(inspection.helperBytes, expected.toString('hex'));
  assert.equal(inspection.helperLooksKnown, false);
  assert.equal(inspection.leaOffset !== undefined, true);
});

test('a missing retail guard is a hard patch failure', () => {
  const { data, guardOff } = peWithInternalHelper();
  data[guardOff + 26] = 0x90;
  const inspection = inspectInternalPatch(data);
  assert.equal(inspection.ok, false);
  assert.match(inspection.reason ?? '', /retail-build guard/);
});
