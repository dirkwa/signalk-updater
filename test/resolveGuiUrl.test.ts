import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { resolveGuiUrl } from '../src/index.js';

function req(headers: Record<string, string>, secure = false): Request {
  return { headers, secure } as unknown as Request;
}

describe('resolveGuiUrl', () => {
  it('substitutes the request hostname onto the engine port', () => {
    const r = req({ host: '192.168.0.122:3000' });
    expect(resolveGuiUrl(r)).toBe('http://192.168.0.122:3003');
  });

  it('keeps localhost when the request host is localhost', () => {
    const r = req({ host: 'localhost:3000' });
    expect(resolveGuiUrl(r)).toBe('http://localhost:3003');
  });

  it('handles a .local hostname without a port (browser resolves it)', () => {
    const r = req({ host: 'boat.local' });
    expect(resolveGuiUrl(r)).toBe('http://boat.local:3003');
  });

  it('handles IPv6 brackets correctly', () => {
    const r = req({ host: '[::1]:3000' });
    expect(resolveGuiUrl(r)).toBe('http://[::1]:3003');
  });

  it('honors X-Forwarded-Host over Host', () => {
    const r = req({ host: 'internal:3000', 'x-forwarded-host': 'public.example.com' });
    expect(resolveGuiUrl(r)).toBe('http://public.example.com:3003');
  });

  it('honors X-Forwarded-Proto for HTTPS-fronted reverse proxies', () => {
    const r = req({ host: 'public.example.com', 'x-forwarded-proto': 'https' });
    expect(resolveGuiUrl(r)).toBe('https://public.example.com:3003');
  });

  it('uses req.secure when no X-Forwarded-Proto', () => {
    const r = req({ host: 'public.example.com' }, true);
    expect(resolveGuiUrl(r)).toBe('https://public.example.com:3003');
  });

  it('falls back to localhost:3003 when Host header is absent', () => {
    const r = req({});
    expect(resolveGuiUrl(r)).toBe('http://localhost:3003');
  });
});
