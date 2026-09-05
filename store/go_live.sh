#!/usr/bin/env bash
# 総当たりスコアボード — 公開スクリプト
#
# 実行者: 本人が `!` で手動実行すること（Claudeは実行しない）。
# 何をするか:
#   1. プロジェクトルートで git init（未initなら）→ 個人GitHub(ghp)にpush
#   2. store/site/ の中身を docs/ にコピー（GitHub Pages公開物）
#   3. www/index.html を docs/app/index.html にもコピー（Web版としても使えるように）
#   4. GitHub Pages を docs/ ソースで有効化
#   5. https://ryoseiimai.github.io/round-robin-scoreboard/ が200になるまで待つ
#
# 意図的な簡略化: 個人GitHub専用（ghp/Ryoseiimai固定）。組織移管や複数リポジトリ運用には未対応。
#   本格対応する場合はリポジトリ名・オーナー名を引数化すること。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="round-robin-scoreboard"
OWNER="Ryoseiimai"
PAGES_URL="https://ryoseiimai.github.io/${REPO_NAME}/"

cd "$ROOT_DIR"

echo "== 1. プロジェクトルート確認: $ROOT_DIR =="

if [ ! -d .git ]; then
  echo "== git未初期化なので git init -b main を実行 =="
  git init -b main
else
  echo "== 既存の.gitを使用 =="
fi

echo "== 2. docs/ を作成し、store/site/ の中身を公開用にコピー =="
rm -rf docs
mkdir -p docs
cp -R store/site/. docs/

echo "== 3. Web版アプリを docs/app/ にコピー =="
mkdir -p docs/app
cp www/index.html docs/app/index.html

echo "== 4. git add / commit =="
git add -A
if git diff --cached --quiet; then
  echo "== コミット対象の変更なし。スキップ =="
else
  git commit -m "$(cat <<'EOF'
Add App Store submission assets and GitHub Pages site

Claude-Session: https://claude.ai/code/session_01DKtVyGPpukcSdoGqNwwhwv
EOF
)"
fi

echo "== 5. 個人GitHub(ghp)にリポジトリ作成 & push =="
if ! git remote get-url origin >/dev/null 2>&1; then
  ghp repo create "$REPO_NAME" --public --source=. --push
else
  echo "== originが既に設定済み。git push origin main を実行 =="
  if ! git push origin main; then
    echo "== 通常pushが403等で失敗。credential.helperを差し替えて再push =="
    git -c credential.helper= \
        -c "credential.helper=!f(){ echo username=Ryoseiimai; echo password=\$(GH_CONFIG_DIR=\$HOME/.config/gh-personal gh auth token); }; f" \
        push origin main
  fi
fi

echo "== 6. GitHub Pages を docs/ ソースで有効化 =="
if ! ghp api "repos/${OWNER}/${REPO_NAME}/pages" >/dev/null 2>&1; then
  ghp api -X POST "repos/${OWNER}/${REPO_NAME}/pages" \
    -f 'source[branch]=main' -f 'source[path]=/docs'
else
  echo "== Pagesは既に有効化済み =="
fi

echo "== 7. ${PAGES_URL} が200になるまで待機（最大3分） =="
elapsed=0
max_wait=180
interval=10
until [ "$elapsed" -ge "$max_wait" ]; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$PAGES_URL" || echo "000")
  if [ "$status" = "200" ]; then
    echo "== 公開確認OK: ${PAGES_URL} (HTTP $status) =="
    exit 0
  fi
  echo "== まだ公開されていません（HTTP $status）。${interval}秒待って再確認... 経過${elapsed}秒 =="
  sleep "$interval"
  elapsed=$((elapsed + interval))
done

echo "== 3分待っても200になりませんでした。GitHub側の反映に時間がかかっている可能性があります。数分後に手動で ${PAGES_URL} を確認してください =="
exit 1
