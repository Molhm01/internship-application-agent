import {
  answerGenerationStoreSchema,
  type AnswerGenerationRecord,
  type AnswerGenerationStore,
} from '@internship-agent/shared';

const KEY = 'latestAnswerGenerationStore';

export async function loadAnswerGenerationStore(): Promise<AnswerGenerationStore | null> {
  const stored = await chrome.storage.local.get(KEY);
  const parsed = answerGenerationStoreSchema.safeParse(stored[KEY]);
  return parsed.success ? parsed.data : null;
}

export async function saveAnswerGenerationStore(
  store: AnswerGenerationStore,
): Promise<AnswerGenerationStore> {
  const parsed = answerGenerationStoreSchema.parse(store);
  await chrome.storage.local.set({ [KEY]: parsed });
  return parsed;
}

export async function saveAnswerGenerationRecord(
  scanId: string,
  planId: string,
  record: AnswerGenerationRecord,
): Promise<AnswerGenerationStore> {
  const current = await loadAnswerGenerationStore();
  const records =
    current?.scanId === scanId && current.planId === planId
      ? current.records.filter((candidate) => candidate.id !== record.id)
      : [];
  return saveAnswerGenerationStore({
    scanId,
    planId,
    records: [...records, record],
    updatedAt: new Date().toISOString(),
  });
}

export async function clearAnswerGenerationStore(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
