// 回帰テスト: .github/workflows/*.yml の run: 本文に、外部から影響できる
// ${{ inputs.* }} / ${{ steps.*.outputs.* }} / ${{ github.event.* }} を直接埋め込んでいないことを確認する。
// GitHub Actionsはrun:の値をシェルに渡す前に文字列としてそのまま貼り付けるため、
// 直接埋め込むと引用符やセミコロンを使ったコマンド注入が可能になる(2026-10-10 security-audit finding 1)。
// 正しい形は env: で一度シェル変数に渡してから "$VAR" として使うこと。
//
// 意図的な簡略化: 本格的なYAMLパーサは使わず、`run:`キーのブロックスカラーをインデントで
// 抜き出す簡易パーサ。このワークフロー群の書き方(全てブロックスカラー `run: |`)には十分。
// 本格対応するときはjs-yaml等でASTから `steps[].run` を取り出す形にすること。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

// `run: |` (または `run:` 単独行) の直後から、インデントが戻るまでの行を1ブロックとして集める。
function extractRunBlocks(yamlText) {
  const lines = yamlText.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)run:\s*\|?\s*$/);
    if (!m) continue;
    const runIndent = m[1].length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') { body.push(l); continue; }
      if (indentOf(l) <= runIndent) break;
      body.push(l);
    }
    blocks.push({ startLine: i + 1, text: body.join('\n') });
    i = j - 1;
  }
  return blocks;
}

// 外部から影響できる(ワークフロー実行時の入力・直前ステップの出力・イベント本文)コンテキストだけを対象にする。
// secrets.* / runner.* / github.repository 等、攻撃者が値を選べないものは対象外。
const DANGEROUS = /\$\{\{\s*(inputs\.[\w.-]+|steps\.[\w-]+\.outputs\.[\w.-]+|github\.event\.[^}]+|github\.head_ref)\s*\}\}/;

test('GitHub Actionsのrun:本文に外部入力の${{ }}を直接埋め込んでいない(script injection対策)', () => {
  const files = readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  assert.ok(files.length > 0, '.github/workflows/ 配下にワークフローが見つからない');

  for (const file of files) {
    const text = readFileSync(path.join(workflowsDir, file), 'utf8');
    for (const block of extractRunBlocks(text)) {
      const found = block.text.match(DANGEROUS);
      assert.ok(
        !found,
        `${file} の run:本文(${block.startLine}行目付近)に直接埋め込まれた危険な式があります: ${found && found[0]}。` +
        'env: で変数に渡してから "$VAR" として使う形に直してください。'
      );
    }
  }
});
