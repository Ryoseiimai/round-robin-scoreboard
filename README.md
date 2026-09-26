# 総当たりスコアボード

正本は `www/index.html`。Capacitor で iOS アプリ化している（`ios/` ディレクトリ）。

## iOS で開く

```
npx cap sync ios
open ios/App/App.xcworkspace
```

## iOS の週次/オンデマンド審査提出（クラウド・無人）

`.github/workflows/ios-release.yml` が GitHub Actions の macOS ランナーで無人ビルド・審査提出まで行う。Xcode本人サインインは使わず、App Store Connect APIキー（`ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_KEY_P8`/`ASC_TEAM_ID` の4 secrets）で `-allowProvisioningUpdates` の自動署名管理を使う。

- 起動条件: LINEで承認者が「アプリにも反映して」と言った時（line-autofix Workerがdispatch）／毎週月曜（`www/`に前回反映後の未反映変更がある時だけ）
- 審査中のバージョンがあれば `scripts/ios-release.mjs prepare` がASC APIで検知し、その回は見送る
- `dry_run=true`（既定）は archive までで停止。実際のアップロード・審査提出は `dry_run=false` のときだけ
- ビルド番号は `store/ExportOptionsUpload.plist` の `manageAppVersionAndBuildNumber` でApple側が自動採番。バージョン文字列（例 1.1→1.2）は既存の App Store Connect 上のバージョン状態を見て自動で決める
- 署名証明書の手動インポートは実装していない（Apple発行済みの`.cer`が手元になく、CSR/秘密鍵だけではp12を組み立てられないため）。本格対応するときは`.cer`取得→p12化→キーチェーン導入の経路を追加する
