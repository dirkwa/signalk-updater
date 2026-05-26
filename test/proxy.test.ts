import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import express from 'express';
import { createConsoleProxy, injectApiBaseMeta } from '../src/proxy.js';

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

  function makeApp(): { app: express.Express; close: () => Promise<void>; baseUrl: string } {
    const app = express();
    const proxy = createConsoleProxy({
      getTargetUrl: () => upstreamUrl,
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
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
    const { baseUrl, close } = makeApp();
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
    const { baseUrl, close } = makeApp();
    try {
      const res = await fetch(`${baseUrl}/console/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<meta name="api-base" content="/plugins/signalk-updater/console">');
    } finally {
      await close();
    }
  });

  it('strips Accept-Encoding so the upstream sends uncompressed', async () => {
    const { baseUrl, close } = makeApp();
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

  it('returns 502 with a helpful message when the upstream is unreachable', async () => {
    const app = express();
    const proxy = createConsoleProxy({
      // Port 1 is virtually always closed and rejects fast.
      getTargetUrl: () => 'http://127.0.0.1:1',
      publicPathPrefix: '/plugins/signalk-updater/console',
    });
    app.use('/console', proxy);
    const server = app.listen(0);
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
