import { AppError } from '../core/errors.js';
import { luaString } from '../localization/lua-table.js';
import type { StudioEditSession } from './mcp.js';

export interface Dimensions { width: number; height: number }
export interface StudioDeviceState {
  deviceId: string;
  deviceName: string;
  orientation: string;
  resolution: Dimensions | null;
  pixelDensity: number | null;
  scalingMode: string | null;
}

const deviceScript = `
local simulator = game:GetService("StudioDeviceSimulatorService")
local function isMobile(deviceId)
    if deviceId == "default" then return false end
    local form = simulator:GetDeviceInfoAsync(deviceId).DeviceForm
    return form == Enum.DeviceForm.Phone or form == Enum.DeviceForm.Tablet
end
local function readDevice()
    local deviceId = simulator:GetDeviceAsync()
    local state = {
        deviceId = deviceId,
        deviceName = "Current device",
        orientation = simulator:GetOrientationAsync().Name,
    }
    if deviceId ~= "default" then
        local resolution = simulator:GetResolutionAsync()
        state.deviceName = simulator:GetDeviceInfoAsync(deviceId).Name
        state.resolution = {width = resolution.X, height = resolution.Y}
        state.pixelDensity = simulator:GetPixelDensityAsync()
        state.scalingMode = simulator:GetScalingModeAsync().Name
    end
    return state
end
`;

export function dimensions(value: unknown): value is Dimensions {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as Partial<Dimensions>;
  return Number.isSafeInteger(width) && width! > 0 && Number.isSafeInteger(height) && height! > 0;
}

export class StudioDeviceSimulator {
  constructor(private readonly placeId: string, private readonly execute: StudioEditSession['execute']) {}

  private async request(body: string): Promise<unknown> {
    const result = await this.execute(`
if tostring(game.PlaceId) ~= ${luaString(this.placeId)} or game:GetService("RunService"):IsRunning() then
    return '{"error":"Wrong Place or not in Studio edit mode"}'
end
local ok, result = pcall(function()
${deviceScript}
${body}
end)
return game:GetService("HttpService"):JSONEncode(ok and result or {error = tostring(result)})
`, 10_000);
    if (!result || typeof result !== 'object') throw new AppError('INVALID_RESPONSE', 'Studio returned no device simulator response.');
    if ('error' in result && typeof result.error === 'string') {
      throw new AppError('INVALID_RESPONSE', `Studio Device Simulator: ${result.error.slice(0, 300)}`);
    }
    return result;
  }

  private async state(body: string): Promise<StudioDeviceState> {
    const value = await this.request(body) as Partial<StudioDeviceState>;
    if (typeof value.deviceId !== 'string' || !value.deviceId || typeof value.deviceName !== 'string'
      || typeof value.orientation !== 'string' || !value.orientation
      || (value.deviceId !== 'default' && (!dimensions(value.resolution)
        || !Number.isFinite(value.pixelDensity) || value.pixelDensity! <= 0 || typeof value.scalingMode !== 'string'))) {
      throw new AppError('INVALID_RESPONSE', 'Studio returned an incomplete device simulator state.');
    }
    return {
      deviceId: value.deviceId, deviceName: value.deviceName, orientation: value.orientation,
      resolution: value.resolution ?? null, pixelDensity: value.pixelDensity ?? null, scalingMode: value.scalingMode ?? null,
    };
  }

  read(): Promise<StudioDeviceState> {
    return this.state('return readDevice()');
  }

  async resolve(query: string): Promise<string> {
    const result = await this.request(`
local query = string.lower(${luaString(query)})
local names = {}
for _, deviceId in simulator:GetDeviceListAsync() do
    if string.lower(deviceId) == query then
        return {deviceId = deviceId}
    end
    local info = simulator:GetDeviceInfoAsync(deviceId)
    if string.lower(info.Name) == query then
        table.insert(names, deviceId)
    end
end
if #names == 1 then return {deviceId = names[1]} end
return {ambiguous = #names > 1}
`) as { deviceId?: unknown; ambiguous?: unknown };
    if (typeof result.deviceId === 'string' && result.deviceId && result.deviceId !== 'default') return result.deviceId;
    if (typeof result.ambiguous !== 'boolean') throw new AppError('INVALID_RESPONSE', 'Studio returned an invalid device preset lookup.');
    throw new AppError('ARGUMENT_ERROR', result.ambiguous ? `Ambiguous Studio device name: ${query}. Use a device ID.` : `Unknown Studio device: ${query}.`);
  }

  async select(deviceId: string): Promise<StudioDeviceState> {
    const state = await this.state(`
local deviceId = ${luaString(deviceId)}
simulator:SetDeviceAsync(deviceId)
local mobile = isMobile(deviceId)
if mobile and simulator:GetOrientationAsync() ~= Enum.ScreenOrientation.LandscapeLeft then
    simulator:SetOrientationAsync(Enum.ScreenOrientation.LandscapeLeft)
end
task.wait(0.35)
local state = readDevice()
if mobile and state.orientation ~= "LandscapeLeft" then
    error("Studio did not confirm landscape orientation")
end
return state
`);
    if (state.deviceId !== deviceId || !state.resolution) {
      throw new AppError('INVALID_RESPONSE', 'Studio did not confirm the requested device.');
    }
    return state;
  }

  async switchToCurrent(): Promise<void> {
    const state = await this.state(`
if simulator:GetDeviceAsync() ~= "default" then
    simulator:StopSimulationAsync()
    task.wait(0.25)
end
return readDevice()
`);
    if (state.deviceId !== 'default') {
      throw new AppError('INVALID_RESPONSE', 'Studio did not confirm the Current device mode.');
    }
  }
}

export function sameDeviceConfiguration(a: StudioDeviceState, b: StudioDeviceState): boolean {
  return a.deviceId === b.deviceId && a.orientation === b.orientation && a.scalingMode === b.scalingMode
    && a.pixelDensity === b.pixelDensity && a.resolution?.width === b.resolution?.width && a.resolution?.height === b.resolution?.height;
}
