import React from 'react';

/** Category filter chips. Sorted by POI count so useful ones lead. */
export default function CategoryFilter({ categories, active, onToggle }) {
  if (!categories.length) return null;

  return (
    <div className="cat-filters">
      <p className="section-label" id="cat-filter-label">
        Filter by type
      </p>
      <div className="chips" role="group" aria-labelledby="cat-filter-label">
        <button
          type="button"
          className={`chip chip--clear${active ? ' is-active' : ''}`}
          onClick={() => active && onToggle(active)}
          aria-pressed={!active}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.category}
            type="button"
            className={`chip${active === c.category ? ' is-active' : ''}`}
            style={{ '--chip-color': c.color }}
            onClick={() => onToggle(c.category)}
            aria-pressed={active === c.category}
          >
            <span aria-hidden="true">{c.icon}</span>
            <span>{c.label}</span>
            <span className="chip__count">{c.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}