/**
 * Control run for the egress recorder used by TBI-005.
 *
 * TBI-005 concludes "no outbound telemetry was observed". That conclusion is only worth anything if
 * the instrument demonstrably sees traffic when traffic exists, so these checks exercise each layer
 * against a local server and an unresolvable host before the real measurement is trusted.
 */
import http from 'http';
import https from 'https';
import net from 'net';
import { withEgressRecorder } from './support/egress-recorder';

jest.setTimeout(60_000);

describe('egress recorder control run', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('observes fetch, http and https', async () => {
    const { calls, external } = await withEgressRecorder(async () => {
      await fetch(`http://127.0.0.1:${port}/telemetry-probe`).then((r) => r.text());

      await new Promise<void>((resolve) => {
        http.get(`http://127.0.0.1:${port}/http-probe`, (res) => { res.resume(); res.on('end', () => resolve()); });
      });

      // The *attempt* must be recorded even though DNS fails.
      await new Promise<void>((resolve) => {
        const req = https.get('https://telemetry.invalid-host-for-spike.example/collect', () => resolve());
        req.on('error', () => resolve());
      });
    });

    const layers = [...new Set(calls.map((c) => c.layer))].sort();
    console.log('  layers observed:', layers.join(', '));
    console.log('  total:', calls.length, '| external:', external.length);
    console.log('  external:', JSON.stringify(external.map((c) => `${c.layer} ${c.host}`)));

    expect(layers).toEqual(expect.arrayContaining(['undici', 'http', 'https']));
    // One outbound attempt surfaces at more than one layer, so assert on the distinct destinations
    // rather than the record count. Loopback probes must not appear here at all.
    expect([...new Set(external.map((c) => c.host))]).toEqual(['telemetry.invalid-host-for-spike.example']);
  });

  it('observes raw tcp connects', async () => {
    const { calls } = await withEgressRecorder(async () => {
      await new Promise<void>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => { s.end(); resolve(); });
        s.on('error', () => resolve());
      });
    });
    expect(calls.some((c) => c.layer === 'tcp')).toBe(true);
  });

  it('records nothing when the process makes no outbound call', async () => {
    const { external } = await withEgressRecorder(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(external).toHaveLength(0);
  });

  it('restores every patched global even when the body throws', async () => {
    const before = { hr: http.request, hg: http.get, sr: https.request, nc: net.Socket.prototype.connect };
    await expect(
      withEgressRecorder(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');
    expect(http.request).toBe(before.hr);
    expect(http.get).toBe(before.hg);
    expect(https.request).toBe(before.sr);
    expect(net.Socket.prototype.connect).toBe(before.nc);
  });
});
