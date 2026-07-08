import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { readAllUsage, wasJsonlUpdatedRecently } from './jsonlReader';
import type { PricingContext } from './pricing';
import {
  fetchRateLimitData,
  fetchZaiQuota,
  readClaudeBaseUrl,
  readZaiToken,
  detectProvider,
  RateLimitData,
  ClaudeProvider,
} from './apiClient';
import { readCache, writeCache, isCacheValid, getCacheAge } from './cache';
import { acquireApiPollLock, releaseApiPollLock } from './apiLock';
import { getAllProjectCosts, workspacePathToHash, ProjectCostData } from './projectCost';
import { computePrediction, PredictionData } from './prediction';
import { getHeatmapData as computeHeatmapData, HeatmapData } from '../webview/heatmap';
import { loadPersistedCache, persistCache } from './entryCache';
import { readSnapshot, writeSnapshot } from './snapshotCache';
import { config } from '../config';

export { PredictionData, HeatmapData };

export interface ClaudeUsageData {
  // From API / cache
  utilization5h: number
  utilization7d: number
  resetIn5h: number
  resetIn7d: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'

  // From local JSONL
  cost5h: number
  costDay: number
  cost7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number

  // Rate limit metadata
  has7dLimit: boolean      // false for plans without a 7d window or non-Claude.ai providers
  providerType: ClaudeProvider

  // Metadata
  lastUpdated: Date
  cacheAge: number
  dataSource: 'api' | 'cache' | 'stale' | 'no-credentials' | 'no-data' | 'local-only'
}

export { ProjectCostData };

export class DataManager {
  private static instance: DataManager;
  private readonly _onDidUpdate = new vscode.EventEmitter<ClaudeUsageData>();
  readonly onDidUpdate: vscode.Event<ClaudeUsageData> = this._onDidUpdate.event;

  private watcher: vscode.FileSystemWatcher | undefined;
  private lastData: ClaudeUsageData | undefined;
  private lastProjectCosts: ProjectCostData[] = [];
  private lastPrediction: PredictionData | null = null;
  private lastHeatmapData: HeatmapData | null = null;
  private heatmapComputedAt = 0;
  private readonly heatmapTtlMs = 5 * 60 * 1000; // 5-minute in-memory TTL
  private heatmapPending = false;

  // Refresh serialization: at most one refresh runs at a time; a request arriving while
  // one is in flight is coalesced into a single queued run (force wins over normal). This
  // keeps a burst of watcher events from spawning overlapping heavy refreshes that would
  // overload the shared Extension Host.
  private refreshing = false;
  private queuedRefresh: 'normal' | 'force' | null = null;

  // Debounce timer for file-watcher events (collapses a write burst into one refresh).
  private watcherTimer: ReturnType<typeof setTimeout> | undefined;
  private diskLoaded = false;

  // Multi-window damping. Every VSCode window runs its own instance of this extension,
  // and each watches the whole ~/.claude/projects tree — so one long Claude Code session
  // used to fan out into continuous re-parse + multi-MB cache rewrites in EVERY window.
  // Watcher-triggered refreshes are rate-limited (the 60s timer covers freshness), and
  // the parse cache is persisted at most once per interval per instance.
  private lastWatcherRefreshAt = 0;
  private readonly watcherMinIntervalMs = 15_000;
  private lastParseCachePersistAt = 0;
  private readonly parseCachePersistIntervalMs = 5 * 60 * 1000;

  private constructor() {}

  static getInstance(): DataManager {
    if (!DataManager.instance) {
      DataManager.instance = new DataManager();
    }
    return DataManager.instance;
  }

  /** Resolve the active provider from user config or auto-detection. */
  private async resolveProvider(): Promise<ClaudeProvider> {
    const configured = config.claudeProvider;
    return configured === 'auto'
      ? detectProvider(config.credentialsPath)
      : configured;
  }

  /** Build the per-model pricing context for a resolved provider. */
  private pricingContext(providerType: ClaudeProvider): PricingContext {
    return {
      userOverrides: config.pricingModels,
      providerType,
      fallback: config.tokenPricing,
    };
  }

