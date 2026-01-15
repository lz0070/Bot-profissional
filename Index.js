/**
 * BAKAIO APOSTA - bot.js (final)
 * - Painel 100% no Discord (comando /announce) — apenas administradores do servidor podem usar
 * - Publica anúncio em canais selecionados com botões; quando 2 membros clicam "Entrar na aposta" no mesmo anúncio:
 *   -> o bot cria um canal privado (checkout) visível somente para os 2 apostadores + autor (admin)
 * - Checkout: admin propõe valor (modal), apostadores confirmam (botão), admin marca pago, admin resolve
 * - Persistência: SQLite (bakaio_matches.sqlite) com logs
 *
 * Requisitos:
 * - Node >= 18
 * - Preencha .env com DISCORD_TOKEN e CLIENT_ID
 * - npm install
 * - node bot.js
 */

require('dotenv').config();
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  InteractionType
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || undefined;

if (!TOKEN || !CLIENT_ID) {
  console.error('Defina DISCORD_TOKEN e CLIENT_ID no .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// --- DB ---
const dbPath = path.resolve(process.cwd(), 'bakaio_matches.sqlite');
const db = new Database(dbPath);

// matches: announcement records
db.prepare(`
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  mode TEXT,
  suggested_value TEXT,
  image_url TEXT,
  button_label TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  message_ids TEXT,         -- JSON array (one per channel)
  channel_ids TEXT,         -- JSON array
  checkout_channel_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);`).run();

// participants: who entered which match
db.prepare(`
CREATE TABLE IF NOT EXISTS participants (
  match_id TEXT,
  user_id TEXT,
  confirmed INTEGER DEFAULT 0,
  PRIMARY KEY (match_id, user_id)
);`).run();

// logs for auditing
db.prepare(`
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT,
  action TEXT,
  actor_id TEXT,
  details TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);`).run();

function logAction(matchId, action, actorId = null, details = '') {
  db.prepare('INSERT INTO logs (match_id, action, actor_id, details) VALUES (?, ?, ?, ?)').run(matchId, action, actorId, details);
}

// --- UTIL: embed & components ---
function buildAnnouncementEmbed(matchRecord, players = []) {
  // matchRecord fields: id, mode, suggested_value, image_url, button_label, author_id
  const embed = new EmbedBuilder()
    .setColor(0x1F2937) // dark-gray
    .setTitle(`🎯 BAKAIO APOSTA — ${matchRecord.mode || 'Partida'}`)
    .setDescription(matchRecord.suggested_value ? `💸 Valor sugerido: R$ ${matchRecord.suggested_value}` : '💬 Valor: A negociar com admin')
    .addFields(
      { name: '⚡ Jogadores', value: players.length ? players.join('\n') : 'Nenhum jogador na fila', inline: false },
      { name: '📌 ID', value: matchRecord.id, inline: true }
    )
    .setFooter({ text: `Autor: <@${matchRecord.author_id}>` })
    .setTimestamp();
  if (matchRecord.image_url) embed.setThumbnail(matchRecord.image_url);
  return embed;
}
function buildAnnouncementComponents(matchId, buttonLabel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`match:${matchId}:join`).setLabel('✅ Entrar na aposta').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`match:${matchId}:full`).setLabel(buttonLabel || 'Full').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`match:${matchId}:leave`).setLabel('❌ Sair da fila').setStyle(ButtonStyle.Danger)
  );
  return [row];
}
function buildCheckoutComponents(matchId) {
  // single row with up to 5 buttons: propose, confirm, markpaid, resolveA, resolveB
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`match:${matchId}:propose`).setLabel('📝 Propor valor (autor)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`match:${matchId}:confirm`).setLabel('✅ Confirmo que enviei PIX').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`match:${matchId}:markpaid`).setLabel('💳 Autor: Marcar pago').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`match:${matchId}:resolveA`).setLabel('🏆 Resolver: A venceu').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`match:${matchId}:resolveB`).setLabel('🏆 Resolver: B venceu').setStyle(ButtonStyle.Secondary)
  );
  return [row];
}

