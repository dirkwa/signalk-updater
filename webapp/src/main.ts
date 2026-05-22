// Tiny redirect shell: ask the plugin for the externalUrl, then redirect.
// If the plugin is unreachable (signalk-server missing) or the updater
// container is down, render a friendly explanation instead of a blank page.

interface GuiUrlResponse {
  url: string;
}

const msg = document.getElementById('msg');
const actions = document.getElementById('actions');

async function bootstrap(): Promise<void> {
  try {
    const res = await fetch('/plugins/signalk-updater/api/gui-url');
    if (!res.ok) throw new Error(`plugin API returned HTTP ${res.status}`);
    const body = (await res.json()) as GuiUrlResponse;
    if (!body.url) throw new Error('no url in plugin response');

    // Probe the updater itself before redirecting, so we can show a useful
    // error if the container is down (instead of a generic "page can't load").
    try {
      const health = await fetch(`${body.url.replace(/\/$/, '')}/api/health`, {
        method: 'GET',
        mode: 'no-cors',
      });
      // no-cors gives us opaque responses; reaching here at all means TCP reach.
      void health;
    } catch (probeErr) {
      if (msg) {
        msg.innerHTML = `<span class="err">Updater container is not reachable at <code>${body.url}</code>.</span>
        <p>The systemd unit may be down. Open an SSH session and try
        <code>systemctl --user status signalk-updater-server.service</code>,
        or fall back to <code>~/.local/bin/signalk-recovery rollback-updater</code>
        if the container is bricked.</p>
        <p>Original error: <code>${probeErr instanceof Error ? probeErr.message : String(probeErr)}</code></p>`;
      }
      return;
    }

    if (msg) {
      msg.innerHTML = `<span class="ok">Updater Console is reachable.</span>
      Redirecting to <code>${body.url}</code>…`;
    }
    window.location.replace(body.url);
  } catch (err) {
    if (msg) {
      msg.innerHTML = `<span class="err">Could not contact the signalk-updater plugin.</span>
      <p>Either the plugin is disabled or signalk-server is unhealthy.
      The Updater Console may still be reachable directly:</p>`;
    }
    if (actions) {
      actions.style.display = 'block';
      actions.innerHTML = '<a href="http://localhost:3003">Open Updater Console on :3003</a>';
    }
    console.error(err);
  }
}

void bootstrap();
