import React, { useRef, useEffect } from 'react';
import CategoryFilter from './CategoryFilter.jsx';
import SuggestionList from './SuggestionList.jsx';
import PopularChips from './PopularChips.jsx';

/**
 * Search sheet — the single surface for finding a campus location.
 *
 * Collapsed it is just the "Where are you headed?" trigger; tapping it
 * expands into the full sheet with type filters, ranked results and
 * popular shortcuts.
 */
export default function SearchSheet({
  open,
  onClose,
  query,
  onQueryChange,
  categories,
  category,
  onToggleCategory,
  results,
  popular,
  selectedId,
  onSelect,
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <>
      {/* Collapsed trigger */}
      {!open && (
        <div className="bar default-bar">
          <div className="bar-pill" />
          <button type="button" className="search-trigger" onClick={onClose} aria-haspopup="dialog">
            <span className="trigger-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </span>
            <span className="trigger-text">Where are you headed?</span>
          </button>
        </div>
      )}

      {open && (
        <div className="full-sheet" role="dialog" aria-label="Search campus locations">
          <div className="sheet-header">
            <button type="button" className="back-btn" onClick={onClose} aria-label="Close search">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <div className="search-field">
              <svg className="field-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                type="search"
                className="search-input"
                placeholder="Search locations..."
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label="Search locations"
              />
              {query && (
                <button type="button" className="clear-btn" onClick={() => onQueryChange('')} aria-label="Clear search">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="sheet-body">
            <CategoryFilter categories={categories} active={category} onToggle={onToggleCategory} />

            <SuggestionList
              results={results}
              query={query}
              onSelect={onSelect}
              selectedId={selectedId}
            />

            {!query.trim() && <PopularChips popular={popular} onSelect={onSelect} />}
          </div>
        </div>
      )}
    </>
  );
}