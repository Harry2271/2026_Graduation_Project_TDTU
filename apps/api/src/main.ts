import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder,SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { migratePackageZones } from './scripts/migrate-package-zone';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // One-time backfill: convert legacy targetSlotCode/sourceSlotCode → zoneCode.
  // Idempotent — safe to call on every restart; subsequent runs are no-ops.
  await migratePackageZones();

  app.enableCors({
    origin: ['https://web.nguyen-robot.io.vn', 'http://localhost:3000', 'http://localhost:8081'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Park Smart API')
    .setDescription('API documentation for Park Smart')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const httpAdapter = app.getHttpAdapter();
   
  (httpAdapter as { get: (path: string, handler: (req: unknown, res: { json: (data: unknown) => void }) => void) => void }).get('/api/docs.json', (_req, res) => {
    res.json(document);
  });

  const port = process.env.PORT ?? '5000';
  await app.listen(port);
  console.warn(`Swagger UI: http://localhost:${port}/api/docs`);
  console.warn(`Swagger JSON: http://localhost:${port}/api/docs.json`);
}
void bootstrap();
