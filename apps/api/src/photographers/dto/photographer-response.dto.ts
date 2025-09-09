export interface PhotographerProfileResponse {
  id: string;
  slug: string;
  name: string;
  email: string;
  profileImageUrl?: string;
  bio?: string;
  website?: string;
  instagram?: string;
  facebook?: string;
  specialties: string[];
  experienceYears?: number;
  location?: string;
  portfolioUrl?: string;
  isVerified: boolean;
  createdAt: string;
  stats: {
    totalEvents: number;
    totalPhotos: number;
  };
}

export interface PhotographerListResponse {
  slug: string;
  name: string;
  profileImageUrl?: string;
  bio?: string;
  location?: string;
  specialties: string[];
  experienceYears?: number;
  isVerified: boolean;
  eventCount: number;
}

export interface PhotographerStatsResponse {
  totalEvents: number;
  totalPhotos: number;
  totalProcessedPhotos: number;
  totalRevenue: number;
  averagePhotosPerEvent: number;
  recentEvents: Array<{
    id: string;
    name: string;
    date: string;
    photoCount: number;
  }>;
}