import * as assert from 'assert';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  getWebviewContent,
  buildUpdatePayload,
  rebuildUnitsPayload,
  quotaWindowStartMs,
  sumCreditsSince,
  makeConfigChangeHandler,
} from '../../webview/panel';
import { formatCredits } from '../../config';
import { readSnapshot } from '../../data/snapshotCache';
import type { ClaudeUsageData } from '../../data/dataManager';
import type { PredictionData } from '../../data/prediction';
import type { UsageEntry } from '../../data/entryCache';

const NONCE = 'testnonce123';
const html = getWebviewContent(NONCE, { title: 'Test' }, 'vscode-webview://x/chart-bundle.js');

suite('WebView CSP / Chart.js bundling', () => {
  test('CSP script-src does not reference an external CDN (H-1)', () => {
    assert.ok(!html.includes('cdn.jsdelivr.net'), 'CSP must not allow cdn.jsdelivr.net');
  });

  test('CSP script-src is locked to the nonce (H-1)', () => {
    assert.ok(html.includes(`script-src 'nonce-${NONCE}'`), 'script-src must be nonce-only');
  });

  test('no <script> loads Chart.js from an https CDN (H-2)', () => {
    assert.ok(
      !/<script[^>]+src=["']https:\/\//.test(html),
      'no script tag may load from an https:// URL',
    );
  });

  test('Chart.js is loaded from the passed local bundle URI (H-2)', () => {
    assert.ok(
      html.includes('src="vscode-webview://x/chart-bundle.js"'),
      'Chart.js must load from the local chart-bundle.js resource',
    );
  });
});

suite('WebView credit amounts and plan tier', () => {
  test('the amounts blocks start hidden, so a provider without them shows nothing', () => {
    // Every provider but z.ai, and every token-based z.ai tariff, reports no amounts at all.
    // Rendering is driven purely by presence, so the default state has to be hidden.
    assert.ok(
      /id="usage-5h-amounts"[^>]*style="display:none"/.test(html),
      '5h amounts block must default to hidden',
    );
    assert.ok(
      /id="usage-7d-amounts"[^>]*style="display:none"/.test(html),
      '7d amounts block must default to hidden',
    );
  });

  test('the plan tier badge starts hidden', () => {
    assert.ok(
      /id="plan-badge"[^>]*style="display:none"/.test(html),
      'plan badge must default to hidden',
    );
  });
  test('the plan tier is written as text, never as markup', () => {
    // planLevel is a free-form string from an external API that also lands in the on-disk
    // cache, so it must never reach a markup sink.
    assert.ok(html.includes('badge.textContent = level'), 'plan tier must be set via textContent');

    // Scoped to the externally-sourced values rather than banning markup sinks outright: the
    // dashboard legitimately builds project and chart markup that way, escaping as it goes.
    // What must never happen is a quota value reaching one. Assignment, append and
    // insertAdjacentHTML are all covered; the identifiers are the specific ones this change
    // introduces, not generic words like "total" that appear throughout the cost rendering.
    const SINKS = /(?:\.(?:inner|outer)HTML\s*\+?=|insertAdjacentHTML\s*\()[^;]*/g;
    const QUOTA_VALUES = /planLevel|credits5h|credits7d|amounts/;
    const tainted = (html.match(SINKS) ?? []).filter((sink) => QUOTA_VALUES.test(sink));
    assert.deepStrictEqual(tainted, [], 'quota values must not reach a markup sink');
  });

  test('amounts are written as text too', () => {
    assert.ok(html.includes('el.textContent = tmpl'), 'amounts must be set via textContent');
  });
});

suite('WebView rate data visibility', () => {
  // The host decides whether utilization is live (dashboardUsage → showRateData, covered in
  // pollOutcome.test.ts). The page must use that decision and not re-derive its own: its own
  // condition excluded only 'local-only', and drew an old cache's numbers behind a refused key.
  test('the page reads showRateData', () => {
    assert.ok(html.includes('usage.showRateData === true'), 'the page must consult showRateData');
  });

  test('the page has no rate-data condition of its own', () => {
    assert.ok(!html.includes("dataSource !== 'local-only'"),
      "a local 'local-only' check means the page decides by itself again");
  });

  test('the footer names a refused credential and an expired token', () => {
    assert.ok(html.includes("usage.dataSource === 'auth-rejected'"), 'footer branch for a refusal');
    assert.ok(html.includes("usage.pollNotice === 'token-expired'"), 'footer branch for an expired token');
  });
});

// ---- Stage 4 (add-statusbar-peak-ctx-units): the update message and the Now panel ----

const PEAK = {
  active: true,
  windowStartMs: Date.UTC(2026, 10, 11, 6, 0),
  windowEndMs: Date.UTC(2026, 10, 11, 10, 0),
  windowStartLocal: '09:00',
  windowEndLocal: '13:00',
  tzLabel: 'UTC+3',
};

const CONTEXT = {
  model: 'glm-5.3', windowTokens: 200_000, usedTokens: 76_000,
  fillRatio: 0.38, nearLimit: false,
};

function makeUsage(overrides: Partial<ClaudeUsageData> = {}): ClaudeUsageData {
  return {
    utilization5h: 0.42, utilization7d: 0.11, resetIn5h: 3600, resetIn7d: 86400,
    limitStatus: 'allowed', has7dLimit: true, providerType: 'z-ai',
    cost5h: 1.42, costDay: 3.0, cost7d: 9.0,
    localCredits5h: 2871, localCreditsDay: 8000, localCredits7d: 21_000,
    tokensIn5h: 1000, tokensOut5h: 100, tokensCacheRead5h: 1000, tokensCacheCreate5h: 0,
    credits5h: { used: 3120, total: 28_000, remaining: 24_880 },
    peak: PEAK,
    context: CONTEXT,
    lastUpdated: new Date(), cacheAge: 30, dataSource: 'api',
    ...overrides,
  };
}

function makePrediction(overrides: Partial<PredictionData> = {}): PredictionData {
  return {
    estimatedExhaustionTime: null, estimatedExhaustionIn: null,
    currentBurnRate: 1.42, burnRateCreditsPerHour: 412,
    creditsRemaining5h: 24_880, exhaustsBeforeReset: false,
    budgetRemaining: null, budgetExhaustionTime: null, safeToStartHeavyTask: true,
    recommendation: 'The 5h window will not be exhausted before the reset.',
    recommendationKey: 'survives-reset',
    ...overrides,
  };
}

function payloadInput(
  usage: ClaudeUsageData,
  primaryUnitSetting: 'auto' | 'credits' | 'usd' = 'auto',
  quotaWindowCredits: number | null = 2871.4,
) {
  return {
    usage,
    prediction: makePrediction(),
    heatmap: null,
    projectCosts: [],
    pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheCreatePerMillion: 3.75 },
    apiEnabled: true,
    cacheTtlSeconds: 300,
    weeklyBudget: null,
    primaryUnitSetting,
    quotaWindowCredits,
  };
}

suite('Dashboard update message structure', () => {
  test('carries peak, context, units, reconcile and the showRateData decision', () => {
    const usage = makeUsage();
    const { data } = buildUpdatePayload(payloadInput(usage));
    assert.strictEqual(data.usage.showRateData, true, 'the host decides rate-data visibility');
    assert.strictEqual(data.peak, usage.peak, 'peak reaches the page top-level');
    assert.strictEqual(data.context, usage.context, 'context reaches the page top-level');
    assert.strictEqual(data.units.primary, 'credits', 'auto resolves to credits for z-ai');
    assert.deepStrictEqual(
      data.reconcile,
      { localCredits: 2871.4, quotaUsed: 3120 },
      'reconcile pairs the local quota-window count with the quota used',
    );
    assert.strictEqual(data.settings.provider, 'z-ai');
  });

  test('the primary unit follows the setting (usd for z-ai, credits stays)', () => {
    assert.strictEqual(buildUpdatePayload(payloadInput(makeUsage(), 'usd')).data.units.primary, 'usd');
    assert.strictEqual(buildUpdatePayload(payloadInput(makeUsage(), 'credits')).data.units.primary, 'credits');
    // claude-ai has no credit tariff: auto and an explicit credits both degrade to dollars.
    const claudeAi = makeUsage({
      providerType: 'claude-ai', peak: undefined, context: undefined, credits5h: undefined,
    });
    assert.strictEqual(buildUpdatePayload(payloadInput(claudeAi)).data.units.primary, 'usd');
    assert.strictEqual(buildUpdatePayload(payloadInput(claudeAi, 'credits')).data.units.primary, 'usd');
  });

  test('claude-ai carries no peak, no context and no reconcile', () => {
    const { data } = buildUpdatePayload(payloadInput(makeUsage({
      providerType: 'claude-ai', peak: undefined, context: undefined, credits5h: undefined,
    })));
    assert.strictEqual(data.peak, null, 'no peak object for a provider without peak pricing');
    assert.strictEqual(data.context, null);
    assert.strictEqual(data.reconcile, null);
  });

  test('reconcile requires the quota amounts to be on screen', () => {
    // Local-only z-ai (no live quota numbers) — nothing to reconcile against.
    assert.strictEqual(
      buildUpdatePayload(payloadInput(makeUsage({ dataSource: 'local-only' }))).data.reconcile,
      null,
      'a refused/local-only state must not pair the local count with an off-screen quota',
    );
    // A token-based z-ai tariff reports percentages only — no credits5h.
    assert.strictEqual(
      buildUpdatePayload(payloadInput(makeUsage({ credits5h: undefined }))).data.reconcile,
      null,
    );
    // The local count itself failed to read — the row hides rather than shows half a pair.
    assert.strictEqual(
      buildUpdatePayload(payloadInput(makeUsage(), 'auto', null)).data.reconcile,
      null,
    );
  });
});

suite('quota reconciliation window', () => {
  test('starts at reset5hAt − 5h, not at now − 5h (rolling hours)', () => {
    const now = 1_000_000_000_000;
    // One hour left to the reset: the quota window began four hours ago, not five.
    assert.strictEqual(quotaWindowStartMs(3600, now), now + 3_600_000 - 5 * 3600 * 1000);
    // A just-rolled window resets in 5h — its start is now; an expired one started 5h ago.
    assert.strictEqual(quotaWindowStartMs(5 * 3600, now), now);
    assert.strictEqual(quotaWindowStartMs(0, now), now - 5 * 3600 * 1000);
  });

  test('sums § of the entries inside the window, at the boundary included', () => {
    // 2026-11-11 is a Wednesday: 07:00 UTC is inside the peak window, 12:00 UTC outside.
    const peakTs = Date.UTC(2026, 10, 11, 7, 0);
    const offpeakTs = Date.UTC(2026, 10, 11, 12, 0);
    // glm-5.3, input 1000 / cache_read 1000 / output 100 → 1.1 § in peak, 0.55 § outside.
    const glmTurn = (timestamp: number): UsageEntry => ({
      timestamp,
      model: 'glm-5.3',
      usage: {
        input_tokens: 1000, cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0, output_tokens: 100,
      },
    });
    const claudeTurn: UsageEntry = {
      timestamp: offpeakTs - 1000,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: 100_000, cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0, output_tokens: 10_000,
      },
    };
    const entries = [glmTurn(peakTs), glmTurn(offpeakTs), claudeTurn];

    // Window covering both GLM turns: peak turn full price, off-peak half, claude-* zero.
    assert.ok(Math.abs(sumCreditsSince(entries, peakTs) - 1.65) < 1e-9);
    // Window starting exactly at the off-peak turn: the boundary entry counts.
    assert.ok(Math.abs(sumCreditsSince(entries, offpeakTs) - 0.55) < 1e-9);
    // One millisecond later excludes it; the peak turn (4h+ before) is outside either way.
    assert.ok(Math.abs(sumCreditsSince(entries, offpeakTs + 1) - 0) < 1e-9);
  });
});

