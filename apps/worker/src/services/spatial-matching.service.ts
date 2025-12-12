import { Injectable, Logger } from '@nestjs/common';
import { FaceBibMatch } from '@shared/types';
import { FACE_BIB_LINKING } from '@shared/constants';

interface BBox {
  bbox: [number, number, number, number]; // [x, y, width, height]
}

interface FaceData extends BBox {
  embedding: number[];
  confidence: number;
}

interface BibData extends BBox {
  bib: string;
  confidence: number;
}

@Injectable()
export class SpatialMatchingService {
  private readonly logger = new Logger(SpatialMatchingService.name);

  /**
   * Match faces with bibs using SIMPLE horizontal proximity
   * 
   * Algorithm: Find the bib closest horizontally (same X position) to each face
   * This works for running photos where people are in "lanes"
   */
  matchFacesWithBibs(
    faces: FaceData[],
    bibs: BibData[]
  ): FaceBibMatch[] {
    const matches: FaceBibMatch[] = [];
    if (faces.length === 0 || bibs.length === 0) {
      this.logger.debug('No faces or bibs to match');
      return matches;
    }

    this.logger.log(`Matching ${faces.length} face(s) with ${bibs.length} bib(s) using SIMPLE horizontal proximity`);

    // Calculate center X for each face and bib
    const faceCenters = faces.map((f, i) => ({
      index: i,
      centerX: f.bbox[0] + f.bbox[2] / 2,
      centerY: f.bbox[1] + f.bbox[3] / 2,
    }));

    const bibCenters = bibs.map((b, i) => ({
      index: i,
      bib: b.bib,
      centerX: b.bbox[0] + b.bbox[2] / 2,
      centerY: b.bbox[1] + b.bbox[3] / 2,
      confidence: b.confidence,
    }));

    // Log positions
    faceCenters.forEach(f => this.logger.log(`   👤 Face ${f.index}: X=${f.centerX.toFixed(0)}, Y=${f.centerY.toFixed(0)}`));
    bibCenters.forEach(b => this.logger.log(`   🔢 Bib "${b.bib}": X=${b.centerX.toFixed(0)}, Y=${b.centerY.toFixed(0)}`));

    // For each face, find closest bib by horizontal distance
    const usedBibs = new Set<number>();

    for (const face of faceCenters) {
      let bestBib: typeof bibCenters[0] | null = null;
      let bestDistance = Infinity;

      for (const bib of bibCenters) {
        if (usedBibs.has(bib.index)) continue;

        // Simple horizontal distance
        const horizontalDist = Math.abs(face.centerX - bib.centerX);

        this.logger.debug(`   Face ${face.index} vs Bib "${bib.bib}": H-dist=${horizontalDist.toFixed(0)}px`);

        if (horizontalDist < bestDistance) {
          bestDistance = horizontalDist;
          bestBib = bib;
        }
      }

      // Accept match if horizontal distance is reasonable (within 1000px)
      const MAX_HORIZONTAL_DISTANCE = 1000; // pixels

      if (bestBib && bestDistance <= MAX_HORIZONTAL_DISTANCE) {
        usedBibs.add(bestBib.index);
        const score = Math.max(0, 1 - (bestDistance / MAX_HORIZONTAL_DISTANCE));

        matches.push({
          faceIndex: face.index,
          bibValue: bestBib.bib,
          spatialScore: Number(score.toFixed(3)),
        });

        this.logger.log(
          `   ✅ Face ${face.index} matched with bib "${bestBib.bib}" (H-dist: ${bestDistance.toFixed(0)}px, score: ${score.toFixed(3)})`
        );
      } else {
        this.logger.log(`   ❌ Face ${face.index}: no bib within ${MAX_HORIZONTAL_DISTANCE}px (best: ${bestDistance.toFixed(0)}px)`);
      }
    }

    this.logger.log(`Spatial matching complete: ${matches.length}/${faces.length} faces matched`);
    return matches;
  }

