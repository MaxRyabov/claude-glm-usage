import * as assert from 'assert';
import { buildLabel, buildTooltip, formatDuration } from '../../statusBar';
import { ClaudeUsageData } from '../../data/dataManager';
import { ContextFill } from '../../data/contextFill';
import { isPeakAt } from '../../data/peakHours';

function makeData(overrides: Partial<ClaudeUsageData> = {}): ClaudeUsageData {
  return {
    utilization5h: 0.5,
    utilization7d: 0.3,
    resetIn5h: 3600,
    resetIn7d: 86400,
    limitStatus: 'allowed',
    has7dLimit: true,
    providerType: 'claude-ai',
    cost5h: 1.23,
    costDay: 2.50,
    cost7d: 10.00,
    localCredits5h: 2.8,
    localCreditsDay: 11.2,
    localCredits7d: 44.0,
    tokensIn5h: 50_000,
    tokensOut5h: 10_000,
    tokensCacheRead5h: 5_000,
    tokensCacheCreate5h: 1_000,
    lastUpdated: new Date(),
    cacheAge: 30,
    dataSource: 'cache',
    ...overrides,
  };
}

const mockProject = {
  projectName: 'my-app',
  projectPath: '/home/user/.claude/projects/-home-user-my-app',
  costToday: 3.21,
  cost7d: 18.45,
  cost30d: 62.10,
  creditsToday: 9.1,
  credits7d: 51.0,
  credits30d: 180.0,
  sessionCount: 5,
  lastActive: new Date(),
};

suite('formatDuration', () => {
  test('returns minutes for < 1 hour', () => {
    assert.strictEqual(formatDuration(600), '10m');
    assert.strictEqual(formatDuration(3540), '59m');
  });

  test('returns hours for 1h-23h', () => {
    assert.strictEqual(formatDuration(3600), '1h');
    assert.strictEqual(formatDuration(5400), '1h 30m');
    assert.strictEqual(formatDuration(82800), '23h');
  });

  test('returns days for >= 24h', () => {
    assert.strictEqual(formatDuration(86400), '1d');
    assert.strictEqual(formatDuration(90000), '1d 1h');
    assert.strictEqual(formatDuration(172800), '2d');
  });
});