suite('primaryUnit change redraws the open dashboard', () => {
  const eventFor = (section: string) => ({ affectsConfiguration: (s: string) => s === section });

  test('a primaryUnit change pushes an update built from the last data', () => {
    const usage = makeUsage();
    const pushed: ClaudeUsageData[] = [];
    const handler = makeConfigChangeHandler(() => usage, d => pushed.push(d));
    handler(eventFor('claudeStatus.display.primaryUnit'));
    assert.deepStrictEqual(pushed, [usage], 'the redraw reuses the last data, no data cycle');
  });

  test('an unrelated setting change and a dataless panel push nothing', () => {
    const pushed: ClaudeUsageData[] = [];
    const handler = makeConfigChangeHandler(() => makeUsage(), d => pushed.push(d));
    handler(eventFor('claudeStatus.cache.ttlSeconds'));
    assert.strictEqual(pushed.length, 0, 'only primaryUnit changes presentation-only');

    const dataless = makeConfigChangeHandler(() => undefined, d => pushed.push(d));
    dataless(eventFor('claudeStatus.display.primaryUnit'));
    assert.strictEqual(pushed.length, 0, 'nothing to redraw before the first data arrives');
  });

  test('rebuildUnitsPayload flips the unit without regathering — and redraws nothing before the first update', () => {
    // The handler's redraw path: the last gathered input is rebuilt under the current
    // setting, so the flipped unit reaches the page with no data cycle and no disk read.
    const last = payloadInput(makeUsage(), 'auto');
    assert.strictEqual(rebuildUnitsPayload(last, 'usd')!.data.units.primary, 'usd');
    assert.strictEqual(rebuildUnitsPayload(last, 'credits')!.data.units.primary, 'credits');
    // The gathered part is reused as-is, not recomputed: the reconcile pairing survives.
    assert.deepStrictEqual(
      rebuildUnitsPayload(last, 'usd')!.data.reconcile,
      buildUpdatePayload(last).data.reconcile,
      'a presentation-only flip must not alter the gathered data',
    );
    assert.strictEqual(rebuildUnitsPayload(null, 'usd'), null, 'nothing to redraw before the first update');
  });
});

