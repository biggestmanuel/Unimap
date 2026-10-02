import L from 'leaflet';
import { categoryMeta } from '../lib/categories.js';

/**
 * Category-coloured circular marker built as a divIcon.
 *
 * divIcon rather than a PNG icon for three reasons: no bundler asset-path
 * wrangling (the classic react-leaflet trap), category colour without
 * shipping 18 sprite sheets, and no <img> requests on a 2G connection.
 */
export function createPoiIcon(category, { active = false } = {}) {
  const { icon, color } = categoryMeta(category);
  return L.divIcon({
    className: 'poi-marker-wrapper',
    html: `<div class="poi-marker${active ? ' is-active' : ''}" style="--poi-color:${color}">
             <span class="poi-marker__glyph" aria-hidden="true">${icon}</span>
           </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

/** User location marker — deliberately distinct from POIs. */
export function createUserIcon() {
  return L.divIcon({
    className: 'user-marker-wrapper',
    html: `<div class="user-marker" aria-hidden="true">
             <span class="user-marker__pulse"></span>
             <span class="user-marker__dot"></span>
           </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}