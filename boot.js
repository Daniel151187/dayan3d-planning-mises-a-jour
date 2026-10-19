// Premier script chargé : si l'application plante au démarrage, on affiche la cause au lieu d'un écran blanc.
(function () {
  function show(msg) {
    var box = document.getElementById('fatal');
    if (!box) {
      box = document.createElement('div');
      box.id = 'fatal';
      box.setAttribute('role', 'alert');
      box.innerHTML = '<div class="fatal-card"><h1>Dayan 3D Planning n’a pas pu démarrer</h1>' +
        '<p>Un fichier de l’application est manquant ou abîmé. Tes données ne sont pas touchées : elles sont dans Supabase.</p>' +
        '<p><b>Que faire :</b> installe la dernière version de l’application (ou ré-ouvre-la une fois connecté à internet : elle se met à jour toute seule).</p>' +
        '<pre id="fatal-msg"></pre><button type="button" id="fatal-copy">Copier le message</button></div>';
      document.body.appendChild(box);
      document.getElementById('fatal-copy').addEventListener('click', function () {
        var t = document.getElementById('fatal-msg').textContent;
        try { navigator.clipboard.writeText(t); } catch (e) { /* ignoré */ }
      });
    }
    document.getElementById('fatal-msg').textContent = msg;
  }
  window.__fatal = show;
  function started() {
    var l = document.getElementById('login');
    var a = document.getElementById('app');
    return (l && !l.classList.contains('hidden')) || (a && !a.classList.contains('hidden'));
  }
  window.addEventListener('error', function (e) {
    // une erreur avant l'affichage de l'écran de connexion = l'appli ne démarrera pas
    setTimeout(function () { if (!started()) show((e.message || 'Erreur') + (e.filename ? '\n' + e.filename.split('/').pop() + ':' + e.lineno : '')); }, 400);
  });
  window.addEventListener('unhandledrejection', function (e) {
    setTimeout(function () { if (!started()) show(String(e.reason && e.reason.message ? e.reason.message : e.reason)); }, 400);
  });
})();
