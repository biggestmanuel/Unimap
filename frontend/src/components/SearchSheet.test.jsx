import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SearchSheet from './SearchSheet.jsx';
import { normalizeCollection, resolvePopularPlaces, categoryCounts, searchPois } from '../lib/pois.js';

const pois = normalizeCollection({
  features: [
    { type: 'Feature', properties: { Name: 'Faculty of Engineering', category: 'faculty' }, geometry: { type: 'Point', coordinates: [6.98, 4.79] } },
    { type: 'Feature', properties: { Name: 'Faculty of Law', category: 'faculty' }, geometry: { type: 'Point', coordinates: [6.981, 4.791] } },
    { type: 'Feature', properties: { Name: 'NEH', category: 'academic' }, geometry: { type: 'Point', coordinates: [6.982, 4.792] } },
    { type: 'Feature', properties: { Name: 'Love Garden', category: 'landmark' }, geometry: { type: 'Point', coordinates: [6.983, 4.793] } },
  ],
});

const categories = categoryCounts(pois);
const popular = resolvePopularPlaces(pois).resolved;

function renderSheet(overrides = {}) {
  const onSelect = vi.fn();
  const props = {
    open: true,
    onClose: vi.fn(),
    query: '',
    onQueryChange: vi.fn(),
    categories,
    category: null,
    onToggleCategory: vi.fn(),
    results: [],
    popular,
    selectedId: null,
    onSelect,
    ...overrides,
  };
  const view = render(<SearchSheet {...props} />);
  return { props, onSelect, view };
}

describe('SearchSheet', () => {
  it('renders the search field when open', () => {
    renderSheet();
    expect(screen.getByRole('searchbox', { name: /search locations/i })).toBeInTheDocument();
  });

  it('renders the collapsed trigger when closed', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet({ open: false });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /where are you headed/i }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('lists every category with counts', () => {
    renderSheet();
    const group = screen.getByRole('group', { name: /filter by type/i });
    const buttons = within(group).getAllByRole('button');

    const faculty = buttons.find((b) => b.textContent.includes('Faculty'));
    expect(faculty).toBeDefined();
    expect(faculty.textContent).toContain('2');

    const academic = buttons.find((b) => b.textContent.includes('Academic'));
    expect(academic).toBeDefined();
    expect(academic.textContent).toContain('1');

    // "All" plus one chip per category present in the data.
    expect(buttons.length).toBe(categories.length + 1);
  });

  it('toggles a category filter', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();
    await user.click(screen.getByRole('button', { name: /faculty/i }));
    expect(props.onToggleCategory).toHaveBeenCalledWith('faculty');
  });

  it('marks the active category as pressed', () => {
    renderSheet({ category: 'faculty' });
    expect(screen.getByRole('button', { name: /faculty/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /all/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports a query change', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();
    await user.type(screen.getByRole('searchbox'), 'fac');
    expect(props.onQueryChange).toHaveBeenCalled();
  });

  it('shows a clear button only when there is a query', async () => {
    const user = userEvent.setup();
    const { view, props } = renderSheet();
    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();

    view.rerender(<SearchSheet {...props} query="fac" />);
    await user.click(screen.getByRole('button', { name: /clear search/i }));
    expect(props.onQueryChange).toHaveBeenCalledWith('');
  });

  it('renders ranked results for a query', () => {
    renderSheet({ query: 'fac', results: searchPois(pois, 'fac') });
    const list = screen.getByRole('list', { name: /search results/i });
    const items = within(list).getAllByRole('button');
    expect(items).toHaveLength(2);
    // Tightest prefix match leads: "Faculty of Law" is shorter than
    // "Faculty of Engineering", so it outranks it for the query "fac".
    expect(items[0]).toHaveTextContent('Faculty of Law');
    expect(items[1]).toHaveTextContent('Faculty of Engineering');
  });

  it('shows an empty state when nothing matches', () => {
    renderSheet({ query: 'zzzz', results: [] });
    expect(screen.getByText(/no match for/i)).toBeInTheDocument();
  });

  it('shows popular places only with no query', () => {
    const { view, props } = renderSheet();
    expect(screen.getByText(/popular places/i)).toBeInTheDocument();

    view.rerender(<SearchSheet {...props} query="fac" results={searchPois(pois, 'fac')} />);
    expect(screen.queryByText(/popular places/i)).not.toBeInTheDocument();
  });

  it('selects a popular place and closes', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSheet();
    await user.click(screen.getByRole('button', { name: /love garden/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'Love Garden' }));
  });

  it('selects a search result', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSheet({ query: 'neh', results: searchPois(pois, 'neh') });
    await user.click(screen.getByRole('button', { name: /neh/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'NEH' }));
  });

  it('highlights the selected POI', () => {
    renderSheet({ query: 'neh', results: searchPois(pois, 'neh'), selectedId: 'neh-2' });
    expect(screen.getByRole('button', { name: /neh/i }).className).toMatch(/is-selected/);
  });

  it('closes from the back button', async () => {
    const user = userEvent.setup();
    const { props } = renderSheet();
    await user.click(screen.getByRole('button', { name: /close search/i }));
    expect(props.onClose).toHaveBeenCalled();
  });
});