suite('StatusBar', () => {
  test('buildLabel shows not-logged-in for no-credentials', () => {
    const label = buildLabel(makeData({ dataSource: 'no-credentials' }));
    assert.strictEqual(label, '🤖 Not logged in');
  });

  test('buildLabel shows run-refresh for no-data', () => {
    const label = buildLabel(makeData({ dataSource: 'no-data' }));
    assert.strictEqual(label, '🤖 Claude: run refresh');
  });

  test('buildLabel shows denied with ✗ indicator', () => {
    const label = buildLabel(makeData({ limitStatus: 'denied', dataSource: 'cache' }));
    assert.ok(label.includes('✗'), `Expected ✗ in: ${label}`);
  });

  test('buildLabel marks the window that is actually exhausted', () => {
    // z.ai denies on whichever window hits 100%, and a live token tariff sits at 100% weekly
    // with an empty 5-hour window. The label used to print a flat "5h:100%✗" and drop the
    // weekly part, stating the exact opposite of the truth.
    const label = buildLabel(makeData({
      providerType: 'z-ai', limitStatus: 'denied', dataSource: 'cache',
      utilization5h: 0, utilization7d: 1, has7dLimit: true,
    }));
    assert.ok(label.includes('5h:0%'), `5h window must show its real value: ${label}`);
    assert.ok(label.includes('7d:100%✗'), `the weekly window must carry the mark: ${label}`);
    assert.ok(!label.includes('5h:100%'), `the 5h window must not be claimed spent: ${label}`);
  });

  test('buildLabel keeps the mark on the 5h window when Anthropic denies by header', () => {
    // Anthropic's denial comes from the 5-hour status header and can arrive without either
    // utilization reaching 1.
    const label = buildLabel(makeData({
      providerType: 'claude-ai', limitStatus: 'denied', dataSource: 'cache',
      utilization5h: 0.98, utilization7d: 0.4, has7dLimit: true,
    }));
    assert.ok(label.includes('5h:98%✗'), `expected the 5h window to carry the mark: ${label}`);
  });

  test('buildLabel shows ⚠ when utilization >= 75%', () => {
    const label = buildLabel(makeData({
      utilization5h: 0.80,
      limitStatus: 'allowed_warning',
      dataSource: 'cache',
    }));
    assert.ok(label.includes('⚠'), `Expected ⚠ in: ${label}`);
  });

  test('buildLabel shows stale age suffix for stale data (minutes)', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 600 }));
    assert.ok(label.includes('10m ago'), `Expected stale suffix in: ${label}`);
  });

  test('buildLabel shows stale age in hours for stale data > 1h', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 7200 }));
    assert.ok(label.includes('2h ago'), `Expected 2h ago in: ${label}`);
  });

  test('buildLabel shows stale age in days for stale data > 24h', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 172800 }));
    assert.ok(label.includes('2d ago'), `Expected 2d ago in: ${label}`);
  });

  test('buildLabel includes project cost when project data is present', () => {
    const label = buildLabel(makeData({ dataSource: 'cache' }), [mockProject]);
    assert.ok(label.includes('my-app'), `Expected project name in: ${label}`);
    assert.ok(label.includes('$3.21'), `Expected project cost in: ${label}`);
  });

  test('buildLabel shows PJ aggregate for multi-root workspaces', () => {
    const second = { ...mockProject, projectName: 'other-app', costToday: 1.00 };
    const label = buildLabel(makeData({ dataSource: 'cache' }), [mockProject, second]);
    assert.ok(label.includes('PJ:'), `Expected PJ: prefix in: ${label}`);
    assert.ok(label.includes('$4.21'), `Expected aggregate cost in: ${label}`);
  });

  test('buildLabel omits project part when no project costs', () => {
    const label = buildLabel(makeData({ dataSource: 'cache' }), []);
    assert.ok(!label.includes('|'), `Expected no | separator in: ${label}`);
  });

  test('buildTooltip includes utilization percentages', () => {
    const tooltip = buildTooltip(makeData({ utilization5h: 0.5, utilization7d: 0.3 }));
    assert.ok(tooltip.includes('50%'), `Expected 50% in tooltip`);
    assert.ok(tooltip.includes('30%'), `Expected 30% in tooltip`);
  });

  test('buildTooltip shows project breakdown when data provided', () => {
    const tooltip = buildTooltip(makeData({ dataSource: 'cache' }), [mockProject]);
    assert.ok(tooltip.includes('my-app'), `Expected project name in tooltip`);
    assert.ok(tooltip.includes('$3.21'), `Expected project cost in tooltip`);
  });

  test('buildTooltip shows no-credentials message', () => {
    const tooltip = buildTooltip(makeData({ dataSource: 'no-credentials' }));
    assert.ok(tooltip.includes('not logged in') || tooltip.includes('Not logged'), tooltip);
  });

  test('z-ai provider uses cost mode in the label (no rate %)', () => {
    // Cost mode with localCredits as the source: the cost windows render in §, not $ —
    // the usd overrides (cost5h 1.23 / cost7d 10) are here to prove the dollar values
    // are NOT what the label shows (primaryUnit spec, auto → credits for z-ai).
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'local-only', cost5h: 1.23, cost7d: 10 }));
    // Digit-boundary assertions: a bare includes('5h:§3') would also pass for §34.
    assert.match(label, /5h:§3(?!\d)/, `expected the credit cost window (localCredits5h 2.8 → §3): ${label}`);
    assert.match(label, /7d:§44(?!\d)/, `expected the credit cost window (localCredits7d 44 → §44): ${label}`);
    assert.ok(!label.includes('%'), `Expected no rate percentage in: ${label}`);
  });

  test('z-ai provider tooltip shows the Z.AI label and hides the rate-limit window', () => {
    const tooltip = buildTooltip(makeData({ providerType: 'z-ai', dataSource: 'local-only' }));
    assert.ok(tooltip.includes('Z.AI / GLM'), `Expected Z.AI label in tooltip:\n${tooltip}`);
    assert.ok(!tooltip.includes('5h window'), `Expected no rate-limit window for z-ai:\n${tooltip}`);
  });

  test('custom-endpoint provider shows its label in the tooltip', () => {
    const tooltip = buildTooltip(makeData({ providerType: 'custom-endpoint', dataSource: 'local-only' }));
    assert.ok(tooltip.includes('Custom endpoint'), `Expected custom-endpoint label in tooltip:\n${tooltip}`);
  });
});