  /**
   * Check if a face-bib match is valid based on spatial score
   *
   * @param faceBbox Face bounding box [x, y, width, height]
   * @param bibBbox Bib bounding box [x, y, width, height]
   * @returns Score from 0 to 1 (higher = better match)
   */
  private calculateSpatialScore(
    faceBbox: [number, number, number, number],
    bibBbox: [number, number, number, number]
  ): { score: number; zoneId: string | null } {
    const [faceX, faceY, faceW, faceH] = faceBbox;
    const [bibX, bibY, bibW, bibH] = bibBbox;

    // Calculate centers
    const faceCenterX = faceX + faceW / 2;
    const faceCenterY = faceY + faceH / 2;
    const bibCenterX = bibX + bibW / 2;
    const bibCenterY = bibY + bibH / 2;

    // ════════════════════════════════════════════════
    // 1. HORIZONTAL DISTANCE (normalized)
    // ════════════════════════════════════════════════
    const normalizedHorizontalDist = Math.abs(faceCenterX - bibCenterX) / Math.max(faceW, bibW);
    const rejectionThreshold = FACE_BIB_LINKING.MAX_HORIZONTAL_REJECTION_RATIO;

    if (normalizedHorizontalDist > rejectionThreshold) {
      return { score: 0, zoneId: null }; // Too far horizontally
    }

    const horizontalScore = Math.exp(
      -normalizedHorizontalDist / FACE_BIB_LINKING.HORIZONTAL_DECAY
    );

    // ════════════════════════════════════════════════
    // 2. VERTICAL POSITION (body zone scoring)
    // ════════════════════════════════════════════════
    const deltaY = bibCenterY - faceCenterY;
    const normalizedVerticalDist = deltaY / faceH; // express in "face heights"

    if (Math.abs(normalizedVerticalDist) > FACE_BIB_LINKING.MAX_NORMALIZED_VERTICAL_DISTANCE) {
      return { score: 0, zoneId: null };
    }

    const { score: verticalScore, zoneId } = this.calculateVerticalScore(normalizedVerticalDist);

    if (verticalScore < FACE_BIB_LINKING.MIN_VERTICAL_ZONE_SCORE) {
      return { score: 0, zoneId: null };
    }

    // ════════════════════════════════════════════════
    // 3. CALCULATE COMBINED SCORE
    // ════════════════════════════════════════════════

    const finalScore =
      horizontalScore * FACE_BIB_LINKING.HORIZONTAL_WEIGHT +
      verticalScore * FACE_BIB_LINKING.VERTICAL_WEIGHT;

    return { score: Number(finalScore.toFixed(3)), zoneId };
  }

  /**
   * Check if a face-bib match is valid based on spatial score
   */
  isValidMatch(spatialScore: number): boolean {
    return spatialScore >= FACE_BIB_LINKING.SPATIAL_SCORE_THRESHOLD;
  }

  /**
   * Get detailed debug info about a spatial match
   */
  getMatchDebugInfo(
    faceBbox: [number, number, number, number],
    bibBbox: [number, number, number, number]
  ): string {
    const [faceX, faceY, faceW, faceH] = faceBbox;
    const [bibX, bibY, bibW, bibH] = bibBbox;

    const faceCenterX = faceX + faceW / 2;
    const faceCenterY = faceY + faceH / 2;
    const bibCenterX = bibX + bibW / 2;
    const bibCenterY = bibY + bibH / 2;

    const horizontalDist = Math.abs(faceCenterX - bibCenterX);
    const verticalDist = bibCenterY - faceCenterY;
    const { score, zoneId } = this.calculateSpatialScore(faceBbox, bibBbox);
    const normalizedVertical = (verticalDist) / faceH;

    return (
      `Face: [${faceX}, ${faceY}, ${faceW}, ${faceH}] | ` +
      `Bib: [${bibX}, ${bibY}, ${bibW}, ${bibH}] | ` +
      `H-dist: ${horizontalDist.toFixed(0)}px | ` +
      `V-dist: ${verticalDist.toFixed(0)}px | ` +
      `V-norm: ${normalizedVertical.toFixed(2)} faceH | ` +
      `Zone: ${zoneId ?? 'N/A'} | ` +
      `Score: ${score.toFixed(3)}`
    );
  }

  private calculateVerticalScore(normalizedDeltaY: number): { score: number; zoneId: string | null } {
    let bestScore = 0;
    let bestZone: string | null = null;

    for (const zone of FACE_BIB_LINKING.VERTICAL_ZONES) {
      const gaussian =
        zone.weight *
        Math.exp(
          -0.5 * Math.pow((normalizedDeltaY - zone.mean) / zone.stdDev, 2)
        );

      if (gaussian > bestScore) {
        bestScore = gaussian;
        bestZone = zone.id;
      }
    }

    return { score: Math.min(1, bestScore), zoneId: bestZone };
  }

  private getZoneLabel(
    faceBbox: [number, number, number, number],
    bibBbox: [number, number, number, number]
  ): string {
    const [faceX, faceY, faceW, faceH] = faceBbox;
    const [bibX, bibY, bibW, bibH] = bibBbox;

    const faceCenterY = faceY + faceH / 2;
    const bibCenterY = bibY + bibH / 2;
    const normalizedVertical = (bibCenterY - faceCenterY) / faceH;
    const { zoneId } = this.calculateVerticalScore(normalizedVertical);

    return zoneId ?? 'UNKNOWN_ZONE';
  }
}
