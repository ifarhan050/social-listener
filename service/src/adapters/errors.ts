import type { HealthStatus } from './types.js';

/** Thrown when a source shows a login wall or checkpoint mid-run. The run must stop (spec §14). */
export class SessionError extends Error {
  constructor(public health: HealthStatus) {
    super(`session not usable: ${health.status}`);
  }
}