suite('Now panel page logic', () => {
  test('the extra-rows block exists under the window progress bars', () => {
    assert.ok(html.includes('id="now-extra"'), 'the Now panel needs its extra-rows container');
  });

  test('the peak line renders only for an active z-ai peak', () => {
    // claude-ai never gets a peak object and an off-peak z-ai has active=false — both must
    // leave the ⚡ row out; only data.peak && data.peak.active draws it.
    assert.ok(html.includes('if (peak && peak.active)'), 'the page must guard on peak.active');
  });

  test('the speed line joins both units for z-ai, ordered by the primary unit', () => {
    assert.ok(
      html.includes("providerType === 'z-ai' && prediction.burnRateCreditsPerHour > 0"),
      'both units are a z-ai-only companion',
    );
    assert.ok(
      html.includes("units.primary === 'credits' ? cr + ' · ' + usd : usd + ' · ' + cr"),
      'credits lead when primary, dollars otherwise',
    );
    // A credits-only stream shows credits alone — "$0.00/hr · 412 cr/hr" reads as broken data.
    assert.ok(
      html.includes('const usd = prediction.currentBurnRate > 0'),
      'the dollar part renders only for a real dollar rate',
    );
  });

  test('the reconciliation row uses the quota-window template', () => {
    assert.ok(html.includes('i18n.reconcile5h'), 'the row renders the localized phrase');
    assert.ok(html.includes('fmtCreditsNum(rec.localCredits)'), 'the local count is §-formatted');
  });

  test('reset labels carry the absolute clock next to the relative duration', () => {
    assert.ok(html.includes('resetSuffix(usage.resetIn5h)'), 'the 5h label names the reset clock time');
    assert.ok(html.includes('resetSuffix(usage.resetIn7d)'), 'the 7d label names the reset clock time');
    assert.ok(
      html.includes('function resetSuffix(seconds) {\n      return seconds > 0'),
      'one suffix helper gates both modes and both windows: an absent reset (0) must not read "resets in 0m (at <now>)"',
    );
  });

  test('the survives-reset recommendation is localized, not the English fallback', () => {
    assert.ok(
      html.includes("'survives-reset':     i18n.recSurvivesReset"),
      'recI18n must map survives-reset to its localized string',
    );
  });

  test('the credit path row shows the remaining 5h quota credits', () => {
    assert.ok(html.includes('i18n.creditsLeft5h'), 'Prediction card carries the credit path');
    assert.ok(
      !html.includes('creditsRemaining5h !== null'),
      'presence is the typeof check alone — a null-union field never passes typeof anyway',
    );
  });
});

