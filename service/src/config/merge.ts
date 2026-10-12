import { configSchema, type Config } from './schema.js';

type Plain = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `patch` into `base`. Arrays and scalars in the patch replace base values. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Apply a partial patch and re-validate. Throws ZodError on invalid input. */
export function applyConfigPatch(current: Config, patch: unknown): Config {
  if (!isPlainObject(patch)) throw new Error('config patch must be an object');
  return configSchema.parse(deepMerge(current, patch));
}
