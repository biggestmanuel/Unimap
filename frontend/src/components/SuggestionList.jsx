import React from 'react';
import { categoryMeta } from '../lib/categories.js';

/** Ranked search results. */
export default function SuggestionList({ results, query, onSelect, selectedId }) {
  if (!query.trim()) return null;

  if (results.length === 0) {
    return (
      <div className="suggestions-empty" role="status">
        <p>No match for “{query.trim()}”</p>
        <span>Try a shorter name, or clear the type filter.</span>
      </div>
    );
  }

  return (
    <ul className="suggestions" aria-label="Search results">
      {results.map((poi) => {
        const meta = categoryMeta(poi.category);
        return (
          <li key={poi.id}>
            <button
              type="button"
              className={`suggestion${selectedId === poi.id ? ' is-selected' : ''}`}
              onClick={() => onSelect(poi)}
            >
              <span className="suggestion__icon" style={{ '--chip-color': meta.color }} aria-hidden="true">
                {meta.icon}
              </span>
              <span className="suggestion__text">
                <span className="suggestion__name">{poi.name}</span>
                <span className="suggestion__category">{poi.categoryLabel}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}