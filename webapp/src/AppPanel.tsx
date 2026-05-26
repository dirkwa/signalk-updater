/**
 * Embedded panel rendered by the SignalK admin UI's /admin/#/e/Updater route.
 *
 * Renders an iframe pointing at the plugin's same-origin proxy to the
 * signalk-updater-server console. Same-origin keeps cookies, SSE, and
 * reverse-proxy setups (Traefik/nginx HTTPS in front of :3000) working
 * without mixed-content or CORS gymnastics.
 *
 * The iframe URL is plugin-relative, not derived from /api/gui-url. The
 * gui-url endpoint still exists for direct-link use cases but the embedded
 * panel doesn't need it: the proxy is mounted at a known plugin-relative
 * path under registerWithRouter().
 */
import { useEffect, useState } from 'react';

/**
 * Subset of the adminUI object the SignalK admin shell injects into every
 * embeddable webapp. We intentionally don't depend on the bigger surface
 * (websocket, applicationData, Login) — this panel is a thin iframe host.
 */
interface AdminUI {
  hideSideBar: () => void;
}

interface AppPanelProps {
  loginStatus: unknown;
  adminUI: AdminUI;
}

const CONSOLE_PATH = '/plugins/signalk-updater/console/';
const INFO_PATH = '/plugins/signalk-updater/api/info';

type ProbeState = 'probing' | 'ok' | 'plugin-down';

export default function AppPanel(_props: AppPanelProps) {
  const [state, setState] = useState<ProbeState>('probing');
  const [errorDetail, setErrorDetail] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(INFO_PATH, { credentials: 'include' });
        if (cancelled) return;
        if (!res.ok) {
          setErrorDetail(`HTTP ${res.status}`);
          setState('plugin-down');
          return;
        }
        setState('ok');
      } catch (err) {
        if (cancelled) return;
        setErrorDetail(err instanceof Error ? err.message : String(err));
        setState('plugin-down');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'probing') {
    return <div className="p-3 text-muted">Loading Updater Console…</div>;
  }

  if (state === 'plugin-down') {
    return (
      <div className="alert alert-danger m-3" role="alert">
        <h5 className="alert-heading">signalk-updater plugin is unreachable</h5>
        <p className="mb-1">
          The plugin endpoint at <code>{INFO_PATH}</code> did not respond. The plugin may be
          disabled, or signalk-container is missing.
        </p>
        <p className="mb-0 small text-muted">Detail: {errorDetail}</p>
      </div>
    );
  }

  return (
    <iframe
      src={CONSOLE_PATH}
      title="SignalK Updater Console"
      style={{
        border: 'none',
        width: '100%',
        height: '100%',
        display: 'block',
      }}
    />
  );
}
