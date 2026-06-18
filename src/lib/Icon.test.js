import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import Icon from './Icon.svelte';

function svgOf(container) {
  return container.querySelector('svg');
}

describe('Icon', () => {
  it('renders an svg sized by the size prop', () => {
    const { container } = render(Icon, { name: 'arrow-down', size: 30 });
    const svg = svgOf(container);
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('30');
    expect(svg.getAttribute('height')).toBe('30');
  });

  it('draws arrow-down as two normalized paths', () => {
    const { container } = render(Icon, { name: 'arrow-down' });
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    // pathLength="1" is what makes the draw animation geometry-independent.
    expect(paths[0].getAttribute('pathLength')).toBe('1');
  });

  it('renders the settings icon with a circle plus a path', () => {
    const { container } = render(Icon, { name: 'settings' });
    expect(container.querySelector('circle')).toBeTruthy();
    expect(container.querySelector('path')).toBeTruthy();
  });

  it('adds the draw class by default and omits it when draw=false', () => {
    const { container: a } = render(Icon, { name: 'menu' });
    expect(svgOf(a).classList.contains('draw')).toBe(true);

    const { container: b } = render(Icon, { name: 'menu', draw: false });
    expect(svgOf(b).classList.contains('draw')).toBe(false);
  });

  it('exposes an accessible label only when a title is given', () => {
    const { container: labeled } = render(Icon, { name: 'folder', title: 'Files' });
    const svg = svgOf(labeled);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Files');

    const { container: plain } = render(Icon, { name: 'folder' });
    expect(svgOf(plain).getAttribute('aria-hidden')).toBe('true');
  });

  it('renders an empty svg for an unknown icon name', () => {
    const { container } = render(Icon, { name: 'does-not-exist' });
    expect(svgOf(container)).toBeTruthy();
    expect(container.querySelectorAll('path, circle, line').length).toBe(0);
  });
});
