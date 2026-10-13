const f = document.getElementById('f');
const err = document.getElementById('err');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const btn = document.getElementById('go');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ user: document.getElementById('user').value.trim(), password: document.getElementById('pw').value }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ? j.error.message : 'Sign-in failed');
    location.replace('/');
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
    btn.disabled = false;
    document.getElementById('pw').select();
  }
});
