import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

interface CreateUserData {
  email: string;
  passwordHash?: string;
  name?: string;
  phone?: string;
  profileImageUrl?: string;
  address?: string;
  role: UserRole;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async create(userData: CreateUserData) {
    return this.prisma.user.create({
      data: { ...userData, email: userData.email.trim().toLowerCase() },
    });
  }

  async createFirstAdmin(userData: CreateUserData) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('lucilamon-initial-admin'))`;
      const adminCount = await tx.user.count({ where: { role: UserRole.ADMIN } });
      if (adminCount > 0) {
        throw new BadRequestException('El administrador inicial ya fue creado');
      }
      const email = userData.email.trim().toLowerCase();
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new BadRequestException('El usuario ya existe');
      }
      return tx.user.create({ data: { ...userData, email, role: UserRole.ADMIN } });
    });
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
  }

  async update(id: string, data: Partial<CreateUserData>) {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.user.delete({
      where: { id },
    });
  }
}
