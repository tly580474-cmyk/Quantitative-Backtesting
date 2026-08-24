import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { AgentAttachmentError, AgentAttachmentService } from './attachmentService.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fakePool() {
  const rows: Record<string, unknown>[] = [];
  const pool = {
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO agent_attachments')) {
        rows.push({
          id: params[0], run_id: null, original_name: params[1], media_type: params[2],
          file_kind: params[3], extension: params[4], file_size: params[5], sha256: params[6],
          stored_path: params[7], extracted_path: params[8], extracted_chars: params[9], created_at: params[10],
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT id, run_id')) {
        return [rows.filter(row => params.includes(row.id))];
      }
      if (sql.startsWith('UPDATE agent_attachments SET run_id')) {
        const [runId, ...ids] = params;
        let affectedRows = 0;
        for (const row of rows) {
          if (row.run_id == null && ids.includes(row.id)) { row.run_id = runId; affectedRows += 1; }
        }
        return [{ affectedRows }];
      }
      if (sql.startsWith('SELECT * FROM agent_attachments WHERE run_id IS NULL')) {
        return [rows.filter(row => row.run_id == null && String(row.created_at) < String(params[0]))];
      }
      if (sql.startsWith('DELETE FROM agent_attachments WHERE run_id IS NULL')) {
        const cutoff = String(params[0]);
        let affectedRows = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index]?.run_id == null && String(rows[index]?.created_at) < cutoff) {
            rows.splice(index, 1); affectedRows += 1;
          }
        }
        return [{ affectedRows }];
      }
      if (sql.includes('WHERE run_id = ?')) return [rows.filter(row => row.run_id === params[0])];
      if (sql.includes('WHERE id = ?')) return [rows.filter(row => row.id === params[0])];
      return [{ affectedRows: 0 }];
    },
  } as unknown as Pool;
  return { pool, rows };
}

async function service(maxFileMb = 20) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'agent-attachment-'));
  temporaryRoots.push(temporaryRoot);
  const workspace = join(temporaryRoot, 'workspace');
  const root = join(workspace, 'tmp_output', '.agent-attachments');
  await mkdir(workspace, { recursive: true });
  const database = fakePool();
  return { service: new AgentAttachmentService(database.pool, root, workspace, maxFileMb, 8, 300_000), ...database };
}

function upload(filename: string, content: Buffer, mimetype = 'application/octet-stream') {
  return { filename, mimetype, toBuffer: async () => content };
}

describe('AgentAttachmentService', () => {
  it('stores Markdown locally and exposes extracted content after binding', async () => {
    const fixture = await service();
    const attachment = await fixture.service.create(upload('research.md', Buffer.from('# 结论\n内容')));
    await fixture.service.bindToRun([attachment.id], 'run-1');
    const [providerAttachment] = await fixture.service.providerAttachments('run-1');

    expect(attachment).toMatchObject({ name: 'research.md', kind: 'text', mediaType: 'text/markdown' });
    expect(providerAttachment.extractedText).toContain('# 结论');
    expect(providerAttachment.workspacePath).toContain('tmp_output/.agent-attachments');
  });

  it('converts CSV to Markdown through anydoc', async () => {
    const fixture = await service();
    const attachment = await fixture.service.create(upload('prices.csv', Buffer.from('code,price\n600519,1272.83')));
    await fixture.service.bindToRun([attachment.id], 'run-2');
    const [providerAttachment] = await fixture.service.providerAttachments('run-2');

    expect(attachment.kind).toBe('spreadsheet');
    expect(providerAttachment.extractedText).toContain('600519');
    expect(providerAttachment.extractedText).toContain('1272.83');
  });

  it('accepts a real PNG signature and rejects a mislabeled image', async () => {
    const fixture = await service();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nC8AAAAASUVORK5CYII=', 'base64');
    const attachment = await fixture.service.create(upload('chart.png', png, 'image/png'));
    expect(attachment).toMatchObject({ kind: 'image', mediaType: 'image/png' });
    await expect(fixture.service.create(upload('fake.png', Buffer.from('not an image'))))
      .rejects.toThrow('图片内容与文件扩展名不匹配');
  });

  it('rejects unsupported formats and oversized files', async () => {
    const fixture = await service(1);
    await expect(fixture.service.create(upload('payload.exe', Buffer.from('MZ'))))
      .rejects.toBeInstanceOf(AgentAttachmentError);
    await expect(fixture.service.create(upload('large.md', Buffer.alloc(1024 * 1024 + 1, 65))))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', statusCode: 413 });
  });

  it('cleans unbound uploads older than 24 hours', async () => {
    const fixture = await service();
    await fixture.service.create(upload('orphan.md', Buffer.from('old content')));
    fixture.rows[0]!.created_at = '2026-08-20T00:00:00.000Z';
    const directory = dirname(String(fixture.rows[0]!.stored_path));

    expect(await fixture.service.cleanupStaleUnbound(Date.parse('2026-08-22T00:00:00.000Z'))).toBe(1);
    expect(fixture.rows).toHaveLength(0);
    await expect(access(directory)).rejects.toThrow();
  });
});
