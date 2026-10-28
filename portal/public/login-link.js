'use strict';
(() => {
  let token = location.hash.slice(1);
  history.replaceState(null, '', '/login-link');
  const button = document.querySelector('#continue-login');
  const status = document.querySelector('#link-status');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    button.disabled = true;
    status.textContent = 'Open the full private sign-in link you received.';
    return;
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Signing you in…';
    try {
      const response = await fetch('/portal/login-link', {method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token})});
      if (!response.ok) throw new Error('This link has expired, has already been used, or is no longer valid. Ask for a new link or sign in with Google.');
      token = '';
      location.replace('/');
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
})();
