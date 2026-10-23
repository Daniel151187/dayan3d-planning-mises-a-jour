// Vérificateur de paquet — lancé automatiquement par la publication GitHub avant toute fabrication.
// Il refuse un paquet dont un fichier est vide, une configuration illisible, un script invalide, une référence manquante
// ou des versions incohérentes (c'est ce qui aurait évité l'écran vide de la version 2.4.1).
// Usage : node tools/verifier.js <dossier du projet> app      (depuis le dossier « app » : node tools/verifier.js . app)
// Contrôle d'un paquet avant livraison : aucun fichier vide, scripts valides, références présentes, configuration lisible.
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const root = process.argv[2]; const mode = process.argv[3] || 'web'; // « web » = contenu de renderer ; « app » = projet complet
let bad = 0; const ok = (c, m) => { console.log((c ? 'OK   ' : 'ÉCHEC ') + m); if (!c) bad++; };
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));
const R = mode === 'app' ? 'renderer/' : '';

// 1) aucun fichier vide
const empties = [];
(function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (fs.statSync(p).size === 0) empties.push(path.relative(root, p)); }); })(root);
ok(empties.length === 0, 'aucun fichier vide' + (empties.length ? ' : ' + empties.join(', ') : ''));

// 2) configuration lisible
const w = {}; try { vm.runInNewContext(read(R + 'config.js'), { window: w }); } catch (e) { /* signalé ci-dessous */ }
ok(w.CONFIG && /^https:\/\/.+\.supabase\.co$/.test(w.CONFIG.SUPABASE_URL) && /^sb_publishable_/.test(w.CONFIG.SUPABASE_KEY) && w.CONFIG.APP_VERSION, 'config.js : adresse Supabase, clé publique et version présentes');

ok(w.CONFIG && /^https:\/\/.+\.supabase\.co$/.test(w.CONFIG.BILLING_URL || '') && /^sb_publishable_/.test(w.CONFIG.BILLING_KEY || ''), 'config.js : projet de la facturation renseigné (envoi des clients)');

ok(w.CONFIG && /^https:\/\/[^ ]+\/$/.test(w.CONFIG.WEB_URL || ''), 'config.js : adresse de la version web renseignée (QR lisibles au téléphone)');

// 3) syntaxe de tous les scripts de l'interface
['app.js', 'boot.js', 'pwa.js', 'sw.js', 'config.js'].forEach((f) => { try { new vm.Script(read(R + f), { filename: f }); ok(true, f + ' : syntaxe valide'); } catch (e) { ok(false, f + ' : ' + e.message); } });

// 4) références de index.html et liste du mode hors ligne
const idx = read(R + 'index.html');
const refs = [...idx.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
const missing = refs.filter((r) => !exists(R + r));
ok(missing.length === 0, 'index.html : toutes les références existent' + (missing.length ? ' (manquent : ' + missing.join(', ') + ')' : ''));
const list = eval(read(R + 'sw.js').match(/const SHELL = (\[[\s\S]*?\]);/)[1]);
const miss2 = list.filter((f) => f !== './' && !exists(R + f));
ok(list.length > 10 && miss2.length === 0, 'sw.js : ' + list.length + ' fichiers listés, tous présents');
try { const m = JSON.parse(read(R + 'manifest.webmanifest')); ok(m.icons.every((i) => exists(R + i.src)), 'manifeste : icônes présentes'); } catch (e) { ok(false, 'manifeste illisible'); }
ok(/<script src="boot\.js">/.test(idx) && idx.indexOf('boot.js') < idx.indexOf('app.js'), 'boot.js chargé avant app.js');

// 5) projet complet : version cohérente, fichiers principaux
if (mode === 'app') {
  const pkg = JSON.parse(read('package.json'));
  const cv = (w.CONFIG || {}).APP_VERSION; ok(pkg.version === cv, 'version cohérente (package.json ' + pkg.version + ' = config.js ' + cv + ')');
  ['main.js', 'preload.js', 'printers.js'].forEach((f) => { try { new vm.Script(read(f), { filename: f }); ok(true, f + ' : syntaxe valide'); } catch (e) { ok(false, f + ' : ' + e.message); } });
  ok(pkg.dependencies && pkg.dependencies.mqtt && pkg.dependencies['electron-updater'], 'dépendances mqtt et electron-updater déclarées');
  ok(pkg.build.files.includes('printers.js') && pkg.build.files.includes('preload.js'), 'package.json : printers.js et preload.js inclus dans l’installateur');
  try { const u = JSON.parse(read('updates.json')); ok(/^https:\/\/github\.com\/Daniel151187\/.+\/releases\/latest\/download\/$/.test(u.url), 'updates.json : adresse des mises à jour correcte'); } catch (e) { ok(false, 'updates.json illisible'); }
  ok(exists('supabase-schema.sql') && fs.statSync(path.join(root, 'supabase-schema.sql')).size > 20000, 'schéma SQL présent');
}
console.log(bad ? '\n' + bad + ' PROBLÈME(S)' : '\nPaquet conforme.');
process.exit(bad ? 1 : 0);
