import { Body, Controller, Delete, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { OrgDepartment, OrgDirectory, OrgGroup } from '@gmind/shared';
import { AdminGuard } from '../auth/admin.guard';
import { UserGuard } from '../auth/user.guard';
import { OrgService } from './org.service';
import { createDepartmentSchema, createGroupSchema } from './org-request.schema';

/**
 * 组织管理端点（/api/org，第二期批次 A）：
 * - 类级 UserGuard：全部端点须登录（directory 是待办筛选数据源）；
 * - 写（建/删）叠加 AdminGuard（super_admin，同账号管理口；依赖 UserGuard 先行装配 req.user）。
 * 错误文案两段式（NFR-USE-005）。
 */
@Controller('api/org')
@UseGuards(UserGuard)
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @Get('departments')
  listDepartments(): Promise<OrgDepartment[]> {
    return this.org.listDepartments();
  }

  @Post('departments')
  @UseGuards(AdminGuard)
  createDepartment(@Body() body: unknown): Promise<OrgDepartment> {
    return this.org.createDepartment(createDepartmentSchema.parse(body).name);
  }

  @Delete('departments/:id')
  @UseGuards(AdminGuard)
  async deleteDepartment(@Param('id') id: string): Promise<{ ok: true }> {
    await this.org.deleteDepartment(id);
    return { ok: true };
  }

  @Get('groups')
  listGroups(): Promise<OrgGroup[]> {
    return this.org.listGroups();
  }

  @Post('groups')
  @UseGuards(AdminGuard)
  createGroup(@Body() body: unknown): Promise<OrgGroup> {
    const input = createGroupSchema.parse(body);
    return this.org.createGroup(input.name, input.color ?? null);
  }

  @Delete('groups/:id')
  @UseGuards(AdminGuard)
  async deleteGroup(@Param('id') id: string): Promise<{ ok: true }> {
    await this.org.deleteGroup(id);
    return { ok: true };
  }

  @Get('directory')
  directory(): Promise<OrgDirectory> {
    return this.org.directory();
  }
}
