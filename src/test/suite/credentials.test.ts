import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { validateCredentialsPath } from '../../data/apiClient';

suite('Credentials path validation', () => {
  test('accepts the default path inside ~/.claude', () => {
    const p = path.join(os.homedir(), '.claude', '.credentials.json');
    assert.strictEqual(validateCredentialsPath(p), path.resolve(p));
  });

  test('accepts ~/.claude itself', () => {
    const p = path.join(os.homedir(), '.claude');
    assert.strictEqual(validateCredentialsPath(p), path.resolve(p));
  });

  test('throws for an absolute path outside ~/.claude', () => {
    // On Windows this resolves under the cwd drive, still outside ~/.claude.
    assert.throws(() => validateCredentialsPath('/etc/passwd'), /must be inside/);
  });

  test('throws for a traversal escaping ~/.claude', () => {
    const p = path.join(os.homedir(), '.claude', '..', 'evil');
    assert.throws(() => validateCredentialsPath(p), /must be inside/);
  });
});
