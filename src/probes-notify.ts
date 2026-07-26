// Poll the updater engine's /api/updater-status and republish its warn/fail
// results as SignalK notifications under `notifications.updater.<id>`, clearing
// them (state: normal) when a condition recovers. This is the plugin's only
// writer to the SignalK data model — the engine reports status over HTTP but
// never emits SignalK notifications, so an update-available / stale-lock /
// failed-self-update condition is otherwise invisible outside the updater
// console. Lifted from the signalk-doctor plugin's equivalent module (same
// raise/clear reconcile over an `active` set, driven by a poll timer in
// index.ts); only the notification prefix and engine path differ.

import {
  ALARM_STATE,
  ALARM_METHOD,
  type Delta,
  type Path,
  type ServerAPI,
} from '@signalk/server-api';

const ENGINE_PROBES_PATH = '/api/updater-status';
const FETCH_TIMEOUT_MS = 5000;
const NOTIF_PREFIX = 'notifications.updater.';

// The four status levels the engine emits (signalk-updater-server
// src/updater-status.ts). We only republish warn and fail; `unknown` is a
// couldn't-measure state (not a real failure) and would flap, so it is
// deliberately ignored.
type ProbeStatus = 'ok' | 'warn' | 'fail' | 'unknown';

interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  message: string;
}

// Minimal, defensive narrowing of the engine JSON — never trust its shape
// (noUncheckedIndexedAccess is on, and the engine is a separate release).
function parseProbes(raw: unknown): ProbeResult[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const results = (raw as Record<string, unknown>).results;
  if (!Array.isArray(results)) return null;
  const out: ProbeResult[] = [];
  for (const r of results) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (
      typeof o.id === 'string' &&
      o.id.length > 0 && // guard against notifications.updater. with an empty id
      typeof o.label === 'string' &&
      typeof o.message === 'string' &&
      (o.status === 'ok' || o.status === 'warn' || o.status === 'fail' || o.status === 'unknown')
    ) {
      out.push({ id: o.id, label: o.label, status: o.status, message: o.message });
    }
  }
  return out;
}

/** Fetch + parse the engine probes. Returns null on any error (unreachable,
 *  timeout, bad JSON) so the caller can skip a cycle without throwing. */
export async function fetchProbes(engineBaseUrl: string): Promise<ProbeResult[] | null> {
  const url = `${engineBaseUrl.replace(/\/$/, '')}${ENGINE_PROBES_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // Release the unread body so repeated failures don't tie up pooled
      // connections.
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return parseProbes(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function notificationPath(id: string): Path {
  return `${NOTIF_PREFIX}${id}` as Path;
}

// warn → warn (visual); fail → alarm (visual + sound). unknown/ok never raise.
function raiseValue(status: 'warn' | 'fail', label: string, message: string) {
  const state = status === 'fail' ? ALARM_STATE.alarm : ALARM_STATE.warn;
  const method =
    status === 'fail' ? [ALARM_METHOD.visual, ALARM_METHOD.sound] : [ALARM_METHOD.visual];
  return { state, method, message: `${label}: ${message}` };
}

function clearValue(label: string) {
  return { state: ALARM_STATE.normal, method: [] as ALARM_METHOD[], message: `${label}: OK` };
}

function emit(app: ServerAPI, pluginId: string, path: Path, value: object): void {
  const delta: Partial<Delta> = {
    updates: [{ values: [{ path, value }] }],
  };
  app.handleMessage(pluginId, delta);
}

/** Tracks which probe ids currently have an active (warn/fail) notification so
 *  we clear exactly those that recover — and clear them all on shutdown. */
export class ProbeNotifier {
  private readonly active = new Map<string, string>(); // id -> label (for the clear message)

  constructor(
    private readonly app: ServerAPI,
    private readonly pluginId: string,
  ) {}

  /** Reconcile the current probe results against the active set: raise/update
   *  warn+fail, and clear (state: normal) any previously-active probe that is
   *  now ok/unknown or has disappeared from the results entirely. */
  reconcile(results: ProbeResult[]): void {
    const seenBad = new Set<string>();
    for (const r of results) {
      if (r.status === 'warn' || r.status === 'fail') {
        seenBad.add(r.id);
        this.active.set(r.id, r.label);
        emit(
          this.app,
          this.pluginId,
          notificationPath(r.id),
          raiseValue(r.status, r.label, r.message),
        );
      }
    }
    // Clear anything we previously raised that is no longer bad (recovered,
    // went unknown, or dropped out of the probe list).
    for (const [id, label] of [...this.active]) {
      if (!seenBad.has(id)) {
        emit(this.app, this.pluginId, notificationPath(id), clearValue(label));
        this.active.delete(id);
      }
    }
  }

  /** Clear every still-active notification. Called from stop() so a plugin
   *  shutdown doesn't leave stale updater alarms latched in the data model. */
  clearAll(): void {
    for (const [id, label] of [...this.active]) {
      emit(this.app, this.pluginId, notificationPath(id), clearValue(label));
    }
    this.active.clear();
  }

  /** Test/inspection helper: ids with an active notification. */
  activeIds(): string[] {
    return [...this.active.keys()];
  }
}

/** One poll cycle: fetch probes and reconcile. Skips silently (leaving the
 *  active set untouched) when the engine can't be reached, so a transient
 *  engine blip doesn't spuriously clear real notifications. `isStopped`, when
 *  provided, is checked after the (async) fetch so a cycle that was in flight
 *  when the plugin stopped does not reconcile — which would re-raise alarms
 *  right after stop() cleared them. */
export async function pollOnce(
  engineBaseUrl: string,
  notifier: ProbeNotifier,
  onError?: (msg: string) => void,
  isStopped?: () => boolean,
): Promise<void> {
  const results = await fetchProbes(engineBaseUrl);
  if (isStopped?.()) return;
  if (results === null) {
    onError?.('probes fetch failed — skipping this cycle (notifications unchanged)');
    return;
  }
  notifier.reconcile(results);
}
