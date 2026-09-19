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

/** How a plan meters its quota: an absolute credit budget, or a percentage-only token cap. */
export type QuotaBilling = 'credits' | 'tokens';

/**
 * Absolute amounts for one quota window. `remaining` is optional because the API does not
 * always send it, and it is never recomputed from used/total — upstream rounds it
 * (28000 - 16693 = 11307 arrives as 11306, because credits are fractional).
 */
export interface QuotaAmounts {
  used: number
  total: number
  remaining?: number
}

export interface RateLimitData {
  utilization5h: number
  utilization7d: number
  resetIn5h: number
  resetIn7d: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'
  has7dLimit: boolean
  // The fields below are populated by the z.ai parser only; the Anthropic path leaves them
  // undefined, which is what keeps that path unchanged by construction.
  billing?: QuotaBilling
  planLevel?: string
  credits5h?: QuotaAmounts
  credits7d?: QuotaAmounts
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

export async function fetchRateLimitData(
  customCredPath?: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitData> {
  const token = await readCredentials(customCredPath);

  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
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

  // Clamp to the 0..1 contract (cache validation enforces it too); a malformed header
  // must not surface as a NaN/out-of-range utilization downstream.
  const util5h = clamp01(parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization') ?? '0'));
  const util7d = clamp01(parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization') ?? '0'));
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
// z.ai exposes the same 5-hour + weekly quota shown on its subscription dashboard via an
// internal monitor endpoint (undocumented but stable). Two payload generations are live:
//
//   token tariffs:  `TOKENS_LIMIT` entries carrying a `percentage` only, plus a monthly
//                   `TIME_LIMIT` entry for the MCP allowance.
//   credit tariffs: `CREDIT_LIMIT` entries carrying absolute credit amounts and no MCP entry.
//
// Older deployments sent neither `unit` nor `number`, naming the period nowhere. Every entry
// is therefore classified on its own — there is deliberately no global format-version switch,
// because a half-migrated payload would be routed wholly to the wrong parser.
const ZAI_QUOTA_PATH = '/api/monitor/usage/quota/limit';

interface ZaiLimitEntry {
  type?: string
  /** Period unit: 3 = hours, 5 = months, 6 = weeks. Absent before 2026-09; 1/2/4 unobserved. */
  unit?: number
  /** How many `unit`s the window spans: `unit: 3, number: 5` is the 5-hour window. */
  number?: number
  /** Integer percent consumed. */
  percentage?: number
  /** Amount USED — credits, or MCP calls on TIME_LIMIT. See `usage`: the naming is inverted. */
  currentValue?: number
  /** The CAP, not the usage. z.ai's naming is genuinely backwards here. */
  usage?: number
  /** Cap minus used, ROUNDED by upstream — never recompute it. */
  remaining?: number
  /** Epoch MILLISECONDS. Omitted entirely for an idle 5-hour window. */
  nextResetTime?: number | null
}

interface ZaiQuotaResponse {
  code?: number
  msg?: string
  success?: boolean
  data?: {
    limits?: ZaiLimitEntry[]
    /** Plan tier: lite | pro | max. */
    level?: string
  }
}

const ZAI_UNIT_HOUR = 3;
const ZAI_UNIT_MONTH = 5;
const ZAI_UNIT_WEEK = 6;

const ZAI_TOKENS_LIMIT = 'TOKENS_LIMIT';
const ZAI_CREDIT_LIMIT = 'CREDIT_LIMIT';
const ZAI_TIME_LIMIT = 'TIME_LIMIT';

/**
 * A 5-hour window can never be more than five hours from resetting, so anything further out
 * is provably not the 5-hour cap; the extra hour absorbs clock skew against z.ai's server.
 *
 * This only rules candidates OUT. It can never rule one IN: an exhausted weekly cap was
 * observed resetting 40 minutes BEFORE the 5-hour window on the same account.
 */
const ZAI_SHORT_WINDOW_HORIZON_MS = 6 * 3_600_000;

const ZAI_FIVE_HOUR_SECONDS = 5 * 3600;
const ZAI_WEEK_SECONDS = 7 * 86_400;
/** Beyond this a reset time is upstream nonsense (seconds sent as ms lands ~55 000 years out). */
const ZAI_MAX_RESET_HORIZON_SECONDS = 400 * 86_400;
/** Results reach the on-disk cache, so an unexpectedly huge response must not inflate it. */
const ZAI_MAX_LIMIT_ENTRIES = 32;
/** `level` is a free-form external string that ends up in WebView markup. */
const ZAI_MAX_LEVEL_LENGTH = 32;

type ZaiWindowKind = '5h' | 'week' | 'mcp' | 'other';

function clamp01(n: number): number {
  if (!isFinite(n) || n < 0) { return 0; }
  return n > 1 ? 1 : n;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

/** The envelope's `data.limits`, defensively unwrapped and bounded. Never throws. */
function zaiLimitsOf(json: unknown): ZaiLimitEntry[] {
  if (!json || typeof json !== 'object') { return []; }
  const raw = (json as ZaiQuotaResponse).data?.limits;
  if (!Array.isArray(raw)) { return []; }
  return raw
    .filter((e): e is ZaiLimitEntry => !!e && typeof e === 'object')
    .slice(0, ZAI_MAX_LIMIT_ENTRIES);
}

/**
 * Caps that draw on the plan's quota. `TIME_LIMIT` (the monthly MCP allowance) is NOT one:
 * a 99%-consumed MCP allowance must never be mistaken for a 5-hour window.
 */
function isZaiWindowCap(entry: ZaiLimitEntry): boolean {
  return entry.type === ZAI_TOKENS_LIMIT || entry.type === ZAI_CREDIT_LIMIT;
}

/** Read the period off the (type, unit) pair — what z.ai keys its own dashboard cards on. */
function zaiKindFromUnit(entry: ZaiLimitEntry): ZaiWindowKind | null {
  const windowCap = isZaiWindowCap(entry);
  // An hour period means the short window whatever `number` says; z.ai has only ever shipped
  // a five-hour one.
  if (entry.unit === ZAI_UNIT_HOUR) { return windowCap ? '5h' : null; }
  if (entry.unit === ZAI_UNIT_WEEK) { return windowCap ? 'week' : null; }
  if (entry.unit === ZAI_UNIT_MONTH) {
    if (entry.type === ZAI_TIME_LIMIT) { return 'mcp'; }
    // A monthly window cap has nowhere to go — RateLimitData holds two windows. Returning
    // 'other' rather than null keeps it out of the positional path, where it would take a
    // slot and corrupt both readings.
    return windowCap ? 'other' : null;
  }
  return null; // no unit (legacy payload), or one of the unobserved codes 1/2/4
}

/**
 * Legacy payloads name the period nowhere and both token caps share one `type`.
 *
 * Position is the signal that holds there: the array arrives in the order z.ai's own
 * dashboard renders it — 5-hour, then weekly, then MCP. `nextResetTime` cannot carry this
 * on its own, because an idle 5-hour window comes back with no reset time at all while an
 * exhausted weekly cap can be minutes from resetting. So order decides, and the reset time
 * only rejects a candidate that could not possibly be a 5-hour window.
 *
 * Only window caps compete for slots, so a payload leading with `TIME_LIMIT` — which the
 * live token tariff does — classifies the same as one without it. The returned map is keyed
 * by index into the FULL array so it zips back onto it entry for entry.
 */
function zaiKindsFromOrder(limits: ZaiLimitEntry[], now: number): Map<number, ZaiWindowKind> {
  const capIndexes: number[] = [];
  limits.forEach((entry, index) => { if (isZaiWindowCap(entry)) { capIndexes.push(index); } });

  const couldBeShortWindow = (index: number): boolean => {
    const reset = limits[index].nextResetTime;
    if (!isFiniteNumber(reset)) { return true; } // no reset time at all — an idle 5-hour window
    return reset - now <= ZAI_SHORT_WINDOW_HORIZON_MS;
  };

  // The first cap not provably too far out takes the 5-hour slot; when every candidate looks
  // too far out, trust the ordering rather than inventing a swap.
  const shortIndex = capIndexes.find(couldBeShortWindow) ?? capIndexes[0];

  const kinds = new Map<number, ZaiWindowKind>();
  let weeklyTaken = false;
  for (const index of capIndexes) {
    if (index === shortIndex) {
      kinds.set(index, '5h');
    } else if (!weeklyTaken) {
      kinds.set(index, 'week');
      weeklyTaken = true;
    } else {
      // Only two windows exist; a third cap is ignored rather than replacing the weekly one.
      kinds.set(index, 'other');
    }
  }
  return kinds;
}

/** Per-entry kind, aligned index-for-index with `limits`. */
function zaiResolveKinds(limits: ZaiLimitEntry[], now: number): ZaiWindowKind[] {
  // Build the positional map only when some cap's period is unresolvable; `unit` still wins
  // per entry wherever it resolves, so a half-migrated payload is read correctly.
  const needsOrder = limits.some(e => isZaiWindowCap(e) && zaiKindFromUnit(e) === null);
  const byOrder = needsOrder ? zaiKindsFromOrder(limits, now) : new Map<number, ZaiWindowKind>();

  return limits.map((entry, index): ZaiWindowKind =>
    zaiKindFromUnit(entry)
      ?? byOrder.get(index)
      ?? (entry.type === ZAI_TIME_LIMIT ? 'mcp' : 'other'));
}

/** Window length in seconds: `unit` x `number` when stated, else the known default. */
function zaiWindowSeconds(entry: ZaiLimitEntry, kind: '5h' | 'week'): number {
  const count = entry.number;
  if (isFiniteNumber(count) && count > 0) {
    if (entry.unit === ZAI_UNIT_HOUR) { return count * 3600; }
    if (entry.unit === ZAI_UNIT_WEEK) { return count * ZAI_WEEK_SECONDS; }
  }
  return kind === '5h' ? ZAI_FIVE_HOUR_SECONDS : ZAI_WEEK_SECONDS;
}

/**
 * Seconds until this window resets.
 *
 * Zero is not a neutral "unknown" here: the dashboard hides its prediction chart when
 * resetIn5h is 0, and the prediction engine caps time-to-exhaustion by it, turning 0 into a
 * "under 10 minutes left" warning for a user at 3% utilization. For an idle 5-hour window a
 * full window is also simply the right answer — the window is anchored to the first request
 * inside it, so one with no anchor yet is a full five hours away from rolling over.
 */
function zaiResetSeconds(entry: ZaiLimitEntry, kind: '5h' | 'week', nowSec: number): number {
  const reset = entry.nextResetTime;
  if (isFiniteNumber(reset)) {
    const seconds = reset / 1000 - nowSec;
    // A past reset is a stale snapshot; an absurdly distant one is an upstream unit mix-up.
    if (seconds > 0 && seconds <= ZAI_MAX_RESET_HORIZON_SECONDS) { return seconds; }
  }
  return zaiWindowSeconds(entry, kind);
}

/**
 * Fraction consumed for one window.
 *
 * `percentage` is an integer — the live credit account reports 59 for an actual 59.62% — and
 * the notification ladder steps at 90/92/94/96/98, so the derived ratio is preferred where
 * the amounts allow it. The agreement check guards the one case that would silently invert
 * the result: z.ai fixing its backwards `usage`/`currentValue` naming. With no `percentage`
 * at all there is nothing to disagree with, so the ratio is used directly — comparing against
 * a `?? 0` default would report 0% for a perfectly good credit window.
 */
function zaiUtilization(entry: ZaiLimitEntry): number {
  const pct = isFiniteNumber(entry.percentage) ? entry.percentage : null;
  const used = entry.currentValue;
  const total = entry.usage;

  if (isFiniteNumber(used) && isFiniteNumber(total) && total > 0) {
    const ratio = used / total;
    if (pct === null || Math.abs(ratio * 100 - pct) <= 1.5) { return clamp01(ratio); }
  }
  return pct === null ? 0 : clamp01(pct / 100);
}

/** Absolute amounts, when the window reports them. `remaining` may legitimately be missing. */
function zaiAmounts(entry: ZaiLimitEntry): QuotaAmounts | undefined {
  const used = entry.currentValue;
  const total = entry.usage;
  if (!isFiniteNumber(used) || !isFiniteNumber(total) || total <= 0) { return undefined; }
  const remaining = entry.remaining;
  return isFiniteNumber(remaining) ? { used, total, remaining } : { used, total };
}

function zaiPlanLevel(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') { return undefined; }
  const level = (json as ZaiQuotaResponse).data?.level;
  if (typeof level !== 'string' || level.length === 0) { return undefined; }
  return level.length <= ZAI_MAX_LEVEL_LENGTH ? level : undefined;
}

/**
 * `now` is injectable so the positional fallback and the reset horizons can be tested
 * deterministically; production callers use the default.
 */
export function parseZaiQuota(json: unknown, now: number = Date.now()): RateLimitData {
  const limits = zaiLimitsOf(json);
  const kinds = zaiResolveKinds(limits, now);
  const nowSec = now / 1000;

  const five = limits.find((_, i) => kinds[i] === '5h');
  const weekly = limits.find((_, i) => kinds[i] === 'week');

  const util5h = five ? zaiUtilization(five) : 0;
  const util7d = weekly ? zaiUtilization(weekly) : 0;
  const resetIn5h = five ? zaiResetSeconds(five, '5h', nowSec) : 0;
  const resetIn7d = weekly ? zaiResetSeconds(weekly, 'week', nowSec) : 0;
  const has7dLimit = weekly !== undefined;

  let limitStatus: RateLimitData['limitStatus'];
  if (util5h >= 1 || (has7dLimit && util7d >= 1)) {
    // Until now z.ai could never reach 'denied', so an exhausted quota looked the same as one
    // at 76% — amber either way.
    limitStatus = 'denied';
  } else if (util5h >= 0.75 || (has7dLimit && util7d >= 0.75)) {
    limitStatus = 'allowed_warning';
  } else {
    limitStatus = 'allowed';
  }

  const result: RateLimitData = {
    utilization5h: util5h, utilization7d: util7d, resetIn5h, resetIn7d, limitStatus, has7dLimit,
  };

  if (limits.some(isZaiWindowCap)) {
    result.billing = limits.some(e => e.type === ZAI_CREDIT_LIMIT) ? 'credits' : 'tokens';
  }
  const level = zaiPlanLevel(json);
  if (level !== undefined) { result.planLevel = level; }
  const amounts5h = five ? zaiAmounts(five) : undefined;
  if (amounts5h) { result.credits5h = amounts5h; }
  const amounts7d = weekly ? zaiAmounts(weekly) : undefined;
  if (amounts7d) { result.credits7d = amounts7d; }

  return result;
}

// z.ai business codes to an HTTP-ish status. All of these arrive with HTTP 200.
const ZAI_CODE_TO_STATUS: Record<number, number> = {
  401: 401,  // "token expired or incorrect" — a token the gateway could not parse
  403: 403,
  429: 429,
  1000: 401, // "Authentication Failed" — well-formed key, refused
  1001: 401, // no Authorization header reached the gateway
};

/**
 * z.ai answers a rejected key with HTTP 200 and `success: false`, so `response.ok` alone
 * classifies a dead key as a live one with no activity — which the parser would then report
 * as a cheerful "0% used", cached as fresh API data. Only an explicit `success: false` counts
 * as a failure: a good payload that omits the field must keep flowing.
 */
export function readZaiEnvelopeFailure(json: unknown): { code: number | null, status: number } | null {
  if (!json || typeof json !== 'object') { return null; }
  const envelope = json as ZaiQuotaResponse;
  if (envelope.success !== false) { return null; }
  const code = typeof envelope.code === 'number' ? envelope.code : null;
  const mapped = code !== null ? ZAI_CODE_TO_STATUS[code] : undefined;
  return { code, status: mapped ?? 502 };
}

/** Marks "your key was refused" so the caller can back off instead of retrying every tick. */
export class ZaiAuthError extends Error {}

export async function fetchZaiQuota(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RateLimitData> {
  // Derive the monitor host from the configured base URL's origin so this works for
  // api.z.ai as well as regional/coding-plan hosts.
  const origin = new URL(baseUrl).origin;
  const url = origin + ZAI_QUOTA_PATH;

  // Standard plans accept `Bearer <token>`; z.ai coding-plan endpoints accept the token
  // directly. Retrying is driven by the failure CLASS, not the HTTP status — on the live API
  // an auth refusal arrives as HTTP 200 with a failure envelope, so a status-gated retry
  // never actually fired in production.
  const authVariants = [`Bearer ${token}`, token];
  let lastError = 'no response';
  let lastWasAuth = false;

  for (const authorization of authVariants) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'Authorization': authorization, 'Accept': 'application/json' },
    });

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('z.ai quota response was not JSON');
      }

      const failure = readZaiEnvelopeFailure(body);
      if (!failure) {
        // A 200 with no usable window cap means the payload shape moved again. Throwing lets
        // the caller keep showing cached quota instead of a fabricated 0%.
        if (!zaiLimitsOf(body).some(isZaiWindowCap)) {
          throw new Error('z.ai quota response contained no usable limits');
        }
        return parseZaiQuota(body);
      }

      // `msg` is never surfaced: z.ai answered in English on one endpoint and Chinese on
      // another within one batch, ignoring Accept-Language. Report the code instead — and
      // call it an envelope code, because the response really was HTTP 200.
      lastError = `envelope code ${failure.code ?? 'unknown'}`;
      lastWasAuth = failure.status === 401 || failure.status === 403;
    } else {
      lastError = `HTTP ${response.status}`;
      lastWasAuth = response.status === 401 || response.status === 403;
    }

    if (!lastWasAuth) { break; } // retrying with a different token format won't help
  }

  const message = `z.ai quota request failed (${lastError})`;
  throw lastWasAuth ? new ZaiAuthError(message) : new Error(message);
}