suite('the page § formatter stays in lockstep with the host', () => {
  test('fmtCreditsNum (plain-JS copy in the page) matches config.formatCredits tier for tier', () => {
    // The webview cannot import config.ts, so the page embeds a plain-JS copy of the
    // number formatter. This pins the copy against the host formatter on the actual
    // template, so a tier change in one place fails the suite instead of silently
    // making the dashboard print numbers the status bar never would.
    const m = html.match(/function fmtCreditsNum\(n\) \{[\s\S]*?\n    \}/);
    assert.ok(m, 'the page template must define fmtCreditsNum');
    const fmtCreditsNum = new Function(`return (${m[0]})`)() as (n: number) => string;
    const values = [
      0, 1, 42, 999, 1000, 1001, 9999, 99_949, 99_950, 123_456, 999_949, 999_950,
      1_000_000, 1_234_567_890, 9.9e11, 5e12, Number.MAX_SAFE_INTEGER, -3, NaN, Infinity,
    ];
    for (const v of values) {
      assert.strictEqual(fmtCreditsNum(v), formatCredits(v).slice(1), `parity at ${v}`);
    }
  });
});

suite('snapshot validator accepts the stage-4 optional fields', () => {
  // The validator runs against a snapshot file in an isolated temp dir — never the
  // production path under ~/.claude, which the user's running extension owns.
  test('a v1 snapshot whose usage still carries peak/context loads unchanged', async () => {
    // writeSnapshot strips the volatile fields, but the validator must not fail closed on
    // them either: v1 accepts new optional fields without a schema-version bump (D7).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbcs-snapshot-'));
    const snapshotPath = path.join(dir, 'vscode-claude-status-snapshot.json');
    try {
      const usage = makeUsage({ providerType: 'z-ai', dataSource: 'api', cost5h: 42.42 });
      const file = {
        version: 1,
        savedAt: new Date().toISOString(),
        usage,
        projectCosts: [],
        heatmap: null,
      };
      // Same mode as the production writer (atomicWriteJson uses 0o600).
      await fsp.writeFile(snapshotPath, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 });
      const back = await readSnapshot(snapshotPath);
      assert.ok(back, 'the v1 validator must accept peak/context on the usage object');
      assert.strictEqual(back.usage.providerType, 'z-ai');
      assert.strictEqual(back.usage.cost5h, 42.42, 'the temp file is the one being read');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