  async getUsageData(forceRefresh = false): Promise<ClaudeUsageData> {
    // Resolve the provider first: it gates the rate-limit call AND drives per-model
    // pricing, so it must be known before reading local usage.
    const [cache, providerType] = await Promise.all([readCache(), this.resolveProvider()]);
    const localUsage = await readAllUsage(this.pricingContext(providerType));

    let rateLimitData: RateLimitData | null = null;
    let dataSource: ClaudeUsageData['dataSource'] = 'no-data';

    // claude-ai (Anthropic rate-limit headers) and z-ai (quota endpoint) both expose
    // utilization windows; everything else is cost-only.
    const supportsRateLimit = providerType === 'claude-ai' || providerType === 'z-ai';
    const hasCostData = localUsage.cost7d > 0 || localUsage.cost5h > 0;

    if (supportsRateLimit && config.rateLimitApiEnabled) {
      if (forceRefresh || (await this.shouldCallApi(cache))) {
        // All windows share one quota and one rate-limit cache — only the window that
        // wins the cross-process lock polls; the rest reuse its cached result.
        if (!(await acquireApiPollLock())) {
          if (cache) {
            rateLimitData = this.cacheToRateLimitData(cache.usageData);
            dataSource = isCacheValid(cache, config.cacheTtlSeconds) ? 'cache' : 'stale';
          } else {
            dataSource = hasCostData ? 'local-only' : 'no-data';
          }
        } else {
          try {
            // Double-check under the lock: another window may have finished its poll
            // between our cache read and the acquire — its result is already fresh.
            const fresh = forceRefresh ? null : await readCache();
            if (fresh && isCacheValid(fresh, config.cacheTtlSeconds)) {
              rateLimitData = this.cacheToRateLimitData(fresh.usageData);
              dataSource = 'cache';
            } else {
              rateLimitData = providerType === 'z-ai'
                ? await this.fetchZaiRateLimit()
                : await fetchRateLimitData(config.credentialsPath);
              await writeCache(rateLimitData);
              dataSource = 'api';
            }
          } catch {
            // missing token/credentials or network error — fall back to cache, else cost-only
            if (cache) {
              rateLimitData = this.cacheToRateLimitData(cache.usageData);
              dataSource = isCacheValid(cache, config.cacheTtlSeconds) ? 'cache' : 'stale';
            } else {
              dataSource = hasCostData ? 'local-only' : 'no-credentials';
            }
          } finally {
            await releaseApiPollLock();
          }
        }
      } else if (cache) {
        rateLimitData = this.cacheToRateLimitData(cache.usageData);
        dataSource = isCacheValid(cache, config.cacheTtlSeconds) ? 'cache' : 'stale';
      } else {
        dataSource = hasCostData ? 'local-only' : 'no-data';
      }
    } else if (supportsRateLimit && cache) {
      // API disabled by user but cache exists — show stale rate limit data with age indicator
      rateLimitData = this.cacheToRateLimitData(cache.usageData);
      dataSource = 'stale';
    } else {
      // Non-rate-limited provider, or no cache — cost only from local JSONL
      dataSource = hasCostData ? 'local-only' : 'no-credentials';
    }

    const cacheAge = cache ? getCacheAge(cache) : 0;

    const data: ClaudeUsageData = {
      utilization5h: rateLimitData?.utilization5h ?? 0,
      utilization7d: rateLimitData?.utilization7d ?? 0,
      resetIn5h: rateLimitData?.resetIn5h ?? 0,
      resetIn7d: rateLimitData?.resetIn7d ?? 0,
      limitStatus: rateLimitData?.limitStatus ?? 'allowed',
      has7dLimit: rateLimitData?.has7dLimit ?? false,
      providerType,
      ...localUsage,
      lastUpdated: new Date(),
      cacheAge,
      dataSource,
    };

    this.lastData = data;
    return data;
  }

