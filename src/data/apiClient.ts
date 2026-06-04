import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Actual structure of ~/.claude/.credentials.json (verified against Claude Code v2.1.x)
// macOS stores these in Keychain under service "Claude Code-credentials" with the same JSON format.
interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string
    expiresAt: number
  }
}

export type ClaudeProvider = 'claude-ai' | 'z-ai' | 'custom-endpoint' | 'aws-bedrock' | 'api-key' | 'unknown';

export interface RateLimitData {
  utilization5h: number
  utilization7d: number
  resetIn5h: number
  resetIn7d: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'
  has7dLimit: boolean
}

/**
 * Read ANTHROPIC_BASE_URL the way Claude Code resolves it: process env first, then
 * ~/.claude/settings.json, then ~/.claude/settings.local.json (the `env` object).
 * Claude Code applies settings.json `env` when it launches the CLI, so it is NOT in
 * the extension host's process.env — we must read the files directly. Reads are
 * confined to ~/.claude and tolerate missing/malformed files (graceful degradation).
 */
export async function readClaudeEnvVar(name: string, claudeDirOverride?: string): Promise<string | null> {
  const fromEnv = process.env[name];
  if (fromEnv) { return fromEnv; }

  const claudeDir = claudeDirOverride ?? path.join(os.homedir(), '.claude');
  for (const file of ['settings.json', 'settings.local.json']) {
    try {
      const raw = await fs.readFile(path.join(claudeDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as { env?: Record<string, string> };
      const value = parsed?.env?.[name];
      if (typeof value === 'string' && value.length > 0) { return value; }
    } catch {
      // missing or malformed — try the next file
    }
  }
  return null;
}

export async function readClaudeBaseUrl(claudeDirOverride?: string): Promise<string | null> {
  return readClaudeEnvVar('ANTHROPIC_BASE_URL', claudeDirOverride);
}

/** The z.ai auth token Claude Code sends — its API key, under either env name. */
export async function readZaiToken(claudeDirOverride?: string): Promise<string | null> {
  return (await readClaudeEnvVar('ANTHROPIC_AUTH_TOKEN', claudeDirOverride))
    ?? (await readClaudeEnvVar('ANTHROPIC_API_KEY', claudeDirOverride));
}

/**
 * Classify a base URL. An Anthropic host (or no URL) returns null so the normal
 * credential/env probing runs; any other host is a third-party provider.
 */
export function classifyBaseUrl(baseUrl: string | null): 'z-ai' | 'custom-endpoint' | null {
  if (!baseUrl) { return null; }
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null; // not a parseable URL — ignore
  }
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) { return null; }
  if (host === 'z.ai' || host.endsWith('.z.ai')) { return 'z-ai'; }
  return 'custom-endpoint';
}

export async function detectProvider(customCredPath?: string | null): Promise<ClaudeProvider> {
  // 0. A custom ANTHROPIC_BASE_URL wins over everything. This must come BEFORE the
  // credential probe so a stale claudeAiOauth file does not cause a misleading
  // rate-limit call to api.anthropic.com when the user is actually on z.ai.
  const customProvider = classifyBaseUrl(await readClaudeBaseUrl());
  if (customProvider) { return customProvider; }

  // 1. Check for OAuth credentials (Claude.ai subscription)
  try {
    await readCredentials(customCredPath);
    return 'claude-ai';
  } catch {
    // No valid OAuth token — check other providers
  }

  // 2. Check for AWS Bedrock-specific env vars
  if (
    process.env['ANTHROPIC_BEDROCK_BASE_URL'] ??
    process.env['AWS_BEDROCK_RUNTIME_URL'] ??
    process.env['CLAUDE_AWS_REGION']
  ) {
    return 'aws-bedrock';
  }

  // 3. Check for direct Anthropic API key
  if (process.env['ANTHROPIC_API_KEY']) {
    return 'api-key';
  }

  return 'unknown';
}

