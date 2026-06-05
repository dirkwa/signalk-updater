import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import express from 'express';
import { createConsoleProxy, injectApiBaseMeta, joinUpstreamPath } from '../src/proxy.js';

describe('joinUpstreamPath', () => {
  it('forwards the client path verbatim when the upstream is at root', () => {
    expect(joinUpstreamPath('/', '/api/health')).toBe('/api/health');
  });

  it('prepends a non-root upstream base path', () => {
    expect(joinUpstreamPath('/updater/', '/api/health')).toBe('/updater/api/health');
  });

  it('handles upstream base without trailing slash', () => {
    expect(joinUpstreamPath('/updater', '/api/health')).toBe('/updater/api/health');
  });

  it('treats empty client path as root', () => {
    expect(joinUpstreamPath('/updater/', '')).toBe('/updater/');
  });

  it('preserves query strings on the client path', () => {
    expect(joinUpstreamPath('/updater', '/api/logs?tail=100')).toBe('/updater/api/logs?tail=100');
  });

  it('falls back to root when basePath is empty', () => {
    expect(joinUpstreamPath('', '/api/health')).toBe('/api/health');
  });
});

describe('injectApiBaseMeta', () => {
  it('inserts the meta tag right after <head>', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body/></html>';
    const out = injectApiBaseMeta(html, '/plugins/signalk-updater/console');
    expect(out).toContain('<meta name="api-base" content="/plugins/signalk-updater/console">');
    expect(out.indexOf('<meta name="api-base"')).toBeLessThan(out.indexOf('<title>'));
  });

  it('replaces an existing api-base meta tag (idempotent)', () => {
    const html = '<head><meta name="api-base" content="/old"><title>x</title></head>';
    const out = injectApiBaseMeta(html, '/new');
    expect(out).toContain('<meta name="api-base" content="/new">');
    expect(out).not.toContain('content="/old"');
    // Only one tag present.
    expect(out.match(/api-base/g)?.length).toBe(1);
  });

  it('escapes attribute-dangerous characters in the prefix', () => {
    const html = '<head></head>';
    const out = injectApiBaseMeta(html, '/a"b<c>&d');
    expect(out).toContain('content="/a&quot;b&lt;c&gt;&amp;d"');
  });

  it('passes through HTML with no <head> unmodified', () => {
    const html = '<html><body>no head</body></html>';
    expect(injectApiBaseMeta(html, '/x')).toBe(html);
  });

  it('handles <head> with attributes', () => {
    const html = '<head lang="en" data-foo="bar"><title>x</title></head>';
    const out = injectApiBaseMeta(html, '/p');
    expect(out).toContain('<head lang="en" data-foo="bar">');
    expect(out).toContain('<meta name="api-base" content="/p">');
  });
});

