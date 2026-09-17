import type { LoginMethod } from '@gmind/shared';
import type { LoginIdentity } from '../../users/users.service';

export interface LoginProvider {
  readonly method: LoginMethod;
  authenticate(payload: unknown): Promise<LoginIdentity>;
}
