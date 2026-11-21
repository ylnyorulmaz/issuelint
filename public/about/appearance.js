/* Shares IssueLint's persisted Light/Dark preference with the SolidJS homepage. */
(function () {
  var KEY = 'issuelint.appearance.v1';
  var theme = 'light';
  try {
    var saved = localStorage.getItem(KEY);
    theme = saved === 'dark' || saved === 'light'
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (_) {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply(next) {
    if (next !== 'light' && next !== 'dark') return;
    document.documentElement.setAttribute('data-theme', next);
    document.querySelectorAll('[data-appearance]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-appearance') === next));
    });
  }
  apply(theme);
  document.addEventListener('DOMContentLoaded', function () {
    apply(theme);
    document.querySelectorAll('[data-appearance]').forEach(function (button) {
      button.addEventListener('click', function () {
        var next = button.getAttribute('data-appearance');
        if (next !== 'light' && next !== 'dark') return;
        theme = next;
        apply(next);
        try { localStorage.setItem(KEY, next); } catch (_) {}
      });
    });
  });
}());
