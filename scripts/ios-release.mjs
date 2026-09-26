#!/usr/bin/env node
// App Store Connect API で iOS の週次/オンデマンド審査提出を無人化するスクリプト（依存ゼロ、node:crypto の ES256 署名だけでJWTを組み立てる）。
// 呼び出し方は .github/workflows/ios-release.yml を参照。
//   prepare <currentVersion>  … 審査中バージョンの有無を確認し、出すべきversionStringを決めて$GITHUB_OUTPUTへ書く
//   finalize <versionId> <versionString> <whatsNewFile>  … アップロード済みビルドの処理完了を待ち、紐付けて審査提出する
//
// 意図的な簡略化: 署名はASC APIキーによる自動管理(xcodebuild -allowProvisioningUpdates)に任せ、
// 配布証明書(.p12)の手動インポートは実装していない（手元にApple発行済みの.cerがなく、dist.csr/dist.keyだけではp12を組み立てられないため）。
// 本格対応するときは、ASCから.cerを取得して.p12化し、apple-actions/import-codesign-certs等でキーチェーンへ導入する経路を追加する。
// finalize の内部（ビルド処理待ち～審査提出）は、このタスクでは dry_run=true のarchiveまでしか実走確認していない。
// 初回の実提出時はActionsのログとASCの実データを見ながらAPIレスポンス形状のズレを調整すること。
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';

const API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const BUNDLE_ID = 'jp.co.ryoseiworld.scoreboard';
const REVIEW_IN_PROGRESS_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE'];
const BUILD_WAIT_TIMEOUT_MS = 25 * 60 * 1000;
const BUILD_POLL_INTERVAL_MS = 30 * 1000;

function need(name) {
 const v = process.env[name];
 if (!v) throw new Error(`missing env ${name}`);
 return v;
}

