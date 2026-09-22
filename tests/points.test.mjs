import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../www/index.html', import.meta.url), 'utf8');
const core = html.split('/* POINTS-CORE-START */')[1]?.split('/* POINTS-CORE-END */')[0];
assert.ok(core);
const ctx = vm.createContext({});
vm.runInContext(core, ctx);
const plain = value => JSON.parse(JSON.stringify(value));
const record = (id, date = '2026-09-23', mvps = []) => ({
  id, date, title: '大会',
  standings: ['田中', '佐藤', '鈴木', '高橋'].map((name, i) => ({teamName: `チーム${i}`, members: [name], rank: i + 1})),
  mvps, scorers: []
});
const sum = (history, period = 'all', year = 2026) => plain(ctx.aggregatePoints(history, period, year));

test('1〜4位は3/2/1/0pt、複数MVPには各+1、MVPなしは追加なし', () => {
  assert.deepEqual(plain(ctx.tournamentPoints(record('a'))), {田中:3, 佐藤:2, 鈴木:1, 高橋:0});
  assert.deepEqual(plain(ctx.tournamentPoints(record('a', undefined, ['田中', '高橋']))), {田中:4, 佐藤:2, 鈴木:1, 高橋:1});
});
test('apps・avgの丸め、平均対象とあと何大会か', () => {
  const history = [record('a', undefined, ['田中']), record('b'), record('c')];
  history[1].standings[1].members = [];
  history[2].standings[1].members = [];
  history[2].standings[2].members = [];
  const result = sum(history);
  assert.deepEqual(result.total.find(p => p.name === '田中'), {name:'田中', total:10, apps:3, avg:3.3, remaining:0});
  assert.deepEqual(result.average.map(p => p.name), ['田中', '高橋']);
  assert.equal(result.pending.find(p => p.name === '佐藤').remaining, 2);
  assert.equal(result.pending.find(p => p.name === '鈴木').remaining, 1);
});
test('total同点はappsが少ない順、平均はavg降順', () => {
  const a = record('a');
  const b = record('b');
  b.standings = [{teamName:'A', rank:3, members:['佐藤']}];
  assert.deepEqual(sum([a,b]).total.slice(0,2).map(p => p.name), ['田中','佐藤']);
  assert.deepEqual(sum([a,a,a]).average.map(p => p.avg), [3,2,1,0]);
});
test('今年と全期間を切り替え、年はローカル日付を使う', () => {
  const records = [record('old','2025-12-31'),record('new','2026-01-01')];
  assert.equal(sum(records, 'year').count, 1);
  assert.equal(sum(records).count, 2);
  assert.equal(sum(records, 'year', 2025).total[0].apps, 1);
  // UTCの前年末でも、端末ローカルのgetterが1月1日なら今年の日付。
  assert.equal(ctx.localDate({getFullYear:()=>2026,getMonth:()=>0,getDate:()=>1,toISOString:()=> '2025-12-31T15:00:00.000Z'}), '2026-01-01');
});
test('履歴1件削除でtotal/apps/平均対象が再計算される', () => {
  const history = [record('a',undefined,['田中']),record('b'),record('c')];
  const before = sum(history), after = sum(history.filter(r => r.id !== 'a'));
  assert.equal(before.total[0].total, 10);
  assert.equal(after.total[0].total, 6);
  assert.equal(after.total[0].apps, 2);
  assert.equal(after.average.length, 0);
});
test('空名を除外しtrimのみ行う、同名は1大会1出場・MVP加点1回', () => {
  const r = record('a', undefined, [' 田中 ', '田中', '', '  ']);
  r.standings[0].members = [' 田中 ', '田中', '', '  ', '__proto__', '田 中'];
  const result = sum([r]);
  assert.equal(result.total.find(p => p.name==='田中').total, 4);
  assert.equal(result.total.find(p => p.name==='田中').apps, 1);
  assert.ok(result.total.find(p => p.name==='田 中'));
  assert.ok(result.total.find(p => p.name==='__proto__'));
  assert.ok(result.total.every(p => p.name.trim()));
});

