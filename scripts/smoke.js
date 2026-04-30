const { spawn } = require('child_process');

const port = process.env.PORT || '3100';
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: port,
  NODE_ENV: 'test',
  ALLOW_REGISTRATION: 'true',
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...options });
  const text = await res.text();
  return { res, text };
}

(async () => {
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const { res } = await request('/healthz');
        if (res.status === 200) break;
      } catch (_) {}
      await wait(250);
      if (i === 39) throw new Error('server did not become healthy');
    }

    const username = `smoke_${Date.now()}`;
    const password = 'SmokeTest123!';
    const register = await request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, confirm_password: password }),
    });
    if (![302, 303].includes(register.res.status)) throw new Error(`register failed: ${register.res.status}`);

    const cookie = register.res.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('login cookie was not set');

    const pages = ['/dashboard', '/vps', '/tasks', '/channels', '/stream-keys', '/media', '/logs', '/settings'];
    for (const page of pages) {
      const { res } = await request(page, { headers: { cookie } });
      if (res.status !== 200) throw new Error(`${page} returned ${res.status}`);
    }

    console.log('OK: smoke test passed');
  } catch (e) {
    console.error(output);
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
