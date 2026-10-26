// Isolated browser fixture: no Codex access and no authentication-file writes.
import fs from 'node:fs';
import { startGoalsPanel, openGoalsBrowser } from '../../src/goals-panel.js';
const now = Date.now();
const rows = [
  { id: 'demo-site', title: 'Finalizar o painel financeiro do projeto', cwd: 'C:\\Projetos\\Financeiro' },
  { id: 'demo-tests', title: 'Corrigir os testes de integração e revisar a documentação', cwd: 'C:\\Projetos\\Automação' },
];
let status = { state: 'waiting_quota', running: true, account: 'jey', autoSwitch: true, selected: rows[0], detail: 'Contas sem capacidade ou em proteção. Aguardando sem alternar.', nextCheck: now + 12 * 60000,
  quotas: { jey: { known: true, allowed: false, remaining: 0, resetAt: now + 12 * 60000 }, americano: { known: true, allowed: false, remaining: 0, resetAt: now + 25 * 60000 }, hb: { known: true, allowed: false, remaining: 0, resetAt: now + 18 * 60000 } }, holds: {}, profilesReady: true,
  profiles: [{id:'jey',label:'JEY',configured:true},{id:'americano',label:'AMERICANO',configured:true},{id:'hb',label:'HB',configured:false}], accountSetup:{state:'idle'} };
let execution={runId:'preview',threadId:rows[0].id,lastEventAt:now,turnActive:false,pending:[],events:[
  {id:1,at:now-30000,kind:'session',text:'Execução iniciada pelo Codex CLI.'},
  {id:2,at:now-25000,kind:'message',text:'Vou revisar a implementação e executar os testes do projeto.'},
  {id:3,at:now-20000,kind:'command',text:'npm test\nCódigo de saída: 0'},
  {id:4,at:now-18000,kind:'output',text:'44 testes passaram.\nNenhuma falha encontrada.'},
  {id:5,at:now,kind:'goal',text:'Limite de uso atingido. Aguardando capacidade sem alternar logins.'},
]};
const panel = await startGoalsPanel({
  status: () => ({...status,execution}),
  execution:()=>execution,
  listThreads: async () => rows,
  selectGoal: async (id) => {execution={...execution,threadId:id,events:[],turnActive:false,pending:[]};return status = { ...status, state:'idle',readyToStart:false,selected: {...rows.find((row) => row.id === id),goalStatus:'paused',objective:'Objetivo de demonstração.'} };},
  start: async () => {execution={...execution,turnActive:true,events:[{id:1,at:Date.now(),kind:'message',text:'Executando o Goal selecionado pelo CLI.'}]};return status = { ...status, state: 'running', running: true,detail:'Turno confirmado em execução pelo Codex CLI.' };},
  stop: async () => {execution.turnActive=false;return status = { ...status, state: 'stopped', running: false, detail: 'Execução pausada. Goal preservado.',selected:{...status.selected,goalStatus:'paused'} };},
  confirmSelection:async(payload)=>(status={...status,readyToStart:payload.confirmed}),
  connectHB:async()=>{status.accountSetup={state:'waiting',code:'DEMO-1234',url:'https://auth.openai.com/codex/device'};return status.accountSetup;},
  cancelHB:async()=>{status.accountSetup={state:'cancelled'};return status.accountSetup;},
  createGoal:async(payload)=>{execution={...execution,threadId:'demo-new',events:[],turnActive:false};return status={...status,state:'idle',readyToStart:true,selected:{id:'demo-new',title:payload.objective,cwd:payload.cwd,objective:payload.objective,goalStatus:'paused'}};},
  decide:async()=>{execution.pending=[];return{queued:true};},
  setAutomatic: async (enabled) => (status = { ...status, autoSwitch: enabled }),
  logs: () => 'Demonstração visual com contas fictícias. Nenhuma execução real iniciada.',
}, { openBrowser: process.argv.includes('--open') ? openGoalsBrowser : () => {}, html: () => fs.readFileSync(new URL('../../plugin/resources/goals.html', import.meta.url), 'utf8') });
console.log(panel.url);
if (process.argv.includes('--open')) {
  await panel.open();
  console.log('Browser opening confirmed by an authenticated page request.');
}
