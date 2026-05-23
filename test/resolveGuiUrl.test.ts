import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveGuiUrl } from '../src/index.js';

function req(headers: Record<string, string>, secure = false): Request {
  return { headers, secure } as unknown as Request;
}

describe('resolveGuiUrl', () => {
  it('substitutes the request hostname when configured URL is the default', () => {
    const r = req({ host: '192.168.0.122:3000' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://192.168.0.122:3003');
  });

  it('keeps localhost when the request host is localhost', () => {
    const r = req({ host: 'localhost:3000' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://localhost:3003');
  });

  it('handles hostnames without a port', () => {
    const r = req({ host: 'boat.local' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://boat.local:3003');
  });

  it('handles IPv6 brackets correctly', () => {
    const r = req({ host: '[::1]:3000' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://[::1]:3003');
  });

  it('honors X-Forwarded-Host over Host', () => {
    const r = req({ host: 'internal:3000', 'x-forwarded-host': 'public.example.com' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://public.example.com:3003');
  });

  it('honors X-Forwarded-Proto for HTTPS-fronted reverse proxies', () => {
    const r = req({ host: 'public.example.com', 'x-forwarded-proto': 'https' });
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('https://public.example.com:3003');
  });

  it('uses req.secure when no X-Forwarded-Proto', () => {
    const r = req({ host: 'public.example.com' }, true);
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('https://public.example.com:3003');
  });

  it('returns the configured URL verbatim when explicitly overridden', () => {
    const r = req({ host: '192.168.0.122:3000' });
    expect(resolveGuiUrl(r, 'http://my-proxy.example.com/updater')).toBe(
      'http://my-proxy.example.com/updater',
    );
  });

  it('falls back to localhost:3003 when Host header is absent', () => {
    const r = req({});
    expect(resolveGuiUrl(r, 'http://localhost:3003')).toBe('http://localhost:3003');
  });
});
