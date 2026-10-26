const states = { running: 'EM EXECUÇÃO', waiting_codex: 'AGUARDANDO CLI', waiting_approval: 'SUA DECISÃO', waiting_quota: 'SEM COTA', switching: 'TROCANDO', resuming: 'RETOMANDO', retrying: 'AGUARDANDO', starting: 'INICIANDO' };
export function goalIconSvg(kind, status = {}) {
  let color, label, detail, glyph;
  const folder = '<path d="M40 53h25l8 9h31v32H40z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>';
  const play = '<path d="m57 47 38 25-38 25z" fill="currentColor"/>';
  const stop = '<path d="M53 48h13v44H53zM80 48h13v44H80z" fill="currentColor"/>';
  if (kind === 'automatic') {
    color = status.autoSwitch !== false ? '#34d399' : '#8496ae';
    label = status.autoSwitch !== false ? 'AUTO LIGADO' : 'AUTO DESLIG.';
    detail = 'TROCA DE CONTA';
    glyph = '<path d="M42 57h56l-12-12m16 30H46l12 12" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>';
  } else if (kind === 'goals') {
    color = '#38cfff'; label = 'PAINEL GOALS'; detail = 'SAÍDA E CONTROLE';
    glyph = '<path d="M45 42h54v51H45zM55 54h32M55 67h32M55 80h19" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/>';
  } else if (status.running) {
    color = ['waiting_quota', 'retrying', 'waiting_approval'].includes(status.state) ? '#fbbf24' : '#34d399';
    label = 'PAUSAR'; detail = status.execution?.pending?.length ? 'SUA DECISÃO' : status.execution?.turnActive ? 'EM EXECUÇÃO' : states[status.state] || 'CONTROLADOR ATIVO'; glyph = stop;
  } else if (!status.selected) {
    color = '#8496ae'; label = 'SEM GOAL'; detail = 'USE PAINEL GOALS'; glyph = '<circle cx="72" cy="71" r="24" fill="none" stroke="currentColor" stroke-width="4"/><path d="M57 71h30" stroke="currentColor" stroke-width="4"/>';
  } else if (['blocked', 'budgetLimited', 'complete'].includes(status.selected.goalStatus)) {
    color = status.selected.goalStatus === 'complete' ? '#34d399' : '#fbbf24';
    label = 'INDISPONÍVEL'; detail = status.selected.goalStatus === 'complete' ? 'GOAL CONCLUÍDO' : 'VEJA O PAINEL';
    glyph = folder;
  } else if (status.readyToStart !== true) {
    color = '#8496ae'; label = 'EXECUTAR'; detail = 'CONFIRME NO PAINEL'; glyph = play;
  } else {
    color = '#34d399'; label = status.selected.goalStatus === 'paused' || ['paused', 'stopped'].includes(status.state) ? 'RETOMAR' : 'EXECUTAR'; detail = 'PELO CODEX CLI'; glyph = play;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="22" fill="#101b29"/><rect x="5" y="5" width="134" height="134" rx="18" fill="none" stroke="${color}" stroke-width="2"/><text x="72" y="23" text-anchor="middle" font-family="sans-serif" font-size="9" font-weight="600" fill="#b5c6d8">${detail}</text><g color="${color}">${glyph}</g><text x="72" y="122" text-anchor="middle" font-family="sans-serif" font-size="11" font-weight="700" fill="${color}">${label}</text></svg>`;
}
