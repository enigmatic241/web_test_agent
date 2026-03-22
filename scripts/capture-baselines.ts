import '../utils/load-env.js';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium } from 'playwright';
import { PAGES } from '../config/pages.js';
import { logger } from '../utils/logger.js';

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const browser = await chromium.launch({ headless: true });

  const manifest: Array<{
    pageSlug: string;
    viewport: string;
    capturedAt: string;
    filePath: string;
    checksum: string;
  }> = [];

  try {
    for (const page of PAGES) {
      for (const [label, vp] of [
        ['desktop', DESKTOP],
        ['mobile', MOBILE],
      ] as const) {
        const dir = path.join(process.cwd(), 'baselines', page.slug, label);
        const existing = await fs.readdir(dir).catch(() => []);
        if (existing.length > 0 && !force) {
          logger.error(
            `Refusing to overwrite baselines in ${dir} — pass --force to replace.`
          );
          process.exit(1);
        }
        await fs.mkdir(dir, { recursive: true });

        const context = await browser.newContext({
          viewport: vp,
          userAgent:
            label === 'desktop'
              ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
              : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          recordVideo: { dir: path.join(dir, 'video-temp') },
        });
        await context.route('**/*doubleclick.net*', (r) => r.abort());
        await context.route('**/*googlesyndication.com*', (r) => r.abort());

        const pw = await context.newPage();
        await pw.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });
        await pw.evaluate(() => {
          return Promise.all(
            Array.from(document.images).map((img) => {
              if (img.complete) {
                return Promise.resolve();
              }
              return new Promise<void>((resolve, reject) => {
                img.addEventListener('load', () => resolve());
                img.addEventListener('error', () => resolve());
              });
            })
          );
        });

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const pngPath = path.join(dir, `baseline_${ts}.png`);
        const buf = await pw.screenshot({ fullPage: true });
        await fs.writeFile(pngPath, buf);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        manifest.push({
          pageSlug: page.slug,
          viewport: label,
          capturedAt: new Date().toISOString(),
          filePath: pngPath,
          checksum: hash,
        });

        await context.close();
      }
    }

    await fs.writeFile(
      path.join(process.cwd(), 'baselines', 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    logger.info(
      'Baselines captured. Review screenshots in ./baselines/ before running tests. Run npm run test:visual to compare against these.'
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  logger.error('capture-baselines failed', {
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
