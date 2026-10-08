const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = '1553849458113126491';
const LOG_CHANNEL = '1555717095235391599';
const ALLOWED_USERS = ['1238992343219310643', '377102187408392193'];

const commands = [
  new SlashCommandBuilder().setName('status').setDescription('Voir le statut de tous les services'),
  new SlashCommandBuilder().setName('stats').setDescription('Stats CPU/RAM du VPS'),
  new SlashCommandBuilder()
    .setName('start').setDescription('Demarrer un service')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('stop').setDescription('Arreter un service')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart').setDescription('Redemarrer un service')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('logs').setDescription('Voir les derniers logs d\'un service MC')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('players').setDescription('Voir les joueurs connectes sur un serveur MC')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('ram').setDescription('RAM utilisee par un serveur MC')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('uptime').setDescription('Temps de fonctionnement serveur MC')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('backup').setDescription('Sauvegarder le monde serveur MC')
    .addIntegerOption(o => o.setName('tenant').setDescription('ID du tenant').setRequired(true)),
  new SlashCommandBuilder()
    .setName('alert').setDescription('Envoyer une alerte a tous les clients')
    .addStringOption(o => o.setName('message').setDescription('Message a envoyer').setRequired(true)),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('[ADMINBOT] Commandes slash enregistrees.');
}

function isAllowed(userId) {
  return ALLOWED_USERS.includes(userId);
}

let _minecraftManager = null;
let _tenantManager = null;
let _db = null;

