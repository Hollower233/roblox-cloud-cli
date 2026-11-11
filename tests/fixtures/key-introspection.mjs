// Fictional responses only. Every unexpected request fails; this fixture cannot call Roblox.
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://apis.roblox.com/api-keys/v1/introspect' || init?.method !== 'POST'
    || JSON.parse(init.body).apiKey !== 'fictional-permission-key') throw new Error('Unexpected fixture request');
  const mode = process.env.RBX_TEST_KEY_STATE;
  if (mode === 'denied') return new Response(null, { status: 403 });
  return Response.json({ authorizedUserId: 100, enabled: mode !== 'disabled', expired: mode === 'expired',
    scopes: [{ name: 'developer-product', operations: mode === 'missing' ? ['read'] : ['read', 'write'], universeIds: ['123'] }] });
};
