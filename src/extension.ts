import * as vscode from 'vscode';
import { DataManager, ClaudeUsageData, PredictionData } from './data/dataManager';
import { StatusBarManager, formatDuration } from './statusBar';
import { config } from './config';
import { decideRateLimitNotifications, rateSignalsFor, RateLimitNotification } from './data/notificationDecision';

// --- Notification system ---
// Deduplication: bucket keys (e.g. '5h-92', '7d-85') are cleared per window when that
// window resets, so each step re-arms exactly once per fresh window.
const notifiedKeys = new Set<string>();
let prevResetIn5h = 0;
let prevResetIn7d = 0;

/** Drop all dedup keys for a window (prefix '5h-' / '7d-'). */
function clearWindowKeys(prefix: string): void {
  for (const key of notifiedKeys) {
    if (key.startsWith(prefix)) { notifiedKeys.delete(key); }
  }
}

function checkWindowResets(resetIn5h: number, resetIn7d: number): void {
  // If resetIn increased by more than 1 hour, that window has rolled over.
  if (resetIn5h > prevResetIn5h + 3600) {
    clearWindowKeys('5h-');
    notifiedKeys.delete('budget'); // re-arm the daily budget alert on each 5h rollover (prior behavior)
  }
  if (resetIn7d > prevResetIn7d + 3600) {
    clearWindowKeys('7d-');
  }
  prevResetIn5h = resetIn5h;
  prevResetIn7d = resetIn7d;
}

async function showRateLimitNotification(n: RateLimitNotification): Promise<void> {
  const reset = formatDuration(n.resetIn);
  if (n.reached) {
    const action = await vscode.window.showErrorMessage(
      vscode.l10n.t('Claude Code: 5h rate limit reached — resets in {0}', reset),
      vscode.l10n.t('Open Dashboard'), vscode.l10n.t('Dismiss')
    );
    if (action === vscode.l10n.t('Open Dashboard')) {
      vscode.commands.executeCommand('vscode-claude-status.openDashboard');
    }
    return;
  }
  const message = n.window === '5h'
    ? vscode.l10n.t('Claude Code: 5h limit {0}% used — resets in {1}', n.percentUsed, reset)
    : vscode.l10n.t('Claude Code: 7d limit {0}% used — resets in {1}', n.percentUsed, reset);
  vscode.window.showWarningMessage(message);
}

async function checkAndNotify(data: ClaudeUsageData, prediction: PredictionData | null): Promise<void> {
  // Both the rollover check and the warnings need live utilization; without it they would act
  // on an old cache or on zeros (see rateSignalsFor).
  const signals = rateSignalsFor(data);
  if (signals) {
    checkWindowResets(signals.resetIn5h, signals.resetIn7d);
  }

  // Rate limit warnings — driven by actual quota utilization, not a time prediction.
  if (config.rateLimitWarning && signals) {
    const notifications = decideRateLimitNotifications(signals, config.rateLimitThresholds, notifiedKeys);
    for (const n of notifications) {
      notifiedKeys.add(n.key); // mark before await to prevent duplicates
      await showRateLimitNotification(n);
    }
  }

  // Budget warning
  if (!prediction) { return; }
  if (config.budgetWarning && prediction.budgetRemaining !== null && config.dailyBudget !== null) {
    const remainingPct = (prediction.budgetRemaining / config.dailyBudget) * 100;
    if (remainingPct <= (100 - config.budgetAlertThreshold) && !notifiedKeys.has('budget')) {
      notifiedKeys.add('budget');
      const used = (config.dailyBudget - prediction.budgetRemaining).toFixed(2);
      vscode.window.showWarningMessage(
        vscode.l10n.t('Claude Code: Daily budget {0}% used (${1} / ${2})', config.budgetAlertThreshold, used, config.dailyBudget)
      );
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const dataManager = DataManager.getInstance();
  const statusBar = new StatusBarManager();

  // Helper: update status bar with latest usage + project costs
  function updateStatusBar(): void {
    const data = dataManager.getLastData();
    if (data) {
      statusBar.update(data, dataManager.getLastProjectCosts());
    }
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-claude-status.openDashboard', () => {
      import(/* webpackChunkName: "panel" */ './webview/panel.js')
        .then(({ DashboardPanel }) => DashboardPanel.createOrShow(dataManager, context.extensionUri))
        .catch(() => {});
    }),
    vscode.commands.registerCommand('vscode-claude-status.refresh', async () => {
      await dataManager.forceRefresh();
    }),
    vscode.commands.registerCommand('vscode-claude-status.toggleDisplayMode', async () => {
      const next = config.displayMode === 'percent' ? 'cost' : 'percent';
      await config.setDisplayMode(next);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('vscode-claude-status.setBudget', async () => {
      const current = config.dailyBudget;
      const input = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Set daily budget in USD (leave empty to disable)'),
        value: current !== null ? String(current) : '',
        placeHolder: vscode.l10n.t('e.g. 20'),
        validateInput: (v) => {
          if (v === '') { return null; }
          const n = parseFloat(v);
          if (isNaN(n) || n < 0) { return vscode.l10n.t('Enter a non-negative number, or leave empty to disable'); }
          return null;
        },
      });
      if (input === undefined) { return; } // cancelled
      const value = input === '' ? null : parseFloat(input);
      await config.setDailyBudget(value);
      vscode.window.showInformationMessage(
        value === null
          ? vscode.l10n.t('Daily budget disabled.')
          : vscode.l10n.t('Daily budget set to ${0}.', value.toFixed(2))
      );
    }),
  );

  // React to data updates (usage + project costs are refreshed together)
  context.subscriptions.push(
    dataManager.onDidUpdate(data => {
      statusBar.update(data, dataManager.getLastProjectCosts());
      // Check for rate limit / budget notifications
      const prediction = dataManager.getLastPrediction();
      checkAndNotify(data, prediction).catch(() => {});
    })
  );

  // Re-render on settings change without restart
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeStatus')) {
        updateStatusBar();
      }
    })
  );

  // Re-fetch project costs when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      dataManager.refreshProjectCosts().then(() => updateStatusBar()).catch(() => {});
    })
  );

  // Start JSONL file watcher
  dataManager.startWatching();

  // Cold start: render the last on-disk snapshot immediately (marked stale), then do a
  // live load in the background. loadFromDisk() fires onDidUpdate, so the status bar and any
  // open dashboard render at once without waiting for a full JSONL re-parse. The follow-up
  // uses refresh() (not a bare getUsageData) so it also fires onDidUpdate — refreshing the
  // dashboard and running checkAndNotify on the fresh data, not just the status bar.
  dataManager.loadFromDisk()
    .then(() => dataManager.refresh())
    .catch(() => {
      // graceful degradation: status bar stays in "loading..." state
    });

  // Timer: full periodic refresh every 60 seconds. Uses refresh() (not a bare
  // getUsageData) so it fires onDidUpdate — updating BOTH the status bar and an open
  // dashboard — and re-fetches provider quota (z.ai) / rate limits when the cache is
  // stale. This makes auto-update independent of the file watcher, which is unreliable
  // for ~/.claude/projects (outside the workspace). API calls remain gated by the cache
  // TTL + recent-activity check, so idle sessions still don't poll.
  const timer = setInterval(() => {
    dataManager.refresh().catch(() => {});
  }, 60_000);

  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    { dispose: () => statusBar.dispose() },
    { dispose: () => dataManager.dispose() },
  );
}

export function deactivate() {
  // Fire-and-forget: webpack returns the cached module synchronously if already loaded
  import('./webview/panel.js').then(({ DashboardPanel }) => DashboardPanel.dispose()).catch(() => {});
}
