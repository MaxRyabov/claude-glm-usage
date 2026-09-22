import * as vscode from 'vscode';
import { ClaudeUsageData, ProjectCostData } from './data/dataManager';
import { config } from './config';

export function formatDuration(seconds: number): string {
  if (seconds < 3600) {
    return vscode.l10n.t('{0}m', Math.round(seconds / 60));
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    if (mins === 0) { return vscode.l10n.t('{0}h', hours); }
    return vscode.l10n.t('{0}h {1}m', hours, mins);
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  if (hours === 0) { return vscode.l10n.t('{0}d', days); }
  return vscode.l10n.t('{0}d {1}h', days, hours);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return `${n}`;
}

function formatPercent(util: number): string {
  return `${Math.round(util * 100)}%`;
}

function buildBar(utilization: number, width: number): string {
  const filled = Math.round(Math.min(1, utilization) * width);
  return 'X'.repeat(filled) + '.'.repeat(width - filled);
}

function truncateName(name: string): string {
  return name.length > 12 ? name.slice(0, 11) + '…' : name;
}

export function buildLabel(data: ClaudeUsageData, projectCosts: ProjectCostData[] = []): string {
  const { dataSource, utilization5h, utilization7d, limitStatus, cost5h, cost7d, cacheAge, has7dLimit, providerType } = data;
  const displayMode = config.displayMode;

  if (dataSource === 'no-credentials') {
    return vscode.l10n.t('🤖 Not logged in');
  }
  if (dataSource === 'no-data') {
    // "Run refresh" would not help an expired login: only Claude Code can renew the token.
    return data.pollNotice === 'token-expired'
      ? vscode.l10n.t('🤖 Login expired')
      : vscode.l10n.t('🤖 Claude: run refresh');
  }
  if (dataSource === 'auth-rejected') {
    if (providerType === 'claude-ai') {
      return data.rejectionStatus === 403
        ? vscode.l10n.t('🤖 Access refused')
        : vscode.l10n.t('🤖 Login rejected');
    }
    return vscode.l10n.t('🤖 API key rejected');
  }

  const isStale = dataSource === 'stale';
  const staleSuffix = isStale ? ` [${formatDuration(cacheAge)} ago]` : '';

  // claude-ai and z-ai expose utilization windows; other providers (Bedrock, API key)
  // and any provider without live rate data (local-only) always use cost mode.
  const supportsRateLimit = providerType === 'claude-ai' || providerType === 'z-ai';
  const useCostMode = !supportsRateLimit || dataSource === 'local-only' || displayMode === 'cost';

  let part5h: string;
  let part7d: string;

  if (useCostMode) {
    part5h = `5h:$${cost5h.toFixed(2)}`;
    part7d = ` 7d:$${cost7d.toFixed(2)}`;
  } else {
    // percent mode — claude-ai and z-ai
    //
    // The denial marker goes on the window that is actually spent. This used to print a flat
    // "5h:100%✗" and hide the weekly window, which was true for Anthropic — its denial comes
    // from the 5-hour status header — but not for z.ai, where either window can reach 100%.
    // A live token tariff sits at 100% weekly with an empty 5-hour window, and the old text
    // said exactly the opposite of that.
    const denied = limitStatus === 'denied';
    // Anthropic can deny via the header without either utilization reaching 1; that denial
    // refers to the 5-hour window, so it keeps the marker.
    const deniedWithoutFullWindow =
      denied && utilization5h < 1 && !(has7dLimit && utilization7d >= 1);
    const marker = (utilization: number, forceDenied: boolean): string => {
      if (utilization >= 1 || forceDenied) { return '✗'; }
      return utilization >= 0.75 ? '⚠' : '';
    };

    part5h = `5h:${formatPercent(utilization5h)}${marker(utilization5h, deniedWithoutFullWindow)}`;
    part7d = has7dLimit
      ? ` 7d:${formatPercent(utilization7d)}${marker(utilization7d, false)}`
      : '';
  }

  // Project cost suffix
  let projectPart = '';
  if (config.showProjectCost && projectCosts.length > 0) {
    if (projectCosts.length === 1) {
      const pj = projectCosts[0];
      const shortName = truncateName(pj.projectName);
      projectPart = ` | ${shortName}:$${pj.costToday.toFixed(2)}`;
    } else {
      // Multi-root: aggregate
      const total = projectCosts.reduce((sum, p) => sum + p.costToday, 0);
      projectPart = ` | PJ:$${total.toFixed(2)}`;
    }
  }

  const main = `🤖 ${part5h}${part7d}${projectPart}`;
  return isStale ? `${main}${staleSuffix}` : main;
}

// The login command is `claude auth login`: Claude Code has no `claude login` subcommand, and
// that string used to be the advice here.
function notLoggedInHint(providerType: ClaudeUsageData['providerType']): string {
  if (providerType === 'claude-ai') {
    return vscode.l10n.t('Claude Code is not logged in.\nRun: claude auth login');
  }
  if (providerType === 'z-ai') {
    return vscode.l10n.t('z.ai API key is not configured.\nSet ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json');
  }
  // 'unknown' is what auto-detection returns when it found no credential of any kind — the
  // user may be heading for either provider, so both ways in are named.
  return vscode.l10n.t('Claude Code is not logged in.\nRun: claude auth login — or, for z.ai, set ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json');
}

function rejectedHint(providerType: ClaudeUsageData['providerType'], status: 401 | 403 | undefined): string {
  if (providerType === 'claude-ai') {
    // 403 also comes from region, organization policy or a proxy, where logging in again does
    // nothing. A status lost on the way (restored from a snapshot) reads as the common 401.
    if (status === 403) {
      return vscode.l10n.t('Anthropic refused access (HTTP 403).\nThis is not always a login problem: check region, organization policy or proxy.');
    }
    // The pause after a refusal lifts only on success, so the user has to trigger that refresh.
    // The command is named exactly as the palette shows it (package.nls*.json, cmd.refresh).
    return vscode.l10n.t('Anthropic rejected your Claude Code login.\nRun: claude auth login, then "Claude+GLM: Refresh Now"');
  }
  return vscode.l10n.t('The provider rejected your API key.\nCheck ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in ~/.claude/settings.json');
}

export function buildTooltip(data: ClaudeUsageData, projectCosts: ProjectCostData[] = []): string {
  const {
    utilization5h, utilization7d, resetIn5h, resetIn7d,
    cost5h, costDay, cost7d, tokensIn5h, tokensOut5h,
    cacheAge, dataSource, has7dLimit, providerType,
  } = data;

  const tokenExpired = data.pollNotice === 'token-expired'
    ? vscode.l10n.t('Claude Code login token expired — any Claude Code request refreshes it')
    : null;

  if (dataSource === 'no-credentials') {
    return notLoggedInHint(providerType);
  }
  if (dataSource === 'no-data') {
    const hint = vscode.l10n.t('No usage data found.\nClick to open dashboard →');
    return tokenExpired ? `${tokenExpired}\n${hint}` : hint;
  }
  if (dataSource === 'auth-rejected') {
    return rejectedHint(providerType, data.rejectionStatus);
  }

  const lastUpdated = cacheAge < 60
    ? vscode.l10n.t('just now')
    : vscode.l10n.t('{0} ago', formatDuration(cacheAge));
  const lines: string[] = [];
  if (tokenExpired) { lines.push(tokenExpired, ''); }

  // Rate-limit section — claude-ai (Anthropic windows) and z-ai (quota), when live data exists
  const supportsRateLimit = providerType === 'claude-ai' || providerType === 'z-ai';
  if (supportsRateLimit && dataSource !== 'local-only') {
    const title = providerType === 'z-ai' ? vscode.l10n.t('Z.AI Usage') : vscode.l10n.t('Claude Code Usage');
    const bar5h = buildBar(utilization5h, 8);
    lines.push(
      title,
      '─────────────────────────────',
      `5h window:   ${formatPercent(utilization5h)} [${bar5h}] resets in ${formatDuration(resetIn5h)}`,
    );
    if (has7dLimit) {
      const bar7d = buildBar(utilization7d, 8);
      lines.push(`7d window:   ${formatPercent(utilization7d)} [${bar7d}] resets in ${formatDuration(resetIn7d)}`);
    }
    lines.push('');
  } else {
    const providerLabel = providerType === 'aws-bedrock' ? vscode.l10n.t('AWS Bedrock')
      : providerType === 'api-key' ? vscode.l10n.t('API Key')
      : providerType === 'z-ai' ? vscode.l10n.t('Z.AI / GLM')
      : providerType === 'custom-endpoint' ? vscode.l10n.t('Custom endpoint')
      : vscode.l10n.t('Claude Code');
    lines.push(`Claude Code (${providerLabel})`, '─────────────────────────────', '');
  }

  lines.push(
    vscode.l10n.t('Token Cost (local)'),
    '─────────────────────────────',
    `5h:   in:${formatTokens(tokensIn5h)} out:${formatTokens(tokensOut5h)}  $${cost5h.toFixed(2)}`,
    `day:  $${costDay.toFixed(2)}`,
    `7d:   $${cost7d.toFixed(2)}`,
  );

  if (projectCosts.length > 0) {
    lines.push('');
    for (const pj of projectCosts) {
      lines.push(vscode.l10n.t('Project: {0}', pj.projectName));
      lines.push(`  ${vscode.l10n.t('Today')}: $${pj.costToday.toFixed(2)}  |  ${vscode.l10n.t('7 days')}: $${pj.cost7d.toFixed(2)}`);
    }
  }

  lines.push('', vscode.l10n.t('Last updated: {0}', lastUpdated), vscode.l10n.t('Click to open dashboard →'));
  return lines.join('\n');
}

function applyColor(item: vscode.StatusBarItem, data: ClaudeUsageData): void {
  const { limitStatus, dataSource, providerType } = data;

  // A refused credential is the user's problem to fix, so it gets the error colour rather
  // than the muted one used for data that is merely stale.
  if (dataSource === 'no-credentials' || dataSource === 'auth-rejected') {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    return;
  }

  if (dataSource === 'stale') {
    item.backgroundColor = undefined;
    item.color = new vscode.ThemeColor('descriptionForeground');
    return;
  }

  // Providers without live rate-limit data don't get warning/error colors.
  // claude-ai and z-ai (when not in cost-only local mode) do.
  const supportsRateLimit = providerType === 'claude-ai' || providerType === 'z-ai';
  if (!supportsRateLimit || dataSource === 'local-only') {
    item.backgroundColor = undefined;
    item.color = undefined;
    return;
  }

  switch (limitStatus) {
    case 'denied':
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      break;
    case 'allowed_warning':
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      break;
    default:
      item.backgroundColor = undefined;
      item.color = undefined;
  }
}

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    const alignment = config.statusBarAlignment === 'right'
      ? vscode.StatusBarAlignment.Right
      : vscode.StatusBarAlignment.Left;
    this.item = vscode.window.createStatusBarItem(alignment, 100);
    this.item.name = vscode.l10n.t('Claude Code Usage');
    this.item.command = 'vscode-claude-status.openDashboard';
    this.item.text = vscode.l10n.t('🤖 Claude: loading...');
    this.item.show();
  }

  update(data: ClaudeUsageData, projectCosts: ProjectCostData[] = []): void {
    this.item.text = buildLabel(data, projectCosts);
    this.item.tooltip = buildTooltip(data, projectCosts);
    applyColor(this.item, data);
  }

  dispose(): void {
    this.item.dispose();
  }
}