describe('createConsoleProxy', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let upstreamRequests: { method: string; url: string; headers: http.IncomingHttpHeaders }[];

  beforeAll(async () => {
    upstreamRequests = [];
    upstream = http.createServer((req, res) => {
      upstreamRequests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: { ...req.headers },
      });
      if (req.url === '/' || req.url === '/index.html') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html><head><title>engine</title></head><body/></html>');
        return;
      }
      if (req.url === '/api/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, version: '1.2.3' }));
        return;
      }
      if (req.url === '/stream') {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.write('data: hello\n\n');
        // Don't end — caller will abort.
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    upstream.listen(0);
    await once(upstream, 'listening');
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    upstream.close();
    await once(upstream, 'close');
  });

  async function makeApp(): Promise<{
    app: express.Express;
    close: () => Promise<void>;
    baseUrl: string;
  }> {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    return {
      app,
      baseUrl: `http://127.0.0.1:${addr.port}`,
      close: async () => {
        server.close();
        await once(server, 'close');
      },
    };
  }

  it('proxies a JSON GET unchanged', async () => {
    const { baseUrl, close } = await makeApp();
    try {
      const res = await fetch(`${baseUrl}/console/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, version: '1.2.3' });
    } finally {
      await close();
    }
  });

  it('injects the api-base meta tag into HTML responses', async () => {
    const { baseUrl, close } = await makeApp();
    try {
      const res = await fetch(`${baseUrl}/console/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="api-base" content="/plugins/signalk-updater/console">');
    } finally {
      await close();
    }
  });

  it('preserves upstream base path when the target URL has a non-root pathname', async () => {
    // The default upstream test server in beforeAll() answers at /api/health.
    // Configure the proxy with a base path that shifts the answer endpoint
    // to /updater/api/health and have the upstream answer there, proving
    // the proxy joins paths correctly instead of dropping the base.
    const baseUpstream = http.createServer((req, res) => {
      upstreamRequests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: { ...req.headers },
      });
      if (req.url === '/updater/api/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, basePath: '/updater' }));
        return;
      }
      res.statusCode = 404;
      res.end(`not found at ${req.url}`);
    });
    baseUpstream.listen(0);
    await once(baseUpstream, 'listening');
    const baseAddr = baseUpstream.address() as AddressInfo;
    const baseUpstreamUrl = `http://127.0.0.1:${baseAddr.port}/updater/`;

    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => baseUpstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/console/api/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, basePath: '/updater' });
    } finally {
      server.close();
      await once(server, 'close');
      baseUpstream.close();
      await once(baseUpstream, 'close');
    }
  });

  it('adds no-transform to Cache-Control on SSE responses (defeats signalk-server compression buffering)', async () => {
    // signalk-server's compression middleware compresses text/event-stream
    // by default (compressible('text/event-stream') === true) which buffers
    // SSE for minutes. The documented opt-out is Cache-Control: no-transform.
    const sseUpstream = http.createServer((req, res) => {
      if (req.url === '/stream') {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.write('data: hello\n\n');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    sseUpstream.listen(0);
    await once(sseUpstream, 'listening');
    const sseAddr = sseUpstream.address() as AddressInfo;
    const sseUpstreamUrl = `http://127.0.0.1:${sseAddr.port}`;

    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => sseUpstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/console/stream`);
      expect(res.status).toBe(200);
      const cacheControl = res.headers.get('cache-control') ?? '';
      expect(cacheControl).toMatch(/no-transform/i);
      expect(cacheControl).toMatch(/no-cache/i);
      expect(await res.text()).toContain('data: hello');
    } finally {
      server.close();
      await once(server, 'close');
      sseUpstream.close();
      await once(sseUpstream, 'close');
    }
  });

  it('does not modify Cache-Control on non-SSE responses', async () => {
    const { baseUrl, close } = await makeApp();
    try {
      const res = await fetch(`${baseUrl}/console/api/health`);
      // The default upstream test server doesn't set Cache-Control on
      // /api/health, so our header should be absent (not "no-transform").
      const cacheControl = res.headers.get('cache-control') ?? '';
      expect(cacheControl).not.toMatch(/no-transform/i);
    } finally {
      await close();
    }
  });

  it('strips Accept-Encoding so the upstream sends uncompressed', async () => {
    const { baseUrl, close } = await makeApp();
    try {
      await fetch(`${baseUrl}/console/api/health`, {
        headers: { 'Accept-Encoding': 'gzip' },
      });
      const last = upstreamRequests[upstreamRequests.length - 1];
      expect(last?.headers['accept-encoding']).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('injects the engine bearer when the client sends none', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
      getInjectToken: () => 'engine-token-abc',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${addr.port}/console/api/health`);
      const last = upstreamRequests[upstreamRequests.length - 1];
      expect(last?.headers['authorization']).toBe('Bearer engine-token-abc');
      expect(last?.headers['x-sk-auth']).toBe('engine-token-abc');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('does not clobber a client-supplied bearer', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
      getInjectToken: () => 'engine-token-abc',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${addr.port}/console/api/health`, {
        headers: { Authorization: 'Bearer client-own-token' },
      });
      const last = upstreamRequests[upstreamRequests.length - 1];
      expect(last?.headers['authorization']).toBe('Bearer client-own-token');
      // X-SK-Auth is only set as part of injection; an un-injected request
      // keeps whatever the client sent (here, nothing).
      expect(last?.headers['x-sk-auth']).toBeUndefined();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('does not clobber a client-supplied X-SK-Auth (no bearer)', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
      getInjectToken: () => 'engine-token-abc',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${addr.port}/console/api/health`, {
        headers: { 'X-SK-Auth': 'client-sk-token' },
      });
      const last = upstreamRequests[upstreamRequests.length - 1];
      // The engine authenticates on X-SK-Auth alone, so a client using only
      // that header must survive — injection must not overwrite it (nor add a
      // conflicting Authorization).
      expect(last?.headers['x-sk-auth']).toBe('client-sk-token');
      expect(last?.headers['authorization']).toBeUndefined();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('forwards unchanged when no token is available (fail-open)', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
      getInjectToken: () => null,
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/console/api/health`);
      expect(res.status).toBe(200);
      const last = upstreamRequests[upstreamRequests.length - 1];
      expect(last?.headers['authorization']).toBeUndefined();
      expect(last?.headers['x-sk-auth']).toBeUndefined();
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('returns 502 with a helpful message when the upstream is unreachable', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      // Port 1 is virtually always closed and rejects fast.
      getTargetUrl: () => 'http://127.0.0.1:1',
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/console/api/health`);
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(text).toContain('not reachable');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
