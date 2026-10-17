import assert from 'node:assert/strict';
import { CredentialStore } from '../src/auth/credentials.js';
import { defaultHome } from '../src/storage/store.js';
import { HttpClient } from '../src/transport/http-client.js';
import { GameInfoLocalization } from '../src/localization/game-info.js';

// Explicitly opt-in, read-only. Never saves account responses as repository fixtures.
const universeId = process.env.RBX_LIVE_LOCALIZATION_UNIVERSE;
if (!universeId) throw new Error('Set RBX_LIVE_LOCALIZATION_UNIVERSE explicitly before running this live test.');
const key = await new CredentialStore(defaultHome()).get();
const localization = new GameInfoLocalization(new HttpClient({ apiKey: key }));
const snapshot = await localization.read(universeId);
assert.ok(snapshot.languages.length > 0);
assert.ok(snapshot.languages.every(language => language.locales.length > 0));
const preview = await localization.write(universeId, { [snapshot.source.languageCode]: { title: snapshot.source.title } }, { dryRun: true });
assert.equal(preview.results[0]!.status, 'planned');
console.log(JSON.stringify({ success: true, languageFamilies: snapshot.languages.length, locales: snapshot.languages.reduce((sum, language) => sum + language.locales.length, 0), dryRun: true }));
