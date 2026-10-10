// 回帰テスト: store/go_live.sh を実行しても、ローカル専用の控え(TestFlight招待リンク等)が
// 公開リポジトリへのコミット対象に入らないことを確認する(2026-10-10 security-audit finding 2)。
// 実際のgitコマンドを使った使い捨てのテスト用リポジトリ(os.tmpdir配下)の中だけで検証し、
// 本物のリポジトリやネットワークには一切触れない。
//
// 注: 当初は`git add -A -- . ':!控え' ...`のように明示pathspecでも除外する案を試したが、
// すでに.gitignoreで無視されているパスを明示pathspecで指定すると、gitが
// "ignored files"警告つきで終了コード1を返すことを確認した。go_live.shは
// `set -euo pipefail`なので、その案だと毎回この行で止まってしまう。
// そのため.gitignoreだけに頼る形(終了コード0で正しく除外される)を採用している。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const gitignoreText = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
const goLiveText = readFileSync(path.join(repoRoot, 'store', 'go_live.sh'), 'utf8');

const SENSITIVE_PATTERNS_IN_GITIGNORE = ['控え/', '.playwright-mcp/', 'store/review-reply-2.1.md'];
const SENSITIVE_PATHS_ON_DISK = ['控え/dummy-invite.txt', '.playwright-mcp/dummy.json', 'store/review-reply-2.1.md'];

test('.gitignoreに、ローカル専用の控え・自動操作ログ・レビュー返信メモが入っている', () => {
  for (const pattern of SENSITIVE_PATTERNS_IN_GITIGNORE) {
    assert.ok(gitignoreText.includes(pattern), `.gitignoreに ${pattern} が見つからない`);
  }
});

test('go_live.shのgit addの行は、ignore済みパスを明示pathspecで除外しようとしていない(終了コード1で落ちる罠を踏まない)', () => {
  const addLine = goLiveText.split('\n').find(l => /^\s*git add -A\b/.test(l));
  assert.ok(addLine, 'go_live.sh内に git add -A の行が見つからない');
  assert.doesNotMatch(addLine, /:!/, 'ignore済みパスへの明示pathspec除外はgitが終了コード1を返すため使わないこと');
});

test('実際にgit add -Aを実行すると、終了コード0で、控え/等はステージされず、通常ファイルはステージされる', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'go-live-gitignore-test-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');

    writeFileSync(path.join(tmp, '.gitignore'), gitignoreText);
    mkdirSync(path.join(tmp, 'www'), { recursive: true });
    writeFileSync(path.join(tmp, 'www', 'index.html'), '<html>dummy</html>');
    for (const rel of SENSITIVE_PATHS_ON_DISK) {
      const full = path.join(tmp, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, 'dummy test content, not real secret data');
    }

    // go_live.shと同じ行(`git add -A`)を、本物のリポジトリに触れずテスト用リポジトリで再現する。
    const addLine = goLiveText.split('\n').find(l => /^\s*git add -A\b/.test(l)).trim();
    assert.equal(addLine, 'git add -A', '想定と違う形のgit add行になっている');
    git('add', '-A');

    const staged = git('diff', '--cached', '--name-only').trim().split('\n').filter(Boolean);
    for (const rel of SENSITIVE_PATHS_ON_DISK) {
      assert.ok(!staged.includes(rel), `${rel} がステージされてしまっている: ${staged.join(', ')}`);
    }
    assert.ok(staged.includes('www/index.html'), '無関係な通常ファイルまで除外されてしまっている');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
