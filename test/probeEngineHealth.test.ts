import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { probeEngineHealth } from '../src/index.js';

const URL = 'http://127.0.0.1:3003/api/health';

function res(ok: boolean): Response {
  return { ok, status: ok ? 200 : 503 } as Response;
}

describe('probeEngineHealth', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('reports reachable (no slowMs) on a fast 200', async () => {
    fetchSpy.mockResolvedValueOnce(res(true));
    const r = await probeEngineHealth(URL);
    expect(r).toEqual({ reachable: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports slowMs when a healthy response is slow (>1.5s)', async () => {
    const base = 1_000_000;
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(base) // attempt start
      .mockReturnValue(base + 3000); // after fetch
    try {
      fetchSpy.mockResolvedValueOnce(res(true));
      const r = await probeEngineHealth(URL);
      expect(r.reachable).toBe(true);
      expect(r.slowMs).toBe(3000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('retries a transient failure, then succeeds', async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValueOnce(new Error('aborted')).mockResolvedValueOnce(res(true));
    const p = probeEngineHealth(URL);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.reachable).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('reports unreachable after exhausting 3 attempts', async () => {
    vi.useFakeTimers();
    fetchSpy.mockRejectedValue(new Error('aborted'));
    const p = probeEngineHealth(URL);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r).toEqual({ reachable: false });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('treats a non-2xx as a failed attempt (retries, then unreachable)', async () => {
    vi.useFakeTimers();
    fetchSpy.mockResolvedValue(res(false));
    const p = probeEngineHealth(URL);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.reachable).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
