import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  FULL_VIEWPORT_HEIGHT,
  TERMINAL_INPUT_FONT_SIZE,
} from '../src/mobile-layout-config.js';

test('uses app viewport css variable for full-height layouts', () => {
  assert.equal(FULL_VIEWPORT_HEIGHT, 'var(--app-height)');
});

test('keeps terminal input font size at or above iOS auto-zoom threshold', () => {
  assert.ok(TERMINAL_INPUT_FONT_SIZE >= 16);
  assert.equal(TERMINAL_INPUT_FONT_SIZE, 16);
});
