import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RoutePanel from './RoutePanel.jsx';

const result = {
  found: true,
  mode: 'graph',
  coords: [{ lat: 4.79, lng: 6.98 }, { lat: 4.791, lng: 6.981 }],
  distanceMeters: 190,
  durationSeconds: 140,
  snappedOriginMeters: 4,
  snappedDestinationMeters: 6,
  legs: [{ name: 'Road A', edgeClass: 'corridor', lengthMeters: 190 }],
  from: { lat: 4.79, lng: 6.98 },
  to: { lat: 4.791, lng: 6.981 },
};

function renderPanel(overrides = {}) {
  return render(
    <RoutePanel
      status="ready"
      result={result}
      onDismiss={vi.fn()}
      onReroute={vi.fn()}
      {...overrides}
    />,
  );
}

describe('RoutePanel', () => {
  it('says the route starts at the campus centre when there is no GPS fix', () => {
    renderPanel({ originApproximate: true });
    expect(screen.getByText(/starting from the campus centre/i)).toBeVisible();
  });

  it('does not claim a campus-centre start when the student has a position', () => {
    renderPanel({ originApproximate: false });
    expect(screen.queryByText(/starting from the campus centre/i)).toBeNull();
  });
});
