import fs from 'node:fs';

/** Version unique : celle de package.json (dist/src/version.js → ../../package.json). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
