/**
 * Plantillas de WhatsApp que LucilaMon crea en la cuenta del cliente.
 *
 * Reglas de Meta que condicionan el texto:
 *  - las variables van numeradas en orden y no pueden estar al inicio ni al
 *    final del cuerpo (por eso hay texto después de {{4}});
 *  - la categoría UTILITY es para avisos de algo que la persona pidió; si el
 *    texto suena a promoción, Meta la reclasifica como MARKETING (más cara);
 *  - cada plantilla exige un ejemplo por variable.
 * Si se cambia el texto, sube TEMPLATE_VERSION: Meta no permite editar una
 * plantilla rechazada con el mismo nombre.
 */
export const TEMPLATE_BASE_NAME = 'lucilamon_fotos_listas';
export const TEMPLATE_VARIABLE_COUNT = 4;

export type TemplateLocale = 'es' | 'en';

export interface TemplateDefinition {
  language: TemplateLocale;
  body: string;
  /** Un ejemplo por variable, en orden: nombre, evento, nº de fotos, enlace. */
  examples: [string, string, string, string];
}

export const TEMPLATES: Record<TemplateLocale, TemplateDefinition> = {
  es: {
    language: 'es',
    body: 'Hola {{1}}, ya están disponibles tus fotos de {{2}}: hay {{3}} con tu dorsal. Consúltalas aquí: {{4}} Gracias por participar.',
    examples: ['Ana', 'Maratón Ciudad 2027', '3', 'https://fotos.ejemplo.com/eventos/maraton?bib=123'],
  },
  en: {
    language: 'en',
    body: 'Hi {{1}}, your photos from {{2}} are now available: there are {{3}} with your bib number. See them here: {{4}} Thanks for taking part.',
    examples: ['Ana', 'City Marathon 2027', '3', 'https://photos.example.com/events/marathon?bib=123'],
  },
};

export const TEMPLATE_LOCALES = Object.keys(TEMPLATES) as TemplateLocale[];

export function templateName(version: number): string {
  return `${TEMPLATE_BASE_NAME}_v${version}`;
}

/** Cuerpo de la solicitud de creación de plantilla (Graph API). */
export function templateCreationPayload(locale: TemplateLocale, version: number) {
  const definition = TEMPLATES[locale];
  return {
    name: templateName(version),
    language: definition.language,
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: definition.body, example: { body_text: [definition.examples] } },
    ],
  };
}

/**
 * Meta rechaza parámetros con saltos de línea, tabuladores o más de 4 espacios
 * seguidos, y uno vacío. Se limpia lo que escribe el organizador (nombre del
 * evento) y lo que escribe el corredor (su nombre).
 */
export function cleanTemplateParam(value: string | null | undefined, fallback: string, max = 100): string {
  const cleaned = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max).trim();
  return cleaned || fallback;
}
