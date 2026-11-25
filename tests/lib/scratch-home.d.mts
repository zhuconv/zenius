// Types for scratch-home.mjs, for the SDK's TypeScript tests.

export declare function realPath(path: string): string;

export declare const REAL_HOME: string;

export declare function guardHome<T extends Record<string, string | undefined>>(env: T, what?: string): T;

export type ScratchHome = {
  root: string;
  home: string;
  zeniusHome: string;
  workingFolder: string;
  env(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv;
  writeConfig(folder?: string): void;
  shareRuntime(from?: string): void;
  remove(): void;
};

export declare function scratchHome(
  label?: string,
  options?: { parent?: string; config?: boolean; workingFolder?: string },
): ScratchHome;
