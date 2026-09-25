import { describe, expect, it, vi } from 'vitest';
import { type Repository, type UpdateResult } from 'typeorm';
import { Document } from '@hocuspocus/server';
import type { onStoreDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import { createTemplateDoc, docToState, markLastEditor } from '@gmind/core';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { SessionService } from '../session/session.service';
import { VersionEntity } from '../versions/version.entity';
import { CollabService } from './collab.service';

/** onStoreDocument 契约（fix round 1）：持久化失败必须上抛——v4 依赖 hook 抛错把文档
 *  保留在内存并在下次防抖重试；若吞错，unloadImmediately 会在落库失败后照常卸载，
 *  最后一次断开前的编辑永久丢失。persisted ack 只允许在成功写入之后广播。
 *  M4 Task 6 追加：storeDocument 内嵌的 auto 快照失败不耦合 persist（吞错仅 log）——
 *  persist 已成功，快照另有卸载兜底与下个窗口。 */

const FILE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const makeService = (
  files: Pick<Repository<FileEntity>, 'update'>,
  versions: Partial<Repository<VersionEntity>> = {},
): CollabService =>
  new CollabService(
    {} as SessionService,
    files as Repository<FileEntity>,
    {} as Repository<FileCollaboratorEntity>,
    versions as Repository<VersionEntity>,
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

describe('CollabService.storeDocument（last_modifier 回写，M3a Task 4）', () => {
  const makeUpdate = (): ReturnType<typeof vi.fn> =>
    vi.fn(async () => ({ generatedMaps: [], raw: 0 }) as UpdateResult);

  it('doc meta.lastEditorUserId → 随持久化回写 last_modifier_user_id', async () => {
    const update = makeUpdate();
    const service = makeService({ update });
    const { payload } = makePayload();
    markLastEditor(payload.document as Y.Doc, 'USER_B');

    await callStore(service, payload);

    const patch = update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.lastModifierUserId).toBe('USER_B');
  });

  it('doc 无 lastEditorUserId → patch 不含该字段（保留 DB 既有值）', async () => {
    const update = makeUpdate();
    const service = makeService({ update });
    const { payload } = makePayload(); // 未 markLastEditor

    await callStore(service, payload);

    const patch = update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('lastModifierUserId');
  });
});

describe('CollabService.storeDocument（auto 快照失败不耦合 persist，M4 Task 6）', () => {
  /** 预置快照状态机入口条件：脏标记 + 文档在内存（storeDocument 内 snapshotIfDue 的放行条件）。 */
  const armSnapshot = (service: CollabService, doc: Y.Doc): void => {
    const inner = service as unknown as {
      snapMeta: Map<string, { lastAutoAt: number; dirty: boolean }>;
      hocuspocus: { documents: Map<string, Document> };
    };
    inner.snapMeta.set(FILE_ID, { lastAutoAt: Date.now() - 10 * 60 * 1000, dirty: true });
    inner.hocuspocus.documents.set(FILE_ID, doc as Document);
  };

  it('versions.save 抛错 → store 仍成功返回且 ack 照常广播（仅 log）', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const update = vi.fn(async () => ({ generatedMaps: [], raw: 0 }) as UpdateResult);
    const save = vi.fn(async () => {
      throw new Error('snapshot db down');
    });
    const service = makeService(
      { update },
      { create: (() => ({})) as unknown as Repository<VersionEntity>['create'], save: save as unknown as Repository<VersionEntity>['save'] },
    );
    const { payload, doc, ackSpy } = makePayload();
    armSnapshot(service, doc);

    await expect(callStore(service, payload)).resolves.toBeUndefined(); // persist 不被快照失败拖垮
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledTimes(1); // ack 照常广播
    expect(consoleErr).toHaveBeenCalled(); // 失败仅 log
    consoleErr.mockRestore();
  });

  it('窗口内（lastAutoAt 距今 < 3min）→ 不写版本行，ack 时序不变', async () => {
    const update = vi.fn(async () => ({ generatedMaps: [], raw: 0 }) as UpdateResult);
    const save = vi.fn();
    const service = makeService({ update }, { save: save as unknown as Repository<VersionEntity>['save'] });
    const { payload, doc, ackSpy } = makePayload();
    const inner = service as unknown as { snapMeta: Map<string, { lastAutoAt: number; dirty: boolean }> };
    inner.snapMeta.set(FILE_ID, { lastAutoAt: Date.now(), dirty: true }); // 未越 3 分钟窗口
    const hocus = (service as unknown as { hocuspocus: { documents: Map<string, Document> } }).hocuspocus;
    hocus.documents.set(FILE_ID, doc);

    await callStore(service, payload);

    expect(save).not.toHaveBeenCalled();
    expect(ackSpy).toHaveBeenCalledTimes(1);
  });
});

