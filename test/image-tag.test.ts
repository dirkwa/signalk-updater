import { describe, it, expect } from 'vitest';
import { resolveImageTag, UPDATER_SERVER_VERSION } from '../src/config/image-tag.js';

describe('resolveImageTag', () => {
  it('expands "auto" to UPDATER_SERVER_VERSION', () => {
    expect(resolveImageTag('auto')).toBe(UPDATER_SERVER_VERSION);
  });

  it('passes any other tag through unchanged (pin override)', () => {
    expect(resolveImageTag('0.5.3')).toBe('0.5.3');
    expect(resolveImageTag('beta')).toBe('beta');
    expect(resolveImageTag('latest')).toBe('latest');
    expect(resolveImageTag('1.2.3-rc.4')).toBe('1.2.3-rc.4');
  });

  it('exports a non-empty semver-shaped constant', () => {
    // Allow optional prerelease (e.g. "1.2.3-rc.4") but anchor the end so
    // an accidental "0.6.0garbage" wouldn't pass.
    expect(UPDATER_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  });
});