// On macOS, Claude Code stores credentials in Keychain under this service name
// instead of (or in addition to) ~/.claude/.credentials.json.
const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';

async function readCredentialsFromKeychain(): Promise<string> {
  // Use execFile with an argument array (no shell) so the service name cannot be
  // interpreted as shell syntax — eliminates the command-injection vector (C-2).
  const { stdout } = await execFileAsync(
    '/usr/bin/security',
    ['find-generic-password', '-s', MACOS_KEYCHAIN_SERVICE, '-w']
  );
  const creds = JSON.parse(stdout.trim()) as ClaudeCredentials;
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error('No OAuth access token in macOS Keychain');
  }
  return token;
}

/**
 * Resolve a credentials path and confirm it stays inside ~/.claude/ (C-1).
 * Throws if the resolved path escapes the directory (e.g. via `..` or an absolute
 * path like /etc/passwd), preventing the setting from reading arbitrary files.
 */
export function validateCredentialsPath(p: string): string {
  const resolved = path.resolve(p);
  const claudeDir = path.resolve(path.join(os.homedir(), '.claude'));
  if (!resolved.startsWith(claudeDir + path.sep) && resolved !== claudeDir) {
    throw new Error(`Credentials path must be inside ~/.claude/: ${resolved}`);
  }
  return resolved;
}

async function readCredentials(customPath?: string | null): Promise<string> {
  const rawPath = customPath ?? path.join(os.homedir(), '.claude', '.credentials.json');
  const credPath = validateCredentialsPath(rawPath);
  try {
    const content = await fs.readFile(credPath, 'utf-8');
    const creds = JSON.parse(content) as ClaudeCredentials;
    const token = creds.claudeAiOauth?.accessToken;
    if (!token) {
      throw new Error('No OAuth access token found in credentials file');
    }
    return token;
  } catch {
    // On macOS with no credentials file, fall back to Keychain (Claude Code v2.x+)
    if (process.platform === 'darwin' && (customPath === null || customPath === undefined)) {
      return readCredentialsFromKeychain();
    }
    throw new Error('No Claude.ai credentials found');
  }
}

export async function fetchRateLimitData(customCredPath?: string | null): Promise<RateLimitData> {
  const token = await readCredentials(customCredPath);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    }),
  });

  const util5h = parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization') ?? '0');
  const util7d = parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization') ?? '0');
  const reset5hStr = response.headers.get('anthropic-ratelimit-unified-5h-reset');
  const reset7dStr = response.headers.get('anthropic-ratelimit-unified-7d-reset');
  // Status header value is "allowed" or "denied" (not a boolean)
  const status5h = response.headers.get('anthropic-ratelimit-unified-5h-status');

  // 7d limit is only present on Claude.ai Max plans — detect by header presence
  const has7dLimit = reset7dStr !== null;

  // Reset values are Unix timestamps in seconds (not ISO date strings)
  const nowSec = Date.now() / 1000;
  const resetIn5h = reset5hStr ? Math.max(0, parseInt(reset5hStr, 10) - nowSec) : 0;
  const resetIn7d = reset7dStr ? Math.max(0, parseInt(reset7dStr, 10) - nowSec) : 0;

  let limitStatus: 'allowed' | 'allowed_warning' | 'denied';
  if (status5h === 'denied') {
    limitStatus = 'denied';
  } else if (util5h >= 0.75 || (has7dLimit && util7d >= 0.75)) {
    limitStatus = 'allowed_warning';
  } else {
    limitStatus = 'allowed';
  }

  return { utilization5h: util5h, utilization7d: util7d, resetIn5h, resetIn7d, limitStatus, has7dLimit };
}

// --- z.ai quota -------------------------------------------------------------
// z.ai exposes the same 5-hour + weekly quota shown on its subscription dashboard
// via an internal monitor endpoint (undocumented but stable; used by several usage
// trackers). data.limits[] holds TOKENS_LIMIT entries with a `percentage` (0–100)
// and `nextResetTime` (epoch ms); unit/number describe the window (5 hours vs 7 days).
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';

