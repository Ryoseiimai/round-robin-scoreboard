// Node 22でも `node --test tests/` で実行できる入口。
// `node --test tests/` は tests/ を「ディレクトリ」としてではなく、
// index.js を本体とするモジュールとして解決して1ファイルだけ実行する
// (Node の標準モジュール解決の動き)。新しいテストファイルを追加しても
// ここに import を足さないと一生実行されないので、追加したら必ずここにも足す。
import('./points.test.mjs');
import('./workflow-run-injection.test.mjs');
import('./go-live-gitignore.test.mjs');
