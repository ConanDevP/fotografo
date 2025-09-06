import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { GeminiOCRResponse, DetectedBib, BibRules } from '@shared/types';
import { GEMINI_MODELS } from '@shared/constants';

const GeminiResponseSchema = z.object({
  bibs: z.array(z.object({
    value: z.string(),
    confidence: z.number().min(0).max(1),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })),
  notes: z.string().optional(),
});

@Injectable()
export class OcrGeminiService {
  private readonly logger = new Logger(OcrGeminiService.name);
  private genAI: GoogleGenerativeAI;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY no configurado');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async detectBibs(
    imageUrl: string,
    bibRules?: BibRules,
    strategy: 'flash' | 'pro' = 'flash',
  ): Promise<GeminiOCRResponse> {
    try {
      const model = this.genAI.getGenerativeModel({ 
        model: strategy === 'pro' ? GEMINI_MODELS.PRO : GEMINI_MODELS.FLASH,
      });

      const prompt = this.buildPrompt(bibRules);
      
      this.logger.log(`Iniciando OCR con ${strategy} para imagen: ${imageUrl}`);

      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: await this.fetchImageAsBase64(imageUrl),
          },
        },
      ]);

      const responseText = result.response.text();
      this.logger.debug(`Respuesta Gemini: ${responseText}`);

      // Capture usage metadata
      const usageMetadata = (result.response as any).usageMetadata;
      this.logger.log(`Tokens usados - Entrada: ${usageMetadata?.promptTokenCount}, Salida: ${usageMetadata?.candidatesTokenCount}, Total: ${usageMetadata?.totalTokenCount}`);

      // Parse JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No se encontró JSON válido en la respuesta');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = GeminiResponseSchema.parse(parsed);

      // Apply normalization and filtering
      const processedBibs = this.processBibs(validated.bibs.filter(bib => bib.value !== undefined) as any[], bibRules);

      this.logger.log(`Detectados ${processedBibs.length} dorsales válidos`);

      return {
        bibs: processedBibs,
        notes: validated.notes,
        usage: usageMetadata ? {
          promptTokens: usageMetadata.promptTokenCount || 0,
          candidatesTokens: usageMetadata.candidatesTokenCount || 0,
          totalTokens: usageMetadata.totalTokenCount || 0,
        } : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Error en OCR: ${errorMessage}`, errorStack);
      throw error;
    }
  }

  private buildPrompt(bibRules?: BibRules): string {
    let prompt = `
Analiza esta imagen de un evento deportivo y detecta todos los números de dorsal visibles.

Instrucciones:
- Busca números en petos/dorsales de corredores o ciclistas
- Enfócate en números grandes y visibles en el pecho o espalda
- Ignora números pequeños como relojes, timing chips, etc.
- Proporciona coordenadas aproximadas del bounding box [x, y, width, height]
- Asigna confianza 0-1 basada en claridad y certeza

Responde SOLO en formato JSON:
{
  "bibs": [
    {"value": "123", "confidence": 0.95, "bbox": [100, 200, 80, 60]},
    {"value": "456", "confidence": 0.87, "bbox": [300, 180, 75, 65]}
  ],
  "notes": "descripción opcional"
}`;

    if (bibRules) {
      prompt += '\n\nReglas específicas para este evento:\n';
      
      if (bibRules.minLen || bibRules.maxLen) {
        prompt += `- Longitud: ${bibRules.minLen || 1}-${bibRules.maxLen || 10} dígitos\n`;
      }
      
      if (bibRules.range) {
        prompt += `- Rango válido: ${bibRules.range[0]}-${bibRules.range[1]}\n`;
      }
      
      if (bibRules.regex) {
        prompt += `- Patrón: ${bibRules.regex}\n`;
      }
      
      if (bibRules.whitelist) {
        prompt += `- Solo estos números son válidos: ${bibRules.whitelist.join(', ')}\n`;
      }
    }

    return prompt;
  }

  private processBibs(bibs: DetectedBib[], bibRules?: BibRules): DetectedBib[] {
    this.logger.debug(`Procesando ${bibs.length} dorsales detectados por Gemini`);
    
    const normalized = bibs.map(bib => {
      const normalizedBib = this.normalizeBib(bib);
      this.logger.debug(`Dorsal normalizado: "${bib.value}" -> "${normalizedBib.value}"`);
      return normalizedBib;
    });
    
    const validated = normalized.filter(bib => {
      const isValid = this.validateBib(bib.value, bibRules);
      return isValid;
    });
    
    this.logger.log(`Dorsales procesados: ${bibs.length} detectados -> ${normalized.length} normalizados -> ${validated.length} válidos`);
    
    return validated.sort((a, b) => b.confidence - a.confidence);
  }

  private normalizeBib(bib: DetectedBib): DetectedBib {
    let normalized = bib.value
      .replace(/O/g, '0')  // O -> 0
      .replace(/S/g, '5')  // S -> 5
      .replace(/B/g, '8')  // B -> 8
      .replace(/I/g, '1')  // I -> 1
      .replace(/l/g, '1')  // l -> 1
      .replace(/[^0-9]/g, ''); // Remove non-digits

    // Lower confidence if normalization was needed
    const confidence = normalized === bib.value ? bib.confidence : Math.max(0.1, bib.confidence - 0.1);

    return {
      ...bib,
      value: normalized,
      confidence,
    };
  }

  private validateBib(bib: string, rules?: BibRules): boolean {
    if (!rules) {
      this.logger.debug(`Dorsal ${bib}: Sin reglas - VÁLIDO`);
      return true;
    }

    this.logger.debug(`Validando dorsal "${bib}" con reglas:`, JSON.stringify(rules));

    // Check digits only (default behavior)
    if (!/^[0-9]+$/.test(bib)) {
      this.logger.debug(`Dorsal ${bib}: Contiene caracteres no numéricos - RECHAZADO`);
      return false;
    }

    // Check length
    if (rules.minLen && bib.length < rules.minLen) {
      this.logger.debug(`Dorsal ${bib}: Muy corto (${bib.length} < ${rules.minLen}) - RECHAZADO`);
      return false;
    }
    if (rules.maxLen && bib.length > rules.maxLen) {
      this.logger.debug(`Dorsal ${bib}: Muy largo (${bib.length} > ${rules.maxLen}) - RECHAZADO`);
      return false;
    }

    // Check regex
    if (rules.regex) {
      const regex = new RegExp(rules.regex);
      if (!regex.test(bib)) {
        this.logger.debug(`Dorsal ${bib}: No coincide con regex ${rules.regex} - RECHAZADO`);
        return false;
      }
    }

    // Check whitelist
    if (rules.whitelist && !rules.whitelist.includes(bib)) {
      this.logger.debug(`Dorsal ${bib}: No está en whitelist ${rules.whitelist.join(',')} - RECHAZADO`);
      return false;
    }

    // Check range
    if (rules.range) {
      const num = parseInt(bib);
      if (isNaN(num) || num < rules.range[0] || num > rules.range[1]) {
        this.logger.debug(`Dorsal ${bib}: Fuera de rango [${rules.range[0]}-${rules.range[1]}] - RECHAZADO`);
        return false;
      }
    }

    this.logger.debug(`Dorsal ${bib}: Todas las validaciones pasaron - VÁLIDO`);
    return true;
  }

  private async fetchImageAsBase64(url: string): Promise<string> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
      throw new Error(`Error descargando imagen: ${errorMessage}`);
    }
  }
}