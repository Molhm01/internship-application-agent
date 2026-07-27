import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Document as DocxDocument, Packer, Paragraph } from 'docx';
import { authHeaders, createTestServer, type TestServer } from './helpers.js';

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function uploadAndExtract(
  fileName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<Record<string, unknown>> {
  server = await createTestServer();
  const uploaded = await server.app.inject({
    method: 'POST',
    url: '/documents',
    headers: authHeaders,
    payload: {
      name: fileName,
      type: 'resume',
      fileName,
      mimeType,
      contentBase64: Buffer.from(bytes).toString('base64'),
      tags: [],
      targetRoles: [],
      targetIndustries: [],
      isDefault: true,
    },
  });
  expect(uploaded.statusCode).toBe(201);
  const result = await server.app.inject({
    method: 'POST',
    url: `/documents/${uploaded.json().data.id}/extract`,
    headers: authHeaders,
    payload: {},
  });
  expect(result.statusCode).toBe(200);
  return result.json().data as Record<string, unknown>;
}

describe('local resume extraction formats', () => {
  it('extracts visible PDF page text without using metadata', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('PROJECTS Sensor Monitor built with TypeScript', { x: 40, y: 700, font });
    pdf.setTitle('Invisible metadata should not become evidence');
    const extraction = await uploadAndExtract('resume.pdf', 'application/pdf', await pdf.save());
    expect(extraction.status).toBe('completed');
    expect(extraction.normalizedText).toContain('Sensor Monitor');
    expect(extraction.normalizedText).not.toContain('Invisible metadata');
  });

  it('extracts DOCX paragraphs and identifies sections', async () => {
    const document = new DocxDocument({
      sections: [
        {
          children: [
            new Paragraph('SKILLS'),
            new Paragraph('TypeScript and automated testing'),
            new Paragraph('PROJECTS'),
            new Paragraph('Built a local application assistant'),
          ],
        },
      ],
    });
    const extraction = await uploadAndExtract(
      'resume.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      await Packer.toBuffer(document),
    );
    expect(extraction.status).toBe('completed');
    expect(extraction.normalizedText).toContain('TypeScript');
    expect((extraction.sections as Array<{ name: string }>).map((section) => section.name)).toEqual(
      expect.arrayContaining(['skills', 'projects']),
    );
  });
});
