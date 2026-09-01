import { test } from 'node:test';
import assert from 'node:assert';
import { AccountManager } from '../src/account-manager.js';

function manager(refreshFn) {
  return new AccountManager([{
    name: 'a',
    type: 'oauth',
    accessToken: 'at-old',
    refreshToken: 'rt-dead',
    expiresAt: Date.now() - 1000,
  }], 0.98, { refreshFn });
}

function authError(status = 400) {
  const error = new Error(`Token refresh failed (${status}): {"error":"invalid_grant"}`);
  error.status = status;
  return error;
}

test('a rejected refresh token is sent only once while it stays unchanged', async () => {
  let calls = 0;
  const accountManager = manager(async () => {
    calls += 1;
    throw authError();
  });

  await accountManager.ensureTokenFresh(0);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await accountManager.ensureTokenFresh(0);
  }

  assert.equal(calls, 1);
  assert.equal(accountManager.accounts[0].status, 'error');
});

test('a late rejection for an old refresh token does not poison replacement credentials', async () => {
  let rejectRefresh;
  let attemptedToken;
  const accountManager = manager(token => {
    attemptedToken = token;
    return new Promise((_resolve, reject) => { rejectRefresh = reject; });
  });

  const refresh = accountManager.ensureTokenFresh(0);
  assert.equal(attemptedToken, 'rt-dead');
  accountManager.updateAccountTokens(0, {
    accessToken: 'at-replacement',
    refreshToken: 'rt-replacement',
    expiresAt: Date.now() + 3600_000,
  });
  rejectRefresh(authError());
  await refresh;

  const account = accountManager.accounts[0];
  assert.equal(account.credential, 'at-replacement');
  assert.equal(account.refreshToken, 'rt-replacement');
  assert.equal(account.status, 'active');
  assert.equal(account._deadRefreshToken, null);
});

test('a forced refresh does not resend a known rejected token', async () => {
  let calls = 0;
  const accountManager = manager(async () => {
    calls += 1;
    throw authError(401);
  });

  await accountManager.ensureTokenFresh(0);
  await accountManager.ensureTokenFresh(0, true);

  assert.equal(calls, 1);
});

test('a transient refresh failure retries the unchanged token', async () => {
  let calls = 0;
  const accountManager = manager(async () => {
    calls += 1;
    const error = new Error('socket hang up');
    error.status = 503;
    throw error;
  });

  await accountManager.ensureTokenFresh(0);
  await accountManager.ensureTokenFresh(0);

  assert.equal(calls, 2);
  assert.notEqual(accountManager.accounts[0].status, 'error');
});

test('a replacement refresh token lifts the rejected-token guard', async () => {
  let calls = 0;
  const accountManager = manager(async refreshToken => {
    calls += 1;
    if (refreshToken === 'rt-dead') throw authError();
    return {
      accessToken: 'at-new',
      refreshToken: 'rt-newer',
      expiresAt: Date.now() + 3600_000,
    };
  });

  await accountManager.ensureTokenFresh(0);
  accountManager.updateAccountTokens(0, {
    accessToken: 'at-relogin',
    refreshToken: 'rt-new',
    expiresAt: Date.now() - 1000,
  });
  await accountManager.ensureTokenFresh(0);

  assert.equal(calls, 2);
  assert.equal(accountManager.accounts[0].status, 'active');
});

test('re-enabling an errored account permits one explicit refresh retry', async () => {
  let calls = 0;
  const accountManager = manager(async () => {
    calls += 1;
    throw authError(403);
  });

  await accountManager.ensureTokenFresh(0);
  accountManager.setDisabled(0, true);
  accountManager.setDisabled(0, false);
  await accountManager.ensureTokenFresh(0);

  assert.equal(calls, 2);
});

test('a successful refresh clears an earlier rejected-token guard', async () => {
  let shouldFail = true;
  let calls = 0;
  const accountManager = manager(async () => {
    calls += 1;
    if (shouldFail) throw authError();
    return {
      accessToken: 'at-new',
      refreshToken: 'rt-next',
      expiresAt: Date.now() - 1000,
    };
  });

  await accountManager.ensureTokenFresh(0);
  accountManager.accounts[0].refreshToken = 'rt-replacement';
  shouldFail = false;
  await accountManager.ensureTokenFresh(0);
  const callsAfterSuccess = calls;
  await accountManager.ensureTokenFresh(0);

  assert.equal(accountManager.accounts[0]._deadRefreshToken, null);
  assert.equal(calls, callsAfterSuccess + 1);
});
