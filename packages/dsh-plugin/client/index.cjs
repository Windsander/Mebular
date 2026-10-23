'use strict';

/**
 * Minimal web client loader placeholder for @mebular/dsh-plugin.
 *
 * The panel session will replace this file with the real Mebular panel.
 * Keep it dependency-free: no `@mebular/*` imports, no cross-package paths.
 */

const name = 'mebular';

module.exports = {
  name,
  inject: [],
  apply() {
    // Intentionally empty: the bundle currently ships tools only.
  },
};
