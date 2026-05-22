// Hand-rolled mirror of signalk-container's API surface — we never import
// signalk-container at compile time, only access it at runtime via
// globalThis.__signalk_containerManager. Source of truth:
//
//   https://github.com/dirkwa/signalk-container
//   - src/types.ts
//   - src/updates/types.ts
//
// Last synced against signalk-container: v1.10.2

export type ContainerState = 'running' | 'stopped' | 'missing' | 'no-runtime';

export interface ContainerRuntimeInfo {
  runtime: 'podman' | 'docker';
  version: string;
  isPodmanDockerShim: boolean;
}

export interface VersionSource {
  fetch: (...args: unknown[]) => Promise<unknown>;
}

export interface UpdateRegistration {
  pluginId: string;
  containerName: string;
  image: string;
  currentTag: () => string;
  versionSource: VersionSource;
  currentVersion?: () => Promise<string | null>;
  checkInterval?: string;
}

export interface UpdateServiceApi {
  register: (reg: UpdateRegistration) => void;
  unregister: (pluginId: string) => void;
  sources: {
    githubReleases: (
      repo: string,
      options?: { allowPrerelease?: boolean; tagPrefix?: string },
    ) => VersionSource;
    dockerHubTags: (
      image: string,
      options?: { filter?: (tag: string) => boolean },
    ) => VersionSource;
  };
}

export interface ContainerManagerApi {
  getRuntime: () => ContainerRuntimeInfo | null;
  getState: (name: string) => Promise<ContainerState>;
  updates: UpdateServiceApi;
}

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined;
}
