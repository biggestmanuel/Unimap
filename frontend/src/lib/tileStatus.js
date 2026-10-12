/**
 * Tile failure diagnosis.
 *
 * Split out from the component so the logic can be tested without a map, and so
 * the two cases cannot be confused.
 *
 * A tile request fails for two entirely different reasons and the student needs
 * to be told which one happened:
 *
 *   - the device is offline. Expected. The service worker may still be serving a
 *     cached map, and this is not a fault.
 *   - the device is online and the tile server is refusing. This is the public
 *     OSM usage policy kicking in, and it is the failure `docs/TILES.md` warns
 *     about: it looks exactly like a broken map, and nobody realises the campus
 *     has been throttled.
 *
 * With no `tileerror` handler at all -- which is what this replaced -- both look
 * identical: a grey grid, and nothing in the console worth reading.
 */

/** Consecutive failures before saying anything. */
export const TILE_FAILURE_THRESHOLD = 6;

/**
 * The hostname in a Leaflet tile URL template, for naming in a message.
 *
 * `{s}` is Leaflet's subdomain placeholder, so it is substituted before parsing.
 * Returns null when the URL is not parseable, which is better than throwing
 * inside a render.
 */
export function tileHost(template) {
  if (!template) return null;
  try {
    return new URL(String(template).replace('{s}', 'a')).host;
  } catch {
    return null;
  }
}

/**
 * What to tell the student, given the failure count and whether the device
 * believes it has a network.
 *
 * `failures` below the threshold means nothing: a campus viewport loads a dozen
 * tiles and a transient blip is normal.
 */
export function tileStatus(failures, online) {
  if (failures < TILE_FAILURE_THRESHOLD) return null;

  if (!online) {
    return {
      kind: 'offline',
      message: 'You are offline. The map you see is cached; new areas will not load '
        + 'until you have signal again.',
    };
  }

  return {
    kind: 'blocked',
    message: 'The map tile server is refusing requests, so the basemap has stopped '
      + 'loading. Your location and the campus map data still work. This usually '
      + 'means the shared public tile server has throttled this network.',
  };
}