function b64url(input) {
 return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJwt(keyId, issuerId, pem) {
 const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
 const now = Math.floor(Date.now() / 1000);
 const payload = { iss: issuerId, iat: now, exp: now + 60 * 19, aud: 'appstoreconnect-v1' };
 const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
 const key = createPrivateKey(pem);
 const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
 return `${signingInput}.${b64url(signature)}`;
}

class ASC {
 constructor(keyId, issuerId, pem) { this.keyId = keyId; this.issuerId = issuerId; this.pem = pem; this.token = null; this.issuedAt = 0; }
 authHeader() {
  if (!this.token || Date.now() / 1000 - this.issuedAt > 60 * 15) { this.token = makeJwt(this.keyId, this.issuerId, this.pem); this.issuedAt = Date.now() / 1000; }
  return `Bearer ${this.token}`;
 }
 async req(method, path, body) {
  const url = path.startsWith('http') ? path : API_BASE + path;
  const headers = { Authorization: this.authHeader() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
   const text = await res.text().catch(() => '');
   throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 800)}`);
  }
  if (res.status === 204) return null;
  return res.json();
 }
 get(path) { return this.req('GET', path); }
 post(path, body) { return this.req('POST', path, body); }
 patch(path, body) { return this.req('PATCH', path, body); }
}

async function getAppId(asc, bundleId) {
 const res = await asc.get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
 const app = res.data[0];
 if (!app) throw new Error(`app not found for bundleId=${bundleId}`);
 return app.id;
}

function bumpVersion(v) {
 const parts = v.split('.').map(n => parseInt(n, 10));
 if (parts.some(Number.isNaN)) throw new Error(`unbumpable version: ${v}`);
 parts[parts.length - 1] += 1;
 return parts.join('.');
}

async function resolveVersion(asc, appId, currentVersion) {
 const res = await asc.get(`/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=50`);
 const versions = res.data || [];
 const blocking = versions.find(v => REVIEW_IN_PROGRESS_STATES.includes(v.attributes.appStoreState));
 if (blocking) return { blocked: true, reason: `${blocking.attributes.versionString} is ${blocking.attributes.appStoreState}` };
 const editable = versions.find(v => v.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION');
 if (editable) return { blocked: false, created: false, versionId: editable.id, versionString: editable.attributes.versionString };
 const used = new Set(versions.map(v => v.attributes.versionString));
 let next = currentVersion;
 while (used.has(next)) next = bumpVersion(next);
 const created = await asc.post('/appStoreVersions', {
  data: { type: 'appStoreVersions', attributes: { platform: 'IOS', versionString: next }, relationships: { app: { data: { type: 'apps', id: appId } } } }
 });
 return { blocked: false, created: true, versionId: created.data.id, versionString: next };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForBuild(asc, appId, versionString) {
 const start = Date.now();
 while (Date.now() - start < BUILD_WAIT_TIMEOUT_MS) {
  const res = await asc.get(`/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(versionString)}&sort=-uploadedDate&limit=5`);
  const builds = res.data || [];
  const ready = builds.find(b => b.attributes.processingState === 'VALID');
  if (ready) return ready.id;
  const failed = builds.find(b => ['FAILED', 'INVALID'].includes(b.attributes.processingState));
  if (failed) throw new Error(`build processing failed: ${JSON.stringify(failed.attributes)}`);
  await sleep(BUILD_POLL_INTERVAL_MS);
 }
 throw new Error(`timed out waiting for build ${versionString} to finish processing`);
}

async function submitForReview(asc, appId, versionId, buildId, whatsNew) {
 const locRes = await asc.get(`/appStoreVersions/${versionId}/appStoreVersionLocalizations?filter[locale]=ja`);
 const locId = locRes.data?.[0]?.id;
 if (locId) await asc.patch(`/appStoreVersionLocalizations/${locId}`, { data: { type: 'appStoreVersionLocalizations', id: locId, attributes: { whatsNew: whatsNew.slice(0, 4000) } } });
 await asc.patch(`/appStoreVersions/${versionId}`, {
  data: { type: 'appStoreVersions', id: versionId, attributes: { releaseType: 'AFTER_APPROVAL' }, relationships: { build: { data: { type: 'builds', id: buildId } } } }
 });
 const rs = await asc.post('/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: appId } } } } });
 const rsId = rs.data.id;
 await asc.post('/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: rsId } }, appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } } } });
 await asc.patch(`/reviewSubmissions/${rsId}`, { data: { type: 'reviewSubmissions', id: rsId, attributes: { submitted: true } } });
 return rsId;
}

function writeOutput(obj) {
 const outFile = process.env.GITHUB_OUTPUT;
 const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
 if (outFile) appendFileSync(outFile, lines.join('\n') + '\n');
 else console.log(lines.join('\n'));
}

async function main() {
 const [, , cmd, ...args] = process.argv;
 const asc = new ASC(need('ASC_KEY_ID'), need('ASC_ISSUER_ID'), readFileSync(need('ASC_KEY_PATH'), 'utf8'));
 if (cmd === 'prepare') {
  const currentVersion = args[0];
  if (!currentVersion) throw new Error('usage: prepare <currentVersion>');
  const appId = await getAppId(asc, BUNDLE_ID);
  const result = await resolveVersion(asc, appId, currentVersion);
  writeOutput({ app_id: appId, blocked: result.blocked, reason: result.reason || '', version: result.versionString || '', version_id: result.versionId || '' });
 } else if (cmd === 'finalize') {
  const [versionId, versionString, whatsNewPath] = args;
  if (!versionId || !versionString || !whatsNewPath) throw new Error('usage: finalize <versionId> <versionString> <whatsNewFile>');
  const appId = await getAppId(asc, BUNDLE_ID);
  const whatsNew = readFileSync(whatsNewPath, 'utf8').trim() || '直近の改善を反映しました。';
  const buildId = await waitForBuild(asc, appId, versionString);
  const reviewSubmissionId = await submitForReview(asc, appId, versionId, buildId, whatsNew);
  writeOutput({ build_id: buildId, review_submission_id: reviewSubmissionId });
 } else {
  throw new Error(`unknown command: ${cmd} (expected prepare|finalize)`);
 }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
