import type { Locator, Page } from 'playwright';
import type { Config } from '../../config/schema.js';
import { sleep } from '../../util/random.js';

export type HumanConfig = Config['fetch']['human'];
type Rng = () => number;

const between = (rng: Rng, [a, b]: readonly [number, number]) => Math.floor(a + rng() * (b - a + 1));

/** Wheel steps that add up to `total` px, each within `[min, max]` (last step may be smaller). */
export function wheelSteps(total: number, step: readonly [number, number], rng: Rng = Math.random): number[] {
  const out: number[] = [];
  let left = Math.max(0, Math.round(total));
  while (left > 0) {
    const s = Math.min(left, Math.max(1, between(rng, step)));
    out.push(s);
    left -= s;
  }
  return out;
}

/** Time a person would spend reading `text` at a random words-per-minute, capped. */
export function dwellMs(text: string, wpm: readonly [number, number], cap: number, rng: Rng = Math.random): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const rate = Math.max(1, between(rng, wpm));
  return Math.min(cap, Math.round((words / rate) * 60_000));
}

/** Fisher–Yates shuffle (new array). */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Human-like pacing for Facebook browsing (spec §14 "human pacing"): reading time,
 * wheel scrolling with pauses, hover-before-click, idle pauses, breaks between targets.
 * Pacing only — it does not disguise the browser or hide automation.
 */
export class Human {
  private postsSinceIdle = 0;
  private nextIdleAt: number;

  constructor(
    private cfg: () => HumanConfig,
    private rng: Rng = Math.random,
    private wait: (ms: number, signal?: AbortSignal) => Promise<void> = sleep,
  ) {
    this.nextIdleAt = between(this.rng, this.cfg().idle_every_posts);
  }

  private get on() {
    return this.cfg().enabled;
  }

  /** Scroll down roughly one screen in small wheel steps; occasionally glance back up. */
  async scroll(page: Page, signal?: AbortSignal): Promise<void> {
    if (!this.on) {
      await page.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.9))');
      return;
    }
    const c = this.cfg();
    const vh = ((await page.evaluate('window.innerHeight')) as number) || 900;
    const vw = ((await page.evaluate('window.innerWidth')) as number) || 1280;
    await page.mouse.move(between(this.rng, [Math.round(vw * 0.3), Math.round(vw * 0.6)]), between(this.rng, [Math.round(vh * 0.3), Math.round(vh * 0.7)]), { steps: 5 });
    for (const dy of wheelSteps(vh * (0.6 + this.rng() * 0.5), c.scroll_step_px, this.rng)) {
      await page.mouse.wheel(0, dy);
      await this.wait(between(this.rng, c.scroll_step_pause_ms), signal);
    }
    if (this.rng() < 0.12) {
      // Glance back at something above, then continue.
      for (const dy of wheelSteps(between(this.rng, [100, 250]), c.scroll_step_px, this.rng)) {
        await page.mouse.wheel(0, -dy);
        await this.wait(between(this.rng, c.scroll_step_pause_ms), signal);
      }
      await this.wait(between(this.rng, [600, 1500]), signal);
    }
  }

  /** Spend reading time on text that was just shown/expanded. */
  async read(text: string, signal?: AbortSignal): Promise<void> {
    if (!this.on) return;
    const c = this.cfg();
    const ms = dwellMs(text, c.reading_wpm, c.max_dwell_ms, this.rng);
    if (ms > 0) await this.wait(ms, signal);
  }

  /** Move to the element, pause briefly, then click. */
  async click(loc: Locator, signal?: AbortSignal): Promise<void> {
    if (this.on) {
      await loc.scrollIntoViewIfNeeded().catch(() => undefined);
      await loc.hover({ timeout: 5000 }).catch(() => undefined);
      await this.wait(between(this.rng, this.cfg().click_pause_ms), signal);
    }
    await loc.click({ timeout: 5000 });
  }

  /** Move the mouse onto an element and linger briefly, as when glancing at a timestamp. */
  async hover(loc: Locator, signal?: AbortSignal): Promise<void> {
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await loc.hover({ timeout: 3000 });
    await this.wait(this.on ? between(this.rng, [400, 900]) : 50, signal);
  }

  /** Call once per post looked at; every few posts, take a short idle pause. */
  async afterPost(signal?: AbortSignal): Promise<void> {
    if (!this.on) return;
    if (++this.postsSinceIdle >= this.nextIdleAt) {
      this.postsSinceIdle = 0;
      this.nextIdleAt = between(this.rng, this.cfg().idle_every_posts);
      await this.wait(between(this.rng, this.cfg().idle_pause_ms), signal);
    }
  }

  /** Break between groups/pages/searches, like moving on to something else. */
  async breakBetweenTargets(signal?: AbortSignal): Promise<void> {
    if (!this.on) return;
    await this.wait(between(this.rng, this.cfg().target_break_ms), signal);
  }
}
