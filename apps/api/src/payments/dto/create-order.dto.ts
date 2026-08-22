import { IsBoolean, ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUrl, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(4, { each: true })
  photoIds?: string[];
}

export class CreateOrderDto {
  @IsString({ message: 'EventId debe ser texto' })
  @IsUUID(4, { message: 'EventId debe ser un UUID válido' })
  eventId: string;

  @IsArray({ message: 'Items debe ser un array' })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @IsEnum(PaymentGateway, { message: 'Gateway de pago inválido' })
  gateway?: PaymentGateway = PaymentGateway.STRIPE;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  guestEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;

  @IsOptional()
  @IsString({ message: 'Moneda debe ser texto' })
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsUrl({}, { message: 'URL de retorno inválida' })
  @MaxLength(2048)
  returnUrl?: string;

  @IsOptional()
  @IsUrl({}, { message: 'URL de cancelación inválida' })
  @MaxLength(2048)
  cancelUrl?: string;

  /**
   * El comprador declara haber leído que son archivos digitales sin devolución
   * tras la descarga. Es la prueba con más peso en un contracargo, así que se
   * guarda con marca de tiempo en lugar de darla por supuesta.
   */
  @IsOptional()
  @IsBoolean()
  acceptedRefundPolicy?: boolean;
}
