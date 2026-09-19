const SteamUser = require('steam-user');
const client = new SteamUser();

async function checkAccount(username, password) {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { client.logOff(); } catch (e) {}
        resolve({ status: 'timeout' });
      }
    }, 15000);

    client.on('loggedOn', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { client.logOff(); } catch (e) {}
      resolve({ status: 'works' });
    });

    client.on('steamGuard', (domain, callback) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { client.logOff(); } catch (e) {}
      resolve({ status: '2fa' });
    });

    client.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { client.logOff(); } catch (e) {}
      const msg = String(err.message || '');
      if (msg.includes('AlreadyLoggedInElsewhere')) {
        resolve({ status: 'already_logged_in' });
      } else if (msg.includes('RateLimit')) {
        resolve({ status: 'rate_limited' });
      } else {
        resolve({ status: 'invalid', message: msg });
      }
    });

    client.logOn({
      accountName: username,
      password: password,
      logonID: Math.floor(Math.random() * 999999)
    });
  });
}

module.exports = { checkAccount };