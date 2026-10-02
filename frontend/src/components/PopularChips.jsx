import React from 'react';
import { categoryMeta } from '../lib/categories.js';

/** One-tap jump to high-traffic destinations. */
export default function PopularChips({ popular, onSelect }) {
  if (!popular.length) return null;

  return (
    <div className="popular">
      <p className="section-label">Popular places</p>
      <div className="chips">
        {popular.map(({ poi, label }) => {
          const meta = categoryMeta(poi.category);
          return (
            <button
              key={poi.id}
              type="button"
              className="chip chip--popular"
              style={{ '--chip-color': meta.color }}
              onClick={() => onSelect(poi)}
            >
              <span aria-hidden="true">{meta.icon}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}