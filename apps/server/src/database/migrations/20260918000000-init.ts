import { MigrationInterface, QueryRunner } from 'typeorm';

const T = (name: string, cols: string, keys = ''): string =>
  `CREATE TABLE ${name} (${cols}${keys ? ', ' + keys : ''}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export class Init20260918000000 implements MigrationInterface {
  name = 'Init20260918000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(T(
      'users',
      `id char(26) NOT NULL,
       phone varchar(20) NULL,
       email varchar(191) NULL,
       wechat_openid varchar(64) NULL,
       password_hash varchar(100) NULL,
       nickname varchar(64) NOT NULL,
       avatar_url varchar(500) NULL,
       notify_prefs text NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_users_phone (phone), UNIQUE KEY uk_users_email (email), UNIQUE KEY uk_users_wechat (wechat_openid)',
    ));

    await queryRunner.query(T(
      'folders',
      `id char(26) NOT NULL,
       owner_user_id char(26) NOT NULL,
       space_id char(26) NULL,
       parent_id char(26) NULL,
       name varchar(64) NOT NULL,
       depth tinyint NOT NULL DEFAULT 1,
       deleted_at datetime(3) NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_folders_owner (owner_user_id), KEY idx_folders_parent (parent_id)',
    ));

    await queryRunner.query(T(
      'files',
      `id char(26) NOT NULL,
       owner_user_id char(26) NOT NULL,
       space_id char(26) NULL,
       folder_id char(26) NULL,
       title varchar(255) NOT NULL,
       structure varchar(16) NOT NULL DEFAULT 'mindmap',
       theme_id varchar(32) NOT NULL DEFAULT 'gmind-light',
       node_count int NOT NULL DEFAULT 1,
       doc_state longblob NULL,
       last_opened_at datetime(3) NULL,
       deleted_at datetime(3) NULL,
       deleted_by char(26) NULL,
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_files_owner (owner_user_id), KEY idx_files_folder (folder_id), KEY idx_files_deleted (deleted_at)',
    ));

    await queryRunner.query(T(
      'file_collaborators',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       role enum('owner','editor','commenter','viewer') NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_fc_file_user (file_id, user_id), KEY idx_fc_user (user_id)',
    ));

    await queryRunner.query(T(
      'file_stars',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_star_file_user (file_id, user_id), KEY idx_star_user (user_id)',
    ));

    await queryRunner.query(T(
      'share_links',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       token varchar(32) NOT NULL,
       status enum('active','closed') NOT NULL DEFAULT 'active',
       created_by char(26) NOT NULL,
       password varchar(64) NULL,
       expires_at datetime(3) NULL,
       closed_at datetime(3) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_share_token (token), KEY idx_share_file (file_id)',
    ));

    await queryRunner.query(T(
      'invites',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       contact_type enum('email','phone') NOT NULL,
       contact varchar(191) NOT NULL,
       invited_by char(26) NOT NULL,
       status enum('pending','accepted','revoked') NOT NULL DEFAULT 'pending',
       accepted_user_id char(26) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), UNIQUE KEY uk_invite (file_id, contact_type, contact), KEY idx_invite_contact (contact)',
    ));

    await queryRunner.query(T(
      'comments',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       node_id char(26) NOT NULL,
       node_text_snapshot varchar(500) NOT NULL DEFAULT '',
       parent_id char(26) NULL,
       author_id char(26) NOT NULL,
       content text NOT NULL,
       mentions text NULL,
       status enum('open','resolved') NOT NULL DEFAULT 'open',
       created_at datetime(3) NOT NULL,
       updated_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_comments_file (file_id), KEY idx_comments_node (node_id), KEY idx_comments_parent (parent_id)',
    ));

    await queryRunner.query(T(
      'notifications',
      `id char(26) NOT NULL,
       user_id char(26) NOT NULL,
       type enum('mention','reply','permission','system') NOT NULL,
       payload text NULL,
       read_at datetime(3) NULL,
       emailed_at datetime(3) NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_notif_user_read (user_id, read_at)',
    ));

    await queryRunner.query(T(
      'events',
      `id char(26) NOT NULL,
       type varchar(64) NOT NULL,
       file_id char(26) NULL,
       user_id char(26) NULL,
       payload text NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_events_type_time (type, created_at), KEY idx_events_file (file_id)',
    ));

    await queryRunner.query(T(
      'versions',
      `id char(26) NOT NULL,
       file_id char(26) NOT NULL,
       node_count int NOT NULL,
       created_by char(26) NULL,
       type enum('auto','manual','pre_restore') NOT NULL DEFAULT 'auto',
       state longblob NOT NULL,
       created_at datetime(3) NOT NULL`,
      'PRIMARY KEY (id), KEY idx_versions_file_time (file_id, created_at)',
    ));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const t of ['versions', 'events', 'notifications', 'comments', 'invites', 'share_links', 'file_stars', 'file_collaborators', 'files', 'folders', 'users']) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
