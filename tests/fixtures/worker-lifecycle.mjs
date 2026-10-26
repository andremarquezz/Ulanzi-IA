import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.LOCALAPPDATA;
const interactive = process.argv.includes('--paused');
if (!root || !path.basename(root).startsWith('ulanzi-goals-lifecycle-')) throw Error('This fixture requires an isolated test directory.');
fs.writeFileSync(path.join(root,'native-goal.json'),JSON.stringify({status:interactive?'paused':'usageLimited',threadId:'same-goal',objective:'Fixture objective'}));
const fakeServer = `const fs=require('node:fs'),path=require('node:path');const file=path.join(process.env.LOCALAPPDATA,'native-goal.json');const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const f=JSON.parse(line);if(f.id==null)return;let result={};
fs.appendFileSync(path.join(process.env.LOCALAPPDATA,'requests.log'),JSON.stringify(f)+'\\n');
if(f.method==='thread/goal/get')result={goal:JSON.parse(fs.readFileSync(file,'utf8'))};
if(f.method==='thread/list')result={data:[{id:'same-goal',name:'Fixture Goal',cwd:process.cwd()}]};
if(f.method==='thread/start')result={thread:{id:'new-fixture-goal'}};
if(f.method==='thread/goal/set'){const g={...JSON.parse(fs.readFileSync(file,'utf8')),...f.params};fs.writeFileSync(file,JSON.stringify(g));if(g.status==='active'){
console.log(JSON.stringify({method:'turn/started',params:{threadId:g.threadId,turn:{id:'owned-live-turn'}}}));
console.log(JSON.stringify({method:'item/started',params:{threadId:g.threadId,item:{id:'cmd',type:'commandExecution',command:'npm test'}}}));
console.log(JSON.stringify({method:'item/commandExecution/outputDelta',params:{threadId:g.threadId,itemId:'cmd',delta:'PASS fixture'}}));}}
if(f.method==='turn/interrupt')console.log(JSON.stringify({method:'turn/completed',params:{threadId:f.params.threadId,turn:{id:f.params.turnId,status:'interrupted'}}}));
if(f.method==='account/rateLimits/read')result={ordinaryUsageAllowed:false,accountId:JSON.parse(require('node:fs').readFileSync('auth.json','utf8')).tokens.account_id};
console.log(JSON.stringify({id:f.id,result}));});`;
for (const [name, id] of [['.codex', 'jey-id'], ['.codex-jey', 'jey-id'], ['.codex-americano', 'american-id']]) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: id }, fixture: true }));
  fs.writeFileSync(path.join(home, 'app-server'), fakeServer);
}
process.env.JEY_CODEX_BIN = process.execPath;
const { createGoalController } = await import('../../src/goals.js');
const { goalFile, fingerprint, writeJSON } = await import('../../src/goal-store.js');
const { switchCodexAccount } = await import('../../src/switch.js');
writeJSON(goalFile('selection.json'), { id: 'same-goal', title: 'Fixture Goal', fingerprint: fingerprint() });
const workerArg=process.argv.slice(2).find(v=>!v.startsWith('--'));
const controller = createGoalController({ ...(workerArg ? { workerPath: path.resolve(workerArg) } : {}) });
const waitFor = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (predicate(controller.status())) return; await new Promise((r) => setTimeout(r, 50)); }
  throw Error('Worker state timed out: ' + JSON.stringify(controller.status()));
};
let pid;
try {
  await assert.rejects(controller.start(), /Confirme no painel/);
  if(interactive){
    await controller.selectGoal('same-goal');
    assert.equal(controller.status().selected.goalStatus,'paused');
    await controller.confirmSelection({threadId:'same-goal',confirmed:true});
    assert.equal(controller.status().readyToStart,true);
  }
  await controller.start({ confirmed: true });
  await waitFor((s) => s.state === (interactive?'running':'waiting_quota'));
  pid = controller.status().pid;
  assert.equal(controller.status().running, true);
  if(!interactive)assert.equal(Object.keys(controller.status().quotas).length, 2);
  else { await waitFor(()=>controller.execution().events.some(e=>e.kind==='output'&&e.text.includes('PASS fixture'))); }
  const second = await controller.start({ confirmed: true });
  assert.equal(second.pid, pid, 'duplicate start must not spawn a new worker');
  await assert.rejects(switchCodexAccount('americano'), /Pare o monitor/);
  await assert.rejects(controller.selectGoal('other-goal'), /Pare o monitor/);
  await controller.setAutomatic(false);
  assert.equal(controller.status().autoSwitch, false);
  await controller.stop();
  await waitFor((s) => s.state === 'stopped' && !s.running);
  if(interactive){
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'native-goal.json'),'utf8')).status,'paused');
    assert.match(fs.readFileSync(path.join(root,'requests.log'),'utf8'),/turn\/interrupt/);
    await assert.rejects(controller.createGoal({objective:'Test',cwd:'relative/path'}),/caminho completo/);
    await controller.createGoal({objective:'Create a new Goal without starting it',cwd:root});
    assert.equal(controller.status().selected.id,'new-fixture-goal');
    assert.equal(controller.status().selected.goalStatus,'paused');
    assert.equal(controller.status().readyToStart,true);
    assert.equal(controller.status().running,false);
  }
  console.log('Detached worker started, waited for both accounts, rejected conflicting actions and stopped.');
} finally {
  await controller.stop();
  try { await waitFor((s) => !s.running); } catch { if (pid) process.kill(pid); }
}
