import * as assert from 'assert';
import { getWebviewContent } from '../../webview/panel';

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
    // cache, so it must never reach innerHTML.
    assert.ok(html.includes('badge.textContent = level'), 'plan tier must be set via textContent');
    // Scoped to the externally-sourced values rather than banning markup sinks outright: the
    // dashboard legitimately builds project and chart markup that way, escaping as it goes.
    // What must never happen is the quota values reaching one. Assignment, append and
    // insertAdjacentHTML are all covered; the identifiers are the specific ones this change
    // introduces, not generic words like "total" that appear all over the cost rendering.
    const sinks = html.match(/(?:\.(?:inner|outer)HTML\s*\+?=|insertAdjacentHTML\s*\()[^;]*/g) ?? [];
    const tainted = sinks.filter(sink => /(planLevel|credits5h|credits7d|amounts)/.test(sink));
    assert.deepStrictEqual(tainted, [], 'quota values must not reach a markup sink');
  });

  test('amounts are written as text too', () => {
    assert.ok(/el\.textContent = parts\.join/.test(html), 'amounts must be set via textContent');
  });
});