suite('Refused, missing and expired credentials', () => {
  const LOGIN = 'claude auth login';
  const ZAI_VAR = 'ANTHROPIC_AUTH_TOKEN';

  test('Anthropic 401: login rejected, told to log in and refresh', () => {
    const data = makeData({ dataSource: 'auth-rejected', providerType: 'claude-ai', rejectionStatus: 401 });
    assert.strictEqual(buildLabel(data), '🤖 Login rejected');
    const tip = buildTooltip(data);
    assert.ok(tip.includes(LOGIN), tip);
    assert.ok(tip.includes('Claude+GLM: Refresh Now'), tip);
    assert.ok(!tip.includes(ZAI_VAR), 'the z.ai variable is no cure for an Anthropic login');
  });

  test('Anthropic refusal without a status reads as 401', () => {
    const data = makeData({ dataSource: 'auth-rejected', providerType: 'claude-ai' });
    assert.strictEqual(buildLabel(data), '🤖 Login rejected');
    assert.ok(buildTooltip(data).includes(LOGIN));
  });

  test('Anthropic 403: access refused, no login advice', () => {
    const data = makeData({ dataSource: 'auth-rejected', providerType: 'claude-ai', rejectionStatus: 403 });
    assert.strictEqual(buildLabel(data), '🤖 Access refused');
    const tip = buildTooltip(data);
    assert.ok(tip.includes('403'), tip);
    assert.ok(!tip.includes(LOGIN), 'logging in again does not fix a region or policy refusal');
  });

  test('z.ai refusal keeps its key advice', () => {
    const data = makeData({ dataSource: 'auth-rejected', providerType: 'z-ai' });
    assert.strictEqual(buildLabel(data), '🤖 API key rejected');
    const tip = buildTooltip(data);
    assert.ok(tip.includes(ZAI_VAR), tip);
    assert.ok(!tip.includes(LOGIN), tip);
  });

  test('not logged in: the hint depends on the provider', () => {
    const claude = buildTooltip(makeData({ dataSource: 'no-credentials', providerType: 'claude-ai' }));
    assert.ok(claude.includes(LOGIN) && !claude.includes(ZAI_VAR), claude);
    const zai = buildTooltip(makeData({ dataSource: 'no-credentials', providerType: 'z-ai' }));
    assert.ok(zai.includes(ZAI_VAR) && !zai.includes(LOGIN), zai);
    // Auto-detection found nothing: the user may be heading for either provider.
    const unknown = buildTooltip(makeData({ dataSource: 'no-credentials', providerType: 'unknown' }));
    assert.ok(unknown.includes(LOGIN) && unknown.includes(ZAI_VAR), unknown);
  });

  test('no hint names the non-existent `claude login`', () => {
    const states: Partial<ClaudeUsageData>[] = [
      { dataSource: 'no-credentials', providerType: 'claude-ai' },
      { dataSource: 'no-credentials', providerType: 'unknown' },
      { dataSource: 'auth-rejected', providerType: 'claude-ai', rejectionStatus: 401 },
    ];
    for (const s of states) {
      const tip = buildTooltip(makeData(s));
      assert.ok(tip.includes('claude'), 'fixture must reach a login hint');
      assert.ok(!/claude login/.test(tip), tip);
    }
  });

  test('an expired token with data keeps the label and explains in the tooltip', () => {
    const data = makeData({ dataSource: 'stale', pollNotice: 'token-expired', cacheAge: 7200 });
    const label = buildLabel(data);
    assert.ok(label.startsWith('🤖 5h:'), `the data label stays: ${label}`);
    const tip = buildTooltip(data);
    assert.ok(tip.includes('login token expired'), tip);
    assert.ok(!tip.includes(LOGIN), 'an expired token is renewed by Claude Code, not by logging in');
  });

  test('an expired token with nothing to show says so instead of "run refresh"', () => {
    const data = makeData({ dataSource: 'no-data', pollNotice: 'token-expired' });
    assert.strictEqual(buildLabel(data), '🤖 Login expired');
    assert.ok(buildTooltip(data).includes('login token expired'));
    // Without the notice the old label stays.
    assert.strictEqual(buildLabel(makeData({ dataSource: 'no-data' })), '🤖 Claude: run refresh');
  });
});

