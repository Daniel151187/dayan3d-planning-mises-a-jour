// Enregistre le mode hors ligne seulement sur la version web (pas dans l'application Windows).
(function () {
  if (!/^https?:$/.test(location.protocol) || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* sans conséquence */ });
  });
})();
