import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const htmlFile = fileURLToPath(new URL('../resources/goals.html', import.meta.url));

export function openGoalsBrowser(url, { spawnProcess = spawn } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Endereço do painel Goals inválido.');
  return new Promise((resolve, reject) => {
    // ShellExecute through the Windows URL handler. Explorer is a file manager
    // and can exit successfully without opening a URL from the Studio runtime.
    const child = spawnProcess('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('O Windows não confirmou a abertura do navegador.')); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Não foi possível iniciar o navegador padrão.')); });
    child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('O Windows recusou a abertura do navegador.')); });
  });
}

export function openGoalsInStudio(api, url) {
  const target = new URL(url);
  // The Ulanzi SDK requires query parameters in param, not in url.
  api.openUrl(target.origin + target.pathname, false, Object.fromEntries(target.searchParams));
}

export async function startGoalsPanel(controller, {
  openBrowser = openGoalsBrowser, fallbackBrowser = null,
  openTimeout = 3000, html = () => fs.readFileSync(htmlFile, 'utf8'),
} = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  let opened = 0;
  const json = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const expectedHost = '127.0.0.1:' + server.address().port;
      if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== 'http://' + expectedHost)) { json(res, 403, { error: 'Origem não permitida.' }); return; }
      if ((req.headers['x-goals-token'] || url.searchParams.get('token')) !== token) { json(res, 401, { error: 'Abra este painel pela tecla ABRIR GOALS.' }); return; }
      if (req.method === 'GET' && url.pathname === '/') {
        const page = html().replaceAll('__GOALS_TOKEN__', JSON.stringify(token));
        opened++;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
        res.end(page); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') { json(res, 200, controller.status()); return; }
      if (req.method === 'GET' && url.pathname === '/api/threads') { json(res, 200, await controller.listThreads()); return; }
      if (req.method === 'GET' && url.pathname === '/api/logs') { json(res, 200, { text: controller.logs() }); return; }
      if (req.method === 'GET' && url.pathname === '/api/execution') { json(res, 200, controller.execution()); return; }
      if (req.method !== 'POST') { json(res, 404, { error: 'Não encontrado.' }); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 131072) { json(res, 413, { error: 'Requisição muito grande.' }); return; } }
      let payload; try { payload = body ? JSON.parse(body) : {}; } catch { json(res, 400, { error: 'Requisição inválida.' }); return; }
      if (url.pathname === '/api/select') { json(res, 200, await controller.selectGoal(payload.id)); return; }
      if (url.pathname === '/api/create') { json(res, 200, await controller.createGoal(payload)); return; }
      if (url.pathname === '/api/confirm') { json(res, 200, await controller.confirmSelection(payload)); return; }
      if (url.pathname === '/api/setup') { json(res, 200, await controller.setupSandbox(payload)); return; }
      if (url.pathname === '/api/accounts/hb/login') { json(res, 200, await controller.connectHB(payload)); return; }
      if (url.pathname === '/api/accounts/hb/cancel') { json(res, 200, await controller.cancelHB()); return; }
      if (url.pathname === '/api/start') {
        if (payload.exclusiveConfirmed !== true) { json(res, 400, { error: 'Confirme que o mesmo Goal não está em execução em outra interface.' }); return; }
        json(res, 200, await controller.start({ confirmed: true })); return;
      }
      if (url.pathname === '/api/stop') { json(res, 200, await controller.stop()); return; }
      if (url.pathname === '/api/automatic') { json(res, 200, await controller.setAutomatic(payload.enabled)); return; }
      if (url.pathname === '/api/decision') { json(res, 200, await controller.decide(payload)); return; }
      json(res, 404, { error: 'Não encontrado.' });
    } catch (error) { json(res, 400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/?token=${token}`;
  const waitForPage = async (previous) => {
    const deadline = Date.now() + openTimeout;
    while (Date.now() < deadline) {
      if (opened > previous) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return opened > previous;
  };
  return {
    url,
    open: async () => {
      const previous = opened;
      try { await openBrowser(url); if (await waitForPage(previous)) return; }
      catch (error) { if (!fallbackBrowser) throw error; }
      if (fallbackBrowser) { await fallbackBrowser(url); if (await waitForPage(previous)) return; }
      throw new Error('O painel está ativo, mas o navegador não abriu. A URL será copiada para você abrir manualmente.');
    },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); }),
  };
}
