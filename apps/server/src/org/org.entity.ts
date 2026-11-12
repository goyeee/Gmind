import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/** 部门（账号单选挂靠；组织管理批次 A）。 */
@Entity('org_departments')
export class OrgDepartmentEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'varchar', length: 64, unique: true })
  name: string = '';

  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}

/** 分组（账号多选挂靠；color 为标签底色可空）。 */
@Entity('org_groups')
export class OrgGroupEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'varchar', length: 64, unique: true })
  name: string = '';

  @Column({ type: 'varchar', length: 16, nullable: true })
  color: string | null = null;

  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}

/** 账号↔分组多对多。 */
@Entity('org_user_groups')
export class OrgUserGroupEntity {
  @PrimaryColumn({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  @PrimaryColumn({ type: 'char', length: 26, name: 'group_id' })
  groupId: string = '';
}
