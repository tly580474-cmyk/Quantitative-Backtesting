import { createHash } from 'node:crypto';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Pool, ResultSetHeader } from 'mysql2/promise';
import { formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc';
import type { ProviderAttachment } from './providers/types.js';

export type AgentAttachmentKind = 'image' | 'document' | 'text' | 'spreadsheet';

export interface AgentAttachmentRecord {
  id: string;
  runId: string | null;
  originalName: string;
  mediaType: string;
  fileKind: AgentAttachmentKind;
  extension: string;
  fileSize: number;
  sha256: string;
  storedPath: string;
  extractedPath: string | null;
  extractedChars: number;
  createdAt: string;
}

export interface PublicAgentAttachment {
  id: string;
  name: string;
  mediaType: string;
  kind: AgentAttachmentKind;
  size: number;
}

interface AttachmentFormat {
  kind: AgentAttachmentKind;
  mediaType: string;
  convert: 'image' | 'text' | 'anydoc';
}

const FORMATS: Record<string, AttachmentFormat> = {
  png: { kind: 'image', mediaType: 'image/png', convert: 'image' },
  jpg: { kind: 'image', mediaType: 'image/jpeg', convert: 'image' },
  jpeg: { kind: 'image', mediaType: 'image/jpeg', convert: 'image' },
  gif: { kind: 'image', mediaType: 'image/gif', convert: 'image' },
  webp: { kind: 'image', mediaType: 'image/webp', convert: 'image' },
  md: { kind: 'text', mediaType: 'text/markdown', convert: 'text' },
  markdown: { kind: 'text', mediaType: 'text/markdown', convert: 'text' },
  txt: { kind: 'text', mediaType: 'text/plain', convert: 'text' },
  csv: { kind: 'spreadsheet', mediaType: 'text/csv', convert: 'anydoc' },
  xls: { kind: 'spreadsheet', mediaType: 'application/vnd.ms-excel', convert: 'anydoc' },
  xlsx: { kind: 'spreadsheet', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', convert: 'anydoc' },
  xlsm: { kind: 'spreadsheet', mediaType: 'application/vnd.ms-excel.sheet.macroEnabled.12', convert: 'anydoc' },
  xlsb: { kind: 'spreadsheet', mediaType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', convert: 'anydoc' },
  ods: { kind: 'spreadsheet', mediaType: 'application/vnd.oasis.opendocument.spreadsheet', convert: 'anydoc' },
  doc: { kind: 'document', mediaType: 'application/msword', convert: 'anydoc' },
  docx: { kind: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', convert: 'anydoc' },
  docm: { kind: 'document', mediaType: 'application/vnd.ms-word.document.macroEnabled.12', convert: 'anydoc' },
  pdf: { kind: 'document', mediaType: 'application/pdf', convert: 'anydoc' },
  rtf: { kind: 'document', mediaType: 'application/rtf', convert: 'anydoc' },
  odt: { kind: 'document', mediaType: 'application/vnd.oasis.opendocument.text', convert: 'anydoc' },
  ppt: { kind: 'document', mediaType: 'application/vnd.ms-powerpoint', convert: 'anydoc' },
  pptx: { kind: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', convert: 'anydoc' },
  odp: { kind: 'document', mediaType: 'application/vnd.oasis.opendocument.presentation', convert: 'anydoc' },
};

export const AGENT_ATTACHMENT_ACCEPT = Object.keys(FORMATS).map(extension => `.${extension}`).join(',');

export class AgentAttachmentError extends Error {
  constructor(message: string, public statusCode = 400, public code = 'ATTACHMENT_INVALID') {
    super(message);
    this.name = 'AgentAttachmentError';
  }
}

function camelRow(row: Record<string, unknown>): AgentAttachmentRecord {
  return {
    id: String(row.id), runId: row.run_id == null ? null : String(row.run_id),
    originalName: String(row.original_name), mediaType: String(row.media_type),
    fileKind: String(row.file_kind) as AgentAttachmentKind, extension: String(row.extension),
    fileSize: Number(row.file_size), sha256: String(row.sha256), storedPath: String(row.stored_path),
    extractedPath: row.extracted_path == null ? null : String(row.extracted_path),
    extractedChars: Number(row.extracted_chars), createdAt: String(row.created_at),
  };
}

function publicAttachment(record: AgentAttachmentRecord): PublicAgentAttachment {
  return {
    id: record.id, name: record.originalName, mediaType: record.mediaType,
    kind: record.fileKind, size: record.fileSize,
  };
}

function cleanFilename(value: string): string {
  const cleaned = basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'attachment').slice(0, 255);
}

function looksLikeImage(buffer: Buffer, extension: string): boolean {
  if (extension === 'png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === 'jpg' || extension === 'jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (extension === 'gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (extension === 'webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function ensureText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new AgentAttachmentError('文本附件包含二进制内容');
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!text) throw new AgentAttachmentError('附件没有可读取的文本内容');
  return text;
}

export class AgentAttachmentService {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  private lastCleanupAt = 0;

  constructor(
    private pool: Pool,
    private root: string,
    private workspaceRoot: string,
    maxFileMb = 20,
    maxFiles = 8,
    private maxContextChars = 300_000,
  ) {
    this.root = resolve(root);
    this.workspaceRoot = resolve(workspaceRoot);
    this.maxFileBytes = Math.max(1, maxFileMb) * 1024 * 1024;
    this.maxFiles = Math.max(1, maxFiles);
    const rel = relative(this.workspaceRoot, this.root);
    if (!isAbsolute(this.root) || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('智能体附件目录必须位于项目工作区内');
    }
  }

  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AgentAttachmentError('附件 ID 无效');
    const directory = resolve(this.root, id);
    const rel = relative(this.root, directory);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new AgentAttachmentError('附件路径越界');
    return directory;
  }

  async create(file: { filename: string; mimetype: string; toBuffer(): Promise<Buffer> }): Promise<PublicAgentAttachment> {
    const name = cleanFilename(file.filename);
    const extension = extname(name).slice(1).toLowerCase();
    const format = FORMATS[extension];
    if (!format) throw new AgentAttachmentError(`不支持的附件格式：.${extension || '未知'}`);
    const buffer = await file.toBuffer();
    if (buffer.length < 1) throw new AgentAttachmentError('附件为空');
    if (buffer.length > this.maxFileBytes) throw new AgentAttachmentError(`附件不能超过 ${this.maxFileBytes / 1024 / 1024} MB`, 413, 'ATTACHMENT_TOO_LARGE');

    let markdown: string | null = null;
    if (format.convert === 'image') {
      if (!looksLikeImage(buffer, extension)) throw new AgentAttachmentError('图片内容与文件扩展名不匹配');
    } else if (format.convert === 'text') {
      markdown = ensureText(buffer);
    } else {
      try {
        markdown = (await toMarkdownBytes(buffer, formatFromExtension(extension))).trim();
      } catch (error) {
        const errorCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
        const scanned = extension === 'pdf' && errorCode === 'unsupported';
        throw new AgentAttachmentError(
          scanned ? '该 PDF 可能是扫描件或纯图片，当前无法提取文字，请先进行 OCR'
            : `无法解析附件${errorCode ? `（${errorCode}）` : ''}`,
          422, 'ATTACHMENT_CONVERSION_FAILED',
        );
      }
      if (!markdown) throw new AgentAttachmentError(
        extension === 'pdf' ? '该 PDF 可能是扫描件或纯图片，当前无法提取文字，请先进行 OCR' : '附件没有可提取的内容',
        422, 'ATTACHMENT_CONVERSION_FAILED',
      );
    }

    const id = crypto.randomUUID();
    const directory = this.directory(id);
    const storedPath = join(directory, `original.${extension === 'markdown' ? 'md' : extension}`);
    const extractedPath = markdown == null ? null : join(directory, 'content.md');
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(storedPath, buffer, { flag: 'wx' });
      if (extractedPath) await writeFile(extractedPath, markdown!, { encoding: 'utf8', flag: 'wx' });
      const createdAt = new Date().toISOString();
      const record: AgentAttachmentRecord = {
        id, runId: null, originalName: name, mediaType: format.mediaType, fileKind: format.kind,
        extension, fileSize: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
        storedPath, extractedPath, extractedChars: markdown?.length ?? 0, createdAt,
      };
      await this.pool.execute(
        `INSERT INTO agent_attachments
         (id, run_id, original_name, media_type, file_kind, extension, file_size, sha256,
          stored_path, extracted_path, extracted_chars, created_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, record.originalName, record.mediaType, record.fileKind, record.extension,
          record.fileSize, record.sha256, record.storedPath, record.extractedPath,
          record.extractedChars, record.createdAt],
      );
      return publicAttachment(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async bindToRun(ids: string[], runId: string): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new AgentAttachmentError('附件列表包含重复项');
    if (unique.length > this.maxFiles) throw new AgentAttachmentError(`每轮最多上传 ${this.maxFiles} 个附件`);
    if (!unique.length) return;
    const placeholders = unique.map(() => '?').join(', ');
    const [rows] = await this.pool.execute(
      `SELECT id, run_id FROM agent_attachments WHERE id IN (${placeholders})`, unique,
    );
    const records = rows as Array<{ id: string; run_id: string | null }>;
    if (records.length !== unique.length || records.some(item => item.run_id != null)) {
      throw new AgentAttachmentError('附件不存在或已被其他任务使用');
    }
    const [result] = await this.pool.execute(
      `UPDATE agent_attachments SET run_id = ? WHERE run_id IS NULL AND id IN (${placeholders})`,
      [runId, ...unique],
    );
    if ((result as ResultSetHeader).affectedRows !== unique.length) {
      throw new AgentAttachmentError('附件绑定失败，请重新上传');
    }
  }

  async listForRun(runId: string): Promise<PublicAgentAttachment[]> {
    return (await this.recordsForRun(runId)).map(publicAttachment);
  }

  async providerAttachments(runId: string): Promise<ProviderAttachment[]> {
    const records = await this.recordsForRun(runId);
    let remaining = this.maxContextChars;
    const result: ProviderAttachment[] = [];
    for (const record of records) {
      let extractedText: string | undefined;
      let truncated = false;
      if (record.extractedPath && remaining > 0) {
        const full = await readFile(record.extractedPath, 'utf8');
        extractedText = full.slice(0, remaining);
        truncated = extractedText.length < full.length;
        remaining -= extractedText.length;
      } else if (record.extractedPath) truncated = true;
      result.push({
        ...publicAttachment(record), absolutePath: record.storedPath,
        workspacePath: relative(this.workspaceRoot, record.storedPath).replace(/\\/g, '/'),
        ...(extractedText != null ? { extractedText } : {}), ...(truncated ? { truncated: true } : {}),
      });
    }
    return result;
  }

  async deleteUnbound(id: string): Promise<boolean> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_attachments WHERE id = ?', [id]);
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) return false;
    const record = camelRow(row);
    if (record.runId) throw new AgentAttachmentError('已提交的附件不能单独删除', 409, 'ATTACHMENT_BOUND');
    await rm(this.directory(record.id), { recursive: true, force: true });
    await this.pool.execute('DELETE FROM agent_attachments WHERE id = ? AND run_id IS NULL', [id]);
    return true;
  }

  async cleanupStaleUnbound(now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    if (now - this.lastCleanupAt < 60 * 60 * 1000) return 0;
    this.lastCleanupAt = now;
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_attachments WHERE run_id IS NULL AND created_at < ?', [cutoff],
    );
    const records = (rows as Record<string, unknown>[]).map(camelRow);
    for (const record of records) {
      await rm(this.directory(record.id), { recursive: true, force: true }).catch(() => undefined);
    }
    if (records.length) {
      await this.pool.execute('DELETE FROM agent_attachments WHERE run_id IS NULL AND created_at < ?', [cutoff]);
    }
    return records.length;
  }

  async removeRunFiles(runId: string): Promise<void> {
    for (const record of await this.recordsForRun(runId)) {
      await rm(this.directory(record.id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async recordsForRun(runId: string): Promise<AgentAttachmentRecord[]> {
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_attachments WHERE run_id = ? ORDER BY created_at ASC', [runId],
    );
    return (rows as Record<string, unknown>[]).map(camelRow);
  }
}
