import { eq } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';

const SETTING_ID = 'default';

export async function getCandidateAutomationSetting() {
  const [setting] = await getDb().select().from(schema.factorCandidateAutomationSettings)
    .where(eq(schema.factorCandidateAutomationSettings.id, SETTING_ID)).limit(1);
  if (setting) return setting;
  const created = { id: SETTING_ID, enabled: 0, updatedAt: new Date().toISOString() };
  await getDb().insert(schema.factorCandidateAutomationSettings).values(created)
    .onDuplicateKeyUpdate({ set: { id: SETTING_ID } });
  const [resolved] = await getDb().select().from(schema.factorCandidateAutomationSettings)
    .where(eq(schema.factorCandidateAutomationSettings.id, SETTING_ID)).limit(1);
  return resolved ?? created;
}

export async function setCandidateAutomationEnabled(enabled: boolean) {
  const updatedAt = new Date().toISOString();
  await getDb().insert(schema.factorCandidateAutomationSettings).values({
    id: SETTING_ID, enabled: enabled ? 1 : 0, updatedAt,
  }).onDuplicateKeyUpdate({
    set: { enabled: enabled ? 1 : 0, updatedAt },
  });
  return getCandidateAutomationSetting();
}
