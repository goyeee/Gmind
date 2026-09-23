import { describe, expect, it, vi } from 'vitest';
import { type Repository, type UpdateResult } from 'typeorm';
import { Document } from '@hocuspocus/server';
import type { onStoreDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import { createTemplateDoc, docToState } from '@gmind/core';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { SessionService } from '../session/session.service';
import { CollabService } from './collab.service';

/** onStoreDocument 契约（fix round 1）：持久化失败必须上抛——v4 依赖 hook 抛错把文档
 *  保留在内存并在下次防抖重试；若吞错，unloadImmediately 会在落库失败后照常卸载，
 *  最后一次断开前的编辑永久丢失。persisted ack 只允许在成功写入之后广播。 */

const FILE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const makeService = (files: Pick<Repository<FileEntity>, 'update'>): CollabService =>
  new CollabService(
    {} as SessionService,
    files as Repository<FileEntity>,
    {} as Repository<FileCollaboratorEntity>,
  );

const makePayload = () => {
  const doc = new Document(FILE_ID);
  // 经 core 构建非空文档（写路径纪律：装载走 core 序列化）
  Y.applyUpdate(doc, docToState(createTemplateDoc({ title: '协同', children: [{ text: 'a' }] })));
  const ackSpy = vi.spyOn(doc, 'broadcastStateless').mockImplementation(() => undefined as never);
  return { payload: { documentName: FILE_ID, document: doc } as unknown as onStoreDocumentPayload, doc, ackSpy };
};

const callStore = (service: CollabService, payload: onStoreDocumentPayload): Promise<void> =>
  (service as unknown as { storeDocument: (p: onStoreDocumentPayload) => Promise<void> }).storeDocument(payload);

describe('CollabService.storeDocument（持久化失败上抛 + ack 时序）', () => {
  it('repo.update 抛错 → hook 拒绝上抛（不吞错），且不广播 persisted ack', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const update = vi.fn().mockRejectedValue(new Error('db down'));
    const service = makeService({ update });
    const { payload, ackSpy } = makePayload();

    await expect(callStore(service, payload)).rejects.toThrow('db down');
    expect(update).toHaveBeenCalledTimes(1);
    expect(ackSpy).not.toHaveBeenCalled(); // 失败路径不得广播成功 ack
    consoleErr.mockRestore();
  });

  it('成功路径：update 带存活条件（id + deletedAt IsNull）且 persisted ack 在写入之后', async () => {
    const update = vi.fn<(criteria: Record<string, unknown>, patch: unknown) => Promise<UpdateResult>>(
      async () => ({ generatedMaps: [], raw: 0 }) as UpdateResult,
    );
    const service = makeService({ update });
    const { payload, ackSpy } = makePayload();

    await callStore(service, payload);

    expect(update).toHaveBeenCalledTimes(1);
    const criteria = update.mock.calls[0]?.[0] ?? {};
    expect(criteria.id).toBe(FILE_ID);
    expect(criteria.deletedAt).toBeDefined(); // IsNull() FindOperator：不回写已删行

    expect(ackSpy).toHaveBeenCalledTimes(1);
    const ack = JSON.parse(ackSpy.mock.calls[0]?.[0] as string) as { type: string; at: string };
    expect(ack.type).toBe('persisted');
    expect(Number.isNaN(Date.parse(ack.at))).toBe(false);
    // 时序：update 先于 ack
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(ackSpy.mock.invocationCallOrder[0]);
  });
});
