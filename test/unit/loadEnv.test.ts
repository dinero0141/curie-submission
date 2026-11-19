import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENV_FILE, loadEnvFile } from '../../src/loadEnv.js';

// Unique keys so the test never collides with the real environment.
const KEYS = ['CURIE_LOADENV_A', 'CURIE_LOADENV_B', 'CURIE_LOADENV_C'] as const;

describe('loadEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'curie-loadenv-'));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeVars(body: string): string {
    const file = join(dir, 'vars');
    writeFileSync(file, body);
    return file;
  }

  it('loads variables that are not set yet', () => {
    const file = writeVars('CURIE_LOADENV_A=one\nCURIE_LOADENV_B="two words"\n');
    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.CURIE_LOADENV_A).toBe('one');
    expect(process.env.CURIE_LOADENV_B).toBe('two words');
  });

  it('never overrides variables already in the environment, including empty ones', () => {
    process.env.CURIE_LOADENV_A = 'from-shell';
    process.env.CURIE_LOADENV_C = '';
    const file = writeVars('CURIE_LOADENV_A=from-file\nCURIE_LOADENV_B=from-file\nCURIE_LOADENV_C=from-file\n');
    expect(loadEnvFile(file)).toBe(true);
    expect(process.env.CURIE_LOADENV_A).toBe('from-shell');
    expect(process.env.CURIE_LOADENV_B).toBe('from-file');
    expect(process.env.CURIE_LOADENV_C).toBe('');
  });

  it('returns false without throwing when the file does not exist', () => {
    expect(loadEnvFile(join(dir, 'missing'))).toBe(false);
    expect(process.env.CURIE_LOADENV_A).toBeUndefined();
  });

  it('returns false without throwing when the path cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadEnvFile(dir)).toBe(false); // a directory: EISDIR
    expect(warn).toHaveBeenCalledOnce();
  });

  it('defaults to the repo-root dotenv file', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(DEFAULT_ENV_FILE).toBe(join(repoRoot, '.env'));
  });
});
