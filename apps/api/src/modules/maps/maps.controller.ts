import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const MAPS_DIR = process.env.MAPS_DIR ?? '/home/pi/robot_ws/maps';

@Controller('api/robot')
export class MapsController {
  @Get('map-image')
  getLatestMap(@Res() res: Response): void {
    const candidates = ['latest.pgm', 'map.pgm'];
    for (const name of candidates) {
      const full = path.join(MAPS_DIR, name);
      if (fs.existsSync(full)) {
        res.setHeader('Content-Type', 'image/x-portable-graymap');
        fs.createReadStream(full).pipe(res);
        return;
      }
    }
    throw new NotFoundException('No map found');
  }

  @Get('map-image/:name')
  getNamedMap(@Param('name') name: string, @Res() res: Response): void {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
      throw new NotFoundException('Invalid map name');
    }
    const full = path.join(MAPS_DIR, name);
    if (!fs.existsSync(full)) {
      throw new NotFoundException(`Map ${name} not found`);
    }
    res.setHeader('Content-Type', 'image/x-portable-graymap');
    fs.createReadStream(full).pipe(res);
  }
}