function init(minecraftManager, tenantManager, db) {
  _minecraftManager = minecraftManager;
  _tenantManager = tenantManager;
  _db = db;

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    console.log('[ADMINBOT] Bot admin pret:', client.user.tag);
    await registerCommands();
    // Log de demarrage
    const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
    if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(0x10b981).setTitle('[SUCCESS] Bot Admin VHOST demarre').setTimestamp()] });
  });

  client.on('interactionCreate', async (interaction) => {
    // Gestion boutons recrutement
    if (interaction.isButton()) {
      console.log('[AdminBot] Bouton recu:', interaction.customId);
      const ALLOWED = ['1238992343219310643', '377102187408392193'];
      if (!ALLOWED.includes(interaction.user.id)) {
        return interaction.reply({ content: 'Acces refuse.', ephemeral: true });
      }
      // Repondre immediatement pour eviter timeout
      await interaction.reply({ content: 'Traitement en cours...', ephemeral: true });

      const parts = interaction.customId.split('_');
      // recru_entretien_DISCORDID_POSTE ou recru_refus_DISCORDID_POSTE
      if (parts[0] === 'recru' && (parts[1] === 'entretien' || parts[1] === 'refus')) {
        const action = parts[1];
        const discordId = parts[2];
        const poste = parts.slice(3).join(' ').replace(/_/g,' ');

        // Deplacer vers le bon salon
        const targetChannel = action === 'entretien' ? '1556625140941459537' : '1556625063862734870';
        const valideChannel = '1556625091260063785';

        // Copier l embed original
        const originalEmbed = interaction.message.embeds[0];
        const newColor = action === 'entretien' ? 0xf59e0b : 0xf43f5e;
        const statusLabel = action === 'entretien' ? 'En attente entretien' : 'Refuse';

        const newEmbed = {
          ...originalEmbed.data,
          color: newColor,
          footer: { text: statusLabel+' par '+interaction.user.username+' • '+new Date().toLocaleDateString('fr-FR') }
        };

        // Bouton valider entretien si en attente entretien
        const components = action === 'entretien' ? [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Valider entretien', custom_id: 'recru_valide_'+discordId+'_'+poste.replace(/ /g,'_') }
          ]
        }] : [];

        await fetch('https://discord.com/api/v10/channels/'+targetChannel+'/messages', {
          method: 'POST',
          headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [newEmbed], components })
        });

        // Supprimer le message original
        await interaction.message.delete().catch(() => {});

        // Prevenir le candidat par MP
        try {
          const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: discordId })
          });
          if (dmRes.ok) {
            const dm = await dmRes.json();
            const msg = action === 'entretien'
              ? '📋 **Candidature VHOST — Mise à jour**\n\nBonne nouvelle ! Ta candidature pour le poste de **'+poste+'** a été retenue.\n\nTu vas être contacté(e) prochainement pour un **entretien**. Reste disponible sur Discord !'
              : '[ERROR] **Candidature VHOST — Mise à jour**\n\nNous avons étudié ta candidature pour le poste de **'+poste+'** et nous ne donnons malheureusement pas suite.\n\nMerci de ton intérêt pour VHOST. Tu pourras recandidater dans 30 jours.';
            await fetch('https://discord.com/api/v10/channels/'+dm.id+'/messages', {
              method: 'POST',
              headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: msg })
            });
          }
        } catch {}

        await interaction.followUp({ content: action === 'entretien' ? 'Candidature mise en attente entretien.' : 'Candidature refusee.', ephemeral: true });
        return;
      }

      // Bouton valider entretien
      if (parts[0] === 'recru' && parts[1] === 'valide') {
        const discordId = parts[2];
        const poste = parts.slice(3).join(' ').replace(/_/g,' ');
        const originalEmbed = interaction.message.embeds[0];
        const newEmbed = {
          ...originalEmbed.data,
          color: 0x10b981,
          footer: { text: 'Entretien valide par '+interaction.user.username+' • '+new Date().toLocaleDateString('fr-FR') }
        };

        await fetch('https://discord.com/api/v10/channels/1556625091260063785/messages', {
          method: 'POST',
          headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [newEmbed] })
        });

        await interaction.message.delete().catch(() => {});

        // MP candidat
        try {
          const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
            method: 'POST',
            headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient_id: discordId })
          });
          if (dmRes.ok) {
            const dm = await dmRes.json();
            await fetch('https://discord.com/api/v10/channels/'+dm.id+'/messages', {
              method: 'POST',
              headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: 'Bienvenue dans l equipe VHOST ! Ton entretien pour le poste de '+poste+' a ete valide ! Tu vas recevoir ton role staff prochainement.' })
            });
          }
        } catch {}

        await interaction.followUp({ content: 'Entretien valide ! Candidat accepte.', ephemeral: true });
        return;
      }
    }
    if (!interaction.isChatInputCommand()) return;
    if (!isAllowed(interaction.user.id)) {
      return interaction.reply({ content: '[ERROR] Acces refuse.', ephemeral: true });
    }

    const { commandName } = interaction;
    await interaction.deferReply({ ephemeral: commandName !== 'status' && commandName !== 'stats' });

    try {
      if (commandName === 'status') {
        const [rows] = await _db.query('SELECT t.id, t.name, t.service FROM tenants t ORDER BY t.id');
        if (!rows.length) return interaction.editReply('Aucun tenant.');
        const embed = new EmbedBuilder().setTitle('📊 Statut des services VHOST').setColor(0x4f78ff).setTimestamp();
        for (const t of rows) {
          if (t.service === 'minecraft') {
            const store = await _tenantManager.getStore(t.id);
            const ctrl = _minecraftManager.get(t.id, store);
            const status = ctrl.status || 'unknown';
            const emoji = status === 'running' ? '🟢' : status === 'crashed' ? '🔴' : '⚫';
            embed.addFields({ name: emoji + ' #'+t.id+' '+t.name, value: 'Minecraft — '+status, inline: true });
          } else {
            embed.addFields({ name: '🤖 #'+t.id+' '+t.name, value: 'Discord bot', inline: true });
          }
        }
        return interaction.editReply({ embeds: [embed] });
      }

      if (commandName === 'stats') {
        const os = require('os');
        const cpus = os.cpus();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const embed = new EmbedBuilder()
          .setTitle('🖥️ Stats VPS VHOST')
          .setColor(0x6366f1)
          .addFields(
            { name: 'CPU', value: cpus[0].model.trim(), inline: false },
            { name: 'Coeurs', value: cpus.length + ' vCPU', inline: true },
            { name: 'RAM utilisee', value: Math.round(usedMem/1024/1024)+' Mo / '+Math.round(totalMem/1024/1024)+' Mo', inline: true },
            { name: 'Uptime', value: Math.round(os.uptime()/3600)+'h', inline: true },
          ).setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      const tenantId = interaction.options.getInteger('tenant');
      const store = await _tenantManager.getStore(tenantId);
      if (!store) return interaction.editReply('[ERROR] Tenant #'+tenantId+' introuvable.');

      if (commandName === 'start') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const mc = store.getMinecraft();
        await ctrl.start({ memoryMb: mc?.memoryMb || 1024 });
        const embed = new EmbedBuilder().setColor(0x10b981).setTitle('[SUCCESS] Service #'+tenantId+' demarre').setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (ch) ch.send({ embeds: [embed.setDescription('Par '+interaction.user.tag)] });
      }

      else if (commandName === 'stop') {
        const ctrl = _minecraftManager.get(tenantId, store);
        await ctrl.stop();
        const embed = new EmbedBuilder().setColor(0xf43f5e).setTitle('⏹️ Service #'+tenantId+' arrete').setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (ch) ch.send({ embeds: [embed.setDescription('Par '+interaction.user.tag)] });
      }

      else if (commandName === 'restart') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const mc = store.getMinecraft();
        await ctrl.stop();
        setTimeout(async () => {
          try { await ctrl.start({ memoryMb: mc?.memoryMb || 1024 }); } catch {}
        }, 3000);
        const embed = new EmbedBuilder().setColor(0xf59e0b).setTitle('[RELOAD] Service #'+tenantId+' redemarre').setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (ch) ch.send({ embeds: [embed.setDescription('Par '+interaction.user.tag)] });
      }

      else if (commandName === 'logs') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const logs = ctrl.getLogs ? ctrl.getLogs().slice(-20) : [];
        if (!logs.length) return interaction.editReply('Aucun log disponible.');
        const text = logs.map(l => l.msg || l).join('\n').slice(0, 1900);
        await interaction.editReply('```\n'+text+'\n```');
      }

      else if (commandName === 'ram') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const pid = ctrl.process?.pid;
        let ramInfo = 'Serveur arrete.';
        if (pid) {
          try {
            const fs = require('fs');
            const status = fs.readFileSync('/proc/'+pid+'/status', 'utf8');
            const match = status.match(/VmRSS:\s+(\d+)/);
            if (match) ramInfo = Math.round(parseInt(match[1])/1024)+' Mo utilises';
          } catch { ramInfo = 'Impossible de lire la RAM.'; }
        }
        const mc = store.getMinecraft();
        const embed = new EmbedBuilder()
          .setTitle('💾 RAM — Tenant #'+tenantId)
          .setColor(0x6366f1)
          .addFields(
            { name: 'Allouee', value: (mc?.memoryMb||'?')+' Mo', inline: true },
            { name: 'Utilisee', value: ramInfo, inline: true },
          ).setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      else if (commandName === 'uptime') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const startedAt = ctrl.startedAt || null;
        let uptimeStr = 'Serveur arrete.';
        if (startedAt) {
          const diff = Math.floor((Date.now() - startedAt) / 1000);
          const h = Math.floor(diff/3600);
          const m = Math.floor((diff%3600)/60);
          const s2 = diff%60;
          uptimeStr = h+'h '+m+'m '+s2+'s';
        }
        const embed = new EmbedBuilder()
          .setTitle('⏱️ Uptime — Tenant #'+tenantId)
          .setColor(0x22d3ee)
          .setDescription(uptimeStr)
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      else if (commandName === 'backup') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const dir = ctrl.dir;
        if (!dir) return interaction.editReply('[ERROR] Dossier introuvable.');
        const { execSync } = require('child_process');
        const backupName = 'backup-'+tenantId+'-'+Date.now()+'.tar.gz';
        const backupPath = '/opt/mc-agent/backups/'+backupName;
        require('fs').mkdirSync('/opt/mc-agent/backups', { recursive: true });
        // Envoyer save-all avant backup si serveur tourne
        if (ctrl.status === 'running') ctrl.sendCommand('save-all');
        await new Promise(r => setTimeout(r, 2000));
        execSync('tar -czf '+backupPath+' -C '+dir+' world', { timeout: 60000 });
        const size = require('fs').statSync(backupPath).size;
        const embed = new EmbedBuilder()
          .setTitle('💾 Backup cree — Tenant #'+tenantId)
          .setColor(0x10b981)
          .addFields(
            { name: 'Fichier', value: backupName, inline: false },
            { name: 'Taille', value: Math.round(size/1024/1024*10)/10+' Mo', inline: true },
          ).setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (ch) ch.send({ embeds: [embed] });
        return;
      }

      else if (commandName === 'alert') {
        const message = interaction.options.getString('message');
        const [tenants] = await _db.query('SELECT discord_id FROM users WHERE discord_id IS NOT NULL AND discord_id NOT LIKE "local:%"');
        let sent = 0;
        for (const u of tenants) {
          try {
            const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
              method: 'POST',
              headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ recipient_id: u.discord_id })
            });
            const dm = await dmRes.json();
            await fetch('https://discord.com/api/v10/channels/'+dm.id+'/messages', {
              method: 'POST',
              headers: { 'Authorization': 'Bot '+TOKEN, 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: '📢 **Alerte VHOST :** '+message })
            });
            sent++;
          } catch {}
        }
        const embed = new EmbedBuilder()
          .setTitle('📢 Alerte envoyee')
          .setColor(0xf59e0b)
          .setDescription(message)
          .addFields({ name: 'Destinataires', value: sent+' clients', inline: true })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        const ch = await client.channels.fetch(LOG_CHANNEL).catch(() => null);
        if (ch) ch.send({ embeds: [embed] });
        return;
      }

      else if (commandName === 'players') {
        const ctrl = _minecraftManager.get(tenantId, store);
        const players = ctrl.getPlayers ? ctrl.getPlayers() : (ctrl.players || []);
        if (!players.length) return interaction.editReply('Aucun joueur connecte.');
        const embed = new EmbedBuilder()
          .setTitle('👥 Joueurs sur #'+tenantId)
          .setColor(0x22d3ee)
          .setDescription(players.map(p => '• '+(typeof p === 'string' ? p : p.name)).join('\n'))
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
      }

    } catch(e) {
      console.error('[AdminBot] Erreur:', e.message);
      interaction.editReply('[ERROR] Erreur : '+e.message).catch(() => {});
    }
  });

  client.login(TOKEN);
  return client;
}

module.exports = { init };
