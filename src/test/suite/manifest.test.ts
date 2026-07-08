import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// __dirname at runtime: <root>/out/test/suite → repo root is three levels up.
const ROOT = path.resolve(__dirname, '..', '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

suite('package.json manifest hardening', () => {
  test('credentials.path setting is machine-scoped (M-4)', () => {
    const setting =
      pkg.contributes.configuration.properties['claudeStatus.credentials.path'];
    assert.strictEqual(setting.scope, 'machine');
  });

  test('chart.js is a bundled dependency, not a CDN load (H-2)', () => {
    assert.ok(
      pkg.dependencies && pkg.dependencies['chart.js'],
      'chart.js must be listed in dependencies',
    );
  });

  test('claudeProvider enum includes z-ai and custom-endpoint', () => {
    const setting = pkg.contributes.configuration.properties['claudeStatus.claudeProvider'];
    assert.ok(setting.enum.includes('z-ai'), 'enum must include z-ai');
    assert.ok(setting.enum.includes('custom-endpoint'), 'enum must include custom-endpoint');
    // enumDescriptions must stay aligned with enum length
    assert.strictEqual(setting.enum.length, setting.enumDescriptions.length);
  });

  test('pricing.models per-model override setting is declared', () => {
    const setting = pkg.contributes.configuration.properties['claudeStatus.pricing.models'];
    assert.ok(setting, 'claudeStatus.pricing.models must exist');
    assert.strictEqual(setting.type, 'object');
  });
});
