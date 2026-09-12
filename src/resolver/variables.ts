/**
 * FL Studio path-variable discovery.
 *
 * Sample paths inside a .flp are frequently stored with a variable prefix
 * rather than an absolute path, e.g.
 *
 *   %FLStudioFactoryData%\Data\Patches\Packs\Legacy\Drums\Dance\Basic 808 Kick.wav
 *
 * The expansions are per-machine, so they are read from FL's own configuration
 * rather than hardcoded. Confirmed empirically on this machine (see the
 * Findings Log in CLAUDE.md):
 *
 *   %FLStudioFactoryData%  ->  <Install path>            (registry)
 *   %FLStudioData%         ->  <Install path>\Data       (older projects)
 *   %FLStudioUserData%     ->  <Shared data>\FL Studio   (registry)
 *
 * Both registry values live under HKCU\Software\Image-Line\Shared\Paths.
 * Several FL versions can be installed side by side and older projects were
 * saved against older install roots, so every discovered install is offered as
 * a candidate and the caller checks each for existence.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface FlPaths {
  /** Install roots, most likely first. */
  installRoots: string[];
  /** The "Shared data" directory, e.g. ...\Documents\Image-Line */
  sharedDataRoot: string | null;
  /** User data root, e.g. ...\Documents\Image-Line\FL Studio */
  userDataRoots: string[];
  /** How each value was obtained, for reporting. */
  sources: string[];
}

/** Reads one registry key's values via `reg query`. Returns {} if unavailable. */
function regQuery(key: string): Record<string, string> {
  try {
    const out = execFileSync('reg', ['query', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const values: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      // "    Install path    REG_SZ    C:\Program Files\..."
      const m = line.match(/^\s{4}(.+?)\s{4}REG_[A-Z_]+\s{4}(.*)$/);
      if (m?.[1] !== undefined && m[2] !== undefined) values[m[1].trim()] = m[2].trim();
    }
    return values;
  } catch {
    return {};
  }
}

/**
 * An FL install root, as opposed to a sibling like "FL Studio ASIO", is
 * identified by actually carrying the Data tree the variables point into.
 */
function isInstallRoot(dir: string): boolean {
  return existsSync(join(dir, 'Data'));
}

function pushUnique(list: string[], value: string | undefined | null): void {
  if (!value) return;
  const clean = value.replace(/[\\/]+$/, '');
  if (clean.length > 0 && !list.some((x) => x.toLowerCase() === clean.toLowerCase())) {
    list.push(clean);
  }
}

/**
 * Discovers FL's path variables. Never throws: on a machine without FL (or a
 * non-Windows one) it returns empty lists and the resolver simply cannot use
 * the variable-expansion strategy.
 */
export function discoverFlPaths(): FlPaths {
  const sources: string[] = [];
  const installRoots: string[] = [];
  const userDataRoots: string[] = [];
  let sharedDataRoot: string | null = null;

  const paths = regQuery('HKCU\\Software\\Image-Line\\Shared\\Paths');
  if (paths['Install path']) {
    pushUnique(installRoots, paths['Install path']);
    sources.push(`registry Shared\\Paths\\Install path = ${paths['Install path']}`);
  }
  if (paths['Shared data']) {
    sharedDataRoot = paths['Shared data'].replace(/[\\/]+$/, '');
    pushUnique(userDataRoots, join(sharedDataRoot, 'FL Studio'));
    sources.push(`registry Shared\\Paths\\Shared data = ${paths['Shared data']}`);
  }

  // Sibling installs: older projects reference the install they were made with,
  // and FL keeps versions side by side under the Image-Line directory.
  const imageLine = paths['Image-Line']?.replace(/[\\/]+$/, '');
  if (imageLine && existsSync(imageLine)) {
    try {
      for (const name of readdirSync(imageLine)) {
        if (isInstallRoot(join(imageLine, name))) pushUnique(installRoots, join(imageLine, name));
      }
      sources.push(`sibling installs under ${imageLine}`);
    } catch {
      // Unreadable Image-Line directory: the registry install path still stands.
    }
  }

  // Last-resort fallbacks if the registry told us nothing.
  if (installRoots.length === 0) {
    for (const base of ['C:\\Program Files\\Image-Line', 'C:\\Program Files (x86)\\Image-Line']) {
      if (!existsSync(base)) continue;
      try {
        for (const name of readdirSync(base)) {
          if (isInstallRoot(join(base, name))) pushUnique(installRoots, join(base, name));
        }
        sources.push(`filesystem fallback ${base}`);
      } catch {
        // ignore
      }
    }
  }

  return { installRoots, sharedDataRoot, userDataRoots, sources };
}

/**
 * Expands a raw path's leading %Variable% into every candidate absolute path,
 * most likely first. A path without a variable comes back unchanged.
 *
 * Returns candidates only — existence is the caller's job, which is what lets
 * the right install be picked among several.
 */
export function expandVariables(raw: string, fl: FlPaths): string[] {
  const m = raw.match(/^%([^%]+)%[\\/]?(.*)$/);
  if (!m) return [raw];
  const name = (m[1] ?? '').toLowerCase();
  const rest = m[2] ?? '';

  const roots: string[] = [];
  switch (name) {
    case 'flstudiofactorydata':
      roots.push(...fl.installRoots);
      break;
    case 'flstudiodata':
      // Older variable: points at the Data subdirectory, not the install root.
      roots.push(...fl.installRoots.map((r) => join(r, 'Data')));
      break;
    case 'flstudiouserdata':
      roots.push(...fl.userDataRoots);
      if (fl.sharedDataRoot) roots.push(fl.sharedDataRoot);
      break;
    default:
      // An unknown variable: try the OS environment, then give up rather than
      // guessing at a meaning.
      if (m[1] && process.env[m[1]]) roots.push(process.env[m[1]] as string);
      break;
  }

  return roots.map((r) => join(r, rest));
}

/** True if the raw path starts with a %Variable% prefix. */
export function hasVariablePrefix(raw: string): boolean {
  return /^%[^%]+%/.test(raw);
}
