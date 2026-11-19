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
  Buffer.from('803daa3e8f0a0074', 'hex').copy(data, helperOff);
  data[helperOff + 8] = 0xc3;
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
  return { data, helperOff };
}

test('the Internal helper is found from the [Internal] title load and rewritten in place', () => {
  const { data, helperOff } = peWithInternalHelper();
  const plan = planInternalPatch(data);
  assert.equal(plan.fileOffset, helperOff);
  assert.equal(plan.originalBytes, '803daa3e8f0a0074');
  const patched = applyInternalPatch(data, plan);
  assert.equal(patched.subarray(helperOff, helperOff + 8).toString('hex'), 'b0019090909090c3');
  assert.notEqual(patched, data);
});

test('a missing Internal marker is a hard patch failure', () => {
  const { data } = peWithInternalHelper();
  data.fill(0, 0x600, 0x610);
  assert.throws(() => planInternalPatch(data), (e: AppError) => e.code === 'STUDIO_PATCH_FAILED');
});

test('inspect reports the helper bytes when the prologue no longer matches', () => {
  const { data, helperOff } = peWithInternalHelper();
  data[helperOff + 7] = 0x0f;
  const inspection = inspectInternalPatch(data);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.helperOffset, helperOff);
  assert.equal(inspection.helperBytes, '803daa3e8f0a000f');
  assert.equal(inspection.helperLooksKnown, false);
  assert.equal(inspection.leaOffset !== undefined, true);
});
