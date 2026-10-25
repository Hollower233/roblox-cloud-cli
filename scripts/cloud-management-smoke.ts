import assert from 'node:assert/strict';
import { CredentialStore } from '../src/auth/credentials.js';
import { defaultHome } from '../src/storage/store.js';
import { HttpClient } from '../src/transport/http-client.js';
import { ConfigRepository } from '../src/configs/repository.js';
import { Experiments } from '../src/experiments/experiments.js';

// Explicit opt-in. Only GET requests; no real responses are saved in the repo.
const universeId = process.env.RBX_LIVE_CLOUD_UNIVERSE;
if (!universeId) throw new Error('Set RBX_LIVE_CLOUD_UNIVERSE explicitly before running this read-only live test.');
const http = new HttpClient({ apiKey: await new CredentialStore(defaultHome()).get() });
const configs = new ConfigRepository(http), experiments = new Experiments(http);
const published = await configs.read(universeId);
await configs.draft(universeId);
await configs.history(universeId, { limit: 1 });
assert.ok(published && typeof published === 'object');
const page = await experiments.list(universeId, { limit: 1 });
assert.ok(Array.isArray(page.experiments));
const experimentId = process.env.RBX_LIVE_CLOUD_EXPERIMENT;
if (experimentId) await experiments.get(universeId, experimentId);
console.log(JSON.stringify({ success: true, configs: true, experiments: true, readOnly: true }));
