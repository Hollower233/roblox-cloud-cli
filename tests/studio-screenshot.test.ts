import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/core/errors.js';
import type { StudioDeviceState } from '../src/studio/device-simulator.js';
import { captureStudioDevice } from '../src/studio/screenshot.js';

const original = {
  deviceId: 'average_windows', deviceName: 'Average Windows', orientation: 'LandscapeLeft',
  resolution: { width: 1366, height: 768 }, pixelDensity: 96, scalingMode: 'FitToWindow',
} satisfies StudioDeviceState;
const phone = {
  deviceId: 'iphone_17_pro', deviceName: 'iPhone 17 Pro', orientation: 'LandscapeLeft',
  resolution: { width: 874, height: 402 }, pixelDensity: 460, scalingMode: 'FitToWindow',
} satisfies StudioDeviceState;
const phoneImage = { width: 1631, height: 750 };
const current = {
  deviceId: 'default', deviceName: 'Current device', orientation: 'LandscapeLeft',
  resolution: null, pixelDensity: null, scalingMode: null,
} satisfies StudioDeviceState;

function fakeSimulator() {
  let state: StudioDeviceState = original;
  const calls: string[] = [];
  return {
    calls,
    read: async () => state,
    resolve: async (query: string) => {
      assert.equal(query, phone.deviceId);
      return phone.deviceId;
    },
    select: async () => {
      calls.push('select');
      state = phone;
      return state;
    },
    switchToCurrent: async () => {
      calls.push('switchToCurrent');
      state = current;
    },
  };
}

test('device screenshot retries stale viewport geometry and switches from the preset to Current device', async () => {
  const simulator = fakeSimulator();
  let attempts = 0;
  const result = await captureStudioDevice(simulator, phone.deviceId, new AbortController().signal, async () =>
    ++attempts === 1 ? { width: 1500, height: 843 } : phoneImage);
  assert.deepEqual(result, { state: phone, image: phoneImage });
  assert.equal(attempts, 2);
  assert.deepEqual(simulator.calls, ['select', 'switchToCurrent']);
  assert.deepEqual(await simulator.read(), current);
});

test('device screenshot switches to Current device after a capture failure or cancellation', async () => {
  for (const cancelled of [false, true]) {
    const simulator = fakeSimulator();
    const controller = new AbortController();
    const error = new AppError('INVALID_RESPONSE', 'Windows capture failed.');
    await assert.rejects(captureStudioDevice(simulator, phone.deviceId, controller.signal, async () => {
      if (cancelled) controller.abort();
      throw error;
    }), cancelled ? { code: 'CANCELLED' } : error);
    assert.deepEqual(simulator.calls, ['select', 'switchToCurrent']);
    assert.deepEqual(await simulator.read(), current);
  }
});

test('current device screenshot leaves Studio settings alone', async () => {
  const simulator = fakeSimulator();
  const image = { width: 1500, height: 843 };
  const result = await captureStudioDevice(simulator, 'current', new AbortController().signal, async () => image);
  assert.deepEqual(result, { state: original, image });
  assert.deepEqual(simulator.calls, []);
});

test('a captured PNG is reported separately from a failed switch to Current device', async () => {
  const simulator = fakeSimulator();
  simulator.switchToCurrent = async () => { throw new AppError('TIMEOUT', 'Switch timed out.'); };
  const result = await captureStudioDevice(simulator, phone.deviceId, new AbortController().signal, async () => phoneImage);
  assert.deepEqual(result, { state: phone, image: phoneImage, restoreError: { code: 'TIMEOUT', message: 'Switch timed out.', httpStatus: undefined } });
});
