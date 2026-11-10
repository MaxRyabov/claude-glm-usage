import { readClaudeEnvVar } from './apiClient';
import { findActiveSession } from './entryCache';

// Context window of the active session relative to its model — the "ctx 38%" segment.
// The last assistant turn carries the whole accumulated context, so its input +
// cache_read + cache_creation is the fill; the auto-compact warning margin mirrors the
// Claude Code widget (window − 20k).

/** Warn (⚠) margin before the window limit, in tokens — Claude Code's auto-compact edge. */
export const CONTEXT_WARN_MARGIN_TOKENS = 20_000;

const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_1M = 1_000_000;

/**
 * Built-in Claude Code context windows, lowercased model name → tokens. Short names
 * (opus/sonnet/haiku) appear in real logs too. Every current model defaults to 200k —
 * the 1M selector arrives as the `[1m]` suffix and is handled before the table.
 */
const CLAUDE_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-5-5': 200_000,
  'claude-opus-5': 200_000,
  'claude-sonnet-5-5': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-haiku-5-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'opus': 200_000,
  'sonnet': 200_000,
  'haiku': 200_000,
};

function isClaudeModel(name: string): boolean {
  return name.startsWith('claude') || name === 'opus' || name === 'sonnet' || name === 'haiku';
}

/**
 * Resolve the context window (tokens) for a model. `[1m]` wins for any model — it is
 * Claude Code's own 1M-window selector. A claude model reads the built-in table (a name
 * missing from it falls back to 200k); the CLAUDE_CODE_MAX_CONTEXT_TOKENS override
 * applies only to non-claude models, matching Claude Code itself.
 */
export function resolveContextWindow(model: string | undefined, maxTokensOverride: number | null): number {
  const name = (model ?? '').toLowerCase();
  if (name.includes('[1m]')) { return CONTEXT_WINDOW_1M; }
  if (isClaudeModel(name)) { return CLAUDE_CONTEXT_WINDOWS[name] ?? CONTEXT_WINDOW_DEFAULT; }
  return maxTokensOverride ?? CONTEXT_WINDOW_DEFAULT;
}

/** CLAUDE_CODE_MAX_CONTEXT_TOKENS from the Claude Code environment (env → settings.json → settings.local.json), as a positive integer or null. */
export async function readContextOverride(): Promise<number | null> {
  const raw = await readClaudeEnvVar('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
  if (raw === null) { return null; }
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export interface ContextFill {
  model: string
  windowTokens: number
  usedTokens: number
  /** usedTokens / windowTokens, NOT clamped: an override below the real fill shows 104%. */
  fillRatio: number
  /** usedTokens reached the ⚠ threshold: window − min(CONTEXT_WARN_MARGIN_TOKENS, 10% of the window). */
  nearLimit: boolean
}

/**
 * Context fill of the workspace's active session, or null when there is no project dir,
 * no fresh session (findActiveSession already applies the 6h freshness), or no model.
 */
export async function computeContextFill(
  projectDir: string | null,
  maxTokensOverride: number | null,
  freshnessMs?: number,
): Promise<ContextFill | null> {
  if (!projectDir) { return null; }
  const session = await findActiveSession(projectDir, freshnessMs);
  if (!session || !session.model) { return null; }
  const windowTokens = resolveContextWindow(session.model, maxTokensOverride);
  const u = session.usage;
  const usedTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  // On a window smaller than the margin (reachable only via the override — every
  // built-in window is ≥ 200k) an absolute 20k edge would sit below zero and light ⚠
  // even on an empty context. Cap the margin at 10% of the window, which is exactly
  // what 20k is on the 200k default.
  const warnMargin = Math.min(CONTEXT_WARN_MARGIN_TOKENS, Math.floor(windowTokens / 10));
  return {
    model: session.model,
    windowTokens,
    usedTokens,
    fillRatio: usedTokens / windowTokens,
    nearLimit: usedTokens >= windowTokens - warnMargin,
  };
}
