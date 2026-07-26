import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerAPI } from '@signalk/server-api';
import { ProbeNotifier, fetchProbes, pollOnce } from '../src/probes-notify.js';

const PLUGIN_ID = 'signalk-updater';

// Capture every handleMessage delta so tests can assert path + notification value.
interface Emitted {
  path: string;
  value: { state: string; method: string[]; message: string };
}
function fakeApp(): { app: ServerAPI; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const app = {
    handleMessage: (_id: string, delta: { updates?: { values?: Emitted[] }[] }) => {
      for (const u of delta.updates ?? []) {
        for (const v of u.values ?? []) emitted.push(v);
      }
    },
    debug: () => undefined,
  } as unknown as ServerAPI;
  return { app, emitted };
}

function probe(id: string, status: 'ok' | 'warn' | 'fail' | 'unknown', message = 'msg') {
  return { id, label: id.toUpperCase(), status, message };
}

describe('ProbeNotifier.reconcile', () => {
  it('raises warn as state=warn (visual) and fail as state=alarm (visual+sound)', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([
      probe('timezone-drift', 'warn', 'zone lag'),
      probe('signalk-health', 'fail', 'down'),
    ]);

    const warn = emitted.find((e) => e.path === 'notifications.updater.timezone-drift');
    const fail = emitted.find((e) => e.path === 'notifications.updater.signalk-health');
    expect(warn?.value.state).toBe('warn');
    expect(warn?.value.method).toEqual(['visual']);
    expect(warn?.value.message).toContain('zone lag');
    expect(fail?.value.state).toBe('alarm');
    expect(fail?.value.method).toEqual(['visual', 'sound']);
    expect(n.activeIds().sort()).toEqual(['signalk-health', 'timezone-drift']);
  });

  it('does not raise ok or unknown', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('disk', 'ok'), probe('podman', 'unknown')]);
    expect(emitted).toHaveLength(0);
    expect(n.activeIds()).toEqual([]);
  });

  it('clears a recovered probe with state=normal and drops it from active', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('timezone-drift', 'warn')]);
    expect(n.activeIds()).toEqual(['timezone-drift']);
    emitted.length = 0;

    n.reconcile([probe('timezone-drift', 'ok')]); // recovered
    const clear = emitted.find((e) => e.path === 'notifications.updater.timezone-drift');
    expect(clear?.value.state).toBe('normal');
    expect(clear?.value.method).toEqual([]);
    expect(n.activeIds()).toEqual([]);
  });

  it('clears a probe that went unknown (couldn’t measure = not still failing)', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('memory', 'fail')]);
    emitted.length = 0;
    n.reconcile([probe('memory', 'unknown')]);
    expect(emitted[0]?.value.state).toBe('normal');
    expect(n.activeIds()).toEqual([]);
  });

  it('clears a probe that disappeared from the results entirely', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('snapshots', 'warn')]);
    emitted.length = 0;
    n.reconcile([]); // probe no longer reported
    expect(emitted[0]?.value.state).toBe('normal');
    expect(n.activeIds()).toEqual([]);
  });

  it('re-emits an ongoing warn each cycle (keeps it latched) without clearing', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('disk', 'warn', 'low')]);
    emitted.length = 0;
    n.reconcile([probe('disk', 'warn', 'still low')]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.value.state).toBe('warn');
    expect(emitted[0]?.value.message).toContain('still low');
    expect(n.activeIds()).toEqual(['disk']);
  });
});

describe('ProbeNotifier.clearAll', () => {
  it('clears every active notification and empties the set', () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    n.reconcile([probe('a', 'warn'), probe('b', 'fail')]);
    emitted.length = 0;
    n.clearAll();
    expect(emitted.map((e) => e.value.state)).toEqual(['normal', 'normal']);
    expect(emitted.map((e) => e.path).sort()).toEqual([
      'notifications.updater.a',
      'notifications.updater.b',
    ]);
    expect(n.activeIds()).toEqual([]);
  });
});

describe('fetchProbes', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function jsonRes(body: unknown, ok = true): Response {
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
  }

  it('parses a well-formed probes response', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ results: [probe('x', 'warn'), probe('y', 'ok')], summary: {} }),
    );
    const r = await fetchProbes('http://127.0.0.1:3004');
    expect(r).toEqual([
      { id: 'x', label: 'X', status: 'warn', message: 'msg' },
      { id: 'y', label: 'Y', status: 'ok', message: 'msg' },
    ]);
  });

  it('returns null on a non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({}, false));
    expect(await fetchProbes('http://127.0.0.1:3004')).toBeNull();
  });

  it('returns null on a network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('aborted'));
    expect(await fetchProbes('http://127.0.0.1:3004')).toBeNull();
  });

  it('returns null when results is missing (cannot distinguish from a broken response)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ nope: true }));
    expect(await fetchProbes('http://127.0.0.1:3004')).toBeNull();
  });

  it('returns an empty list when results is present but empty', async () => {
    fetchSpy.mockResolvedValueOnce(jsonRes({ results: [] }));
    expect(await fetchProbes('http://127.0.0.1:3004')).toEqual([]);
  });

  it('skips malformed result entries but keeps valid ones', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ results: [probe('good', 'warn'), { id: 'bad' }, 42, null] }),
    );
    const r = await fetchProbes('http://127.0.0.1:3004');
    expect(r).toEqual([{ id: 'good', label: 'GOOD', status: 'warn', message: 'msg' }]);
  });

  it('drops a probe with an empty id (would produce notifications.updater.)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonRes({ results: [probe('', 'warn'), probe('ok-id', 'warn')] }),
    );
    const r = await fetchProbes('http://127.0.0.1:3004');
    expect(r).toEqual([{ id: 'ok-id', label: 'OK-ID', status: 'warn', message: 'msg' }]);
  });
});

describe('pollOnce', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reconciles on a good fetch', async () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [probe('timezone-drift', 'warn')] }),
    } as Response);
    await pollOnce('http://127.0.0.1:3004', n);
    expect(emitted[0]?.value.state).toBe('warn');
    expect(n.activeIds()).toEqual(['timezone-drift']);
  });

  it('skips the cycle on a fetch failure WITHOUT clearing existing notifications', async () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    // Establish an active warn first.
    n.reconcile([probe('timezone-drift', 'warn')]);
    emitted.length = 0;
    // Engine unreachable this cycle → must NOT clear the active warn.
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    const onError = vi.fn();
    await pollOnce('http://127.0.0.1:3004', n, onError);
    expect(emitted).toHaveLength(0);
    expect(n.activeIds()).toEqual(['timezone-drift']);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not reconcile when isStopped() is true after the fetch (no post-stop re-raise)', async () => {
    const { app, emitted } = fakeApp();
    const n = new ProbeNotifier(app, PLUGIN_ID);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ results: [probe('timezone-drift', 'warn')] }),
    } as Response);
    // Simulate stop() having run while the fetch was in flight.
    await pollOnce('http://127.0.0.1:3004', n, undefined, () => true);
    expect(emitted).toHaveLength(0);
    expect(n.activeIds()).toEqual([]);
  });
});