interface ZaiLimitEntry {
  type?: string
  unit?: number
  number?: number
  percentage?: number
  nextResetTime?: number | null
}

interface ZaiQuotaResponse {
  code?: number
  success?: boolean
  data?: { limits?: ZaiLimitEntry[] }
}

// unit codes vary across z.ai plans; map to a duration so we can tell the short
// (5-hour) window from the long (weekly) one regardless of the exact code.
function zaiUnitToMs(unit?: number): number {
  switch (unit) {
    case 5: return 60_000;            // minutes
    case 3: return 3_600_000;         // hours
    case 1: case 2: case 6: return 86_400_000; // days
    default: return 3_600_000;
  }
}

function clamp01(n: number): number {
  if (!isFinite(n) || n < 0) { return 0; }
  return n > 1 ? 1 : n;
}

export function parseZaiQuota(json: unknown): RateLimitData {
  const resp = (json ?? {}) as ZaiQuotaResponse;
  const limits = Array.isArray(resp.data?.limits) ? resp.data!.limits! : [];
  const tokenLimits = limits.filter(l => l?.type === 'TOKENS_LIMIT');

  const windows = tokenLimits.map(l => ({ l, ms: (l.number ?? 0) * zaiUnitToMs(l.unit) }));
  // Short window (< 1 day) is the 5-hour quota; long window is the weekly quota.
  const five = windows.find(w => w.ms < 86_400_000)?.l ?? windows[0]?.l;
  const weekly = windows.find(w => w.ms >= 86_400_000)?.l;

  const nowSec = Date.now() / 1000;

  // Reset horizon in seconds. z.ai doesn't always return a reset timestamp for the
  // 5-hour rolling window (its dashboard only shows the weekly reset), so fall back
  // to the window's own length (unit × number) — known from the entry — instead of 0.
  // A non-zero horizon is what the dashboard's prediction chart needs to render.
  const resetSeconds = (entry?: ZaiLimitEntry): number => {
    if (!entry) { return 0; }
    if (entry.nextResetTime) {
      const s = entry.nextResetTime / 1000 - nowSec;
      if (s > 0) { return s; }
    }
    return ((entry.number ?? 0) * zaiUnitToMs(entry.unit)) / 1000;
  };

  const util5h = five ? clamp01((five.percentage ?? 0) / 100) : 0;
  const util7d = weekly ? clamp01((weekly.percentage ?? 0) / 100) : 0;
  const resetIn5h = resetSeconds(five);
  const resetIn7d = resetSeconds(weekly);
  const has7dLimit = weekly !== undefined;

  const limitStatus: RateLimitData['limitStatus'] =
    (util5h >= 0.75 || (has7dLimit && util7d >= 0.75)) ? 'allowed_warning' : 'allowed';

  return { utilization5h: util5h, utilization7d: util7d, resetIn5h, resetIn7d, limitStatus, has7dLimit };
}

export async function fetchZaiQuota(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitData> {
  // Derive the monitor host from the configured base URL's origin so this works
  // for api.z.ai as well as regional/coding-plan hosts.
  const origin = new URL(baseUrl).origin;
  const url = origin + ZAI_QUOTA_PATH;

  // Standard plans accept `Bearer <token>`; z.ai coding-plan endpoints accept the
  // token directly. Try Bearer first, then fall back to the raw token on 401/403.
  const authVariants = [`Bearer ${token}`, token];
  let lastStatus = 0;
  for (const authorization of authVariants) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Authorization': authorization, 'Accept': 'application/json' },
    });
    if (response.ok) {
      return parseZaiQuota(await response.json());
    }
    lastStatus = response.status;
    if (response.status !== 401 && response.status !== 403) {
      break; // non-auth error — retrying with a different token format won't help
    }
  }
  throw new Error(`z.ai quota request failed (HTTP ${lastStatus})`);
}