// 2026-11-11 is a Wednesday: 07:00 UTC is inside the peak window, 12:00 UTC outside.
// Injecting the moment keeps the peak assertions deterministic on any machine/CI clock.
const PEAK_NOW = new Date(Date.UTC(2026, 10, 11, 7, 0));
const OFFPEAK_NOW = new Date(Date.UTC(2026, 10, 11, 12, 0));

function makeContext(fillRatio: number, nearLimit: boolean): ContextFill {
  return {
    model: 'glm-5.3',
    windowTokens: 200_000,
    usedTokens: Math.round(fillRatio * 200_000),
    fillRatio,
    nearLimit,
  };
}

suite('Peak marker (⚡)', () => {
  test('the injected fixtures really sit inside/outside the peak window', () => {
    // Anchors the hardcoded dates to the live peak rule: if the window definition in
    // peakHours.ts ever changes, this fails with a clear cause instead of letting the
    // tests below silently verify the wrong scenario. Window boundaries themselves are
    // covered by peakHours.test.ts.
    assert.ok(isPeakAt(PEAK_NOW.getTime()), 'PEAK_NOW must be inside the peak window');
    assert.ok(!isPeakAt(OFFPEAK_NOW.getTime()), 'OFFPEAK_NOW must be outside the peak window');
  });

  test('z-ai inside the window shows ⚡ next to the quota windows', () => {
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'cache' }), [], PEAK_NOW);
    assert.ok(label.includes('7d:30% ⚡'), `Expected ⚡ after the quota windows: ${label}`);
  });

  test('z-ai outside the window shows no ⚡', () => {
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'cache' }), [], OFFPEAK_NOW);
    assert.ok(!label.includes('⚡'), `No peak badge off-peak: ${label}`);
  });

  test('claude-ai never shows ⚡', () => {
    const label = buildLabel(makeData({ providerType: 'claude-ai', dataSource: 'cache' }), [], PEAK_NOW);
    assert.ok(!label.includes('⚡'), `Anthropic has no peak tariff: ${label}`);
  });

  test('degraded states keep their plain label (no ⚡)', () => {
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'no-credentials' }), [], PEAK_NOW);
    assert.strictEqual(label, '🤖 Not logged in');
  });

  test('local-only data (no quota API) still shows ⚡', () => {
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'local-only' }), [], PEAK_NOW);
    assert.ok(label.includes('⚡'), `The badge depends on the clock, not on quota data: ${label}`);
  });

  test('rendering the peak segment issues no provider requests', () => {
    // peakStatus is pure date math; the guard catches anyone wiring the badge to a fetch.
    // The stub RESOLVES (a throwing stub would leave an unhandled rejection that can
    // take down the whole mocha run if the code ever forgets to await the call).
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const data = makeData({ providerType: 'z-ai', dataSource: 'cache' });
      for (let i = 0; i < 3; i++) {
        buildLabel(data, [mockProject], PEAK_NOW);
        buildTooltip(data, [mockProject], PEAK_NOW);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(calls, 0, 'peak rendering must not call the provider');
  });
});

suite('Context segment (ctx NN%)', () => {
  test('shows the active session fill as a percentage', () => {
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache', context: makeContext(0.38, false) }),
      [], OFFPEAK_NOW,
    );
    assert.ok(label.includes('ctx 38%'), `Expected ctx 38% in: ${label}`);
  });

  test('marks the segment ⚠ at the auto-compact edge', () => {
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache', context: makeContext(0.93, true) }),
      [], OFFPEAK_NOW,
    );
    assert.ok(label.includes('ctx 93%⚠'), `Expected ⚠ at the edge: ${label}`);
  });

  test('shows the true ratio past 100% without clamping', () => {
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache', context: makeContext(1.04, true) }),
      [], OFFPEAK_NOW,
    );
    assert.ok(label.includes('ctx 104%'), `Expected 104% for an over-full window: ${label}`);
  });

  test('no fresh session hides the segment', () => {
    const label = buildLabel(makeData({ providerType: 'z-ai', dataSource: 'cache' }), [], OFFPEAK_NOW);
    assert.doesNotMatch(label, /ctx \d+%/, `Expected no ctx segment: ${label}`);
  });

  test('the tooltip mirrors the segment as a line (Accessibility)', () => {
    // The label-only segment would be invisible to tooltip readers: contextLine()
    // repeats it inside the tooltip, above the Token Cost section.
    const tip = buildTooltip(
      makeData({ providerType: 'z-ai', dataSource: 'cache', context: makeContext(0.93, true) }),
      [], OFFPEAK_NOW,
    );
    assert.match(tip, /Context: 93%⚠/, `Expected a context line in the tooltip:\n${tip}`);
  });
});

