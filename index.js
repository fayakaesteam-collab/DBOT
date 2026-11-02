const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");

const GUILD_ID = "1565361379299426344";
const MEMBER_ROLE_ID = "1565414617742839960";
const MODERATOR_ROLE_ID = "1565741214261715035";
const MODERATION_CHANNEL_ID = "1566155207753076906";
const WARNING_ROLE_IDS = [
  "1566152387805192302",
  "1566152652830544106",
  "1566152707121873142",
];
const VERIFICATION_EMOJI = "✅";
const INVITE_PATTERN = /(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i;
const EXECUTABLE_EXTENSIONS = new Set([
  ".apk", ".bat", ".cmd", ".com", ".dll", ".exe", ".jar", ".js", ".msi",
  ".ps1", ".scr", ".vbs",
]);
const RULE_PATTERN = /^\s*(\d+\.\d+)\s+(.+?)\s*$/gm;
const DATABASE_PATH = process.env.DB_PATH || path.join(__dirname, "bot_data.sqlite3");
const RULES_PATH = path.join(__dirname, "rules.txt");

const logger = {
  info: (...args) => console.info(new Date().toISOString(), "INFO", ...args),
  error: (...args) => console.error(new Date().toISOString(), "ERROR", ...args),
};

const db = new DatabaseSync(DATABASE_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS warnings (
    guild_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    count INTEGER NOT NULL CHECK (count >= 0),
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS verification_messages (
    guild_id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL
  );
`);

function loadRules() {
  const text = fs.readFileSync(RULES_PATH, "utf8");
  const parsedRules = new Map();
  for (const match of text.matchAll(RULE_PATTERN)) {
    parsedRules.set(match[1], match[2].trim().replace(/[ \[]+$/, ""));
  }
  if (parsedRules.size === 0) {
    throw new Error(`В файле ${RULES_PATH} не найдены правила формата 1.1 Название`);
  }
  return parsedRules;
}

const rules = loadRules();
const getWarningCount = db.prepare(
  "SELECT count FROM warnings WHERE guild_id = ? AND user_id = ?",
);
getWarningCount.setReadBigInts(true);
const saveWarningCount = db.prepare(`
  INSERT INTO warnings (guild_id, user_id, count)
  VALUES (?, ?, ?)
  ON CONFLICT (guild_id, user_id)
  DO UPDATE SET count = excluded.count
`);
const getVerificationMessage = db.prepare(
  "SELECT message_id FROM verification_messages WHERE guild_id = ?",
);
getVerificationMessage.setReadBigInts(true);
const saveVerificationMessage = db.prepare(`
  INSERT INTO verification_messages (guild_id, message_id)
  VALUES (?, ?)
  ON CONFLICT (guild_id)
  DO UPDATE SET message_id = excluded.message_id
`);

function warningCount(guildId, userId) {
  const result = getWarningCount.get(guildId, userId);
  return result ? Number(result.count) : 0;
}

function verificationMessageId(guildId) {
  const result = getVerificationMessage.get(guildId);
  return result ? String(result.message_id) : null;
}

function sortRuleIds(ruleIds) {
  return [...ruleIds].sort((left, right) => {
    const [leftMajor, leftMinor] = left.split(".").map(Number);
    const [rightMajor, rightMinor] = right.split(".").map(Number);
    return leftMajor - rightMajor || leftMinor - rightMinor;
  });
}

const messageHistory = new Map();
const warningLocks = new Map();

function detectMessageCandidates(message) {
  const content = message.content;
  const candidates = [];
  const key = `${message.guild.id}:${message.channel.id}:${message.author.id}`;
  const now = Date.now();
  const history = (messageHistory.get(key) || []).filter(([timestamp]) => now - timestamp <= 30_000);
  const normalized = content.trim().toLocaleLowerCase();

  if (normalized) {
    history.push([now, normalized]);
    if (history.filter(([, previous]) => previous === normalized).length >= 3) {
      candidates.push(["1.2", "Повтор одинакового сообщения несколько раз за короткое время"]);
    }
  }
  if (history.length > 0) {
    messageHistory.set(key, history);
  } else {
    messageHistory.delete(key);
  }

  const letters = content.match(/\p{L}/gu) || [];
  const uppercaseLetters = content.match(/\p{Lu}/gu) || [];
  if (letters.length >= 20 && uppercaseLetters.length / letters.length >= 0.8) {
    candidates.push(["1.2", "Сообщение преимущественно написано заглавными буквами"]);
  }
  if (message.mentions.users.size >= 5 || message.mentions.everyone) {
    candidates.push(["1.10", "Массовое упоминание или большое число упомянутых пользователей"]);
  }
  if (INVITE_PATTERN.test(content)) {
    candidates.push(["1.5", "В сообщении обнаружена ссылка-приглашение Discord"]);
  }
  if (message.attachments.some((attachment) =>
    EXECUTABLE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()),
  )) {
    candidates.push(["1.11", "Вложение имеет расширение исполняемого файла или скрипта"]);
  }
  return candidates;
}

function configuredRole(guild, roleId, label) {
  const role = guild.roles.cache.get(roleId);
  if (!role) {
    throw new Error(`На сервере не найдена роль ${label} (ID ${roleId})`);
  }
  return role;
}

function roleAssignmentIssue(guild, member, roles) {
  const botMember = guild.members.me;
  if (!botMember) {
    return "Не удалось определить участника-бота на сервере.";
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return "Выдайте боту право «Управлять ролями» (Manage Roles).";
  }
  if (member.id === guild.ownerId) {
    return "Бот не может изменять роли владельца сервера.";
  }
  if (member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0) {
    return `Самая высокая роль пользователя «${member.roles.highest.name}» должна быть ниже самой высокой роли бота «${botMember.roles.highest.name}».`;
  }
  for (const role of roles) {
    if (role.comparePositionTo(botMember.roles.highest) >= 0) {
      return `Переместите роль бота «${botMember.roles.highest.name}» выше роли «${role.name}» в настройках ролей сервера.`;
    }
  }
  return null;
}

async function sendModeratorAlert(guild, { title, description, message }) {
  const channel = guild.channels.cache.get(MODERATION_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText) {
    logger.error(`Канал модерации ${MODERATION_CHANNEL_ID} не найден или не является текстовым`);
    return;
  }
  const moderatorRole = guild.roles.cache.get(MODERATOR_ROLE_ID);
  if (!moderatorRole) {
    logger.error(`Роль модератора ${MODERATOR_ROLE_ID} не найдена на сервере`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xfee75c);
  if (message) {
    embed.addFields(
      { name: "Сообщение", value: (message.content.trim() || "(текст отсутствует)").slice(0, 1000), inline: false },
      { name: "Автор", value: `${message.author} (\`${message.author.id}\`)`, inline: true },
      { name: "Канал", value: `${message.channel}`, inline: true },
      { name: "Ссылка", value: `[Открыть сообщение](${message.url})`, inline: false },
    );
    if (message.attachments.size > 0) {
      embed.addFields({
        name: "Вложения",
        value: [...message.attachments.values()].map((attachment) => attachment.name).join("\n").slice(0, 1000),
        inline: false,
      });
    }
  }

  await channel.send({
    content: `${moderatorRole}`,
    embeds: [embed],
    allowedMentions: { roles: [moderatorRole.id], users: [], parse: [] },
  });
}

