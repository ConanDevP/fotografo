// Payment Gateway Types
export enum PaymentGateway {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  MERCADOPAGO = 'mercadopago',
  DEMO = 'demo',
}

export enum PaymentStatus {
  CREATED = 'created',
  PENDING = 'pending', 
  APPROVED = 'approved',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUNDED = 'refunded',
}

export interface PaymentRequest {
  orderId: string;
  eventId: string;
  totalAmount: number;
  currency: string;
  items: PaymentItem[];
  returnUrl: string;
  cancelUrl: string;
  description?: string;
}

export interface PaymentItem {
  name: string;
  quantity: number;
  unitAmount: number;
  description?: string;
  photoId?: string;
}

export interface PaymentResponse {
  paymentId: string;
  orderId: string;
  status: PaymentStatus;
  gateway: PaymentGateway;
  redirectUrl?: string;
  totalAmount: number;
  currency: string;
  metadata?: any;
}

export interface PaymentConfirmation {
  paymentId: string;
  orderId: string;
  status: PaymentStatus;
  transactionId?: string;
  paidAmount?: number;
  paidCurrency?: string;
  gatewayResponse?: any;
}

export interface RefundResponse {
  refundId: string;
  paymentId: string;
  status: 'success' | 'failed' | 'pending';
  amount: number;
  currency: string;
}

// PayPal specific types
export interface PayPalOrderResponse {
  id: string;
  status: string;
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type: string;
  resource: any;
  create_time: string;
}