// --- DB helper functions ---
function createMatchRecord(match) {
  db.prepare('INSERT INTO matches (id, guild_id, author_id, mode, suggested_value, image_url, button_label, channel_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    match.id, match.guildId, match.authorId, match.mode, match.suggestedValue, match.imageUrl, match.buttonLabel, JSON.stringify(match.channelIds || [])
  );
  logAction(match.id, 'create_match', match.authorId, `channels=${(match.channelIds||[]).join(',')}`);
}
function updateMatch(matchId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  values.push(matchId);
  db.prepare(`UPDATE matches SET ${sets} WHERE id = ?`).run(...values);
}
function getMatch(matchId) {
  return db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
}
function addParticipantRecord(matchId, userId) {
  db.prepare('INSERT OR IGNORE INTO participants (match_id, user_id, confirmed) VALUES (?, ?, 0)').run(matchId, userId);
  logAction(matchId, 'participant_added', userId);
}
function removeParticipantRecord(matchId, userId) {
  db.prepare('DELETE FROM participants WHERE match_id = ? AND user_id = ?').run(matchId, userId);
  logAction(matchId, 'participant_removed', userId);
}
function listParticipants(matchId) {
  return db.prepare('SELECT user_id, confirmed FROM participants WHERE match_id = ?').all(matchId);
}
function countParticipants(matchId) {
  const r = db.prepare('SELECT COUNT(*) as c FROM participants WHERE match_id = ?').get(matchId);
  return r ? r.c : 0;
}
function setParticipantConfirmed(matchId, userId) {
  db.prepare('UPDATE participants SET confirmed = 1 WHERE match_id = ? AND user_id = ?').run(matchId, userId);
  logAction(matchId, 'participant_confirmed', userId);
}

// Transactional join: insert participant and return count after insert (atomic)
const joinTransaction = db.transaction((matchId, userId) => {
  // ensure match exists and open
  const match = db.prepare('SELECT status FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Match not found');
  if (match.status !== 'open') throw new Error('Match not open for join');
  // check if already participant
  const existing = db.prepare('SELECT user_id FROM participants WHERE match_id = ? AND user_id = ?').get(matchId, userId);
  if (existing) return { already: true, count: db.prepare('SELECT COUNT(*) as c FROM participants WHERE match_id = ?').get(matchId).c };
  // check count
  const c = db.prepare('SELECT COUNT(*) as c FROM participants WHERE match_id = ?').get(matchId).c;
  if (c >= 2) throw new Error('Esta aposta já possui 2 apostadores');
  db.prepare('INSERT INTO participants (match_id, user_id, confirmed) VALUES (?, ?, 0)').run(matchId, userId);
  const newCount = db.prepare('SELECT COUNT(*) as c FROM participants WHERE match_id = ?').get(matchId).c;
  return { already: false, count: newCount };
});

// --- Slash commands registration ---
const commands = [
  new SlashCommandBuilder().setName('announce').setDescription('Abrir painel para publicar anúncio (Administradores)').toJSON(),
  new SlashCommandBuilder().setName('bakaio-logs').setDescription('Mostrar logs simples (admin only)').toJSON()
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Comandos registrados no GUILD_ID (teste).');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Comandos globais registrados (pode levar até 1h).');
    }
  } catch (err) {
    console.error('Erro registrando comandos', err);
  }
}

