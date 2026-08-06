import { Body, Controller, Get, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

interface SaveMapBody {
  name?: string;
}

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

  /**
   * List all saved SLAM maps in MAPS_DIR.  Each entry is a base name
   * (without extension) returned for both the .pgm and .yaml pair so the
   * UI can offer "Save map" / "Load map" pickers.
   */
  @Get('maps')
  listMaps(): { name: string; sizeBytes: number; modifiedAt: string }[] {
    try {
      if (!fs.existsSync(MAPS_DIR)) return [];
      const seen = new Set<string>();
      const out: { name: string; sizeBytes: number; modifiedAt: string }[] = [];
      for (const file of fs.readdirSync(MAPS_DIR)) {
        const m = file.match(/^(.+)\.(pgm|yaml)$/);
        if (!m) continue;
        const base = m[1];
        if (seen.has(base)) continue;
        seen.add(base);

        // Pick the size of the .pgm if present (the image file is what the UI shows)
        const pgm = path.join(MAPS_DIR, `${base}.pgm`);
        const stat = fs.existsSync(pgm) ? fs.statSync(pgm) : fs.statSync(path.join(MAPS_DIR, `${base}.yaml`));
        out.push({
          name: base,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
      out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return out;
    } catch (err) {
      throw new NotFoundException(
        `Không thể liệt kê maps: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Save the current SLAM map by invoking ROS 2's map_saver_cli.
   * The Pi-side brain may already call this on EXPLORE-complete; this
   * endpoint exposes the same capability for operator-driven saves from
   * the web UI (e.g. when finishing a mapping session manually).
   *
   * The output filename is validated to avoid path traversal.
   */
  @Post('maps/save')
  async saveMap(@Body() body: SaveMapBody): Promise<{ savedAs: string }> {
    const name = (body?.name ?? 'latest').replace(/[^a-zA-Z0-9_.-]/g, '_');
    if (!name || name.length > 64) {
      throw new NotFoundException('Tên map không hợp lệ (chỉ chứa a-z 0-9 _.-, tối đa 64 ký tự)');
    }
    const outPath = path.join(MAPS_DIR, name);

    // map_saver_cli runs on the Pi; this endpoint is intended to be hit
    // from the operator console after stopping mapping.  We delegate via
    // shell so the ROS 2 environment is loaded.
    try {
      await execFileAsync(
        'bash',
        ['-lc', `source /opt/ros/jazzy/setup.bash 2>/dev/null; ros2 run nav2_map_server map_saver_cli -f "${outPath}"`],
        { timeout: 30_000 },
      );
    } catch (err) {
      throw new NotFoundException(`map_saver_cli thất bại: ${(err as Error).message}`);
    }

    if (!fs.existsSync(`${outPath}.pgm`)) {
      throw new NotFoundException(`map_saver_cli không tạo file ${outPath}.pgm`);
    }
    return { savedAs: name };
  }
}
