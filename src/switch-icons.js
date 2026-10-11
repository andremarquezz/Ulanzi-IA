// Compact SVG keys designed to remain legible on the Ulanzi D200H at 144x144.
// Keep account identity in color and a one-letter corner monogram, not large text.
const ACCOUNTS = {
  jey: {
    initial: 'J',
    accent: '#38cfff',
    accentSoft: '#8be4ff',
    background: '#0b2032',
    edge: '#27627f',
  },
  americano: {
    initial: 'A',
    accent: '#80e86a',
    accentSoft: '#bbf5a8',
    background: '#12271d',
    edge: '#3c7650',
  },
};

const STATUS = {
  idle: { border: null, badge: '#536275', ink: '#a5b5c7' },
  active: { border: '#34d399', badge: '#34d399', ink: '#063b2e' },
  switching: { border: '#fbbf24', badge: '#fbbf24', ink: '#422006' },
  error: { border: '#fb556c', badge: '#fb556c', ink: '#3b0914' },
};

function badgeIcon(state, ink) {
  const stroke = 'fill="none" stroke="' + ink + '" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"';

  if (state === 'active') {
    return '<path d="M104 110 l6 6 11-13" ' + stroke + '/>';
  }

  if (state === 'error') {
    return '<path d="M112 103 v10" ' + stroke + '/>'
      + '<circle cx="112" cy="119" r="2.3" fill="' + ink + '"/>';
  }

  if (state === 'switching') {
    return '<path d="M103 108 a10 10 0 0 1 17-3" ' + stroke + '/>'
      + '<path d="M120 101 v6 h-6" ' + stroke + '/>'
      + '<path d="M121 116 a10 10 0 0 1-17 3" ' + stroke + '/>'
      + '<path d="M104 123 v-6 h6" ' + stroke + '/>';
  }

  return '<path d="M105 112 h13 m-5-5 5 5-5 5" ' + stroke + '/>';
}

export function switchIconSvg(account, state = 'idle', stage = '') {
  const identity = ACCOUNTS[account] || ACCOUNTS.jey;
  const status = STATUS[state] || STATUS.idle;
  const statusName = STATUS[state] ? state : 'idle';
  const strokeColor = status.border || identity.edge;

  // These three strokes convey "code", independent of any platform font.
  const mark = [
    '<path d="M54 48 30 72 54 96" fill="none" stroke="' + identity.accentSoft + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M90 48 114 72 90 96" fill="none" stroke="' + identity.accentSoft + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M80 44 64 100" fill="none" stroke="' + identity.accent + '" stroke-width="10" stroke-linecap="round"/>',
  ].join('');

  const phase = stage === 'FECHANDO' ? 1
    : stage === 'TROCANDO' || stage === 'LENDO' || stage === 'INICIANDO' ? 2
      : stage === 'ABRINDO' || stage === 'AGUARDE' ? 3
        : 1;

  const bars = statusName === 'switching'
    ? [0, 1, 2].map((index) => {
        const x = 18 + index * 24;
        const fill = index < phase ? '#fbbf24' : '#54472d';
        return '<rect x="' + x + '" y="120" width="17" height="5" rx="2.5" fill="' + fill + '"/>';
      }).join('')
    : '';

  return '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
    + '<defs>'
    + '<linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="' + identity.background + '"/>'
    + '<stop offset="1" stop-color="#080d16"/>'
    + '</linearGradient>'
    + '<radialGradient id="glow"><stop offset="0" stop-color="' + identity.accent + '" stop-opacity=".16"/>'
    + '<stop offset="1" stop-color="' + identity.accent + '" stop-opacity="0"/></radialGradient>'
    + '</defs>'
    + '<rect width="144" height="144" rx="17" fill="url(#panel)"/>'
    + '<circle cx="72" cy="75" r="65" fill="url(#glow)"/>'
    + '<rect x="3.5" y="3.5" width="137" height="137" rx="14" fill="none" stroke="' + strokeColor + '" stroke-width="' + (statusName === 'idle' ? 3 : 5) + '"/>'
    + '<path d="M16 14 h38" stroke="' + identity.accent + '" stroke-width="3" stroke-linecap="round" opacity=".8"/>'
    + '<rect x="15" y="17" width="29" height="29" rx="9" fill="' + identity.accent + '"/>'
    + '<text x="29.5" y="38.5" text-anchor="middle" font-family="IBM Plex Sans, Arial, sans-serif" font-size="23" font-weight="700" fill="#06131b">'
    + identity.initial + '</text>'
    + '<circle cx="122" cy="23" r="3" fill="' + identity.accent + '" opacity=".9"/>'
    + '<circle cx="110" cy="23" r="3" fill="' + identity.accent + '" opacity=".35"/>'
    + mark
    + bars
    + '<circle cx="112" cy="112" r="18" fill="#0b101a" opacity=".95"/>'
    + '<circle cx="112" cy="112" r="15" fill="' + status.badge + '"/>'
    + badgeIcon(statusName, status.ink)
    + '</svg>';
}
