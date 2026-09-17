import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { LoginMethod } from '@gmind/shared';
import { UserEntity } from './user.entity';

export interface LoginIdentity {
  method: LoginMethod;
  phone?: string;
  email?: string;
  wechatOpenid?: string;
  nickname?: string;
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>) {}

  findById(id: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ id });
  }

  findByIdentity(identity: LoginIdentity): Promise<UserEntity | null> {
    if (identity.method === 'phone') return this.repo.findOneBy({ phone: identity.phone });
    if (identity.method === 'email') return this.repo.findOneBy({ email: identity.email });
    return this.repo.findOneBy({ wechatOpenid: identity.wechatOpenid });
  }

  save(user: UserEntity): Promise<UserEntity> {
    return this.repo.save(user);
  }

  async create(identity: LoginIdentity): Promise<UserEntity> {
    const user = this.repo.create();
    if (identity.method === 'phone') user.phone = identity.phone ?? null;
    if (identity.method === 'email') user.email = identity.email ?? null;
    if (identity.method === 'wechat') user.wechatOpenid = identity.wechatOpenid ?? null;
    user.nickname = identity.nickname ?? this.defaultNickname(identity);
    return this.repo.save(user);
  }

  private defaultNickname(identity: LoginIdentity): string {
    if (identity.nickname) return identity.nickname;
    if (identity.phone) return `用户${identity.phone.slice(-4)}`;
    if (identity.email) return identity.email.split('@')[0] ?? '用户';
    return '微信用户';
  }
}
