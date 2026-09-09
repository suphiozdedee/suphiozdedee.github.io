(() => {
  // Keep the public site key and one-time nonce out of server/CDN request logs.
  const params = new URLSearchParams(window.location.hash.slice(1));
  const siteKey = String(params.get('sitekey') || '').trim();
  const action = String(params.get('action') || '').trim();
  const nonce = String(params.get('nonce') || '').trim();
  const status = document.getElementById('status');
  const validAction = /^[a-z0-9_-]{1,32}$/.test(action);
  const validNonce = /^[a-f0-9]{32}$/.test(nonce);

  const setStatus = (message) => {
    if (status) status.textContent = message;
  };

  const finish = (token) => {
    const callback = new URL('planicworks-turnstile://success');
    callback.searchParams.set('nonce', nonce);
    callback.searchParams.set('token', token);
    window.location.replace(callback.toString());
  };

  if (!siteKey || siteKey.length > 256 || !validAction || !validNonce) {
    setStatus('Doğrulama isteği geçersiz. Uygulamaya dönüp tekrar deneyin.');
    return;
  }

  window.planicworksTurnstileReady = () => {
    if (!window.turnstile) {
      setStatus('Doğrulama servisi yüklenemedi. Tekrar deneyin.');
      return;
    }

    setStatus('Lütfen güvenlik doğrulamasını tamamlayın.');
    window.turnstile.render('#turnstile-widget', {
      sitekey: siteKey,
      action,
      appearance: 'always',
      execution: 'render',
      language: 'auto',
      retry: 'auto',
      'retry-interval': 4000,
      'refresh-expired': 'auto',
      'refresh-timeout': 'auto',
      size: 'flexible',
      theme: 'dark',
      callback: finish,
      'error-callback': () => {
        setStatus('Doğrulama tamamlanamadı. Otomatik olarak yeniden deneniyor…');
        return true;
      },
      'timeout-callback': () => {
        setStatus('Doğrulama zaman aşımına uğradı. Yeniden deneniyor…');
      },
      'unsupported-callback': () => {
        setStatus('Bu cihazda güvenlik doğrulaması başlatılamadı.');
      },
    });
  };

  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=planicworksTurnstileReady&render=explicit';
  script.async = true;
  script.defer = true;
  script.onerror = () => setStatus('Doğrulama servisine ulaşılamadı. Tekrar deneyin.');
  document.head.appendChild(script);
})();
