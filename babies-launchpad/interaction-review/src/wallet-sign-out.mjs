export async function disconnectAndSignOut(actions, deadlines = {walletMs:3000,sessionMs:6000}) {
  const wallet = (async () => {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(actions.disconnect), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet disconnect timed out")), deadlines.walletMs); })]);
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); actions.forgetWallet(); }
  })();
  const session = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new DOMException("Sign-out timed out", "TimeoutError")), deadlines.sessionMs);
    try { await actions.logout(abort.signal); return true; }
    catch { return false; }
    finally { clearTimeout(timer); }
  })();
  const [walletDisconnected, sessionRevoked] = await Promise.all([wallet, session]);
  return { walletDisconnected, sessionRevoked };
}
