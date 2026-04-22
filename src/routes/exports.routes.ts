/**
 * Admin-only data export (P6). Streams a ZIP of JSON dumps for
 * compliance, backup, or migration. R2 attachment bytes are NOT
 * included — see the ZIP's README.txt for how to fetch them.
 *
 *   GET /admin/export.zip
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildExportBundle } from '../services/exports.service';
import { buildZip } from '../util/zip';
import { writeAudit } from '../services/audit.service';

export const exportsRoutes = new Hono<AppEnv>();

function getClientIp(headers: Headers): string | null {
  return headers.get('CF-Connecting-IP') ?? headers.get('X-Forwarded-For') ?? null;
}

exportsRoutes.get('/export.zip', async (c) => {
  const user = c.get('user');
  const bundle = await buildExportBundle(c.env.DB);
  const zipBytes = buildZip(bundle.files);

  // Audit row before sending bytes — exports leave the system; the
  // trail must exist whether or not the download completes.
  await writeAudit(c.env.DB, {
    userId: user.id,
    action: 'admin.export',
    metadata: {
      generatedAt: bundle.generatedAt,
      fileCount: bundle.files.length,
      sizeBytes: zipBytes.length,
    },
    ip: getClientIp(c.req.raw.headers),
  });

  const dateSlug = bundle.generatedAt.slice(0, 10);
  return new Response(zipBytes, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(zipBytes.length),
      'Content-Disposition': `attachment; filename="aprs-internal-export-${dateSlug}.zip"`,
      // Exports are sensitive — never let intermediaries cache.
      'Cache-Control': 'private, no-store',
    },
  });
});
