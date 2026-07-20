import 'dotenv/config';
import { loadConfig } from '../config.js';
import { checkConnection, closePool, createPool } from '../db/connection.js';
import { closeDb, initDb } from '../db/index.js';
import { EmailSender } from './emailSender.js';
import { MarketOpinionAgent, type MarketOpinionDigestKind } from './marketOpinionAgent.js';
import { MarketOpinionPushService } from './marketOpinionPushService.js';

const kinds = ['morning', 'midday', 'close'] as const;

async function main(): Promise<void> {
  const config = loadConfig();
  const requested = process.argv.find((arg) => arg.startsWith('--kind='))?.slice('--kind='.length) ?? 'morning';
  if (!kinds.includes(requested as MarketOpinionDigestKind)) {
    throw new Error('--kind 仅支持 morning、midday 或 close');
  }
  const kind = requested as MarketOpinionDigestKind;
  const simulation = process.argv.includes('--simulation');
  const correction = process.argv.includes('--correction');
  if (simulation && correction) throw new Error('--simulation 与 --correction 不能同时使用');
  const recipients = config.MAIL_TO.split(',').map((item) => item.trim()).filter(Boolean);
  const pool = createPool(config);
  try {
    const connection = await checkConnection(pool);
    if (!connection.ok) throw new Error(`数据库不可用：${connection.error}`);
    initDb(pool);
    const email = new EmailSender({
      host: config.SMTP_HOST,
      port: parseInt(config.SMTP_PORT, 10),
      secure: config.SMTP_SECURE === 'true',
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: config.MAIL_FROM || config.SMTP_USER,
      to: recipients,
    });
    const service = new MarketOpinionPushService({
      enabled: true,
      schedules: {
        morning: config.MARKET_OPINION_MORNING_TIME,
        midday: config.MARKET_OPINION_MIDDAY_TIME,
        close: config.MARKET_OPINION_CLOSE_TIME,
      },
      recipientCount: recipients.length,
      agent: new MarketOpinionAgent(
        config.OPENAI_API_KEY,
        config.OPENAI_BASE_URL,
        config.OPENAI_MODEL,
        parseInt(config.OPENAI_TIMEOUT_MS, 10),
      ),
      email,
      model: config.OPENAI_MODEL,
    });
    const result = await service.send(kind, new Date(), {
      subjectPrefix: simulation ? '【模拟推送】' : correction ? '【更正版】' : undefined,
    });
    console.log(JSON.stringify({
      sent: true,
      simulation,
      correction,
      kind: result.kind,
      generatedAt: result.generatedAt,
      newsCount: result.newsCount,
      sourceCount: result.sourceCount,
      recipients: recipients.length,
      messageId: result.messageId,
      newsFetchedAt: result.newsFetchedAt,
      marketCapturedAt: result.marketCapturedAt,
      newsSources: result.newsSources,
    }));
  } finally {
    closeDb();
    await closePool(pool);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
