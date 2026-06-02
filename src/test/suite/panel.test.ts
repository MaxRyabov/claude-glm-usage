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
