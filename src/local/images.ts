import { execFileSync } from 'node:child_process';

/**
 * Is the container image a recipe needs already built?
 *
 * This exists because of a real incident: switching to a model whose image was missing stopped
 * the running vLLM, then `run-recipe.sh` asked "Build now? [y/N]", got EOF, and left the machine
 * with no model at all half an hour before a demo. The switcher checks first and refuses.
 */

const cache = new Map<string, { at: number; present: boolean }>();
const TTL_MS = 60_000;

export type DockerProbe = (image: string) => boolean;

const realProbe: DockerProbe = (image) => {
  try {
    const out = execFileSync('docker', ['images', '-q', image], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim().length > 0;
  } catch {
    return false; // no docker, no daemon, or no such image — all mean "cannot start it now"
  }
};

export function imageExists(image: string | null | undefined, probe: DockerProbe = realProbe): boolean {
  if (!image) return true; // recipe does not pin one — let run-recipe decide
  const hit = cache.get(image);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.present;
  const present = probe(image);
  cache.set(image, { at: Date.now(), present });
  return present;
}

export function clearImageCache(): void {
  cache.clear();
}
