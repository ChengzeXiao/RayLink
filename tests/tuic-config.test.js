import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProtocolInbounds, buildProtocolClientConfig, defaultProtocolConfigs } from '../server/singbox/protocol-catalog.js';
import { buildProtocolProbeConfig } from '../server/singbox/protocol-probe.js';
import { buildSubscriptionArtifact } from '../server/subscriptions/formats.js';
import { buildProtocolProbeConfig as buildNodeProtocolProbeConfig } from '../web/node/raylink-node.mjs';

for (const mode of ['certificate', 'acme']) {
  test(`managed TUIC ${mode} TLS negotiates the same ALPN in subscriptions and external probes`, () => {
    const profile = { ...defaultProtocolConfigs().find(item => item.type === 'tuic'), enabled: true,
      tls: { mode, serverName: 'node.example.com', certificatePath: '/fixture/cert.pem', keyPath: '/fixture/key.pem', acmeEmail: 'admin@example.com' } };
    const credential = { email: 'tuic@example.com', runtimeUuid: '11111111-1111-4111-8111-111111111111', runtimePassword: 'test-only-tuic-password' };
    const inbounds = buildProtocolInbounds({ profiles: [profile], users: [credential], masterPassword: 'test-only-probe-seed' });
    assert.deepEqual(inbounds[0].tls.alpn, ['h3'], 'Mihomo requires the server to select an ALPN protocol');
    const client = buildProtocolClientConfig({ profiles: [profile], credential, server: 'node.example.com' });
    assert.deepEqual(client.outbounds.find(item => item.type === 'tuic').tls.alpn, ['h3']);
    const probe = buildProtocolProbeConfig({ type: 'tuic', address: 'node.example.com', port: profile.port, serverConfig: { inbounds } });
    assert.deepEqual(probe.outbounds[0].tls.alpn, ['h3']);
    const nodeProbe = buildNodeProtocolProbeConfig({ activation: { type: 'tuic', address: 'node.example.com', port: profile.port }, configText: JSON.stringify({ inbounds }) });
    assert.deepEqual(nodeProbe, probe, 'remote Node probes must negotiate the same TLS ALPN as the control plane');
    for (const format of ['mihomo', 'egern', 'egern-profile']) {
      assert.match(buildSubscriptionArtifact({ format, singBoxConfig: client }).body, /alpn:\n\s+- "h3"/);
    }
  });
}