// --- Interaction handling ---
client.on('interactionCreate', async (interaction) => {
  try {
    // Chat commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      if (cmd === 'announce') {
        // must be server admin
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: 'Use este comando em um servidor (guild).', ephemeral: true });
        const member = await guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: 'Apenas administradores do servidor podem usar este painel.', ephemeral: true });
        }

        // gather text channels (up to 25)
        await guild.channels.fetch();
        const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
        const options = [];
        for (const [id, ch] of textChannels) {
          if (options.length >= 25) break;
          options.push({ label: `#${ch.name}`, value: ch.id, description: ch.topic ? ch.topic.substring(0, 75) : undefined });
        }
        if (options.length === 0) {
          return interaction.reply({ content: 'Nenhum canal de texto encontrado ou sem acesso.', ephemeral: true });
        }

        const channelSelect = new StringSelectMenuBuilder()
          .setCustomId('announce:select_channels')
          .setPlaceholder('Selecione canais para publicar (máx 25)')
          .setMinValues(1)
          .setMaxValues(Math.min(25, options.length))
          .addOptions(options);

        const rowChannels = new ActionRowBuilder().addComponents(channelSelect);
        const rowButtons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('announce:open_modal').setLabel('📝 Abrir formulário').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('announce:preview').setLabel('🔍 Pré-visualizar').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('announce:publish').setLabel('📣 Publicar').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('announce:cancel').setLabel('✖ Cancelar').setStyle(ButtonStyle.Danger)
        );

        // temp config for this user
        tempConfigs.set(interaction.user.id, {
          guildId: guild.id,
          channelIds: [],
          mode: '2v2 MOBILE',
          suggestedValue: '',
          imageUrl: '',
          buttonLabel: 'Full ump e xm8'
        });

        await interaction.reply({ content: 'Painel aberto — selecione canais e clique em "Abrir formulário".', components: [rowChannels, rowButtons], ephemeral: true });
        return;
      }

      if (cmd === 'bakaio-logs') {
        // only server admin allowed
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: 'Use em servidor.', ephemeral: true });
        const member = await guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Somente administradores do servidor.', ephemeral: true });
        const rows = db.prepare('SELECT * FROM logs ORDER BY created_at DESC LIMIT 50').all();
        if (!rows.length) return interaction.reply({ content: 'Sem logs recentes.', ephemeral: true });
        const text = rows.map(r => `${new Date(r.created_at*1000).toLocaleString()} • ${r.match_id||'-'} • ${r.action} • ${r.actor_id||'-'} • ${r.details||''}`).join('\n');
        return interaction.reply({ content: `Últimos logs:\n${text.substring(0, 1900)}`, ephemeral: true });
      }
    }

    // select menu handling
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'announce:select_channels') {
        const sel = interaction.values; // array of channel ids
        const cfg = tempConfigs.get(interaction.user.id);
        if (!cfg) return interaction.reply({ content: 'Sessão expirada. Reabra /announce.', ephemeral: true });
        cfg.channelIds = sel;
        tempConfigs.set(interaction.user.id, cfg);
        return interaction.update({ content: `Canais selecionados: ${sel.map(id => `<#${id}>`).join(', ')}`, components: interaction.message.components, ephemeral: true });
      }
    }

    // button handling
    if (interaction.isButton()) {
      const custom = interaction.customId;

      // panel buttons
      if (custom === 'announce:open_modal') {
        const cfg = tempConfigs.get(interaction.user.id);
        if (!cfg) return interaction.reply({ content: 'Sessão expirada. Reabra /announce.', ephemeral: true });
        // only server admins allowed
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Apenas administradores do servidor.', ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`announce:modal:${interaction.user.id}`).setTitle('Configurar anúncio');
        const modeInput = new TextInputBuilder().setCustomId('modeInput').setLabel('Modo (ex: 2v2 MOBILE)').setStyle(TextInputStyle.Short).setRequired(true).setValue(cfg.mode);
        const valueInput = new TextInputBuilder().setCustomId('valueInput').setLabel('Valor (opcional)').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.suggestedValue || '');
        const imageInput = new TextInputBuilder().setCustomId('imageInput').setLabel('URL thumbnail (opcional)').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.imageUrl || '');
        const buttonLabelInput = new TextInputBuilder().setCustomId('buttonLabelInput').setLabel('Label do botão central').setStyle(TextInputStyle.Short).setRequired(false).setValue(cfg.buttonLabel || '');

        modal.addComponents(
          new ActionRowBuilder().addComponents(modeInput),
          new ActionRowBuilder().addComponents(valueInput),
          new ActionRowBuilder().addComponents(imageInput),
          new ActionRowBuilder().addComponents(buttonLabelInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (custom === 'announce:preview') {
        const cfg = tempConfigs.get(interaction.user.id);
        if (!cfg) return interaction.reply({ content: 'Nada configurado ainda. Reabra /announce e preencha.', ephemeral: true });
        const previewMatch = { id: 'PREVIEW', mode: cfg.mode, suggested_value: cfg.suggestedValue, image_url: cfg.imageUrl, button_label: cfg.buttonLabel, author_id: interaction.user.id };
        const embed = buildAnnouncementEmbed(previewMatch, []);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (custom === 'announce:publish') {
        const cfg = tempConfigs.get(interaction.user.id);
        if (!cfg) return interaction.reply({ content: 'Nenhum dado temporário. Reabra /announce.', ephemeral: true });
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Somente administradores do servidor podem publicar.', ephemeral: true });
        if (!cfg.channelIds || cfg.channelIds.length === 0) return interaction.reply({ content: 'Selecione ao menos 1 canal.', ephemeral: true });

        const matchId = uuidv4();
        const matchRecord = {
          id: matchId,
          guildId: interaction.guild.id,
          authorId: interaction.user.id,
          mode: cfg.mode,
          suggestedValue: cfg.suggestedValue,
          imageUrl: cfg.imageUrl,
          buttonLabel: cfg.buttonLabel,
          channelIds: cfg.channelIds
        };
        // create DB record
        createMatchRecord(matchRecord);

        // post messages
        const postedIds = [];
        for (const chId of matchRecord.channelIds) {
          try {
            const ch = await interaction.guild.channels.fetch(chId).catch(()=>null);
            if (!ch || ch.type !== ChannelType.GuildText) {
              postedIds.push(null);
              continue;
            }
            const embed = buildAnnouncementEmbed(matchRecord, []);
            const components = buildAnnouncementComponents(matchId, matchRecord.buttonLabel);
            const msg = await ch.send({ embeds: [embed], components });
            postedIds.push(msg.id);
          } catch (err) {
            console.error('Erro postar em canal', chId, err);
            postedIds.push(null);
          }
        }
        updateMatch(matchId, { message_ids: JSON.stringify(postedIds), channel_ids: JSON.stringify(matchRecord.channelIds) });
        logAction(matchId, 'published', interaction.user.id, `channels=${matchRecord.channelIds.join(',')}`);
        tempConfigs.delete(interaction.user.id);
        return interaction.reply({ content: `Anúncio publicado (ID ${matchId.slice(0,6)}).`, ephemeral: true });
      }

      if (custom === 'announce:cancel') {
        tempConfigs.delete(interaction.user.id);
        return interaction.reply({ content: 'Operação cancelada.', ephemeral: true });
      }

      // public message buttons — format: match:<matchId>:action
      if (custom.startsWith('match:')) {
        const parts = custom.split(':'); // ['match', matchId, action]
        if (parts.length < 3) return interaction.reply({ content: 'Ação inválida.', ephemeral: true });
        const matchId = parts[1];
        const action = parts[2];

        const match = getMatch(matchId);
        if (!match) return interaction.reply({ content: 'Anúncio não encontrado (talvez removido).', ephemeral: true });

        // JOIN action must be transactional and create checkout only after count reaches 2
        if (action === 'join') {
          try {
            const res = joinTransaction(matchId, interaction.user.id);
            if (res.already) {
              return interaction.reply({ content: 'Você já entrou nessa aposta.', ephemeral: true });
            }
            // update public messages with current participants
            const partsList = listParticipants(matchId).map(p => `<@${p.user_id}>`);
            const embed = buildAnnouncementEmbed(match, partsList);
            const channelIds = JSON.parse(match.channel_ids || '[]');
            const messageIds = JSON.parse(match.message_ids || '[]');
            for (let i = 0; i < channelIds.length; i++) {
              const chId = channelIds[i];
              const msgId = messageIds[i];
              if (!chId || !msgId) continue;
              try {
                const ch = await interaction.guild.channels.fetch(chId).catch(()=>null);
                if (!ch || ch.type !== ChannelType.GuildText) continue;
                const message = await ch.messages.fetch(msgId).catch(()=>null);
                if (message) await message.edit({ embeds: [embed], components: buildAnnouncementComponents(matchId, match.button_label) }).catch(()=>null);
              } catch (e) {}
            }

            await interaction.reply({ content: 'Você entrou na aposta. Aguarde até haver 2 apostadores.', ephemeral: true });

            // if new count equals 2 -> create private checkout channel for the exact two + author
            if (res.count === 2) {
              // create checkout channel (only once)
              try {
                // double-check match hasn't already checkout_created
                const fresh = getMatch(matchId);
                if (fresh.status === 'open' || fresh.status === 'waiting_checkout') {
                  // create channel now
                  // get participant ids
                  const participants = listParticipants(matchId).map(p => p.user_id);
                  // prepare overwrites
                  const overwrites = [
                    { id: interaction.guild.roles.everyone.id, deny: ['ViewChannel'] },
                    { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory'] },
                    { id: match.author_id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] }
                  ];
                  for (const uid of participants) {
                    overwrites.push({ id: uid, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] });
                  }
                  const channelName = `checkout-${matchId.slice(0,6)}`;
                  const checkoutCh = await interaction.guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    permissionOverwrites: overwrites,
                    topic: `Checkout privado da aposta ${matchId} — apenas os 2 apostadores e o autor têm acesso.`
                  });
                  // update DB
                  updateMatch(matchId, { checkout_channel_id: checkoutCh.id, status: 'checkout_created' });
                  logAction(matchId, 'checkout_channel_created', interaction.user.id, `channel=${checkoutCh.id}`);
                  // send initial message in checkout
                  const players = participants.map(id => `<@${id}>`);
                  const embedCheckout = buildAnnouncementEmbed(match, players);
                  await checkoutCh.send({ content: `Checkout privado criado. Apenas os 2 apostadores e o autor (admin) têm acesso aqui. Autor pode propor valor com o botão.`, embeds: [embedCheckout], components: buildCheckoutComponents(matchId) });
                }
              } catch (err) {
                console.error('Erro ao criar checkout channel:', err);
                logAction(matchId, 'checkout_create_error', interaction.user.id, err.message);
                // notify admin ephemeral
                await interaction.followUp({ content: `Erro criando checkout privado: ${err.message}`, ephemeral: true });
              }
            }

          } catch (err) {
            // joinTransaction throws if match not open or full
            return interaction.reply({ content: `Erro ao entrar: ${err.message}`, ephemeral: true });
          }
          return;
        }

        // LEAVE
        if (action === 'leave') {
          const exists = db.prepare('SELECT * FROM participants WHERE match_id = ? AND user_id = ?').get(matchId, interaction.user.id);
          if (!exists) return interaction.reply({ content: 'Você não está nessa aposta.', ephemeral: true });
          removeParticipantRecord(matchId, interaction.user.id);
          // update posted messages
          const partsList = listParticipants(matchId).map(p => `<@${p.user_id}>`);
          const embed = buildAnnouncementEmbed(match, partsList);
          const channelIds = JSON.parse(match.channel_ids || '[]');
          const messageIds = JSON.parse(match.message_ids || '[]');
          for (let i = 0; i < channelIds.length; i++) {
            const chId = channelIds[i];
            const msgId = messageIds[i];
            if (!chId || !msgId) continue;
            try {
              const ch = await interaction.guild.channels.fetch(chId).catch(()=>null);
              if (!ch || ch.type !== ChannelType.GuildText) continue;
              const message = await ch.messages.fetch(msgId).catch(()=>null);
              if (message) await message.edit({ embeds: [embed], components: buildAnnouncementComponents(matchId, match.button_label) }).catch(()=>null);
            } catch (e) {}
          }
          await interaction.reply({ content: 'Você saiu da aposta.', ephemeral: true });
          return;
        }

        // FULL (just an informational button - customize if you want)
        if (action === 'full') {
          return interaction.reply({ content: 'Ação Full (informativa).', ephemeral: true });
        }

        // CHECKOUT buttons (in checkout channel)
        if (action === 'propose') {
          // only author (admin) can propose
          const matchRec = getMatch(matchId);
          if (!matchRec) return interaction.reply({ content: 'Match não encontrado.', ephemeral: true });
          if (interaction.user.id !== matchRec.author_id) return interaction.reply({ content: 'Apenas o autor (admin) pode propor o valor.', ephemeral: true });

          // show modal to input proposed value
          const modal = new ModalBuilder().setCustomId(`propose_modal:${matchId}`).setTitle('Propor valor da aposta');
          const valueInput = new TextInputBuilder().setCustomId('proposed_value').setLabel('Valor em R$ (apenas números)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('100');
          modal.addComponents(new ActionRowBuilder().addComponents(valueInput));
          await interaction.showModal(modal);
          return;
        }

        if (action === 'confirm') {
          // participant confirms they did PIX
          const p = db.prepare('SELECT * FROM participants WHERE match_id = ? AND user_id = ?').get(matchId, interaction.user.id);
          if (!p) return interaction.reply({ content: 'Você não é participante desta aposta.', ephemeral: true });
          setParticipantConfirmed(matchId, interaction.user.id);
          await interaction.reply({ content: 'Confirmação registrada. Aguarde o autor verificar o PIX.', ephemeral: true });
          return;
        }

        if (action === 'markpaid') {
          const matchRec = getMatch(matchId);
          if (!matchRec) return interaction.reply({ content: 'Match não encontrado.', ephemeral: true });
          if (interaction.user.id !== matchRec.author_id) return interaction.reply({ content: 'Apenas o autor (admin) pode marcar pago.', ephemeral: true });
          updateMatch(matchId, { status: 'confirmed' });
          logAction(matchId, 'marked_paid', interaction.user.id);
          await interaction.reply({ content: 'Marcado como pago. Prosseguam.', ephemeral: true });
          // notify in checkout channel
          if (matchRec.checkout_channel_id) {
            const ch = await interaction.guild.channels.fetch(matchRec.checkout_channel_id).catch(()=>null);
            if (ch && ch.isTextBased()) ch.send(`Autor marcou como pago. Podem prosseguir.`);
          }
          return;
        }

        if (action === 'resolveA' || action === 'resolveB') {
          const matchRec = getMatch(matchId);
          if (!matchRec) return interaction.reply({ content: 'Match não encontrado.', ephemeral: true });
          if (interaction.user.id !== matchRec.author_id) return interaction.reply({ content: 'Apenas o autor (admin) pode resolver a partida.', ephemeral: true });
          const winner = action === 'resolveA' ? 'A' : 'B';
          updateMatch(matchId, { status: 'resolved' });
          logAction(matchId, 'resolved', interaction.user.id, `winner=${winner}`);
          await interaction.reply({ content: `Partida resolvida: time ${winner} venceu.`, ephemeral: false });
          return;
        }
      }
    }

    // Modal submit handling
    if (interaction.type === InteractionType.ModalSubmit) {
      const custom = interaction.customId;
      if (custom && custom.startsWith('announce:modal:')) {
        const userId = custom.split(':')[2];
        if (userId !== interaction.user.id) return interaction.reply({ content: 'Modal inválido para este usuário.', ephemeral: true });
        const cfg = tempConfigs.get(interaction.user.id);
        if (!cfg) return interaction.reply({ content: 'Sessão expirada.', ephemeral: true });
        const mode = interaction.fields.getTextInputValue('modeInput');
        const suggestedValue = interaction.fields.getTextInputValue('valueInput') || '';
        const imageUrl = interaction.fields.getTextInputValue('imageInput') || '';
        const buttonLabel = interaction.fields.getTextInputValue('buttonLabelInput') || cfg.buttonLabel || 'Full';
        cfg.mode = mode;
        cfg.suggestedValue = suggestedValue;
        cfg.imageUrl = imageUrl;
        cfg.buttonLabel = buttonLabel;
        tempConfigs.set(interaction.user.id, cfg);
        return interaction.reply({ content: 'Dados do anúncio salvos temporariamente. Use Pré-visualizar ou Publicar.', ephemeral: true });
      }

      if (custom && custom.startsWith('propose_modal:')) {
        const matchId = custom.split(':')[1];
        const proposedValue = interaction.fields.getTextInputValue('proposed_value');
        const match = getMatch(matchId);
        if (!match) return interaction.reply({ content: 'Match não encontrado.', ephemeral: true });
        if (interaction.user.id !== match.author_id) return interaction.reply({ content: 'Apenas o autor pode propor valor.', ephemeral: true });
        logAction(matchId, 'proposed_value', interaction.user.id, `value=${proposedValue}`);
        // notify in checkout channel
        if (match.checkout_channel_id) {
          const ch = await interaction.guild.channels.fetch(match.checkout_channel_id).catch(()=>null);
          if (ch && ch.isTextBased()) ch.send(`📣 Autor propôs o valor: **R$ ${proposedValue}**. Participantes, confirmem quando fizerem o PIX.`);
        }
        return interaction.reply({ content: `Proposta R$ ${proposedValue} publicada no checkout.`, ephemeral: true });
      }
    }

  } catch (err) {
    console.error('Erro interactionCreate:', err);
    try {
      if (!interaction.replied) await interaction.reply({ content: `Erro: ${err.message}`, ephemeral: true });
    } catch (e) {}
  }
});

// register commands on ready
client.once('ready', async () => {
  console.log(`BAKAIO APOSTA logado como ${client.user.tag}`);
  await registerSlashCommands();
});

async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const cmds = [
    new SlashCommandBuilder().setName('announce').setDescription('Abrir painel para publicar anúncio (Administradores)').toJSON(),
    new SlashCommandBuilder().setName('bakaio-logs').setDescription('Mostrar logs recentes (admin)').toJSON()
  ];
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
      console.log('Comandos registrados no GUILD_ID (teste).');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: cmds });
      console.log('Comandos globais registrados.');
    }
  } catch (err) {
    console.error('Erro registrando comandos:', err);
  }
}

client.login(TOKEN).catch(err => {
  console.error('Falha ao logar bot:', err);
  process.exit(1);
});