// 実物のアプリを最小DOMで起動し、保存経路も確認する。
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function app(initial = {}, throws = false) {
  const store = new Map(Object.entries(initial));
  const nodes = new Map();
  function node() {
    return {innerHTML:'', textContent:'', style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){}},
      listeners:{}, addEventListener(type,fn){ this.listeners[type]=fn; }, appendChild(){}, setAttribute(){},
      querySelector(){return node();}};
  }
  const document = {body:node(),createElement:node,querySelectorAll:()=>[],getElementById(id){
    if (!nodes.has(id)) nodes.set(id,node());
    return nodes.get(id);
  }};
  const context = vm.createContext({document, window:{scrollTo(){}}, navigator:{}, setTimeout(){},clearInterval(){},
    localStorage:{getItem(key){if(throws) throw Error('blocked'); return store.get(key) ?? null;},
      setItem(key,value){if(throws) throw Error('blocked'); store.set(key,value);},
      removeItem(key){if(throws) throw Error('blocked'); store.delete(key);}}});
  vm.runInContext(script.replace('  // ---------- 初期化 ----------', `
    globalThis.api = {getState:()=>state, getHistory:()=>tournamentHistory, saveTournamentHistory, renderFinale};
    // ---------- 初期化 ----------`), context);
  return {api:context.api, store, nodes};
}
function finishAll(api) {
  api.getState().matches = Array.from({length:12}, () => ({home:0,away:1,homeScore:0,awayScore:0,status:'done',log:[]}));
}
test('script全体が構文エラーなくパースできる', () => { assert.doesNotThrow(() => new Function(script)); });
test('旧state、壊れたJSON・不正な履歴、storage例外でも起動・終了・リセットできる', () => {
  const fixtures = [{}, {'rrsb_history_v1':'{'}, {'rrsb_history_v1':'[null,{}]'}, {'rrsb_history_v1':'{}'}, {'rr-scoreboard-v1':'{'}, {'rr-scoreboard-v1':JSON.stringify({started:false})}];
  for (const initial of fixtures) {
    const {api} = app(initial);
    assert.equal(api.getState().historyId, null);
    assert.equal(api.getHistory().length, 0);
    finishAll(api);
    api.saveTournamentHistory();
    api.renderFinale();
    assert.equal(api.getHistory().length, 1);
  }
  const blocked = app({},true);
  finishAll(blocked.api);
  blocked.api.saveTournamentHistory();
  blocked.api.renderFinale();
  blocked.nodes.get('btnReset').listeners.click();
  blocked.nodes.get('btnReset').listeners.click();
  assert.equal(blocked.api.getState().started,false);
});
test('終了でupsert、再描画で増えない、再読込とリセットで履歴を保持する', () => {
  const {api, store, nodes} = app();
  finishAll(api);
  api.getState().teams[0].members = [{name:'田中',gender:'M'}];
  api.saveTournamentHistory();
  const id = api.getState().historyId;
  api.renderFinale(); api.renderFinale(); api.saveTournamentHistory();
  assert.equal(api.getHistory().length, 1);
  assert.equal(api.getHistory()[0].id,id);
  assert.deepEqual(plain(api.getHistory()[0].mvps), []);
  api.getState().teams[0].name = '新チーム';
  api.saveTournamentHistory();
  assert.ok(api.getHistory()[0].standings.some(t=>t.teamName==='新チーム'));
  const restored = app(Object.fromEntries(store));
  restored.api.saveTournamentHistory();
  assert.equal(restored.api.getHistory().length,1);
  nodes.get('btnReset').listeners.click(); nodes.get('btnReset').listeners.click();
  assert.equal(api.getState().historyId,null);
  assert.equal(JSON.parse(store.get('rrsb_history_v1')).length,1);
});
test('実際の順位順・男女加重点の同点MVPを履歴化し、候補の属性をエスケープする', () => {
  const {api,nodes} = app();
  const state = api.getState();
  const unsafe = '<田中 "&\'>';
  state.teams.forEach((team,i) => {team.name=`チーム${i}`;team.members=[{name:i===0?unsafe:`選手${i}`,gender:i===1?'F':'M'}];});
  finishAll(api);
  state.matches[0] = {home:0,away:1,homeScore:2,awayScore:2,status:'done',log:[
    {teamIdx:0,player:unsafe,points:1},{teamIdx:0,player:unsafe,points:1},
    {teamIdx:1,player:'選手1',points:2}
  ]};
  api.saveTournamentHistory();
  const saved = plain(api.getHistory()[0]);
  assert.deepEqual(saved.standings.map(t=>t.rank),[1,2,3,4]);
  assert.deepEqual(saved.mvps,[unsafe,'選手1']);
  assert.deepEqual(saved.scorers.map(s=>s.count),[2,2]);
  assert.equal(sum([saved]).total.find(p=>p.name===unsafe).total,4);
  assert.match(nodes.get('knownPlayersList').innerHTML,/&lt;田中 &quot;&amp;&#39;&gt;/);
  api.renderFinale();
  assert.ok(!nodes.get('finaleBody').innerHTML.includes(unsafe));
});

test('全12試合doneのみ保存し、未終了の表彰式は注記、終了後は同じidにupsertする', () => {
  const {api,nodes} = app();
  api.saveTournamentHistory();
  assert.equal(api.getHistory().length,0);
  finishAll(api);
  const matches = api.getState().matches;
  matches[5].status = 'ongoing';
  matches[5].homeScore = 1;
  matches[5].log = [{teamIdx:0,player:'田中',points:1}];
  matches.slice(6).forEach(m => {m.status='pending';});
  api.saveTournamentHistory(); api.renderFinale();
  assert.equal(api.getHistory().length,0);
  assert.equal(api.getState().historyId,null);
  assert.match(nodes.get('finaleBody').innerHTML,/未終了の試合があるため、個人ポイントはまだ記録されていません/);
  matches.forEach(m => {m.status='done';});
  api.saveTournamentHistory(); api.renderFinale();
  assert.equal(api.getHistory().length,1);
  assert.match(nodes.get('finaleBody').innerHTML,/得点王 田中 \+1pt/);
  assert.doesNotMatch(nodes.get('finaleBody').innerHTML,/未終了の試合/);
  const saved = JSON.stringify(api.getHistory());
  matches[11].status = 'ongoing';
  api.saveTournamentHistory();
  assert.equal(JSON.stringify(api.getHistory()),saved);
  matches[11].status = 'done';
  matches[11].log = [{teamIdx:1,player:'佐藤',points:1}];
  api.saveTournamentHistory(); api.renderFinale();
  assert.equal(api.getHistory().length,1);
  assert.match(nodes.get('finaleBody').innerHTML,/得点王 田中・佐藤 各\+1pt/);
  const completed = JSON.stringify(api.getHistory());
  matches.pop();
  api.getState().teams[0].name = '保存されない変更';
  api.saveTournamentHistory();
  assert.equal(JSON.stringify(api.getHistory()),completed);
});
