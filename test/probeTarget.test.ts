import { describe, it, expect } from 'vitest';
import { ENGINE_LOCAL_URL } from '../src/index.js';

// The server-side health probe, version fetch, and console proxy all run inside
// the signalk-server container, which shares the host network namespace
// (Network=host) with the engine published on host loopback. They must target
// 127.0.0.1 — never a user-supplied hostname, which the slim engine image can't
// resolve for .local/mDNS names. This pins that contract so it can't silently
// regress to `localhost` (IPv6 ::1-first risk) or a config-derived value.
describe('ENGINE_LOCAL_URL', () => {
  it('is the IPv4 loopback engine URL', () => {
    expect(ENGINE_LOCAL_URL).toBe('http://127.0.0.1:3003');
  });
});
