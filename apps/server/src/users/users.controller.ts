import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';

@Controller('api/users')
@UseGuards(UserGuard)
export class UsersController {
  @Get('me')
  me(@Req() req: { user: { id: string }; fullUser?: unknown }): unknown {
    return req.fullUser;
  }
}
