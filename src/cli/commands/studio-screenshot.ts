import type { Command } from 'commander';
import { id } from '../../core/errors.js';
import { screenshotStudio } from '../../studio/screenshot.js';
import { clean, emit } from '../output.js';

export function registerStudioScreenshot(studio: Command, signal: AbortSignal, json: () => boolean): void {
  studio.command('screenshot')
    .description('Save the Studio game viewport as PNG in the background (Windows)')
    .requiredOption('--place <id>', 'Open Edit Place ID', id)
    .requiredOption('--out <path>', 'Path for a new PNG file')
    .option('--device <name-or-id>', 'Simulator preset name or ID, or current to keep the current viewport', 'i17p')
    .action(async (options: { place: string; out: string; device: string }) => {
      const result = await screenshotStudio({
        placeId: options.place, output: options.out, device: options.device, signal,
      });
      const { width, height } = result.image;
      emit(result, json(), `${clean(result.deviceName)} (${clean(result.orientation)})\t${width}×${height}\t${clean(result.path)}`,
        result.restoreError ? [{
          code: 'STUDIO_DEVICE_RESTORE_UNVERIFIED',
          message: `The screenshot was saved. Could not confirm Current device mode: ${result.restoreError.message}`,
          resource: result.placeId,
        }] : []);
    });
}
