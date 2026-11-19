import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('turns a raw fetch failure into an actionable message with a retry', async () => {
    const onRetry = vi.fn();
    render(
      <RoutePanel
        status="error"
        error="Failed to fetch"
        onRetry={onRetry}
        onDismiss={vi.fn()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/check your connection and try again/i);
    expect(alert).not.toHaveTextContent(/failed to fetch/i);

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps a generic message for errors that are not network failures', () => {
    render(<RoutePanel status="error" error="Bad request" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not work out a route/i);
  });
});
