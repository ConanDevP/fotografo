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
   * Match faces with bibs using OPTIMAL horizontal proximity.
   *
   * Algorithm:
   *   1. Generate ALL (face, bib) pairs and compute horizontal distance for each.
   *   2. Sort pairs by distance ascending — best matches first.
   *   3. Greedily assign from best pair downward, skipping already-used faces/bibs.
   *
   * This ensures the globally closest pairs are assigned first, preventing a
   * far-away face from stealing a bib that belongs to a closer face.
   *
   * @param imageWidth  Original photo width in pixels. Used to compute a
   *                    relative max-distance threshold (35% of image width,
   *                    minimum 1 000 px). Pass 0 to fall back to 1 000 px fixed.
   */
  matchFacesWithBibs(
    faces: FaceData[],
    bibs: BibData[],
    imageWidth = 0,
  ): FaceBibMatch[] {
    const matches: FaceBibMatch[] = [];
    if (faces.length === 0 || bibs.length === 0) {
      this.logger.debug('No faces or bibs to match');
      return matches;
    }

    // Relative threshold: 35% of image width, but never below 1 000 px.
    // For a 4 000 px wide photo this gives 1 400 px, handling side-by-side runners.
    const MAX_H_DIST =
      imageWidth > 0
        ? Math.max(1000, Math.round(imageWidth * 0.35))
        : 1000;

    this.logger.log(
      `Matching ${faces.length} face(s) with ${bibs.length} bib(s) using OPTIMAL horizontal proximity ` +
        `(max dist: ${MAX_H_DIST}px${imageWidth > 0 ? `, image width: ${imageWidth}px` : ''})`,
    );

    // Pre-compute centers
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

    faceCenters.forEach((f) =>
      this.logger.log(`   👤 Face ${f.index}: X=${f.centerX.toFixed(0)}, Y=${f.centerY.toFixed(0)}`),
    );
    bibCenters.forEach((b) =>
      this.logger.log(`   🔢 Bib "${b.bib}": X=${b.centerX.toFixed(0)}, Y=${b.centerY.toFixed(0)}`),
    );

    // ── Step 1: enumerate all (face, bib) candidate pairs ──
    interface Candidate {
      faceIndex: number;
      bibIndex: number;
      bibValue: string;
      distance: number;
      score: number;
    }

    const candidates: Candidate[] = [];

    for (const face of faceCenters) {
      for (const bib of bibCenters) {
        const distance = Math.abs(face.centerX - bib.centerX);
        this.logger.debug(
          `   Face ${face.index} vs Bib "${bib.bib}": H-dist=${distance.toFixed(0)}px`,
        );
        if (distance <= MAX_H_DIST) {
          candidates.push({
            faceIndex: face.index,
            bibIndex: bib.index,
            bibValue: bib.bib,
            distance,
            score: Number(Math.max(0, 1 - distance / MAX_H_DIST).toFixed(3)),
          });
        }
      }
    }

    // ── Step 2: sort by distance ascending (best match first) ──
    candidates.sort((a, b) => a.distance - b.distance);

    // ── Step 3: greedy optimal assignment ──
    const usedFaces = new Set<number>();
    const usedBibs = new Set<number>();

    for (const c of candidates) {
      if (usedFaces.has(c.faceIndex) || usedBibs.has(c.bibIndex)) continue;

      usedFaces.add(c.faceIndex);
      usedBibs.add(c.bibIndex);

      matches.push({
        faceIndex: c.faceIndex,
        bibValue: c.bibValue,
        spatialScore: c.score,
      });

      this.logger.log(
        `   ✅ Face ${c.faceIndex} matched with bib "${c.bibValue}" (H-dist: ${c.distance.toFixed(0)}px, score: ${c.score.toFixed(3)})`,
      );
    }

    // Log unmatched faces
    for (const face of faceCenters) {
      if (!usedFaces.has(face.index)) {
        // Find the closest bib (even if over threshold) for diagnostic logging
        let closestDist = Infinity;
        let closestBib = '';
        for (const bib of bibCenters) {
          const d = Math.abs(face.centerX - bib.centerX);
          if (d < closestDist) {
            closestDist = d;
            closestBib = bib.bib;
          }
        }
        const reason =
          closestDist <= MAX_H_DIST
            ? `bib "${closestBib}" already assigned to another face`
            : `no bib within ${MAX_H_DIST}px (closest: bib "${closestBib}" at ${closestDist.toFixed(0)}px)`;
        this.logger.log(`   ❌ Face ${face.index}: unmatched — ${reason}`);
      }
    }

    this.logger.log(`Spatial matching complete: ${matches.length}/${faces.length} faces matched`);
    return matches;
  }

  isValidMatch(spatialScore: number): boolean {
    return spatialScore >= FACE_BIB_LINKING.SPATIAL_SCORE_THRESHOLD;
  }

  getMatchDebugInfo(
    faceBbox: [number, number, number, number],
    bibBbox: [number, number, number, number],
  ): string {
    const [faceX, faceY, faceW, faceH] = faceBbox;
    const [bibX, bibY, bibW, bibH] = bibBbox;

    const faceCenterX = faceX + faceW / 2;
    const faceCenterY = faceY + faceH / 2;
    const bibCenterX = bibX + bibW / 2;
    const bibCenterY = bibY + bibH / 2;

    const horizontalDist = Math.abs(faceCenterX - bibCenterX);
    const verticalDist = bibCenterY - faceCenterY;

    return (
      `Face: [${faceX}, ${faceY}, ${faceW}, ${faceH}] | ` +
      `Bib: [${bibX}, ${bibY}, ${bibW}, ${bibH}] | ` +
      `H-dist: ${horizontalDist.toFixed(0)}px | ` +
      `V-dist: ${verticalDist.toFixed(0)}px`
    );
  }
}