async function withWarningLock(key, action) {
  const previous = warningLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  warningLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (warningLocks.get(key) === current) {
      warningLocks.delete(key);
    }
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once("ready", () => {
  logger.info(`Бот запущен как ${client.user.tag} (${client.user.id})`);
});

async function handleMessage(message) {
  if (message.guildId === GUILD_ID && !message.author.bot && message.content.startsWith("!")) {
    await handleCommand(message);
  }
  if (
    !message.guild ||
    message.guild.id !== GUILD_ID ||
    message.author.bot ||
    message.content.startsWith("!")
  ) {
    return;
  }

  const candidates = detectMessageCandidates(message);
  if (candidates.length === 0) return;
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.join("\0"), candidate])).values()];
  const details = uniqueCandidates
    .map(([ruleId, reason]) => `**${ruleId} — ${rules.get(ruleId) || "Правило из rules.txt"}**: ${reason}`)
    .join("\n");
  await sendModeratorAlert(message.guild, {
    title: "Возможное нарушение — требуется проверка модератора",
    description: details,
    message,
  });
}

async function handleCommand(message) {
  const [commandName, ...args] = message.content.trim().split(/\s+/);
  const command = commandName.slice(1).toLowerCase();
  const guild = message.guild;
  const invokingMember = message.member || await guild.members.fetch(message.author.id);

  if (command === "в" || command === "verify") {
    if (!invokingMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await message.reply("У вас недостаточно прав для этой команды.");
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Верификация")
      .setDescription(`Чтобы получить роль **Участник** и открыть сервер, нажмите ${VERIFICATION_EMOJI} под этим сообщением.`)
      .setColor(0x57f287)
      .setFooter({ text: "Dream Shore • проверка участника" });
    const verificationMessage = await message.channel.send({ embeds: [embed] });
    await verificationMessage.react(VERIFICATION_EMOJI);
    saveVerificationMessage.run(guild.id, verificationMessage.id);
    return;
  }

  if (command === "варн") {
    if (!invokingMember.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply("У вас недостаточно прав для этой команды.");
      return;
    }
    const [memberInput, rawRuleId] = args;
    if (!memberInput || !rawRuleId) {
      await message.reply("Использование: `!варн @пользователь номер_правила` (например, `!варн @user 1.1`).");
      return;
    }
    const memberId = memberInput.match(/^<@!?(\d+)>$/)?.[1] ||
      (/^\d+$/.test(memberInput) ? memberInput : null);
    if (!memberId) {
      await message.reply("Не удалось найти участника. Укажите его упоминанием или ID.");
      return;
    }
    let member;
    try {
      member = await guild.members.fetch(memberId);
    } catch (error) {
      if (error.code === 10007) {
        await message.reply("Не удалось найти участника. Укажите его упоминанием или ID.");
        return;
      }
      throw error;
    }
    if (member.user.bot) {
      await message.reply("Нельзя выдать предупреждение боту.");
      return;
    }

    const ruleId = rawRuleId.trim();
    const ruleTitle = rules.get(ruleId);
    if (!ruleTitle) {
      const available = sortRuleIds(rules.keys()).join(", ");
      await message.reply(`Правило \`${ruleId}\` не найдено в \`rules.txt\`. Доступные номера: ${available}`);
      return;
    }

    const warningCountValue = await withWarningLock(`${guild.id}:${member.id}`, async () => {
      const warningRoles = WARNING_ROLE_IDS.map((roleId, index) =>
        configuredRole(guild, roleId, `предупреждение ${index + 1}`),
      );
      const issue = roleAssignmentIssue(guild, member, warningRoles);
      if (issue) {
        await message.reply(`Не удалось выдать роль предупреждения: ${issue}`);
        return null;
      }

      const existingRoleCount = warningRoles.reduce(
        (count, role, index) => member.roles.cache.has(role.id) ? index + 1 : count,
        0,
      );
      const previousCount = Math.max(warningCount(guild.id, member.id), existingRoleCount);
      if (previousCount >= warningRoles.length) {
        await message.reply(`У ${member} уже есть роль «Забаненный»; новое предупреждение не выдано.`);
        return null;
      }

      const nextCount = previousCount + 1;
      const updatedRoles = member.roles.cache
        .filter((role) => !WARNING_ROLE_IDS.includes(role.id))
        .map((role) => role.id);
      updatedRoles.push(warningRoles[nextCount - 1].id);
      await member.roles.set(updatedRoles, `Предупреждение ${nextCount}/3 за нарушение правила ${ruleId}`);
      saveWarningCount.run(guild.id, member.id, nextCount);
      return nextCount;
    });
    if (warningCountValue === null) return;

    const messages = {
      1: `${member}, вы нарушили правило **${ruleId} — ${ruleTitle}**. Это первое предупреждение.`,
      2: `${member}, вы нарушили правило **${ruleId} — ${ruleTitle}**. Это второе предупреждение. При третьем нарушении будет выдана роль «Забаненный».`,
      3: `${member}, вы нарушили правило **${ruleId} — ${ruleTitle}**. Это третье предупреждение: выдана роль «Забаненный».`,
    };
    try {
      await sendModeratorAlert(guild, {
        title: `Выдано предупреждение ${warningCountValue}/3`,
        description: `Модератор: ${message.author}\nПользователь: ${member}\nПравило: **${ruleId} — ${ruleTitle}**`,
      });
    } catch (error) {
      logger.error(`Не удалось уведомить модераторов о предупреждении пользователю ${member.id}`, error);
    }
    await message.channel.send({
      content: messages[warningCountValue],
      allowedMentions: { users: [member.id], parse: [] },
    });
    return;
  }

  if (command === "правила") {
    const ruleId = args[0]?.trim();
    if (ruleId) {
      const title = rules.get(ruleId);
      if (!title) {
        await message.reply(`Правило \`${ruleId}\` не найдено в \`rules.txt\`.`);
        return;
      }
      await message.reply(`**${ruleId} — ${title}**`);
      return;
    }
    const ruleList = [...rules].map(([id, title]) => `\`${id}\` — ${title}`).join("\n");
    const embed = new EmbedBuilder()
      .setTitle("Правила сервера")
      .setDescription(ruleList.slice(0, 4000))
      .setColor(0x5865f2)
      .setFooter({ text: "Полный текст правил находится в rules.txt." });
    await message.reply({ embeds: [embed] });
  }
}

client.on("messageCreate", (message) => {
  handleMessage(message).catch((error) => {
    logger.error(`Ошибка обработки сообщения ${message.id}`, error);
    if (message.guildId === GUILD_ID && message.content.startsWith("!")) {
      const response = error.code === 50013
        ? "Discord отказал в изменении ролей. Проверьте право бота «Управлять ролями», положение его роли выше ролей предупреждений и высшей роли пользователя."
        : "Команда завершилась с ошибкой. Подробности записаны в журнал бота.";
      message.reply(response).catch((replyError) => {
        logger.error(`Не удалось сообщить об ошибке команды в сообщении ${message.id}`, replyError);
      });
    }
  });
});

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (reaction.partial) {
      await reaction.fetch();
    }
    const message = reaction.message;
    const guild = message.guild;
    if (
      !guild ||
      guild.id !== GUILD_ID ||
      user.bot ||
      reaction.emoji.name !== VERIFICATION_EMOJI ||
      verificationMessageId(guild.id) !== message.id
    ) {
      return;
    }

    const member = await guild.members.fetch(user.id);
    if (member.user.bot) return;
    const role = configuredRole(guild, MEMBER_ROLE_ID, "Участник");
    const issue = roleAssignmentIssue(guild, member, [role]);
    if (issue) {
      await sendModeratorAlert(guild, {
        title: "Не удалось выдать роль верификации",
        description: `Пользователь: ${member}\nПричина: ${issue}`,
      });
      logger.error(`Не удалось выдать роль участника пользователю ${member.id}: ${issue}`);
      return;
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, "Успешная реакция на сообщение верификации");
    }
  } catch (error) {
    if (error.code === 10007) return;
    logger.error("Ошибка обработки реакции верификации", error);
  }
});

client.on("error", (error) => logger.error("Ошибка Discord-клиента", error));

const token = process.env.DISCORD_TOKEN?.trim();
if (!token || token === "replace_with_your_new_discord_bot_token") {
  throw new Error("Не задан токен. Установите переменную окружения DISCORD_TOKEN.");
}

client.login(token).catch((error) => {
  logger.error("Не удалось войти в Discord. Проверьте DISCORD_TOKEN.", error);
  process.exitCode = 1;
});
