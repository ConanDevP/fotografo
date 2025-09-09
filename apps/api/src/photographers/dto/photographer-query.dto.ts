export class PhotographerQueryDto {
  location?: string;
  specialties?: string | string[];
  featured?: string | boolean;
  verified?: string | boolean;
  search?: string;
  orderBy?: string;
  orderDirection?: string;
}