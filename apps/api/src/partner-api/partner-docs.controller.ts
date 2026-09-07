import { Controller, Get, Header, Res } from '@nestjs/common';
import { Response } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';

@Controller('partner-docs')
export class PartnerDocsController {
  @Get('openapi.yaml')
  @Header('Cache-Control', 'public, max-age=300, must-revalidate')
  async openapi(@Res() response: Response) {
    const specification = await readFile(join(process.cwd(), 'docs', 'partner-openapi.yaml'), 'utf8');
    response
      .type('application/yaml')
      .setHeader('Content-Disposition', 'inline; filename="lucilamon-partner-api-v1.yaml"')
      .send(specification);
  }
}
