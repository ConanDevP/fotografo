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
   * Match faces with bibs using spatial proximity (bounding box analysis)
   *
   * Algorithm:
   * 1. For each face, find the best matching bib based on spatial proximity
   * 2. Bibs should be BELOW the face (chest/back area)
   * 3. Horizontal alignment is important (same X axis ±threshold)
   * 4. Vertical distance should be reasonable (100-500px typically)
   *
   * @param faces Array of detected faces with bboxes
   * @param bibs Array of detected bibs with bboxes
   * @returns Array of face-bib matches with confidence scores
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

    this.logger.log(
      `Matching ${faces.length} face(s) with ${bibs.length} bib(s)`
    );

    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      let bestMatch = { bibValue: null as string | null, score: 0 };

      for (const bib of bibs) {
        const score = this.calculateSpatialScore(face.bbox, bib.bbox);

        if (score > bestMatch.score && score > FACE_BIB_LINKING.SPATIAL_SCORE_THRESHOLD) {
          bestMatch = { bibValue: bib.bib, score };
        }
      }

      if (bestMatch.bibValue) {
        matches.push({
          faceIndex,
          bibValue: bestMatch.bibValue,
          spatialScore: bestMatch.score,
        });

        this.logger.debug(
          `Face ${faceIndex} matched with bib "${bestMatch.bibValue}" ` +
          `(score: ${bestMatch.score.toFixed(3)})`
        );
      } else {
        this.logger.debug(
          `Face ${faceIndex} has no matching bib (all scores below threshold)`
        );
      }
    }

    this.logger.log(
      `Spatial matching complete: ${matches.length}/${faces.length} faces matched`
    );

    return matches;
  }

  /**
   * Calculate spatial proximity score between face and bib bounding boxes
   *
   * @param faceBbox Face bounding box [x, y, width, height]
   * @param bibBbox Bib bounding box [x, y, width, height]
   * @returns Score from 0 to 1 (higher = better match)
   */
  private calculateSpatialScore(
    faceBbox: [number, number, number, number],
    bibBbox: [number, number, number, number]
  ): number {
    const [faceX, faceY, faceW, faceH] = faceBbox;
    const [bibX, bibY, bibW, bibH] = bibBbox;

    // Calculate centers
    const faceCenterX = faceX + faceW / 2;
    const faceCenterY = faceY + faceH / 2;
    const bibCenterX = bibX + bibW / 2;
    const bibCenterY = bibY + bibH / 2;

    // ════════════════════════════════════════════════
    // 1. CHECK: Bib must be BELOW the face
    // ════════════════════════════════════════════════
    const faceBottom = faceY + faceH;
    const isBelow = bibCenterY > (faceCenterY + faceH * 0.3);

    if (!isBelow) {
      return 0; // Bib is not below face - invalid
    }

    // ════════════════════════════════════════════════
    // 2. HORIZONTAL DISTANCE (alignment check)
    // ════════════════════════════════════════════════
    const horizontalDist = Math.abs(faceCenterX - bibCenterX);
    const avgWidth = (faceW + bibW) / 2;
    const maxHorizontalDist = avgWidth * FACE_BIB_LINKING.MAX_HORIZONTAL_DISTANCE_RATIO;

    if (horizontalDist > maxHorizontalDist) {
      return 0; // Too far horizontally - different person
    }

    // ════════════════════════════════════════════════
    // 3. VERTICAL DISTANCE (reasonable range check)
    // ════════════════════════════════════════════════
    const verticalDist = bibCenterY - faceCenterY;

    if (
      verticalDist < FACE_BIB_LINKING.MIN_VERTICAL_DISTANCE ||
      verticalDist > FACE_BIB_LINKING.MAX_VERTICAL_DISTANCE
    ) {
      return 0; // Unreasonable vertical distance
    }

    // ════════════════════════════════════════════════
    // 4. CALCULATE COMBINED SCORE
    // ════════════════════════════════════════════════

    // Horizontal alignment score (1.0 = perfectly aligned, 0.0 = at max distance)
    const horizontalScore = Math.max(
      0,
      1 - (horizontalDist / maxHorizontalDist)
    );

    // Vertical distance score (1.0 = optimal distance, decreases as it deviates)
    const verticalDeviation = Math.abs(
      verticalDist - FACE_BIB_LINKING.OPTIMAL_VERTICAL_DISTANCE
    );
    const maxVerticalDeviation =
      FACE_BIB_LINKING.MAX_VERTICAL_DISTANCE - FACE_BIB_LINKING.OPTIMAL_VERTICAL_DISTANCE;
    const verticalScore = Math.max(
      0,
      1 - (verticalDeviation / maxVerticalDeviation)
    );

    // Combined score (weighted: horizontal 70%, vertical 30%)
    const finalScore = (horizontalScore * 0.7) + (verticalScore * 0.3);

    return Number(finalScore.toFixed(3));
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
    const score = this.calculateSpatialScore(faceBbox, bibBbox);

    return (
      `Face: [${faceX}, ${faceY}, ${faceW}, ${faceH}] | ` +
      `Bib: [${bibX}, ${bibY}, ${bibW}, ${bibH}] | ` +
      `H-dist: ${horizontalDist.toFixed(0)}px | ` +
      `V-dist: ${verticalDist.toFixed(0)}px | ` +
      `Score: ${score.toFixed(3)}`
    );
  }
}
