import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Repo-root dotenv file; resolves the same from `src/` (tsx) and `dist/` (build).
 * Only entrypoints and scripts load it — never `loadConfig()` and never tests, so tests stay hermetic.
 */
export const DEFAULT_ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

/**
 * Load `path` into `process.env` with Node's built-in `process.loadEnvFile()` if the file exists.
 * Never throws and never overrides a variable that is already set (even to an empty string):
 * that is Node's own behaviour on the supported Node 22 (`engines`, Docker image), pinned by
 * `test/unit/loadEnv.test.ts`. Returns whether the file was loaded.
 */
export function loadEnvFile(path: string = DEFAULT_ENV_FILE): boolean {
  try {
    if (!existsSync(path)) return false;
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    // Report only the error code: messages could echo file content.
    const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
    console.warn(`env file not loaded (${code}); continuing with the process environment`);
    return false;
  }
}
