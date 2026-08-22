import { IsEnum, IsOptional } from 'class-validator';
import { MembershipStatus, WorkspaceRole } from '@prisma/client';

export class UpdateWorkspaceMemberDto {
  @IsOptional()
  @IsEnum(WorkspaceRole)
  role?: WorkspaceRole;

  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;
}