  private cacheToRateLimitData(usageData: {
    utilization5h: number
    utilization7d: number
    reset5hAt: number
    reset7dAt: number
    limitStatus: string
  }): RateLimitData {
    const nowSec = Date.now() / 1000;
    return {
      utilization5h: usageData.utilization5h,
      utilization7d: usageData.utilization7d,
      resetIn5h: Math.max(0, usageData.reset5hAt - nowSec),
      resetIn7d: Math.max(0, usageData.reset7dAt - nowSec),
      limitStatus: usageData.limitStatus as RateLimitData['limitStatus'],
      // Derive from cached reset timestamp: non-zero means a 7d limit exists
      has7dLimit: usageData.reset7dAt > 0,
    };
  }

  /** Fetch the z.ai 5h/weekly quota using the base URL + token from Claude settings. */
  private async fetchZaiRateLimit(): Promise<RateLimitData> {
    const [baseUrl, token] = await Promise.all([readClaudeBaseUrl(), readZaiToken()]);
    if (!baseUrl || !token) {
      throw new Error('z.ai base URL or auth token not configured');
    }
    return fetchZaiQuota(baseUrl, token);
  }

  private async shouldCallApi(cache: Awaited<ReturnType<typeof readCache>>): Promise<boolean> {
    if (!cache) { return true; }
    if (!isCacheValid(cache, config.cacheTtlSeconds)) {
      return await wasJsonlUpdatedRecently(300);
    }
    return false;
  }

  async refreshProjectCosts(): Promise<void> {
    try {
      const providerType = await this.resolveProvider();
      this.lastProjectCosts = await getAllProjectCosts(this.pricingContext(providerType));
    } catch {
      this.lastProjectCosts = [];
    }
  }

  getLastProjectCosts(): ProjectCostData[] {
    return this.lastProjectCosts;
  }

  async refresh(): Promise<void> {
    return this.enqueueRefresh('normal');
  }

  async forceRefresh(): Promise<void> {
    return this.enqueueRefresh('force');
  }

  /** Serialize refreshes: run one now, coalesce concurrent requests into a single re-run. */
  private async enqueueRefresh(kind: 'normal' | 'force'): Promise<void> {
    if (this.refreshing) {
      // Coalesce; a force request supersedes a queued normal one.
      if (kind === 'force' || this.queuedRefresh === null) {
        this.queuedRefresh = kind === 'force' ? 'force' : (this.queuedRefresh ?? 'normal');
      }
      if (kind === 'force') { this.queuedRefresh = 'force'; }
      return;
    }
    this.refreshing = true;
    try {
      await this.runRefresh(kind === 'force');
    } finally {
      this.refreshing = false;
      const next = this.queuedRefresh;
      this.queuedRefresh = null;
      if (next) { void this.enqueueRefresh(next); }
    }
  }

  private async runRefresh(force: boolean): Promise<void> {
    try {
      const [data] = await Promise.all([
        this.getUsageData(force),
        this.refreshProjectCosts(),
      ]);
      await this.getPrediction().catch(() => {});
      // On a forced refresh, invalidate the heatmap cache so it recomputes.
      if (force) { this.heatmapComputedAt = 0; }
      this._onDidUpdate.fire(data);

      // Persist the snapshot (usage + project costs + last heatmap) and the parse cache so
      // the next cold start is instant. Heatmap is slow — compute in background, then fire
      // a second update and re-save the snapshot with fresh heatmap data.
      await this.saveStateToDisk();
      this.refreshHeatmapBackground();
    } catch {
      // ignore refresh errors
    }
  }

  private async saveStateToDisk(): Promise<void> {
    if (this.lastData) {
      await writeSnapshot({
        usage: this.lastData,
        projectCosts: this.lastProjectCosts,
        heatmap: this.lastHeatmapData,
      });
    }
    const now = Date.now();
    if (now - this.lastParseCachePersistAt >= this.parseCachePersistIntervalMs) {
      this.lastParseCachePersistAt = now;
      await persistCache(config.heatmapDays * 24 * 3600 * 1000);
    }
  }

