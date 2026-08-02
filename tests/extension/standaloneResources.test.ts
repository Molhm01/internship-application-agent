import { describe, expect, it } from 'vitest';
import type { SavedDocument } from '@internship-agent/shared';
import { selectSavedResume } from '../../extension/src/background/standaloneResources.js';

const NOW = '2026-07-31T12:00:00.000Z';

function resume(id: string, isDefault: boolean): SavedDocument {
  return {
    id,
    name: `${id} resume`,
    type: 'resume',
    filePath: `C:\\private\\${id}.pdf`,
    fileName: `${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 100,
    tags: [],
    targetRoles: [],
    targetIndustries: [],
    isDefault,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('standalone extension resources', () => {
  const documents = [resume('selected', false), resume('default', true)];

  it('uses the résumé selected in extension settings without a website session', () => {
    expect(selectSavedResume(documents, 'selected', 'default')?.id).toBe('selected');
  });

  it('falls back to the extension default résumé', () => {
    expect(selectSavedResume(documents, null, 'default')?.id).toBe('default');
  });
});
