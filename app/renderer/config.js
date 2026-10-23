// Connexion au serveur partagé (Supabase).
// La clé « publishable » est faite pour être dans l'application :
// la sécurité repose sur les comptes et les règles d'accès de la base.
window.CONFIG = {
  SUPABASE_URL: 'https://ufxuxonsnakmiwmnzmuc.supabase.co',
  APP_VERSION: '2.10.0',
  SUPABASE_KEY: 'sb_publishable_ljc0Bj_1eW-MRbN6TrJcag_di7BqSCN',
  // Projet Supabase de l'application de facturation (envoi des clients). Clé publique : la sécurité repose sur le compte de facturation.
  BILLING_URL: 'https://uczoufwtgqnvhqavbngi.supabase.co',
  // Adresse de la version web (tablette, téléphone) : sert aux étiquettes QR imprimées depuis l'application Windows.
  WEB_URL: 'https://daniel151187.github.io/dayan3d-planning-mises-a-jour/',
  BILLING_KEY: 'sb_publishable_09vTX8AkI3BziJ6ImKWDag_FjKdHsI0'
};