suite('Primary unit (claudeStatus.display.primaryUnit)', () => {
  test('z-ai project segment renders in credits under auto', () => {
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache' }),
      [mockProject], OFFPEAK_NOW,
    );
    assert.match(label, /my-app:§9(?![\d.])/, `Expected credits for z-ai (creditsToday 9.1): ${label}`);
    assert.doesNotMatch(label, /\$\d/, `No dollar cost for z-ai in credit mode: ${label}`);
  });

  test('claude-ai project segment stays in dollars', () => {
    const label = buildLabel(
      makeData({ providerType: 'claude-ai', dataSource: 'cache' }),
      [mockProject], OFFPEAK_NOW,
    );
    assert.ok(label.includes('my-app:$3.21'), `Expected dollars for claude-ai: ${label}`);
  });

  test('cost mode windows follow the primary unit', () => {
    const label = buildLabel(
      makeData({
        providerType: 'z-ai', dataSource: 'local-only',
        cost5h: 1.23, cost7d: 10.00, localCredits5h: 2800, localCredits7d: 9100,
      }),
      [], OFFPEAK_NOW,
    );
    assert.ok(label.includes('5h:§2.8k'), `Expected compact credits: ${label}`);
    assert.ok(label.includes('7d:§9.1k'), `Expected compact credits: ${label}`);
  });

  test('multi-root PJ aggregate follows the primary unit', () => {
    const second = { ...mockProject, projectName: 'other-app', costToday: 1.00, creditsToday: 4.0 };
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache' }),
      [mockProject, second], OFFPEAK_NOW,
    );
    assert.match(label, /PJ:§13(?!\d)/, `Expected aggregated credits (9.1 + 4.0): ${label}`);
  });

  test('segments are joined with the · separator', () => {
    const label = buildLabel(
      makeData({ providerType: 'z-ai', dataSource: 'cache', context: makeContext(0.38, false) }),
      [mockProject], OFFPEAK_NOW,
    );
    assert.ok(label.includes('ctx 38% · my-app:'), `Expected · between segments: ${label}`);
    assert.doesNotMatch(label, / \| /, `The old | separator is gone: ${label}`);
  });
});

suite('Peak tooltip', () => {
  test('inside the peak the tooltip names the end time', () => {
    const tip = buildTooltip(makeData({ providerType: 'z-ai', dataSource: 'cache' }), [], PEAK_NOW);
    assert.ok(tip.includes('Peak until'), `Expected the end-time hint:\n${tip}`);
  });

  test('outside the peak the tooltip names the local window bounds', () => {
    const tip = buildTooltip(makeData({ providerType: 'z-ai', dataSource: 'cache' }), [], OFFPEAK_NOW);
    // Local times depend on the machine zone, so match the shape: "Peak 09:00–13:00
    // (UTC+3)". The offset itself may carry half-hours ("UTC+3:30"), so it is not
    // closed with a digit here.
    assert.match(tip, /Peak \d{2}:\d{2}–\d{2}:\d{2} \(UTC[+-]/, `Expected window bounds:\n${tip}`);
  });

  test('claude-ai tooltip has no peak line', () => {
    const tip = buildTooltip(makeData({ providerType: 'claude-ai', dataSource: 'cache' }), [], PEAK_NOW);
    assert.ok(!tip.includes('Peak'), `Anthropic has no peak line:\n${tip}`);
  });

  test('cost lines follow the primary unit', () => {
    const tip = buildTooltip(
      makeData({ providerType: 'z-ai', dataSource: 'local-only', localCreditsDay: 11.2 }),
      [mockProject], OFFPEAK_NOW,
    );
    // Padding-independent shape with a digit+dot boundary (a bare includes('§11')
    // would also pass for §110 and §11.2), anchored to the line it belongs to.
    assert.match(tip, /day:\s+§11(?![\d.])/, `Expected credits in the cost section:\n${tip}`);
    assert.match(tip, /Today: §9(?![\d.])/, `Expected project credits (creditsToday 9.1):\n${tip}`);
  });
});
