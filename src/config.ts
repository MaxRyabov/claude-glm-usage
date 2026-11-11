import * as vscode from 'vscode';
import type { ClaudeProvider } from './data/apiClient';
import type { TokenPricing } from './data/jsonlReader';
import type { RateLimitThresholds } from './data/notificationDecision';

/** Value of `claudeStatus.display.primaryUnit` as the user set it. */
export type PrimaryUnitSetting = 'auto' | 'credits' | 'usd';

/** Resolved display unit: credits exist only for the z.ai credit tariff. */
export type PrimaryUnit = 'credits' | 'usd';

/**
 * Resolve the primary cost-display unit. `auto` follows the provider (credits for z-ai,
 * dollars for everyone else); an explicit `credits` is defined only for z-ai and degrades
 * to dollars elsewhere — no other provider has a credit tariff to convert to. An unknown
 * setting value (hand-edited settings.json) reads as `auto`, the declared default, so both
 * non-usd settings resolve through the same provider check.
 */
export function resolvePrimaryUnit(providerType: ClaudeProvider, setting: PrimaryUnitSetting): PrimaryUnit {
  if (setting === 'usd') { return 'usd'; }
  return providerType === 'z-ai' ? 'credits' : 'usd';
}

/**
 * Credits with the § marker, compact like formatTokens: whole numbers below 1k, then
 * `§2.8k` / `§1.2M` / `§1.0B`. § is one glyph, never confused with $, and present in the
 * monospace status-bar fonts. Non-finite or negative inputs render as §0 (fail-soft:
 * the status bar must not print §NaN). A value whose mantissa would round up to 1000.0
 * moves into the next tier, so §1000.0k / §1000.0M never print.
 */
export function formatCredits(n: number): string {
  if (!Number.isFinite(n) || n < 0) { return '§0'; }
  const r = Math.round(n);
  if (r < 1_000) { return `§${r}`; }
  // Numeric thresholds, not string-matching toFixed output: toFixed(1) rounds the
  // mantissa up to "1000.0" from 999.95 of a tier's unit onwards.
  const compact = (div: number, suffix: string): string | null =>
    r / div < 999.95 ? `§${(r / div).toFixed(1)}${suffix}` : null;
  return compact(1_000, 'k')
    ?? compact(1_000_000, 'M')
    ?? compact(1_000_000_000, 'B')
    // The T tier is the last one — far beyond any real credit count; it exists only
    // to keep the mantissa bounded on this side of Number.MAX_SAFE_INTEGER.
    ?? `§${(r / 1_000_000_000_000).toFixed(1)}T`;
}

export class ExtensionConfig {
  private get cfg() {
    return vscode.workspace.getConfiguration('claudeStatus');
  }

  get displayMode(): 'percent' | 'cost' {
    return this.cfg.get('displayMode', 'percent');
  }

  /** Raw `claudeStatus.display.primaryUnit` value; resolvePrimaryUnit applies it per provider. */
  get primaryUnitSetting(): PrimaryUnitSetting {
    const v = this.cfg.get<PrimaryUnitSetting>('display.primaryUnit', 'auto');
    return v === 'credits' || v === 'usd' ? v : 'auto';
  }

  get statusBarAlignment(): 'left' | 'right' {
    return this.cfg.get('statusBar.alignment', 'left');
  }

  get showProjectCost(): boolean {
    return this.cfg.get('statusBar.showProjectCost', true);
  }

  get cacheTtlSeconds(): number {
    return this.cfg.get('cache.ttlSeconds', 300);
  }

  get realtimeEnabled(): boolean {
    return this.cfg.get('realtime.enabled', false);
  }

  get rateLimitApiEnabled(): boolean {
    return this.cfg.get('rateLimitApi.enabled', true);
  }

  get dailyBudget(): number | null {
    return this.cfg.get('budget.dailyUsd', null);
  }

  get weeklyBudget(): number | null {
    return this.cfg.get('budget.weeklyUsd', null);
  }

  get budgetAlertThreshold(): number {
    return this.cfg.get('budget.alertThresholdPercent', 80);
  }

  get rateLimitWarning(): boolean {
    return this.cfg.get('notifications.rateLimitWarning', true);
  }

  /** Step thresholds (in percent) driving the utilization-based rate-limit notifications. */
  get rateLimitThresholds(): RateLimitThresholds {
    return {
      fiveHourStartPercent: this.cfg.get('notifications.rateLimit5hStartPercent', 90),
      fiveHourStepPercent: this.cfg.get('notifications.rateLimit5hStepPercent', 2),
      sevenDayStartPercent: this.cfg.get('notifications.rateLimit7dStartPercent', 80),
      sevenDayEndPercent: this.cfg.get('notifications.rateLimit7dEndPercent', 90),
      sevenDayStepPercent: this.cfg.get('notifications.rateLimit7dStepPercent', 5),
    };
  }

  get budgetWarning(): boolean {
    return this.cfg.get('notifications.budgetWarning', true);
  }

  get heatmapDays(): number {
    return this.cfg.get('heatmap.days', 90);
  }

  get credentialsPath(): string | null {
    return this.cfg.get('credentials.path', null);
  }

  get claudeProvider(): 'auto' | ClaudeProvider {
    return this.cfg.get('claudeProvider', 'auto');
  }

  get tokenPricing(): TokenPricing {
    return {
      inputPerMillion:      this.cfg.get('pricing.inputPerMillion', 3.00),
      outputPerMillion:     this.cfg.get('pricing.outputPerMillion', 15.00),
      cacheReadPerMillion:  this.cfg.get('pricing.cacheReadPerMillion', 0.30),
      cacheCreatePerMillion: this.cfg.get('pricing.cacheCreatePerMillion', 3.75),
    };
  }

  get pricingModels(): Record<string, TokenPricing> {
    return this.cfg.get('pricing.models', {});
  }

  async setDisplayMode(mode: 'percent' | 'cost'): Promise<void> {
    await this.cfg.update('displayMode', mode, vscode.ConfigurationTarget.Global);
  }

  async setDailyBudget(value: number | null): Promise<void> {
    await this.cfg.update('budget.dailyUsd', value, vscode.ConfigurationTarget.Global);
  }
}

export const config = new ExtensionConfig();
