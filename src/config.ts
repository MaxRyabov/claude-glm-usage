import * as vscode from 'vscode';
import type { ClaudeProvider } from './data/apiClient';
import type { TokenPricing } from './data/jsonlReader';
import type { RateLimitThresholds } from './data/notificationDecision';

export class ExtensionConfig {
  private get cfg() {
    return vscode.workspace.getConfiguration('claudeStatus');
  }

  get displayMode(): 'percent' | 'cost' {
    return this.cfg.get('displayMode', 'percent');
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
