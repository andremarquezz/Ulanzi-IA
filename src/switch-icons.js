const COLORS = {
  idle: { bg: '#101a2a', line: '#5b738f', fg: '#f8fafc', accent: '#64748b' },
  active: { bg: '#09221c', line: '#34d399', fg: '#ecfdf5', accent: '#34d399' },
  switching: { bg: '#291e09', line: '#fbbf24', fg: '#fff7db', accent: '#fbbf24' },
  error: { bg: '#2a1118', line: '#fb7185', fg: '#fff1f2', accent: '#fb7185' },
};

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function switchIconSvg(account, state = 'idle', stage = '') {
  const id = account === 'americano' ? 'americano' : 'jey';
  const palette = COLORS[state] || COLORS.idle;
  const title = id === 'americano' ? 'AMERICANO' : 'JEY';
  const center = id === 'americano' ? 'AMER' : 'JEY';
  const label = state === 'active' ? 'ATIVO'
    : state === 'error' ? 'ERRO'
      : state === 'switching' ? (stage || 'TROCANDO')
        : 'SELECIONAR';

  const centerSize = id === 'americano' ? 42 : 54;
  const footerSize = label.length > 9 ? 14 : 17;
  // Labels are included IN the bitmap; Ulanzi's textData is too small on the keys.
  return '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">'
    + '<rect width="144" height="144" rx="15" fill="' + palette.bg + '"/>'
    + '<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="' + palette.line + '" stroke-width="5"/>'
    + '<text x="72" y="24" text-anchor="middle" font-family="IBM Plex Sans" font-size="15" font-weight="700" letter-spacing="1.4" fill="' + palette.accent + '">CODEX</text>'
    + '<text x="72" y="39" text-anchor="middle" font-family="IBM Plex Sans" font-size="12" font-weight="700" fill="#cbd5e1">' + title + '</text>'
    + '<text x="72" y="91" text-anchor="middle" font-family="IBM Plex Sans" font-size="' + centerSize + '" font-weight="700" fill="' + palette.fg + '">' + center + '</text>'
    + '<rect x="13" y="105" width="118" height="27" rx="8" fill="' + palette.line + '" opacity=".20"/>'
    + '<text x="72" y="123" text-anchor="middle" font-family="IBM Plex Sans" font-size="' + footerSize + '" font-weight="700" fill="' + palette.accent + '">' + escapeText(label.toUpperCase()) + '</text>'
    + '</svg>';
}
