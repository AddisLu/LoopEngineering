// Set the theme before first paint to avoid a flash of the wrong mode. Loaded synchronously in
// <head> by every page in the shell; the toggle itself lives in shell.js.
(function () {
  try {
    var m = localStorage.getItem('loop_mode');
    if (m !== 'light' && m !== 'dark') {
      m = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-mode', m);
  } catch (e) {
    /* private mode */
  }
})();
