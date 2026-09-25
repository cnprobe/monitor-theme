import test from 'node:test';
import assert from 'node:assert/strict';

import { mountFooter } from '../../theme/js/footer.js';

function rootWithFooter() {
  const elements = new Map([
    ['me-footer', { hidden: true }],
    ['footer-text', { textContent: '' }],
  ]);
  return {
    getElementById(id) { return elements.get(id) || null; },
    elements,
  };
}

test('shows only administrator-provided footer text', () => {
  const root = rootWithFooter();
  const stop = mountFooter({ root, text: '  hello  ' });
  assert.equal(root.elements.get('me-footer').hidden, false);
  assert.equal(root.elements.get('footer-text').textContent, 'hello');
  stop();
});

test('keeps the footer hidden when the custom text is empty', () => {
  const root = rootWithFooter();
  mountFooter({ root, text: '   ' });
  assert.equal(root.elements.get('me-footer').hidden, true);
  assert.equal(root.elements.get('footer-text').textContent, '');
});
