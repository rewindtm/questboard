'use strict';
// Dati dimostrativi: progetto "Grimthorn Keep". Non contatta Discord e non gira in produzione.
require('dotenv').config({ quiet: true });
const { loadConfig } = require('../src/config');
const { createPool } = require('../src/db/pool');
const { createBus } = require('../src/events');
const { createServices } = require('../src/services');

const DEMO_MEMBERS = [
  ['990000000000000001', 'Marco', 'developer', false],
  ['990000000000000002', 'Giulia', 'developer', false],
  ['990000000000000003', 'Luca', 'tester', true],
];

const TASKS = [
  ['Sistemare il crash al caricamento del livello Cripta', 'critical', 'todo', 'Bug', 'Marco', 'Il gioco si chiude al caricamento della Cripta su alcune GPU.', ['Riprodurre il crash', 'Correggere il caricamento asincrono', 'Verificare su 3 GPU diverse']],
  ['Bilanciare la difficoltà del boss del Bastione', 'high', 'in_progress', 'Gameplay', 'Giulia', 'Il boss è troppo facile in cooperativa a 4 giocatori.', ['Aumentare i punti ferita in base ai giocatori', 'Playtest con 4 giocatori']],
  ['Aggiungere i sottotitoli ai dialoghi', 'medium', 'review', 'UI', 'Marco', 'Sottotitoli per tutti i dialoghi con dimensione regolabile.', ['Sottotitoli base', 'Opzione dimensione testo']],
  ['Ottimizzare le luci dinamiche del salone', 'medium', 'done', 'Grafica', 'Giulia', 'Ridurre il costo delle luci in tempo reale.', ['Profilare la scena', 'Ridurre le luci attive']],
  ['Nuovo tutorial per la torcia', 'low', 'todo', 'Design', null, 'Spiegare la meccanica della torcia al primo avvio.', []],
  ['Audio dei passi sulle superfici di pietra', 'low', 'in_progress', 'Audio', 'Marco', '', ['Registrare i campioni', 'Integrare nel sistema di superfici']],
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Il seed demo non può essere eseguito in produzione.');
    process.exit(1);
  }
  const { config } = loadConfig(process.env);
  if (config.isProd) {
    console.error('Il seed demo non può essere eseguito in produzione.');
    process.exit(1);
  }
  const pool = createPool(config.databaseUrl);
  try {
    const admin = (await pool.query('SELECT * FROM users WHERE is_superadmin ORDER BY id LIMIT 1')).rows[0];
    if (!admin) {
      console.error('Nessun amministratore di bootstrap: imposta BOOTSTRAP_ADMIN_DISCORD_ID (o il login locale) e avvia una volta l\'app.');
      process.exit(1);
    }
    const stubGateway = { isConfigured: () => false }; // mai Discord
    const services = createServices({ pool, bus: createBus(), config, gateway: stubGateway });

    const existing = (await pool.query(`SELECT id FROM projects WHERE slug = 'grimthorn-keep'`)).rows[0];
    if (existing) { console.log('Il progetto demo esiste già: nulla da fare.'); return; }

    const project = await services.projects.create(admin, {
      name: 'Grimthorn Keep', slug: 'grimthorn-keep', code_prefix: 'GRIM',
      description: 'Horror cooperativo in un castello infestato.',
    });
    await pool.query(`UPDATE projects SET categories = $2 WHERE id = $1`, [project.id, ['Bug', 'Gameplay', 'UI', 'Grafica', 'Audio', 'Design']]);

    const users = {};
    for (const [discordId, name, role, canApprove] of DEMO_MEMBERS) {
      const u = (await pool.query(
        `INSERT INTO users (discord_id, display_name) VALUES ($1,$2) RETURNING id`, [discordId, name])).rows[0];
      await pool.query('INSERT INTO project_members(project_id,user_id,role,can_approve) VALUES ($1,$2,$3,$4)', [project.id, u.id, role, canApprove]);
      users[name] = u.id;
    }
    const due = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
    const build = await services.projects.saveBuild(admin, project.id, null, { name: 'Build 36', kind: 'build', due_date: due, released: false });

    for (const [title, priority, status, category, who, description, checklist] of TASKS) {
      const task = await services.tasks.create({ actor: admin, source: 'web' }, project.id, {
        title, priority, category, description, checklist: checklist.map((text) => ({ text, done: false })),
        assignee_id: who ? users[who] : null, build_id: build.id,
      });
      if (status !== 'todo') {
        // porta il task nello stato voluto passando per transizioni valide
        const path = { in_progress: ['in_progress'], review: ['in_progress', 'review'], done: ['in_progress', 'review', 'done'] }[status];
        let cur = task;
        for (const s of path) cur = (await services.tasks.changeStatus({ actor: admin, source: 'web' }, cur.id, s, { expectedVersion: cur.version })).task;
      }
    }
    console.log(`Progetto demo creato: /p/grimthorn-keep (${TASKS.length} task). Nulla è stato inviato a Discord.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