  /**
   * Load persisted parse cache + dashboard snapshot from disk once on startup, so the
   * status bar and first dashboard open render immediately (marked stale) before the
   * first live refresh completes.
   */
  async loadFromDisk(): Promise<void> {
    if (this.diskLoaded) { return; }
    this.diskLoaded = true;
    await loadPersistedCache().catch(() => {});
    const snapshot = await readSnapshot().catch(() => null);
    if (snapshot) {
      // Mark stale: this is last-known data pending a background refresh.
      this.lastData = { ...snapshot.usage, dataSource: 'stale' };
      // The snapshot file is shared by every VSCode window, so its project costs may
      // belong to a different workspace. Only render entries matching this window's
      // folders; the background refresh fills in the rest.
      const wanted = new Set(
        (vscode.workspace.workspaceFolders ?? []).map((f) => workspacePathToHash(f.uri.fsPath)),
      );
      this.lastProjectCosts = snapshot.projectCosts.filter(
        (p) => wanted.has(path.basename(p.projectPath)),
      );
      this.lastHeatmapData = snapshot.heatmap;
      this._onDidUpdate.fire(this.lastData);
    }
  }

  private refreshHeatmapBackground(): void {
    if (this.heatmapPending) { return; }
    this.heatmapPending = true;
    this.getHeatmapData().then(() => {
      this.heatmapPending = false;
      const freshData = this.lastData;
      if (freshData) { this._onDidUpdate.fire(freshData); }
      // Re-save the snapshot now that the heatmap is fresh.
      void this.saveStateToDisk();
    }).catch(() => { this.heatmapPending = false; });
  }

  startWatching(): void {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(path.join(os.homedir(), '.claude', 'projects')),
      '**/*.jsonl'
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    // Debounce: Claude Code appends to its session JSONL many times per second during a
    // streaming response. Coalesce that burst into a single refresh ~2s after it settles
    // instead of firing one heavy refresh per event (which overloaded the Extension Host).
    const onChange = (): void => {
      if (this.watcherTimer) { clearTimeout(this.watcherTimer); }
      // Trailing debounce, floored by the per-instance rate limit: with several windows
      // open, a stream in one window must not drive constant refreshes in all of them.
      const delay = Math.max(2000, this.lastWatcherRefreshAt + this.watcherMinIntervalMs - Date.now());
      this.watcherTimer = setTimeout(() => {
        this.watcherTimer = undefined;
        this.lastWatcherRefreshAt = Date.now();
        this.refresh().catch(() => {});
      }, delay);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
  }

  async getPrediction(): Promise<PredictionData | null> {
    if (!this.lastData) { return null; }
    try {
      const prediction = await computePrediction(
        this.lastData.utilization5h,
        this.lastData.resetIn5h,
        this.lastData.cost5h,
        this.lastData.costDay,
        config.dailyBudget,
      );
      this.lastPrediction = prediction;
      return prediction;
    } catch {
      return this.lastPrediction;
    }
  }

  getLastPrediction(): PredictionData | null {
    return this.lastPrediction;
  }

  async getHeatmapData(): Promise<HeatmapData | null> {
    const now = Date.now();
    if (this.lastHeatmapData && now - this.heatmapComputedAt < this.heatmapTtlMs) {
      return this.lastHeatmapData;
    }
    try {
      const providerType = await this.resolveProvider();
      const data = await computeHeatmapData(config.heatmapDays, this.pricingContext(providerType));
      this.lastHeatmapData = data;
      this.heatmapComputedAt = now;
      return data;
    } catch {
      return this.lastHeatmapData; // return stale on error
    }
  }

  getLastHeatmapData(): HeatmapData | null {
    return this.lastHeatmapData;
  }

  getLastData(): ClaudeUsageData | undefined {
    return this.lastData;
  }

  dispose(): void {
    if (this.watcherTimer) { clearTimeout(this.watcherTimer); this.watcherTimer = undefined; }
    this.watcher?.dispose();
    this._onDidUpdate.dispose();
    // Best-effort flush of any parse progress the persist throttle was holding back.
    void persistCache(config.heatmapDays * 24 * 3600 * 1000);
  }
}
