import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface PartnerReferralResponse {
  links: Array<{
    href: string;
    rel: string;
    method: string;
  }>;
}

interface MerchantStatusResponse {
  merchant_id: string;
  tracking_id?: string;
  legal_name?: string;
  primary_email?: string;
  primary_email_confirmed: boolean;
  payments_receivable: boolean;
  oauth_third_party: Array<{
    partner_client_id: string;
    merchant_customer_id?: string;
    scopes: string[];
  }>;
  products: Array<{
    name: string;
    vetting_status: string;
  }>;
}

@Injectable()
export class PayPalPartnerService {
  private readonly logger = new Logger(PayPalPartnerService.name);
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly partnerAttributionId: string;

  constructor(private configService: ConfigService) {
    const mode = this.configService.get('PAYPAL_MODE', 'sandbox');
    this.baseUrl = mode === 'production'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

    this.clientId = this.configService.get('PAYPAL_CLIENT_ID');
    this.clientSecret = this.configService.get('PAYPAL_CLIENT_SECRET');
    this.partnerAttributionId = this.configService.get('PAYPAL_PARTNER_ATTRIBUTION_ID', 'PARTNER_ATTRIBUTION_ID');

    if (!this.clientId || !this.clientSecret) {
      throw new Error('PayPal credentials not configured');
    }

    this.logger.log(`PayPal Partner Service configured in ${mode} mode`);
  }

  /**
   * Get OAuth access token for Partner API calls
   */
  private async getAccessToken(): Promise<string> {
    try {
      const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(
        `${this.baseUrl}/v1/oauth2/token`,
        'grant_type=client_credentials',
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      return response.data.access_token;
    } catch (error) {
      this.logger.error('Error getting PayPal access token', error);
      throw new BadRequestException('Failed to authenticate with PayPal');
    }
  }

  /**
   * Generate a Partner Referral link for photographer onboarding
   * @param trackingId - Unique ID to track this photographer (e.g., user.id)
   * @param returnUrl - URL to redirect after successful onboarding
   * @returns Signup URL for the photographer
   */
  async generateReferralLink(trackingId: string, returnUrl: string): Promise<string> {
    try {
      const accessToken = await this.getAccessToken();
      const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');

      const requestBody = {
        tracking_id: trackingId,
        operations: [
          {
            operation: 'API_INTEGRATION',
            api_integration_preference: {
              rest_api_integration: {
                integration_method: 'PAYPAL',
                integration_type: 'THIRD_PARTY',
                third_party_details: {
                  features: ['PAYMENT', 'REFUND', 'PARTNER_FEE'],
                },
              },
            },
          },
        ],
        products: ['EXPRESS_CHECKOUT'],
        legal_consents: [
          {
            type: 'SHARE_DATA_CONSENT',
            granted: true,
          },
        ],
        partner_config_override: {
          return_url: returnUrl || `${frontendUrl}/dashboard/photographer/paypal/callback`,
          return_url_description: 'Regresa a tu dashboard',
          show_add_credit_card: true,
        },
      };

      this.logger.log(`Creating Partner Referral for tracking_id: ${trackingId}`);

      const response = await axios.post<PartnerReferralResponse>(
        `${this.baseUrl}/v2/customer/partner-referrals`,
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'PayPal-Partner-Attribution-Id': this.partnerAttributionId,
          },
        }
      );

      // Extract the action_url from the response
      const actionUrl = response.data.links?.find(link => link.rel === 'action_url')?.href;

      if (!actionUrl) {
        throw new BadRequestException('No action URL found in PayPal response');
      }

      this.logger.log(`Partner Referral link generated for tracking_id: ${trackingId}`);
      return actionUrl;

    } catch (error: any) {
      this.logger.error('Error generating Partner Referral link', {
        error: error.response?.data || error.message,
        trackingId,
      });

      const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
      throw new BadRequestException(`Failed to generate PayPal referral link: ${errorMessage}`);
    }
  }

  /**
   * Get merchant status to verify onboarding completion
   * @param merchantId - The merchant_id returned from PayPal
   * @returns Merchant status information
   */
  async getMerchantStatus(merchantId: string): Promise<MerchantStatusResponse> {
    try {
      const accessToken = await this.getAccessToken();

      this.logger.log(`Fetching merchant status for: ${merchantId}`);

      const response = await axios.get<MerchantStatusResponse>(
        `${this.baseUrl}/v1/customer/partners/${this.clientId}/merchant-integrations/${merchantId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      this.logger.log(`Merchant status retrieved for: ${merchantId}`, {
        paymentsReceivable: response.data.payments_receivable,
        emailConfirmed: response.data.primary_email_confirmed,
      });

      return response.data;

    } catch (error: any) {
      this.logger.error('Error getting merchant status', {
        error: error.response?.data || error.message,
        merchantId,
      });

      const errorMessage = error.response?.data?.message || error.message || 'Unknown error';
      throw new BadRequestException(`Failed to get merchant status: ${errorMessage}`);
    }
  }

  /**
   * Verify if a merchant is ready to receive payments
   */
  async isMerchantReady(merchantId: string): Promise<boolean> {
    try {
      const status = await this.getMerchantStatus(merchantId);

      return (
        status.payments_receivable &&
        status.primary_email_confirmed &&
        status.oauth_third_party?.some(
          oauth => oauth.scopes?.includes('https://uri.paypal.com/services/payments/realtimepayment')
        )
      );
    } catch (error) {
      this.logger.error(`Error verifying merchant readiness for ${merchantId}`, error);
      return false;
    }
  }
}
