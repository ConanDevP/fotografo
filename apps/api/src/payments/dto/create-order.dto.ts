import { IsString, IsArray, ValidateNested, IsEnum, IsUUID, IsOptional, IsUrl } from 'class-validator';
import { Type } from 'class-transformer';
import { ItemType } from '@shared/types';
import { PaymentGateway } from '@shared/payment-types';

class OrderItemDto {
  @IsEnum(ItemType, { message: 'Tipo de item debe ser PHOTO o PACKAGE' })
  type: ItemType;

  @IsOptional()
  @IsUUID(4, { message: 'PhotoId debe ser un UUID válido' })
  photoId?: string;

  @IsOptional()
  @IsString({ message: 'Tipo de paquete debe ser texto' })
  packageType?: 'pack5' | 'pack10' | 'allPhotos';
}

export class CreateOrderDto {
  @IsString({ message: 'EventId debe ser texto' })
  @IsUUID(4, { message: 'EventId debe ser un UUID válido' })
  eventId: string;

  @IsArray({ message: 'Items debe ser un array' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @IsEnum(PaymentGateway, { message: 'Gateway de pago inválido' })
  gateway?: PaymentGateway = PaymentGateway.DEMO;

  @IsOptional()
  @IsString({ message: 'Moneda debe ser texto' })
  currency?: string;

  @IsOptional()
  @IsUrl({}, { message: 'URL de retorno inválida' })
  returnUrl?: string;

  @IsOptional()
  @IsUrl({}, { message: 'URL de cancelación inválida' })
  cancelUrl?: string;
}