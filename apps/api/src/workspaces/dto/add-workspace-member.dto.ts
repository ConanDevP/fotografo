import { IsEmail, IsEnum } from 'class-validator';
import { WorkspaceRole } from '@shared/types';

export class AddWorkspaceMemberDto {
  @IsEmail()
  email: string;

  @IsEnum(WorkspaceRole)
  role: WorkspaceRole;
}

