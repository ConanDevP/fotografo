import { 
  PaymentRequest, 
  PaymentResponse, 
  PaymentConfirmation, 
  RefundResponse 
} from '@shared/payment-types';

export interface IPaymentGateway {
  /**
   * Crear un pago en la pasarela
   */
  createPayment(request: PaymentRequest): Promise<PaymentResponse>;

  /**
   * Confirmar un pago (después del webhook)
   */
  confirmPayment(paymentId: string, details?: any): Promise<PaymentConfirmation>;

  /**
   * Cancelar un pago
   */
  cancelPayment(paymentId: string): Promise<void>;

  /**
   * Procesar reembolso
   */
  refundPayment(paymentId: string, amount?: number): Promise<RefundResponse>;

  /**
   * Verificar webhook signature (para seguridad)
   */
  verifyWebhook(payload: any, signature: string): boolean;
}