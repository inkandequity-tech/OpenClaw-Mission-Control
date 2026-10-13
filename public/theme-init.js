// Runs before first paint (external file: the CSP forbids inline scripts) so the saved theme never flashes.
(function () {
  var theme = 'noir', mode = 'dark';
  try {
    var p = JSON.parse(localStorage.getItem('mc.prefs') || '{}');
    if (p.theme) theme = p.theme;
    if (p.mode) mode = p.mode;
  } catch (e) { /* storage may be unavailable */ }
  if (mode === 'system') mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  var r = document.documentElement;
  r.setAttribute('data-theme', theme);
  r.setAttribute('data-mode', mode);
})();
