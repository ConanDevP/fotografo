import { IsString, Matches, MaxLength } from 'class-validator';

export class SavePaymentMethodDto {
  /** Identificador que devuelve Stripe en el navegador tras guardar la tarjeta. */
  @IsString()
  @MaxLength(120)
  @Matches(/^pm_[A-Za-z0-9_]+$/, { message: 'El método de pago no es válido' })
  paymentMethodId: string;
}
