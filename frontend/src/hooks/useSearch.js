import { useMemo, useState, useCallback } from 'react';
import { searchPois, resolvePopularPlaces } from '../lib/pois.js';
import { categoryCounts } from '../lib/pois.js';

/**
 * Search + filter state for the campus directory.
 * Keeps query, active category and selection in one place so the sheet,
 * the chips and the map all read from the same source.
 */
export function useSearch(pois, { limit = 40 } = {}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const results = useMemo(
    () => searchPois(pois, query, { limit, category }),
    [pois, query, category, limit],
  );

  const categories = useMemo(() => categoryCounts(pois), [pois]);

  const popular = useMemo(() => resolvePopularPlaces(pois).resolved, [pois]);

  const selected = useMemo(
    () => pois.find((p) => p.id === selectedId) ?? null,
    [pois, selectedId],
  );

  const toggleCategory = useCallback((key) => {
    setCategory((current) => (current === key ? null : key));
  }, []);

  const reset = useCallback(() => {
    setQuery('');
    setCategory(null);
  }, []);

  const select = useCallback((poi) => {
    setSelectedId(poi?.id ?? null);
  }, []);

  return {
    query,
    setQuery,
    category,
    setCategory,
    toggleCategory,
    reset,
    results,
    categories,
    popular,
    selected,
    selectedId,
    select,
  };
}