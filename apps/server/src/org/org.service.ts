import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { OrgDepartment, OrgDirectory, OrgGroup } from '@gmind/shared';
import { OrgDepartmentEntity, OrgGroupEntity, OrgUserGroupEntity } from './org.entity';

/**
 * 组织管理（部门/分组）服务（第二期批次 A）：
 * - 部门/分组 CRUD：名字唯一（撞名 409）；删除前置=无账号挂靠（409 两段式）；
 * - directory：目录全量（登录可读——待办筛选数据源）+成员挂靠关系；
 * - setUserOrg：账号挂靠（部门单选 + 分组全量替换），AdminService PATCH 经此落库。
 * users 表的部门列走 DataSource 原生 SQL（避免与 UsersModule 循环依赖；
 * 直写不触发 @UpdateDateColumn——挂靠不是账号资料变更，不翻账号 updated_at）。
 */

@Injectable()
export class OrgService {
  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(OrgDepartmentEntity) private readonly departments: Repository<OrgDepartmentEntity>,
    @InjectRepository(OrgGroupEntity) private readonly groups: Repository<OrgGroupEntity>,
    @InjectRepository(OrgUserGroupEntity) private readonly userGroups: Repository<OrgUserGroupEntity>,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  async listDepartments(): Promise<OrgDepartment[]> {
    const rows = await this.departments.find({ order: { createdAt: 'ASC' } });
    return rows.map((d) => ({ id: d.id, name: d.name }));
  }

  async createDepartment(name: string): Promise<OrgDepartment> {
    const dup = await this.departments.findOneBy({ name });
    if (dup) throw new ConflictException('同名部门已存在，请换个名称');
    const saved = await this.departments.save(this.departments.create({ name }));
    return { id: saved.id, name: saved.name };
  }

  /** 删除部门：仍有账号挂靠 → 409（两段式）。 */
  async deleteDepartment(id: string): Promise<void> {
    const dept = await this.departments.findOneBy({ id });
    if (!dept) throw new NotFoundException('部门不存在，请刷新后重试');
    const attached = await this.usersRepoCountInDepartment(id);
    if (attached > 0) throw new ConflictException('部门下还有账号，请先转移账号后再删除');
    await this.departments.delete(id);
  }

  async listGroups(): Promise<OrgGroup[]> {
    const rows = await this.groups.find({ order: { createdAt: 'ASC' } });
    return rows.map((g) => ({ id: g.id, name: g.name, color: g.color }));
  }

  async createGroup(name: string, color: string | null): Promise<OrgGroup> {
    const dup = await this.groups.findOneBy({ name });
    if (dup) throw new ConflictException('同名分组已存在，请换个名称');
    const saved = await this.groups.save(this.groups.create({ name, color }));
    return { id: saved.id, name: saved.name, color: saved.color };
  }

  async deleteGroup(id: string): Promise<void> {
    const group = await this.groups.findOneBy({ id });
    if (!group) throw new NotFoundException('分组不存在，请刷新后重试');
    const attached = await this.userGroups.countBy({ groupId: id });
    if (attached > 0) throw new ConflictException('分组下还有账号，请先移出账号后再删除');
    await this.groups.delete(id);
  }

  /** 目录全量（登录可读）：部门/分组 + 有挂靠账号的 membership。 */
  async directory(): Promise<OrgDirectory> {
    const [departments, groups, memberships] = await Promise.all([
      this.listDepartments(),
      this.listGroups(),
      this.listMemberships(),
    ]);
    return { departments, groups, memberships };
  }

  /** 有任一挂靠的账号（部门或分组任一），带昵称（待办人员视角/部门筛选显示名）。 */
  async listMemberships(): Promise<OrgDirectory['memberships']> {
    const usersWithDept = (await this.dataSource.query(
      'SELECT u.id, u.department_id AS departmentId, u.nickname FROM users u WHERE u.department_id IS NOT NULL',
    )) as Array<{ id: string; departmentId: string | null; nickname: string | null }>;
    const rows = await this.userGroups.find();
    const byUser = new Map<string, { userId: string; departmentId: string | null; groupIds: string[]; nickname: string | null }>();
    const ensure = (userId: string, departmentId: string | null = null, nickname: string | null = null) => {
      const entry = byUser.get(userId) ?? { userId, departmentId, groupIds: [], nickname };
      if (entry.nickname === null && nickname !== null) entry.nickname = nickname;
      byUser.set(userId, entry);
      return entry;
    };
    for (const u of usersWithDept) ensure(u.id, u.departmentId, u.nickname);
    for (const r of rows) ensure(r.userId).groupIds.push(r.groupId);
    return [...byUser.values()];
  }

  /** 指定账号集的组织挂靠（部门/分组）——列表/单账号回显用。 */
  async membershipsFor(userIds: string[]): Promise<Map<string, { departmentId: string | null; groupIds: string[] }>> {
    if (userIds.length === 0) return new Map();
    const deptRows = (await this.dataSource.query(
      'SELECT id, department_id AS departmentId FROM users WHERE id IN (?)',
      [userIds],
    )) as Array<{ id: string; departmentId: string | null }>;
    const groupRows = await this.userGroups.find({ where: { userId: In(userIds) } });
    const map = new Map<string, { departmentId: string | null; groupIds: string[] }>();
    for (const u of deptRows) map.set(u.id, { departmentId: u.departmentId, groupIds: [] });
    for (const r of groupRows) {
      const entry = map.get(r.userId) ?? { departmentId: null, groupIds: [] };
      entry.groupIds.push(r.groupId);
      map.set(r.userId, entry);
    }
    return map;
  }

  /** 账号挂靠（AdminService PATCH 经此）：部门单选 + 分组全量替换；全部校验先于写。 */
  async setUserOrg(userId: string, input: { departmentId?: string | null; groupIds?: string[] }): Promise<void> {
    if (input.departmentId !== undefined && input.departmentId !== null) {
      const dept = await this.departments.findOneBy({ id: input.departmentId });
      if (!dept) throw new NotFoundException('部门不存在，请刷新后重试');
    }
    if (input.groupIds !== undefined && input.groupIds.length > 0) {
      const found = await this.groups.findBy({ id: In(input.groupIds) });
      if (found.length !== new Set(input.groupIds).size) {
        throw new NotFoundException('分组不存在，请刷新后重试');
      }
    }
    if (input.departmentId !== undefined) {
      await this.usersUpdateDepartment(userId, input.departmentId);
    }
    if (input.groupIds !== undefined) {
      await this.userGroups.delete({ userId });
      const uniq = [...new Set(input.groupIds)];
      if (uniq.length > 0) {
        await this.userGroups.insert(uniq.map((groupId) => ({ userId, groupId }) as OrgUserGroupEntity));
      }
    }
  }

  /** 账号删除前的组织挂靠清理（AdminService 停用不删号，当前无调用方；预留防漏）。 */
  async clearUserOrg(userId: string): Promise<void> {
    await this.userGroups.delete({ userId });
  }

  // —— users 表部门列访问（DataSource 原生 SQL，见类注）——
  private async usersRepoCountInDepartment(departmentId: string): Promise<number> {
    const rows = (await this.dataSource.query(
      'SELECT COUNT(*) AS n FROM users WHERE department_id = ?',
      [departmentId],
    )) as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  }

  private usersUpdateDepartment(userId: string, departmentId: string | null): Promise<unknown> {
    return this.dataSource.query('UPDATE users SET department_id = ? WHERE id = ?', [departmentId, userId]);
  }
}
