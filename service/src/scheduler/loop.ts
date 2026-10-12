import type { ConfigStore } from '../config/store.js';
import { logger } from '../util/logger.js';
import type { Runner } from './runner.js';

/**
 * Optional built-in timer (scheduler.trigger = "service"). By default Cowork drives scans.
 * Background tick: starts a scheduled run when targets are due and nothing blocks it.
 * Re-reads config every tick so changes apply to the next run (spec §16, Phase 3 accept).
 */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private lastBlocked: string | null = null;

  constructor(
    private runner: Runner,
    private config: ConfigStore,
  ) {}

  start(): void {
    const tick = () => {
      try {
        this.tick();
      } catch (err) {
        logger.error({ err }, 'scheduler tick failed');
      }
      this.timer = setTimeout(tick, this.config.get().scheduler.tick_seconds * 1000);
    };
    this.timer = setTimeout(tick, 5000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  tick(now = new Date()): void {
    const cfg = this.config.get();
    // Default: Claude Cowork's scheduled tasks start scans; the service never scans on its own.
    if (cfg.scheduler.trigger !== 'service' || this.runner.busy) return;
    if (!this.runner.dueTargets(now).length) return;
    const blocked = this.runner.blockedReason(cfg, now);
    if (blocked) {
      if (blocked !== this.lastBlocked) logger.info({ reason: blocked }, 'scheduled run blocked');
      this.lastBlocked = blocked;
      return;
    }
    this.lastBlocked = null;
    this.runner.start({ trigger: 'scheduled' });
  }
}
