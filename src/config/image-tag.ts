// The signalk-updater-server image version that "auto" resolves to.
// Bump this when a new signalk-updater-server release is published to ghcr.io.
// Independent of signalk-updater's own package.json version — the two repos
// release on independent cadences. See AGENTS.md "Gotchas" for rationale.
export const UPDATER_SERVER_VERSION = '0.6.5';

export function resolveImageTag(tag: string): string {
  return tag === 'auto' ? UPDATER_SERVER_VERSION : tag;
}
